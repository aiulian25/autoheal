import { isolatedOperatorContainer } from "./operator-authorization.js";
import { canonicalRepository, rolloutJobSchema, type RolloutJob } from "../shared/rollouts.js";
import { OPERATOR_REFUSAL } from "./operator-authorization.js";
import { OperationJournal, type RollbackOperation, type RollbackMember } from "./operation-journal.js";
import { sharesRollbackData } from "./rollback-data.js";
import { UPDATE_GROUP_LABEL, updateGroupOf, type UpdateGroup } from "./update-group.js";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PROVENANCE_MESSAGES,
  ANONYMOUS_VOLUME_PATTERN,
  BIND_SEPARATOR,
  DEFAULT_BRIDGE_NETWORK,
  DEPENDENT_DROPPED_SETTINGS,
  DIGEST_SEPARATOR,
  IMAGE_DEFAULT_SETTINGS,
  IMAGE_ID_PREFIX,
  JOB_ACTION,
  JOB_OUTCOMES,
  KEPT_IMAGE_TAG_SUFFIX,
  DOCKER_TAG_MAX_CHARACTERS,
  EDIT_OUTCOMES,
  MOUNT_TYPE_VOLUME,
  RECREATE_OUTCOMES,
  NETWORK_MODE_CONTAINER_PREFIX,
  NETWORK_MODES,
  OLD_CONTAINER_SUFFIX,
  isParkedContainer,
  READ_ONLY_BIND_SUFFIX,
  SHORT_CONTAINER_ID_LENGTH,
  STOP_GRACE_SECONDS,
  UPDATE_LABEL,
  UPDATE_PHASE,
  UPDATE_POLICY,
  UPDATE_VERIFY,
  VERIFY_PROBLEMS,
  type UpdatePhase,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { ruleForImage, satisfiesRule } from "../shared/image-provenance.js";
import type { ProvenanceSource } from "./image-updates.js";
import { parseImageReference } from "./registry-client.js";
import type { ContainerSummary, DockerClient, ImageDetails } from "./docker-client.js";
import { splitTag } from "../shared/image-reference.js";

/**
 * The digest Docker recorded for what it just pulled, for this very repository: what a signature must be over.
 * Null where Docker knows no digest for it, such as an image built on the host under the same name.
 */
function pulledDigest(image: ImageDetails | null, reference: string): string | null {
  const wanted = canonicalRepository(reference);
  const found = (image?.RepoDigests ?? []).find((entry) => canonicalRepository(entry) === wanted);
  return found?.split("@")[1] ?? null;
}
import { utcMinute } from "../shared/time-zones.js";
import { deniedMountOf, withSettings } from "./container-settings.js";
import { untilSettled } from "./settle-check.js";
import type { PullLine } from "./update-progress.js";
import { dataMountsOf, unavailableCheckpoint, type VolumeCheckpoints } from "./volume-checkpoints.js";
import type {
  ContainerConfig,
  ContainerDetails,
  HostConfiguration,
  MountSpecification,
  NetworkEndpoint,
} from "./incident-report.js";
import type { ContainerSettings } from "../shared/protocol.js";

export interface ActionResult {
  succeeded: boolean;
  outcome: string;
  // What an update undone at once said last, as Docker keeps it: the evidence of why it did not hold.
  output?: string;
}

export interface RecreateSpecification {
  // The body for POST /containers/create: settings, host settings and the primary network.
  create: Record<string, unknown>;
  // Networks joined after creation: older engines take only one network at create time.
  extraNetworks: [network: string, endpoint: NetworkEndpoint][];
}

type UpdaterDocker = Pick<
  DockerClient,
  | "inspect"
  | "inspectImage"
  | "containerSummaries"
  | "pull"
  | "create"
  | "rename"
  | "stop"
  | "start"
  | "remove"
  | "removeStopped"
  | "volumes"
  | "createVolume"
  | "removeVolume"
  | "connect"
  | "tag"
  | "removeImage"
  | "logs"
>;

// Network modes with no endpoints of their own to recreate.
const ENDPOINTLESS_NETWORK_MODES: ReadonlySet<string> = new Set([NETWORK_MODES.host, NETWORK_MODES.none]);

const failed = (outcome: string): ActionResult => ({ succeeded: false, outcome });

/** Told what a replace is doing as it goes, and each line of an update's pull. */
export interface UpdateSteps {
  enter(phase: UpdatePhase): void;
  pulled(line: PullLine): void;
}
const UNWATCHED: UpdateSteps = { enter: () => undefined, pulled: () => undefined };

// How a recreate goes: whether the container's data is kept first, as a new version may change it, and whether
// the new one starts though the old one had stopped, as a repair brings a failed container back.
interface ReplaceMode {
  keepData: boolean;
  startAlways: boolean;
  requireCheckpoint?: boolean;
}
const UPDATING: ReplaceMode = { keepData: true, startAlways: false };
const EDITING: ReplaceMode = { keepData: false, startAlways: false };
const RECREATING: ReplaceMode = { keepData: false, startAlways: true };
const NO_DATA_KEPT = { at: null, problem: null } as const;

function withoutImageEntries(entries: string[] | null | undefined, imageEntries: string[] | null | undefined) {
  const fromImage = new Set(imageEntries ?? []);
  return (entries ?? []).filter((entry) => !fromImage.has(entry));
}

function withoutImageValues(
  values: Record<string, string> | null | undefined,
  image: Record<string, string> | null | undefined,
) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([key, value]) => image?.[key] !== value));
}

function withoutImageKeys(
  values: Record<string, object> | null | undefined,
  image: Record<string, object> | null | undefined,
) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => image?.[key] === undefined));
}

/** The settings the person gave the container, without what it only inherited from the old image. */
function ownSettings(
  config: ContainerConfig,
  image: Partial<ContainerConfig>,
  shortId: string,
): Record<string, unknown> {
  const own: Record<string, unknown> = {
    ...config,
    Env: withoutImageEntries(config.Env, image.Env),
    Labels: withoutImageValues(config.Labels, image.Labels),
    ExposedPorts: withoutImageKeys(config.ExposedPorts, image.ExposedPorts),
    Volumes: withoutImageKeys(config.Volumes, image.Volumes),
  };
  for (const setting of IMAGE_DEFAULT_SETTINGS) {
    if (isDeepStrictEqual(config[setting], image[setting])) {
      delete own[setting];
    }
  }
  delete (own.Labels as Record<string, string>)[UPDATE_GROUP_LABEL];
  // Docker names a container's host after its short id; the new container gets its own.
  if (config.Hostname === shortId) {
    delete own.Hostname;
  }
  return own;
}

const isAnonymousVolume = (mount: NonNullable<ContainerDetails["Mounts"]>[number]) =>
  mount.Type === MOUNT_TYPE_VOLUME && ANONYMOUS_VOLUME_PATTERN.test(mount.Name ?? "");

const bindTarget = (bind: string) => bind.split(BIND_SEPARATOR)[1];

/**
 * The host settings, with the anonymous volumes the old container used attached by name: left
 * alone, Docker would give the new container empty ones and the data would seem to vanish.
 */
function hostSettingsKeepingVolumes(details: ContainerDetails): HostConfiguration {
  const binds = [...(details.HostConfig?.Binds ?? [])];
  const mounts: MountSpecification[] = (details.HostConfig?.Mounts ?? []).map((mount) => ({ ...mount }));
  for (const volume of (details.Mounts ?? []).filter(isAnonymousVolume)) {
    const declared = mounts.find((mount) => mount.Target === volume.Destination);
    const bound = binds.some((bind) => bindTarget(bind) === volume.Destination);
    if (declared !== undefined) {
      declared.Source = volume.Name;
    }
    if (declared === undefined && !bound) {
      binds.push(
        `${volume.Name}${BIND_SEPARATOR}${volume.Destination}${volume.RW === false ? READ_ONLY_BIND_SUFFIX : ""}`,
      );
    }
  }
  return { ...details.HostConfig, Binds: binds, Mounts: mounts };
}

function endpointFor(endpoint: NetworkEndpoint, shortId: string): NetworkEndpoint {
  const aliases = [...new Set(endpoint.Aliases ?? [])].filter((alias) => alias !== shortId);
  return {
    Aliases: aliases,
    IPAMConfig: endpoint.IPAMConfig ?? null,
    Links: endpoint.Links ?? null,
    MacAddress: endpoint.MacAddress,
    DriverOpts: endpoint.DriverOpts ?? null,
  };
}

// In another container's network, Docker gives it that one's names: asked for again, they conflict with the mode.
function withoutNetworkNames(settings: Record<string, unknown>, networkMode: string | undefined) {
  if (!(networkMode ?? "").startsWith(NETWORK_MODE_CONTAINER_PREFIX)) {
    return settings;
  }
  const kept = { ...settings };
  for (const setting of DEPENDENT_DROPPED_SETTINGS) {
    delete kept[setting];
  }
  return kept;
}

function primaryNetworkOf(networkMode: string | undefined): string | null {
  const mode = networkMode ?? NETWORK_MODES.default;
  if (ENDPOINTLESS_NETWORK_MODES.has(mode) || mode.startsWith(NETWORK_MODE_CONTAINER_PREFIX)) {
    return null;
  }
  return mode === NETWORK_MODES.default ? DEFAULT_BRIDGE_NETWORK : mode;
}

/**
 * How to create the container again on a newer image: everything the person configured (as
 * Watchtower does), nothing the old image merely defaulted, the same volumes and networks.
 */
export function recreateSpecification(
  details: ContainerDetails,
  image: Partial<ContainerConfig>,
  reference: string,
): RecreateSpecification {
  const shortId = (details.Id ?? "").slice(0, SHORT_CONTAINER_ID_LENGTH);
  const networks = Object.entries(details.NetworkSettings?.Networks ?? {}).map(
    ([network, endpoint]): [string, NetworkEndpoint] => [network, endpointFor(endpoint, shortId)],
  );
  const primary = primaryNetworkOf(details.HostConfig?.NetworkMode);
  const primaryEndpoints = networks.filter(([network]) => network === primary);
  return {
    create: {
      ...withoutNetworkNames(ownSettings(details.Config, image, shortId), details.HostConfig?.NetworkMode),
      Image: reference,
      HostConfig: hostSettingsKeepingVolumes(details),
      NetworkingConfig: { EndpointsConfig: Object.fromEntries(primaryEndpoints) },
    },
    extraNetworks: primary === null ? [] : networks.filter(([network]) => network !== primary),
  };
}

const parkedNameOf = (name: string) => `${name}${OLD_CONTAINER_SUFFIX}`;

const startedText = (started: readonly string[]) =>
  started.length === 0 ? "" : JOB_OUTCOMES.dependentsStarted(started);

const stripSlash = (name: string) => name.replace(/^\//, "");

const nameOf = (details: ContainerDetails) => stripSlash(details.Name);

const isListed = (summaries: readonly ContainerSummary[], name: string) =>
  summaries.some((summary) => summary.Names.some((listed) => stripSlash(listed) === name));

// The name an update keeps the old container under is taken: a person has not settled the last one.
function parkedRefusal(name: string, summaries: readonly ContainerSummary[]): string | null {
  const parked = parkedNameOf(name);
  return isListed(summaries, parked) ? JOB_OUTCOMES.refusedParked(name, parked) : null;
}

/**
 * The containers that run inside this one's network (Docker records `container:<id>`, or the name it was given),
 * sorted; not the old ones an update keeps aside.
 */
function dependentNamesOf(name: string, id: string, summaries: readonly ContainerSummary[]): string[] {
  const sharing = new Set([`${NETWORK_MODE_CONTAINER_PREFIX}${id}`, `${NETWORK_MODE_CONTAINER_PREFIX}${name}`]);
  return summaries
    .filter((summary) => sharing.has(summary.HostConfig?.NetworkMode ?? ""))
    .map((summary) => stripSlash(summary.Names[0] ?? summary.Id))
    .filter((dependent) => !isParkedContainer(dependent))
    .toSorted();
}

// Where a replace ended: the old container back (the new one never ran), the new one started badly with the old
// one kept aside, or the new one started and checked.
type Swapped =
  | { state: "back"; result: ActionResult }
  | { state: "aside"; result: ActionResult }
  | { state: "started"; newId: string; healthy: boolean; warning: string };

interface ReplaceProgress {
  wasRunning: boolean;
  renamed: boolean;
  newId: string | null;
}

/** How a recreate is told, an update's or an edit's: when the old container came back, or stayed aside. */
interface ReplaceWording {
  restoredAfterFailure: (name: string, error: string) => string;
  restoreFailed: (name: string, error: string, parked: string) => string;
  startedBadly: (name: string, problem: string, parked: string) => string;
  // An update's, of a group: the containers in its network, left stopped for the roll back.
  dependentsStopped?: (dependents: readonly string[]) => string;
  // Once the new one runs as it should (or stays stopped, as the old one was), and the old one is gone.
  finished: (healthy: boolean) => Promise<string>;
}

function updatedWording(name: string, reference: string, wasRunning: boolean, healthy: boolean) {
  if (!wasRunning) return JOB_OUTCOMES.updatedStopped(name, reference);
  return healthy ? JOB_OUTCOMES.updatedHealthy(name, reference) : JOB_OUTCOMES.updated(name, reference);
}

// "ghcr.io/owner/app:2" keeps the image it replaced as "ghcr.io/owner/app:2-autoheal-previous".
function keptNameOf(reference: string) {
  const { name, tag } = splitTag(reference);
  const keptTag = `${tag.slice(0, DOCKER_TAG_MAX_CHARACTERS - KEPT_IMAGE_TAG_SUFFIX.length)}${KEPT_IMAGE_TAG_SUFFIX}`;
  return { repository: name, tag: keptTag, reference: `${name}:${keptTag}` };
}

/**
 * Updates a container to the newest image behind its tag: pull, recreate with the same settings,
 * and check the new one runs (and is healthy, if it has a health check). A new container that
 * never ran is replaced by the old one at once. One that started but went wrong is not: it may
 * already have migrated its data, so the old container is kept aside and a person rolls back, with
 * the data kept before the update when there is a checkpoint of it.
 */
export class ContainerUpdater {
  constructor(
    private readonly docker: UpdaterDocker,
    private readonly wait: (milliseconds: number) => Promise<unknown> = sleep,
    private readonly clock: () => number = Date.now,
    private readonly checkpoints: Pick<VolumeCheckpoints, "take" | "verify" | "restore" | "discard"> | null = null,
    private readonly journal = new OperationJournal(docker),
    // Why no data is kept where there are no checkpoints: a host whose helper image is not there yet says so.
    private readonly withoutCheckpoints: string = JOB_OUTCOMES.checkpointUnavailable,
    // The pull found the image it already runs: the offer of an update is told it was wrong.
    private readonly confirmCurrent: (imageId: string, reference: string) => void = () => undefined,
    // Who published an image, for the scopes an admin asks proof of; null where nothing does.
    private readonly provenance: ProvenanceSource | null = null,
  ) {}

  /**
   * Why the image just pulled may not be put in place: a scope that asks for a signed image, and this digest is not
   * one that holds up. Asked after the pull and about the digest Docker recorded for it, never about the tag, and
   * before anything is stopped. Null where no rule covers the image, or where the proof is in hand.
   */
  private async provenanceRefusal(reference: string, newImage: ImageDetails | null): Promise<string | null> {
    const source = this.provenance;
    const image = parseImageReference(reference);
    if (source === null || image === null) return null;
    const rule = ruleForImage(source.policy(), image);
    if (rule === null) return null;
    const pulled = pulledDigest(newImage, reference);
    if (pulled === null) return PROVENANCE_MESSAGES.heldBackUnknown(reference);
    const found = await source.read(image, pulled).catch((error: unknown) => describeError(error));
    if (typeof found === "string") return PROVENANCE_MESSAGES.heldBack(reference, found);
    if (satisfiesRule(rule, found, pulled)) return null;
    return PROVENANCE_MESSAGES.heldBack(reference, found.problem ?? found.status);
  }

  /**
   * The containers that run inside this one's network. An update recreates them inside the new one's: the
   * network they point at goes with the old container.
   */
  async dependentsOf(name: string): Promise<string[]> {
    const details = await this.docker.inspect(name);
    return details?.Id === undefined ? [] : dependentNamesOf(name, details.Id, await this.docker.containerSummaries());
  }

  /**
   * `undoIfUnhealthy`: a container given to Ollama. A new version that starts badly is undone at once, its data put
   * back as it was, rather than kept aside for a person to roll back. A person updating one by hand on a host that
   * cannot keep its data goes ahead without that undo, since there is no data to put back.
   */
  async update(
    name: string,
    undoIfUnhealthy = false,
    steps: UpdateSteps = UNWATCHED,
    options: { allowWithoutCheckpoint?: boolean; authorize?: () => Promise<boolean>; rollout?: RolloutJob } = {},
  ): Promise<ActionResult> {
    const recovering = await this.journal.find(name);
    if (recovering !== null) return failed(JOB_OUTCOMES.rollbackPending(recovering.owner));
    const details = await this.docker.inspect(name);
    if (details?.Id === undefined) {
      return failed(JOB_OUTCOMES.missing(name));
    }
    const summaries = await this.docker.containerSummaries();
    const refusal = this.refusalFor(name, details, summaries, options.rollout !== undefined);
    if (refusal !== null) {
      return failed(refusal);
    }
    const dependents = await this.detailsOf(dependentNamesOf(name, details.Id, summaries));
    const groupRefusal = await this.groupRefusal(name, dependents, summaries);
    if (groupRefusal !== null) {
      return failed(groupRefusal);
    }
    const rollout = options.rollout;
    if (rollout && dependents.length > 0)
      return failed(
        "Staged rollouts currently require a single-container affected set; namespace groups require a separate reviewed update.",
      );
    if (
      rollout &&
      (!rolloutJobSchema.safeParse(rollout).success ||
        details.Id !== rollout.expectedSourceContainerId ||
        canonicalRepository(details.Config.Image) !== canonicalRepository(rollout.targetReference))
    )
      return failed("The reviewed rollout source or repository changed. Review a new plan.");
    if (
      rollout &&
      [details, ...dependents].some(
        (member) =>
          !isolatedOperatorContainer(member) ||
          !Array.isArray(member.Mounts) ||
          member.Mounts.some((mount) => mount.RW !== false && (mount.Type === "bind" || mount.Type === "volume")),
      )
    )
      return failed(
        "Rollouts require a verified stateless affected set; writable or unknown persistent mounts were found.",
      );
    const reference = rollout?.targetReference ?? details.Config.Image;
    // Read before the pull moves the tag on: what the old image set is not the person's setting. Docker's containerd
    // image store forgets it, though a container still runs it, once a build on the host takes its tag.
    const oldImage = details.Image === undefined ? null : await this.docker.inspectImage(details.Image);
    if (oldImage === null) {
      return failed(JOB_OUTCOMES.refusedImageForgotten(name));
    }
    if (rollout && `${oldImage.Os}/${oldImage.Architecture}` !== rollout.expectedPlatform)
      return failed("The reviewed rollout platform changed or is unknown.");
    try {
      steps.enter(UPDATE_PHASE.pulling);
      await this.docker.pull(reference, (line) => steps.pulled(line));
    } catch (error) {
      return failed(JOB_OUTCOMES.pullFailed(reference, describeError(error)));
    }
    const newImage = await this.docker.inspectImage(reference);
    if (
      rollout &&
      (newImage === null ||
        `${newImage.Os}/${newImage.Architecture}` !== rollout.expectedPlatform ||
        !newImage.RepoDigests?.some(
          (digest) =>
            digest.split("@")[1] === reference.split("@")[1] &&
            canonicalRepository(digest) === canonicalRepository(reference),
        ))
    )
      return failed("Docker did not verify the reviewed image digest and platform. No container was stopped.");
    if (rollout && newImage?.Id === details.Image)
      return failed("The reviewed image is already running; no rollout replacement was made.");
    const heldBack = await this.provenanceRefusal(reference, newImage);
    if (heldBack !== null) {
      return failed(heldBack);
    }
    if (newImage === null || newImage.Id === details.Image) {
      if (details.Image !== undefined) this.confirmCurrent(details.Image, reference);
      return { succeeded: true, outcome: JOB_OUTCOMES.alreadyCurrent(name) };
    }
    if (rollout && Object.keys(newImage?.Config?.Volumes ?? {}).length > 0)
      return failed(
        "The reviewed target image declares persistent volumes. Stateless rollout was refused before stopping the source.",
      );
    const specification = recreateSpecification(details, configOf(oldImage), reference);
    const dataUnkept =
      this.checkpoints === null && [details, ...dependents].some((member) => dataMountsOf(member).length > 0);
    const undoes = undoIfUnhealthy && !(dataUnkept && options.allowWithoutCheckpoint === true);
    const wording: ReplaceWording = {
      ...JOB_OUTCOMES,
      // Undone at once, its group started again with it: nothing waits for a roll back.
      ...(undoes ? { startedBadly: JOB_OUTCOMES.undone, dependentsStopped: () => "" } : {}),
      finished: async (healthy) => {
        const kept = await this.keepPrevious(details).catch(() => null);
        const updated = updatedWording(name, reference, details.State.Running === true, healthy);
        return kept === null ? updated : `${updated}${JOB_OUTCOMES.keptImage(kept)}`;
      },
    };
    // Unknown/older senders fail closed; a human update may waive protection only without automatic undo.
    const mode = { ...UPDATING, requireCheckpoint: undoes || options.allowWithoutCheckpoint !== true };
    // With nowhere to keep its data, one that needs it kept is refused before anything stops, not after.
    if (mode.requireCheckpoint && dataUnkept) {
      return failed(JOB_OUTCOMES.refusedWithoutCheckpoint(name, this.withoutCheckpoints));
    }
    const authorize = rollout
      ? async () => {
          if (options.authorize && !(await options.authorize())) return false;
          for (const member of [details, ...dependents]) {
            const current = await this.docker.inspect(member.Id!);
            if (
              !current ||
              !isolatedOperatorContainer(current) ||
              !Array.isArray(current.Mounts) ||
              current.Mounts.some((mount) => mount.RW !== false && (mount.Type === "bind" || mount.Type === "volume"))
            )
              return false;
          }
          return true;
        }
      : options.authorize;
    const result =
      dependents.length === 0
        ? await this.replace(name, details, specification, mode, wording, steps, authorize)
        : await this.updateGroup(name, details, specification, dependents, mode, wording, steps, authorize);
    // Kept aside only when the new version started badly: undone at once, with its data.
    const aside = !result.succeeded && (await this.docker.inspect(parkedNameOf(name)))?.Id !== undefined;
    if (!undoes || !aside) {
      return result;
    }
    // What the new version said before it goes: why it did not hold.
    const said = await this.lastWords(name);
    steps.enter(UPDATE_PHASE.undoing);
    const undone = await this.rollBack(name);
    const output = result.output === undefined ? said : `${result.output}${said === null ? "" : `\n\n${said}`}`;
    return { ...failed(`${result.outcome} ${undone.outcome}`), ...(output === null ? {} : { output }) };
  }

  private async lastWords(name: string): Promise<string | null> {
    const details = await this.docker.inspect(name);
    if (details === null) {
      return null;
    }
    return this.docker.logs(name, details.Config.Tty ?? false).catch(() => null);
  }

  /**
   * A fresh container from the image it runs, with its own settings: what a stale file in its own filesystem or a
   * start cut short left behind goes with the old one, kept aside until the new one runs. It is started, stopped
   * before or not: this brings a failed container back.
   */
  async recreate(
    name: string,
    steps: UpdateSteps = UNWATCHED,
    authorize?: () => Promise<boolean>,
  ): Promise<ActionResult> {
    const recovering = await this.journal.find(name);
    if (recovering !== null) return failed(JOB_OUTCOMES.rollbackPending(recovering.owner));
    const details = await this.docker.inspect(name);
    if (details?.Id === undefined) {
      return failed(JOB_OUTCOMES.missing(name));
    }
    const refusal = await this.recreateRefusal(name, details);
    if (refusal !== null) {
      return failed(refusal);
    }
    // Recreating by its tag must give the image it runs: one the tag moved on from would be an update too.
    const reference = details.Config.Image;
    const current = await this.docker.inspectImage(reference);
    if (current === null || current.Id !== details.Image) {
      return failed(RECREATE_OUTCOMES.tagMoved(name, reference));
    }
    const specification = recreateSpecification(details, configOf(current), reference);
    const wording: ReplaceWording = {
      ...RECREATE_OUTCOMES,
      finished: async (healthy) =>
        healthy ? RECREATE_OUTCOMES.recreatedHealthy(name) : RECREATE_OUTCOMES.recreated(name),
    };
    return this.replace(name, details, specification, RECREATING, wording, steps, authorize);
  }

  /**
   * Recreates a container with the settings a person changed, on the image it runs now, as an update does: the
   * old one is kept aside until the new one runs, and stays aside if the new one starts badly.
   */
  async edit(name: string, settings: ContainerSettings, authorize?: () => Promise<boolean>): Promise<ActionResult> {
    const details = await this.docker.inspect(name);
    if (details?.Id === undefined) {
      return failed(JOB_OUTCOMES.missing(name));
    }
    const refusal = await this.editRefusal(name, settings);
    if (refusal !== null) {
      return failed(refusal);
    }
    // Recreating by its tag must give the image it runs: one the tag moved on from would be an update too.
    const reference = details.Config.Image;
    const current = await this.docker.inspectImage(reference);
    if (current === null || current.Id !== details.Image) {
      return failed(EDIT_OUTCOMES.tagMoved(name, reference));
    }
    const specification = withSettings(recreateSpecification(details, configOf(current), reference), settings);
    const wasRunning = details.State.Running === true;
    return this.replace(
      name,
      details,
      specification,
      EDITING,
      {
        ...EDIT_OUTCOMES,
        finished: async (healthy) => {
          if (!wasRunning) {
            return EDIT_OUTCOMES.changedStopped(name);
          }
          return healthy ? EDIT_OUTCOMES.changedHealthy(name) : EDIT_OUTCOMES.changed(name);
        },
      },
      UNWATCHED,
      authorize,
    );
  }

  /**
   * Puts back the container an update kept aside, removing the one that replaced it, and the data kept before the
   * update with it. Data that cannot be put back leaves it stopped: the old version must not run on the new data.
   */
  async rollBack(name: string, authorize?: () => Promise<boolean>): Promise<ActionResult> {
    let operation: RollbackOperation | null = null;
    try {
      operation = await this.journal.find(name);
      if (operation !== null && operation.owner !== name) {
        return failed(JOB_OUTCOMES.rollbackPending(operation.owner));
      }
      if (operation === null) {
        const old = await this.docker.inspect(parkedNameOf(name));
        if (old?.Id === undefined) return failed(JOB_OUTCOMES.nothingToRollBack(parkedNameOf(name)));
        const current = await this.docker.inspect(name);
        const group = updateGroupOf(current);
        if (group !== null && (group.provider.name !== name || group.provider.id !== old.Id)) {
          throw new Error("The retained provider does not match its update group.");
        }
        const members: RollbackMember[] = [];
        let at: number | null = null;
        const requested =
          group === null ? [{ name, id: old.Id, running: true }] : [group.provider, ...group.dependents];
        for (const member of requested) {
          const original = await this.docker.inspect(member.id);
          if (
            original === null ||
            original.Id !== member.id ||
            ![member.name, parkedNameOf(member.name)].includes(nameOf(original))
          ) {
            throw new Error(`The original ${member.name} is missing or renamed; manual recovery is required.`);
          }
          const replacement = await this.docker.inspect(member.name);
          if (
            group !== null &&
            member.name !== name &&
            replacement !== null &&
            replacement.Id !== member.id &&
            (replacement.Image !== original.Image ||
              replacement.HostConfig?.NetworkMode !== `${NETWORK_MODE_CONTAINER_PREFIX}${current?.Id}`)
          ) {
            throw new Error(`${member.name} is no longer this group's replacement.`);
          }
          const restore = group !== null || original.Image === undefined || replacement?.Image !== original.Image;
          const available = restore ? await this.checkpointAvailable(member.name, original) : NO_DATA_KEPT;
          if (available.problem !== null) return failed(JOB_OUTCOMES.rollbackRefused(member.name, available.problem));
          if (member.name === name) at = available.at;
          members.push({
            ...member,
            replacementId: replacement?.Id === member.id ? null : (replacement?.Id ?? null),
            restore,
          });
        }
        // Older group updates without a manifest left their network members stopped on the original provider.
        if (group === null) {
          for (const dependent of await this.detailsOf(await this.dependentsOf(parkedNameOf(name)))) {
            members.push({
              name: nameOf(dependent),
              id: dependent.Id!,
              replacementId: null,
              running: true,
              restore: false,
            });
          }
        }
        const originals = await Promise.all(members.map(async ({ id }) => (await this.docker.inspect(id))!));
        const currents = await Promise.all(members.map(({ name: memberName }) => this.docker.inspect(memberName)));
        const writers = [...originals, ...currents.filter((container) => container !== null)];
        await this.assertNoOtherWriters(
          originals.filter((_original, index) => members[index]!.restore),
          writers,
        );
        // Persist before any stop/removal/rename: subsequent attempts use IDs, never the parked name alone.
        if (!(await this.authorizationGranted(authorize))) return failed(OPERATOR_REFUSAL);
        operation = await this.journal.begin(name, members, at);
      }
      return await this.resumeRollback(operation, authorize);
    } catch (error) {
      if (operation !== null) operation = await this.journal.find(operation.owner).catch(() => operation);
      return {
        ...failed(JOB_OUTCOMES.failed(JOB_ACTION.rollBack, name, describeError(error))),
        ...(operation === null ? {} : { output: JSON.stringify(operation, null, 2) }),
      };
    }
  }

  private async authorizationGranted(authorize?: () => Promise<boolean>): Promise<boolean> {
    return authorize === undefined ? true : authorize().catch(() => false);
  }

  private checkpointAvailable(name: string, original: ContainerDetails) {
    return this.checkpoints === null
      ? Promise.resolve({
          at: null,
          problem: unavailableCheckpoint(original).complete ? null : this.withoutCheckpoints,
        })
      : this.checkpoints.verify(name, original);
  }

  private async resumeRollback(
    operation: RollbackOperation,
    authorize?: () => Promise<boolean>,
  ): Promise<ActionResult> {
    const originals: ContainerDetails[] = [];
    const replacements: ContainerDetails[] = [];
    for (const member of operation.members) {
      const original = await this.docker.inspect(member.id);
      if (
        original === null ||
        original.Id !== member.id ||
        ![member.name, parkedNameOf(member.name)].includes(nameOf(original))
      ) {
        throw new Error(`The original ${member.name} is missing or renamed; recovery remains blocked.`);
      }
      const current = await this.docker.inspect(member.name);
      if (current !== null && current.Id !== member.id) {
        if (current.Id !== member.replacementId || operation.phase !== "prepared") {
          throw new Error(`${member.name} has an unexpected replacement; recovery remains blocked.`);
        }
        replacements.push(current);
      }
      if (operation.phase === "prepared" && member.restore) {
        const available = await this.checkpointAvailable(member.name, original);
        if (available.problem !== null)
          return {
            ...failed(JOB_OUTCOMES.rollbackRefused(member.name, available.problem)),
            output: JSON.stringify(operation, null, 2),
          };
      }
      originals.push(original);
    }
    if (!(await this.authorizationGranted(authorize)))
      return { ...failed(OPERATOR_REFUSAL), output: JSON.stringify(operation, null, 2) };
    if (operation.phase === "prepared") {
      const writers = [
        ...replacements.filter((container) => nameOf(container) !== operation.owner),
        ...replacements.filter((container) => nameOf(container) === operation.owner),
        ...originals,
      ];
      const restored = originals.filter((_original, index) => operation.members[index]!.restore);
      await this.assertNoOtherWriters(restored, writers);
      await this.stopForRollback(writers);
      for (const replacement of replacements.toReversed()) await this.docker.removeStopped(replacement.Id!);
      for (const [index, original] of originals.entries()) {
        const member = operation.members[index]!;
        if (nameOf(original) !== member.name) await this.docker.rename(member.id, member.name);
      }
      await this.assertNoOtherWriters(restored, writers);
      for (const [index, original] of originals.entries()) {
        const member = operation.members[index]!;
        if (!member.restore) continue;
        const data = (await this.checkpoints?.restore(member.name, original)) ?? NO_DATA_KEPT;
        if (data.problem !== null)
          return {
            ...failed(JOB_OUTCOMES.restoreDataFailed(member.name, data.problem)),
            output: JSON.stringify(operation, null, 2),
          };
      }
      operation = await this.journal.save(operation, "restored");
    }
    if (operation.phase === "restored") {
      await this.assertNoOtherWriters(
        originals.filter((_original, index) => operation.members[index]!.restore),
        originals,
      );
      for (const member of operation.members) {
        const current = await this.docker.inspect(member.id);
        if (current === null || nameOf(current) !== member.name || current.State.Restarting) {
          throw new Error(`${member.name} cannot safely resume; recovery remains blocked.`);
        }
        if (member.running && current.State.Running !== true) await this.docker.start(member.id);
        if (!member.running && current.State.Running)
          throw new Error(`${member.name} was originally stopped; review its unexpected start.`);
      }
      operation = await this.journal.save(operation, "committed");
    }
    for (const member of operation.members) await this.checkpoints?.discard(member.name);
    await this.journal.complete(operation);
    const names = operation.members.map(({ name }) => name);
    const outcome =
      names.length > 1
        ? JOB_OUTCOMES.groupRolledBack(names)
        : operation.at === null
          ? JOB_OUTCOMES.rolledBack(operation.owner)
          : JOB_OUTCOMES.rolledBackWithData(operation.owner, utcMinute(operation.at));
    return { succeeded: true, outcome };
  }

  /** Docker's stop response is not enough: confirm every writer is stopped before destructive work. */
  private async stopForRollback(containers: readonly ContainerDetails[]) {
    const ids = [...new Set(containers.map((container) => container.Id!))];
    for (const id of ids) {
      const current = await this.docker.inspect(id);
      if (current === null) throw new Error("A rollback container disappeared; no data was restored.");
      if (current.State.Running || current.State.Restarting) {
        await this.docker.stop(id, current.Config.StopTimeout ?? STOP_GRACE_SECONDS);
        const stopped = await this.docker.inspect(id);
        if (stopped?.State.ExitCode === 137) {
          throw new Error(
            `${nameOf(current)} was killed while stopping; recovery needs operator review. No data was restored.`,
          );
        }
      }
    }
    for (const id of ids) {
      const current = await this.docker.inspect(id);
      if (current?.State.Running !== false || current.State.Restarting) {
        throw new Error("A rollback container did not stay stopped; no data was restored.");
      }
    }
  }

  private async assertNoOtherWriters(originals: readonly ContainerDetails[], allowed: readonly ContainerDetails[]) {
    const ids = new Set(allowed.map(({ Id }) => Id));
    for (const summary of await this.docker.containerSummaries()) {
      if (ids.has(summary.Id)) continue;
      const container = await this.docker.inspect(summary.Id);
      if (
        container !== null &&
        (container.State.Running || container.State.Restarting) &&
        originals.some((original) => sharesRollbackData(original, container))
      ) {
        throw new Error(`${nameOf(container)} can still write restored data; stop it before rolling back.`);
      }
    }
  }

  private refusalFor(
    name: string,
    details: ContainerDetails,
    summaries: readonly ContainerSummary[],
    reviewedRollout = false,
  ): string | null {
    if (details.Config.Labels?.[UPDATE_LABEL] === UPDATE_POLICY.off) {
      return JOB_OUTCOMES.refusedUpdatesOff(name);
    }
    const reference = details.Config.Image;
    if ((!reviewedRollout && reference.includes(DIGEST_SEPARATOR)) || reference.startsWith(IMAGE_ID_PREFIX)) {
      return JOB_OUTCOMES.refusedPinned(name);
    }
    return parkedRefusal(name, summaries);
  }

  /**
   * What stops a group before anything stops: a container in its network that its label keeps from updates, one an
   * earlier update has not settled, or one whose tag moved on (recreating it by its tag would update it too).
   */
  private async groupRefusal(
    name: string,
    dependents: readonly ContainerDetails[],
    summaries: readonly ContainerSummary[],
  ): Promise<string | null> {
    const off = dependents.filter((dependent) => dependent.Config.Labels?.[UPDATE_LABEL] === UPDATE_POLICY.off);
    if (off.length > 0) {
      return JOB_OUTCOMES.refusedDependentOff(name, off.map(nameOf));
    }
    const unsettled = dependents.map(nameOf).find((dependent) => isListed(summaries, parkedNameOf(dependent)));
    if (unsettled !== undefined) {
      return JOB_OUTCOMES.refusedParked(unsettled, parkedNameOf(unsettled));
    }
    for (const dependent of dependents) {
      const tagged = await this.docker.inspectImage(dependent.Config.Image);
      if (tagged?.Id !== dependent.Image) {
        return JOB_OUTCOMES.refusedDependentMoved(name, nameOf(dependent));
      }
    }
    return null;
  }

  private async detailsOf(names: readonly string[]): Promise<ContainerDetails[]> {
    const found = await Promise.all(names.map((name) => this.docker.inspect(name)));
    return found.filter((details) => details !== null);
  }

  // Started where they can be; the ones that would not are left as they are.
  private async startEach(containers: readonly ContainerDetails[]): Promise<string[]> {
    const started: string[] = [];
    for (const container of containers) {
      const ok = await this.docker.start(container.Id!).then(
        () => true,
        () => false,
      );
      if (ok) {
        started.push(nameOf(container));
      }
    }
    return started;
  }

  /** What stops an edit however it is carried out, through this class or through the container's Compose file. */
  async editRefusal(name: string, settings: ContainerSettings): Promise<string | null> {
    const recovering = await this.journal.find(name);
    if (recovering !== null) return JOB_OUTCOMES.rollbackPending(recovering.owner);
    const details = await this.docker.inspect(name);
    if (details?.Id === undefined) return JOB_OUTCOMES.missing(name);
    return (await this.recreateRefusal(name, details)) ?? this.mountRefusal(details, settings);
  }

  private mountRefusal(details: ContainerDetails, settings: ContainerSettings): string | null {
    const denied = deniedMountOf(details, settings);
    return denied === null ? null : EDIT_OUTCOMES.deniedMount(denied);
  }

  // What stops an edit: an earlier recreate not settled yet, or containers that live in this one's network.
  private async recreateRefusal(name: string, details: ContainerDetails): Promise<string | null> {
    const summaries = await this.docker.containerSummaries();
    const dependents = dependentNamesOf(name, details.Id!, summaries);
    const shared = dependents.length > 0 ? JOB_OUTCOMES.refusedSharedNetwork(name, dependents) : null;
    return parkedRefusal(name, summaries) ?? shared;
  }

  private async replace(
    name: string,
    details: ContainerDetails,
    specification: RecreateSpecification,
    mode: ReplaceMode,
    wording: ReplaceWording,
    steps: UpdateSteps = UNWATCHED,
    authorize?: () => Promise<boolean>,
  ): Promise<ActionResult> {
    const swapped = await this.swap(name, details, specification, mode, wording, steps, undefined, authorize);
    if (swapped.state !== "started") {
      return swapped.result;
    }
    return {
      succeeded: true,
      outcome: `${await this.finish(name, details, swapped.healthy, wording, steps)}${swapped.warning}`,
    };
  }

  /** Stops the container, keeps its data, sets it aside, then creates and starts the new one and checks it. */
  private async swap(
    name: string,
    details: ContainerDetails,
    specification: RecreateSpecification,
    mode: ReplaceMode,
    wording: ReplaceWording,
    steps: UpdateSteps,
    prepare?: () => Promise<void>,
    authorize?: () => Promise<boolean>,
  ): Promise<Swapped> {
    if (!(await this.authorizationGranted(authorize))) return { state: "back", result: failed(OPERATOR_REFUSAL) };
    const oldId = details.Id!;
    const parked = parkedNameOf(name);
    const wasRunning = details.State.Running === true;
    const starts = wasRunning || mode.startAlways;
    // How far it got, so a failure undoes exactly that.
    const progress: ReplaceProgress = { wasRunning, renamed: false, newId: null };
    let kept = "";
    let warning = "";
    try {
      if (wasRunning) {
        steps.enter(UPDATE_PHASE.stopping);
        await this.docker.stop(oldId, details.Config.StopTimeout ?? STOP_GRACE_SECONDS);
      }
      await prepare?.();
      // Its data as the old version left it, before the new one can change it.
      if (mode.keepData) {
        steps.enter(UPDATE_PHASE.keepingData);
        const taken =
          (await this.checkpoints?.take(name, details)) ?? unavailableCheckpoint(details, this.withoutCheckpoints);
        kept = taken.outcome;
        const complete =
          taken.complete && taken.containerId === details.Id && isDeepStrictEqual(taken.mounts, dataMountsOf(details));
        if (mode.requireCheckpoint) {
          if (!complete) {
            throw new Error(`${JOB_OUTCOMES.checkpointRequired}.${kept}`);
          }
          const verified = await this.checkpoints?.verify(name, details);
          if (verified?.problem != null) {
            throw new Error(verified.problem);
          }
        }
        warning = complete ? "" : kept;
      }
      steps.enter(UPDATE_PHASE.starting);
      await this.docker.rename(oldId, parked);
      progress.renamed = true;
      const newId = await this.docker.create(name, specification.create);
      progress.newId = newId;
      for (const [network, endpoint] of specification.extraNetworks) {
        await this.docker.connect(network, newId, endpoint);
      }
      // A stopped container is updated and left stopped, as it was; a repair starts it.
      if (starts) {
        await this.docker.start(newId);
      }
    } catch (error) {
      return { state: "back", result: await this.restore(name, oldId, progress, describeError(error), wording) };
    }
    const newId = progress.newId!;
    if (starts) {
      steps.enter(UPDATE_PHASE.checking);
    }
    const problem = starts ? await this.problemOf(newId) : null;
    if (problem !== null) {
      return { state: "aside", result: failed(`${wording.startedBadly(name, problem, parked)}${kept}`) };
    }
    const healthy = starts && (await this.docker.inspect(newId))?.State.Health !== undefined;
    return { state: "started", newId, healthy, warning };
  }

  // The new one holds: the old one goes, and nothing can roll back to it any more.
  private async finish(
    name: string,
    details: ContainerDetails,
    healthy: boolean,
    wording: ReplaceWording,
    steps: UpdateSteps,
  ) {
    steps.enter(UPDATE_PHASE.finishing);
    await this.docker.remove(details.Id!).catch(() => undefined);
    await this.checkpoints?.discard(name);
    return wording.finished(healthy);
  }

  private problemOf(containerId: string) {
    return untilSettled(
      (container) => this.docker.inspect(container),
      containerId,
      UPDATE_VERIFY,
      VERIFY_PROBLEMS,
      this.wait,
      this.clock,
    );
  }

  /**
   * A container others run inside the network of: they stop first, it is replaced as any container is, then each
   * is recreated on its own image inside the new one's network and checked. The old one goes only after them. If
   * the new one never ran, they start again on the old one; if it started badly, they wait for the roll back.
   */
  private async updateGroup(
    name: string,
    details: ContainerDetails,
    specification: RecreateSpecification,
    dependents: readonly ContainerDetails[],
    mode: ReplaceMode,
    wording: ReplaceWording,
    steps: UpdateSteps,
    authorize?: () => Promise<boolean>,
  ): Promise<ActionResult> {
    if (!(await this.authorizationGranted(authorize))) return failed(OPERATOR_REFUSAL);
    const running = dependents.filter((dependent) => dependent.State.Running === true);
    steps.enter(UPDATE_PHASE.stopping);
    const stopped: ContainerDetails[] = [];
    for (const dependent of running) {
      try {
        await this.docker.stop(dependent.Id!, dependent.Config.StopTimeout ?? STOP_GRACE_SECONDS);
        stopped.push(dependent);
      } catch (error) {
        // The provider is untouched. Restore only confirmed stops, by immutable ID, under the group lease.
        const restored: string[] = [];
        const failures: { name: string; id: string; error: string }[] = [];
        for (const member of stopped) {
          try {
            await this.docker.start(member.Id!);
            restored.push(nameOf(member));
          } catch (restoreError) {
            failures.push({ name: nameOf(member), id: member.Id!, error: describeError(restoreError) });
          }
        }
        const reason = describeError(error);
        return {
          succeeded: false,
          outcome: `${JOB_OUTCOMES.groupStopFailed(name, nameOf(dependent), reason)}${startedText(restored)}${failures
            .map((failure) => JOB_OUTCOMES.dependentRestartFailed(failure.name, failure.error))
            .join("")}`,
          // Retained in the existing job output/history, beyond the shorter outcome summary.
          output: JSON.stringify(
            {
              phase: "dependent-stop-failed",
              provider: { name, id: details.Id, changed: false },
              originallyRunning: running.map((member) => ({ name: nameOf(member), id: member.Id })),
              stopped: stopped.map((member) => ({ name: nameOf(member), id: member.Id })),
              stopNotConfirmed: { name: nameOf(dependent), id: dependent.Id, error: reason },
              restarted: restored,
              restartFailures: failures,
            },
            null,
            2,
          ),
        };
      }
    }
    const member = (container: ContainerDetails) => ({
      name: nameOf(container),
      id: container.Id!,
      running: container.State.Running === true,
    });
    const group: UpdateGroup = { version: 1, provider: member(details), dependents: dependents.map(member) };
    const prepared: string[] = [];
    const checkpointWarnings: string[] = [];
    // swap stops the provider before this callback, so every known group writer is quiescent.
    const prepare = async () => {
      steps.enter(UPDATE_PHASE.keepingData);
      for (const dependent of dependents) {
        const dependentName = nameOf(dependent);
        prepared.push(dependentName);
        const taken =
          (await this.checkpoints?.take(dependentName, dependent)) ??
          unavailableCheckpoint(dependent, this.withoutCheckpoints);
        if (
          mode.requireCheckpoint &&
          (!taken.complete ||
            taken.containerId !== dependent.Id ||
            !isDeepStrictEqual(taken.mounts, dataMountsOf(dependent)))
        ) {
          throw new Error(`${dependentName}: ${JOB_OUTCOMES.checkpointRequired}.${taken.outcome}`);
        }
        if (!taken.complete)
          checkpointWarnings.push(`${dependentName}: ${taken.outcome || JOB_OUTCOMES.checkpointRequired}`);
        if (mode.requireCheckpoint && this.checkpoints !== null) {
          const verified = await this.checkpoints.verify(dependentName, dependent);
          if (verified.problem !== null) throw new Error(`${dependentName}: ${verified.problem}`);
        }
      }
    };
    specification = {
      ...specification,
      create: {
        ...specification.create,
        Labels: {
          ...(specification.create.Labels as Record<string, string>),
          [UPDATE_GROUP_LABEL]: JSON.stringify(group),
        },
      },
    };
    const swapped = await this.swap(name, details, specification, mode, wording, steps, prepare);
    if (swapped.state === "back") {
      const started = await this.startEach(running);
      for (const dependentName of prepared) await this.checkpoints?.discard(dependentName);
      return failed(`${swapped.result.outcome}${startedText(started)}`);
    }
    if (swapped.state === "aside") {
      return {
        ...failed(`${swapped.result.outcome}${wording.dependentsStopped?.(dependents.map(nameOf)) ?? ""}`),
        output: JSON.stringify(group, null, 2),
      };
    }
    const recreated: string[] = [];
    const problems: string[] = [];
    for (const dependent of dependents) {
      const problem = await this.recreateDependent(dependent, swapped.newId);
      if (problem === null) {
        recreated.push(nameOf(dependent));
      } else {
        problems.push(problem);
      }
    }
    if (problems.length > 0) {
      return {
        succeeded: false,
        outcome: `${JOB_OUTCOMES.groupRetained(name)}${problems.join("")}${swapped.warning}${checkpointWarnings.join(" ")}`,
        output: JSON.stringify(group, null, 2),
      };
    }
    // Group commit: no original or checkpoint is discarded until every dependent verifies.
    for (const dependent of dependents) {
      await this.docker.remove(dependent.Id!).catch(() => undefined);
      await this.checkpoints?.discard(nameOf(dependent));
    }
    const finished = await this.finish(name, details, swapped.healthy, wording, steps);
    const recreatedText = recreated.length === 0 ? "" : JOB_OUTCOMES.groupRecreated(recreated);
    return {
      succeeded: true,
      outcome: `${finished}${recreatedText}${swapped.warning}${checkpointWarnings.join(" ")}`,
    };
  }

  /**
   * The same container on its own image, its network now the new provider's; checked as an updated one is. Its old
   * container stays aside, by its name, when the new one does not hold. Returns what went wrong, if anything.
   */
  private async recreateDependent(dependent: ContainerDetails, providerId: string): Promise<string | null> {
    const name = nameOf(dependent);
    const parked = parkedNameOf(name);
    const wasRunning = dependent.State.Running === true;
    const reference = dependent.Config.Image;
    try {
      const specification = recreateSpecification(
        dependent,
        configOf(await this.docker.inspectImage(reference)),
        reference,
      );
      const create: Record<string, unknown> = {
        ...specification.create,
        HostConfig: {
          ...(specification.create.HostConfig as HostConfiguration),
          NetworkMode: `${NETWORK_MODE_CONTAINER_PREFIX}${providerId}`,
        },
      };
      await this.docker.rename(dependent.Id!, parked);
      const newId = await this.docker.create(name, create);
      if (wasRunning) {
        await this.docker.start(newId);
      }
      const problem = wasRunning ? await this.problemOf(newId) : null;
      if (problem !== null) {
        return JOB_OUTCOMES.dependentFailed(name, problem, parked);
      }
    } catch (error) {
      return JOB_OUTCOMES.dependentNotRecreated(name, describeError(error), parked);
    }
    return null;
  }

  /**
   * The image the container ran before keeps a name, so going back by hand stays possible; the one
   * kept by the update before goes, unless a container still runs it. Returns the name it kept.
   */
  private async keepPrevious(details: ContainerDetails): Promise<string | null> {
    if (details.Image === undefined) {
      return null;
    }
    const kept = keptNameOf(details.Config.Image);
    const before = await this.docker.inspectImage(kept.reference);
    await this.docker.tag(details.Image, kept.repository, kept.tag);
    if (before !== null && before.Id !== details.Image) {
      await this.docker.removeImage(before.Id).catch(() => undefined);
    }
    return kept.reference;
  }

  // The new container never ran its application, so putting the old one back is safe, and its data needs no help.
  private async restore(
    name: string,
    oldId: string,
    progress: ReplaceProgress,
    error: string,
    wording: ReplaceWording,
  ) {
    try {
      if (progress.newId !== null) {
        await this.docker.remove(progress.newId);
      }
      if (progress.renamed) {
        await this.docker.rename(oldId, name);
      }
      if (progress.wasRunning) {
        await this.docker.start(oldId);
      }
    } catch {
      return failed(wording.restoreFailed(name, error, parkedNameOf(name)));
    }
    await this.checkpoints?.discard(name);
    return failed(wording.restoredAfterFailure(name, error));
  }
}

const configOf = (image: ImageDetails | null): Partial<ContainerConfig> => image?.Config ?? {};
