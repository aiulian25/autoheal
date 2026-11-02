import { createHmac } from "node:crypto";
import { RESTART_POLICY_NONE } from "../shared/constants.js";
import {
  STACK_DRIFT,
  STACK_DRIFT_FIELD,
  STACK_DRIFT_KIND,
  type StackDrift,
  type StackDriftService,
} from "../shared/stacks.js";
import type { ContainerDetails } from "./incident-report.js";
import { restartPolicyOf } from "./incident-report.js";

const COMPOSE_OWN_LABEL = "com.docker.compose.";
const ALL_ADDRESSES = new Set(["", "0.0.0.0", "::"]);
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;
const SERVICE_LABEL = `${COMPOSE_OWN_LABEL}service`;
const HASH_LABEL = `${COMPOSE_OWN_LABEL}config-hash`;
const ONE_OFF_LABEL = `${COMPOSE_OWN_LABEL}oneoff`;
const ONE_OFF_VALUE = "True";
const ON_FAILURE_WITH_RETRIES = "on-failure";
const DEFAULT_PROTOCOL = "tcp";
// Compose mounts a service's secrets here by itself: its files name them apart from its volumes.
const COMPOSE_SECRETS_FOLDER = "/run/secrets/";
const IMAGE_ID_PREFIX = "sha256:";

/** A service as Compose resolves it from its files, values and all: this stays on the host. */
export interface DeclaredService {
  image?: string;
  environment?: Record<string, string | null>;
  labels?: Record<string, string>;
  ports?: { target?: number; published?: string | number; protocol?: string; host_ip?: string }[];
  volumes?: { type?: string; source?: string; target?: string; read_only?: boolean }[];
  restart?: string;
  configs?: { target?: string }[];
  scale?: number;
  deploy?: { replicas?: number; restart_policy?: unknown };
}

export interface RunningMember {
  details: ContainerDetails;
  // Null once its image is gone from the host: what that image set can no longer be told from what was added to it, so
  // only what the files declare is compared.
  image: { environment: readonly string[]; labels: Readonly<Record<string, string>> } | null;
}

export interface StackToCompare {
  project: string;
  files: readonly string[];
  // Null when Compose could not read the files.
  declared: Readonly<Record<string, DeclaredService>> | null;
  hashes: ReadonlyMap<string, string>;
  members: readonly RunningMember[];
}

const literal = (value: string) => value.replaceAll("$$", "$");
const nameOf = (details: ContainerDetails) => details.Name.replace(/^\//, "");
const pairsOf = (entries: readonly string[]) =>
  new Map(
    entries.map((entry) => {
      const split = entry.indexOf("=");
      return split < 0 ? ([entry, ""] as const) : ([entry.slice(0, split), entry.slice(split + 1)] as const);
    }),
  );
const bounded = (names: readonly string[]) =>
  [...new Set(names)]
    .toSorted()
    .slice(0, STACK_DRIFT.names)
    .map((name) => name.slice(0, STACK_DRIFT.nameCharacters));

// Names only: what differs, never what it was or is. A value left to the shell (null) cannot be compared here.
function environmentDifferences(declared: DeclaredService, member: RunningMember) {
  const running = pairsOf(member.details.Config.Env ?? []);
  const wanted = declared.environment ?? {};
  const changed = Object.entries(wanted).filter(
    ([name, value]) => value !== null && running.get(name) !== literal(value),
  );
  if (member.image === null) return changed.map(([name]) => name);
  const fromImage = new Set(member.image.environment);
  const added = (member.details.Config.Env ?? []).filter((entry) => !fromImage.has(entry));
  const extra = [...pairsOf(added).keys()].filter((name) => !(name in wanted));
  return [...changed.map(([name]) => name), ...extra];
}

function labelDifferences(declared: DeclaredService, member: RunningMember) {
  const running = member.details.Config.Labels ?? {};
  const wanted = declared.labels ?? {};
  const own = (name: string) => name.startsWith(COMPOSE_OWN_LABEL);
  const changed = Object.entries(wanted).filter(([name, value]) => !own(name) && running[name] !== literal(value));
  if (member.image === null) return changed.map(([name]) => name);
  const fromImage = member.image.labels;
  const extra = Object.entries(running).filter(
    ([name, value]) => !own(name) && !(name in wanted) && fromImage[name] !== value,
  );
  return [...changed.map(([name]) => name), ...extra.map(([name]) => name)];
}

const portKey = (target: number, protocol: string, published: number, address: string) =>
  `${address}${address === "" ? "" : ":"}${published}:${target}/${protocol}`;

function portDifferences(declared: DeclaredService, details: ContainerDetails) {
  const running = Object.entries(details.HostConfig?.PortBindings ?? {}).flatMap(([key, bindings]) => {
    const [target = "", protocol = DEFAULT_PROTOCOL] = key.split("/");
    return (bindings ?? []).map((binding) => ({
      key: portKey(
        Number(target),
        protocol,
        Number(binding.HostPort),
        ALL_ADDRESSES.has(binding.HostIp ?? "") ? "" : binding.HostIp!,
      ),
      target: Number(target),
      protocol,
    }));
  });
  const wanted = (declared.ports ?? []).map((port) => {
    const address = ALL_ADDRESSES.has(port.host_ip ?? "") ? "" : port.host_ip!;
    const protocol = port.protocol ?? DEFAULT_PROTOCOL;
    // One given no port of its own takes any free one, so only its target can be compared.
    const fixed = port.published !== undefined && port.published !== "" && !Number.isNaN(Number(port.published));
    return {
      key: fixed ? portKey(port.target ?? 0, protocol, Number(port.published), address) : null,
      target: port.target ?? 0,
      protocol,
    };
  });
  const sameTarget = (one: { target: number; protocol: string }, other: { target: number; protocol: string }) =>
    one.target === other.target && one.protocol === other.protocol;
  const missing = wanted.filter((port) =>
    port.key === null ? !running.some((each) => sameTarget(each, port)) : !running.some(({ key }) => key === port.key),
  );
  const extra = running.filter(
    (port) => !wanted.some((each) => (each.key === null ? sameTarget(each, port) : each.key === port.key)),
  );
  return [...missing.map(({ target }) => String(target)), ...extra.map(({ target }) => String(target))];
}

// Where it is mounted names it, and is no secret. What Compose calls a volume is not what Docker does, so a volume is
// compared by where it goes alone; a folder by what it is too. A volume an image asks for has no place in its files.
function mountDifferences(declared: DeclaredService, details: ContainerDetails) {
  const running = (details.Mounts ?? []).filter(({ Type }) => Type === "bind" || Type === "volume");
  const wanted = (declared.volumes ?? []).filter(({ type }) => type === "bind" || type === "volume");
  const missing = wanted.filter(
    (mount) =>
      !running.some(
        (each) =>
          each.Destination === mount.target &&
          each.Type === mount.type &&
          (each.RW === false) === (mount.read_only ?? false) &&
          (mount.type === "volume" || each.Source === mount.source),
      ),
  );
  const configs = new Set((declared.configs ?? []).map(({ target }) => target));
  const extra = running.filter(
    (mount) =>
      !wanted.some(({ target }) => target === mount.Destination) &&
      !mount.Destination.startsWith(COMPOSE_SECRETS_FOLDER) &&
      !configs.has(mount.Destination) &&
      !(mount.Type === "volume" && ANONYMOUS_VOLUME.test(mount.Name ?? "")),
  );
  return [...missing.map(({ target }) => target ?? ""), ...extra.map(({ Destination }) => Destination)];
}

function restartDiffers(declared: DeclaredService, details: ContainerDetails) {
  // Swarm's own way of saying it is not one Docker carries over.
  if (declared.deploy?.restart_policy !== undefined) return false;
  const policy = restartPolicyOf(details);
  const retries = details.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0;
  const running = policy === ON_FAILURE_WITH_RETRIES && retries > 0 ? `${policy}:${retries}` : policy;
  return (declared.restart ?? RESTART_POLICY_NONE) !== running;
}

/** What differs between a service as its files say and its container as it is, by name. */
export function fieldsThatDiffer(declared: DeclaredService, member: RunningMember): StackDriftService["fields"] {
  const { details } = member;
  const lists = [
    { field: STACK_DRIFT_FIELD.environment, names: environmentDifferences(declared, member) },
    { field: STACK_DRIFT_FIELD.labels, names: labelDifferences(declared, member) },
    { field: STACK_DRIFT_FIELD.ports, names: portDifferences(declared, details) },
    { field: STACK_DRIFT_FIELD.mounts, names: mountDifferences(declared, details) },
  ];
  return [
    ...(imageDiffers(declared, details) ? [{ field: STACK_DRIFT_FIELD.image, names: [] }] : []),
    ...lists.filter(({ names }) => names.length > 0).map(({ field, names }) => ({ field, names: bounded(names) })),
    ...(restartDiffers(declared, details) ? [{ field: STACK_DRIFT_FIELD.restart, names: [] }] : []),
  ];
}

// One image by the names it can go by. A container made from an image's id says nothing of what name it came from.
const plainImage = (image: string) =>
  image
    .replace(/^(docker\.io|index\.docker\.io)\//, "")
    .replace(/^library\//, "")
    .replace(/:latest$/, "");
const imageDiffers = (declared: DeclaredService, details: ContainerDetails) =>
  declared.image !== undefined &&
  !details.Config.Image.startsWith(IMAGE_ID_PREFIX) &&
  plainImage(declared.image) !== plainImage(details.Config.Image);

const startsNothing = ({ scale, deploy }: DeclaredService) => (deploy?.replicas ?? scale) === 0;

function serviceDifferences(stack: StackToCompare, declared: Readonly<Record<string, DeclaredService>>) {
  const members = stack.members.filter(({ details }) => details.Config.Labels?.[ONE_OFF_LABEL] !== ONE_OFF_VALUE);
  const serviceOf = ({ details }: RunningMember) => details.Config.Labels?.[SERVICE_LABEL] ?? "";
  const found: StackDriftService[] = members.flatMap((member): StackDriftService[] => {
    const service = serviceOf(member);
    const container = nameOf(member.details);
    const wanted = declared[service];
    if (wanted === undefined) return [{ service, container, kind: STACK_DRIFT_KIND.extra, fields: [] }];
    const recorded = member.details.Config.Labels?.[HASH_LABEL];
    if (recorded === undefined) return [{ service, container, kind: STACK_DRIFT_KIND.unknown, fields: [] }];
    const fields = fieldsThatDiffer(wanted, member);
    if (stack.hashes.has(service) && stack.hashes.get(service) !== recorded) {
      return [{ service, container, kind: STACK_DRIFT_KIND.source, fields }];
    }
    return fields.length === 0 ? [] : [{ service, container, kind: STACK_DRIFT_KIND.runtime, fields }];
  });
  const present = new Set(members.map(serviceOf));
  const missing = Object.entries(declared)
    .filter(([service, wanted]) => !present.has(service) && !startsNothing(wanted))
    .map(([service]) => ({ service, container: null, kind: STACK_DRIFT_KIND.missing, fields: [] }));
  return [...found, ...missing].toSorted((one, other) => one.service.localeCompare(other.service));
}

// Whatever could change what a reconcile would do, values included, under a key that never leaves this runner: a
// changed value makes a review stale, and the result shows nothing that could be tested against a guess.
function revisionOf(stack: StackToCompare, key: Buffer) {
  const facts = {
    project: stack.project,
    declared: stack.declared,
    hashes: [...stack.hashes].toSorted(([one], [other]) => one.localeCompare(other)),
    members: stack.members
      .map(({ details }) => [details.Id, details.Config.Env, details.Config.Labels, details.HostConfig?.RestartPolicy])
      .toSorted(([one], [other]) => String(one).localeCompare(String(other))),
  };
  return createHmac("sha256", key).update(JSON.stringify(facts)).digest("hex");
}

/** A stack's differences, or null when it has none to report. */
export function driftOf(stack: StackToCompare, key: Buffer): StackDrift | null {
  const base = {
    project: stack.project,
    revision: revisionOf(stack, key),
    files: stack.files.slice(0, STACK_DRIFT.names),
  };
  if (stack.declared === null) return { ...base, unreadable: true, services: [] };
  const services = serviceDifferences(stack, stack.declared).slice(0, STACK_DRIFT.services);
  return services.length === 0 ? null : { ...base, unreadable: false, services };
}

/** The services a reconcile brings back in line. A leftover or an unknown one is left for a person. */
export const reconcilableServices = (drift: StackDrift) =>
  drift.services
    .filter(
      ({ kind }) =>
        kind === STACK_DRIFT_KIND.source || kind === STACK_DRIFT_KIND.runtime || kind === STACK_DRIFT_KIND.missing,
    )
    .map(({ service }) => service);
