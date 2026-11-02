import { dirname, join } from "node:path";
import {
  BYTES_PER_GIGABYTE,
  COMPOSE_IMPORT,
  HOST_DEPLOY_REFUSALS,
  INSTALL_OUTCOMES,
  INSTALL_TEXT,
  UPDATE_PHASE,
  UPDATE_VERIFY,
  VERIFY_PROBLEMS,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import type { OwnRun } from "../shared/own-compose.js";
import {
  INSTALL_LABEL,
  SECRET_CHARACTERS,
  slugOf,
  type ProjectPage,
  INSTALL_RECIPES,
  containerNamesOf,
  draftOf,
  imagesOf,
  isDeniedSource,
  type ImageFacts,
  type ProjectHints,
  type InstallAnswer,
  type InstallCheck,
  type InstallRequest,
  type InstallSpec,
} from "../shared/install.js";
import type { DockerClient } from "./docker-client.js";
import type { HostFiles } from "./host-files.js";
import { answerHostProfile } from "./host-profile.js";
import { INSTALL_EXIT, checkScript, downScript, parseComposeScript, upScript, writeScript } from "./install-script.js";
import { importCompose, type ComposeConfig } from "./compose-import.js";
import { readProjectFile, readProjectPage, readProjectSettings } from "./project-page.js";
import type { OwnCompose } from "./own-compose.js";
import { parseImageReference, type RegistryClient } from "./registry-client.js";
import { untilSettled } from "./settle-check.js";
import type { UpdateReport } from "./update-progress.js";

/** Runs a POSIX sh script on the host itself: as the SSH user over SSH, as root through a helper on a runner's host. */
export type HostScript = (
  script: string,
  timeoutMilliseconds: number,
) => Promise<{ exitCode: number | null; output: string }>;

export interface InstallsDependencies {
  docker: Pick<DockerClient, "inspect" | "inspectImage" | "containerSummaries" | "pull">;
  registry: Pick<RegistryClient, "facts">;
  files: Pick<HostFiles, "filesystem" | "system">;
  hostRoot: string;
  hostScript: HostScript;
  settings: { hostDeploy: boolean; containerAccess: boolean; dryRun: boolean };
  wait: (milliseconds: number) => Promise<unknown>;
  clock: () => number;
  fetchImplementation?: typeof fetch;
  own?: Pick<OwnCompose, "check" | "install">;
}

const CHECK_TIMEOUT_MILLISECONDS = 30_000;
const WRITE_TIMEOUT_MILLISECONDS = 60_000;
const UP_TIMEOUT_MILLISECONDS = 5 * 60_000;
const DOWN_TIMEOUT_MILLISECONDS = 3 * 60_000;
const LOW_DISK_BYTES = BYTES_PER_GIGABYTE;
// The kernel's name for a machine, and the registries'.
const OCI_ARCHITECTURES: Record<string, string> = {
  x86_64: "amd64",
  aarch64: "arm64",
  armv7l: "arm",
  armv6l: "arm",
  i686: "386",
};
const OUTPUT_CHARACTERS = 800;

const tail = (text: string) => text.trim().slice(-OUTPUT_CHARACTERS);

function factsOfLocal(config: NonNullable<Awaited<ReturnType<DockerClient["inspectImage"]>>>["Config"]): ImageFacts {
  return {
    ports: Object.keys(config?.ExposedPorts ?? {})
      .map((key) => Number(key.split("/")[0]))
      .filter((port) => Number.isInteger(port) && port > 0),
    volumes: Object.keys(config?.Volumes ?? {}),
    environment: (config?.Env ?? []).map((entry) => {
      const at = entry.indexOf("=");
      return at < 0 ? { name: entry, value: "" } : { name: entry.slice(0, at), value: entry.slice(at + 1) };
    }),
    user: config?.User ?? "",
  };
}

const EMPTY_FACTS: ImageFacts = { ports: [], volumes: [], environment: [], user: "" };

/** Puts a new app on the host as its other apps are: an ordinary Compose folder, secrets made on the host. */
export class Installs {
  constructor(private readonly dependencies: InstallsDependencies) {}

  private refusal(): string | null {
    const { hostDeploy, containerAccess, dryRun } = this.dependencies.settings;
    if (!hostDeploy) return HOST_DEPLOY_REFUSALS.off;
    if (!containerAccess) return HOST_DEPLOY_REFUSALS.accessOff;
    return dryRun ? HOST_DEPLOY_REFUSALS.dryRun : null;
  }

  async answer(request: InstallRequest): Promise<InstallAnswer> {
    const refusal = this.refusal();
    if (refusal !== null) return { error: refusal, draft: null, checks: [] };
    try {
      if (request.kind === "ownCheck") {
        const own = await this.dependencies.own?.check(request.files);
        return own === undefined
          ? { error: HOST_DEPLOY_REFUSALS.off, draft: null, checks: [] }
          : { error: null, draft: null, checks: [], own };
      }
      return request.kind === "draft"
        ? await this.draftFor(request)
        : { error: null, draft: null, checks: await this.checks(request.spec, null) };
    } catch (error) {
      return { error: describeError(error), draft: null, checks: [] };
    }
  }

  // Here already, it says all without a call to its registry; else its registry does, for this machine's type.
  private async factsOf(image: string): Promise<ImageFacts> {
    const { docker, registry, files } = this.dependencies;
    const local = await docker.inspectImage(image);
    if (local !== null) return factsOfLocal(local.Config);
    const reference = parseImageReference(image);
    if (reference === null) throw new Error(INSTALL_TEXT.badImage(image));
    const machine = (await files.system()).architecture;
    return registry.facts(reference, machine === null ? null : (OCI_ARCHITECTURES[machine] ?? machine));
  }

  // A project's page says what to run, or at least where to look; then it goes as any image does.
  private async draftFor(request: Extract<InstallRequest, { kind: "draft" }>): Promise<InstallAnswer> {
    const { image, recipe } = request;
    if (request.compose != null) return this.fromCompose(request.compose, {}, null);
    const address = request.project ?? null;
    if (address === null) return this.draft(image, recipe);
    const refused = (error: string): InstallAnswer => ({ error, draft: null, checks: [] });
    const { fetchImplementation } = this.dependencies;
    const page = await readProjectPage(address, fetchImplementation, request.composeFile ?? null);
    if (page.kind === "unknownSite") return refused(INSTALL_TEXT.unknownSite);
    if (page.kind === "composeOnly") return refused(INSTALL_TEXT.composeOnly);
    if (page.kind === "severalImages") return refused(INSTALL_TEXT.severalImages(page.images.join(", ")));
    if (page.kind === "found") return this.draft(page.hints.image, null, { address, hints: page.hints });
    if (page.kind === "compose") return this.fromCompose(page.text, page, address);
    for (const candidate of page.candidates) {
      const hints = { image: candidate, ports: [], volumes: [], environment: [], leftOut: [] };
      const found = await this.factsOf(candidate).catch(() => null);
      if (found !== null) return this.draft(candidate, null, { address, hints });
    }
    return refused(INSTALL_TEXT.noImageFound);
  }

  // Read by the host's own Compose, so it means what it will mean when it runs; then only known fields are taken.
  private async fromCompose(
    text: string,
    page: Partial<Extract<ProjectPage, { kind: "compose" }>>,
    address: string | null,
  ): Promise<InstallAnswer> {
    const refused = (error: string): InstallAnswer => ({ error, draft: null, checks: [] });
    const { docker, files, hostRoot, hostScript, settings, fetchImplementation } = this.dependencies;
    if (/^\s*(include|extends)\s*:/m.test(text)) return refused(COMPOSE_IMPORT.unsafe);
    const source =
      page.owner === undefined || page.name === undefined
        ? null
        : { owner: page.owner, name: page.name, folder: page.folder ?? "" };
    const projectSettings = source === null ? null : await readProjectSettings(source, fetchImplementation);
    const read = await hostScript(parseComposeScript(text, projectSettings), CHECK_TIMEOUT_MILLISECONDS);
    const start = read.output.indexOf("{");
    let config: ComposeConfig | null = null;
    try {
      config = read.exitCode === 0 && start >= 0 ? (JSON.parse(read.output.slice(start)) as ComposeConfig) : null;
    } catch {
      config = null;
    }
    if (config === null) return refused(COMPOSE_IMPORT.unreadable(tail(read.output)));
    const envNames = [
      ...new Set(
        Object.values(config.services ?? {}).flatMap((service) =>
          (service.env_file ?? []).flatMap((file) => (file.path === undefined ? [] : [file.path])),
        ),
      ),
    ];
    const envFiles: Record<string, string> = {};
    if (source !== null) {
      for (const name of envNames) {
        const content =
          name === COMPOSE_IMPORT.settingsFile
            ? projectSettings
            : await readProjectFile(source, name, fetchImplementation);
        if (content !== null) envFiles[name] = content;
      }
    }
    const profile = await answerHostProfile({ docker, files, hostRoot, containerAccess: settings.containerAccess });
    if (profile.profile === null) return refused(profile.error ?? INSTALL_TEXT.nothingAsked);
    const habit = profile.profile.user?.value.split(":");
    const imported = importCompose(
      config,
      envFiles,
      {
        timeZone: profile.profile.timeZone?.value ?? null,
        ids: habit === undefined ? null : { user: habit[0] ?? "", group: habit[1] ?? "" },
      },
      text,
    );
    if ("problem" in imported) return refused(imported.problem);
    const facts = { ports: imported.port === null ? [] : [imported.port], volumes: [], environment: [], user: "" };
    const base = draftOf(imported.mainImage, facts, profile.profile);
    const slug = page.name === undefined ? base.spec.slug : slugOf(page.name);
    const spec: InstallSpec = {
      ...base.spec,
      name: slug,
      slug,
      folder: `${profile.profile.composeFolder?.path ?? dirname(base.spec.folder)}/${slug}`,
      image: imported.mainImage,
      owner: null,
      mounts: imported.mounts,
      environment: [],
      secrets: imported.secrets.map((name) => ({ name, characters: SECRET_CHARACTERS.usual })),
      document: imported.document,
    };
    const draft = {
      ...base,
      spec,
      identity: { kind: "root" as const },
      baseUrlVariable: imported.addressVariable,
      project: {
        address: address ?? "",
        settings: [],
        leftOut: imported.leftOut,
        files: page.files ?? [],
        file: page.file ?? null,
        kept: imported.kept,
      },
    };
    return { error: null, draft, checks: await this.checks(spec, null) };
  }

  private async draft(
    image: string | null,
    recipeId: string | null,
    project?: { address: string; hints: ProjectHints },
  ): Promise<InstallAnswer> {
    const { docker, files, hostRoot, settings } = this.dependencies;
    const recipe = INSTALL_RECIPES.find((candidate) => candidate.id === recipeId);
    const wanted = recipe?.image ?? image;
    if (wanted === null) throw new Error(INSTALL_TEXT.nothingAsked);
    const profile = await answerHostProfile({ docker, files, hostRoot, containerAccess: settings.containerAccess });
    if (profile.profile === null) return { error: profile.error, draft: null, checks: [] };
    let facts = EMPTY_FACTS;
    let imageProblem: string | null = null;
    try {
      facts = await this.factsOf(wanted);
    } catch (error) {
      // Nothing to go on without a recipe: say why. A recipe still shows, its check saying what is wrong.
      if (recipe === undefined) return { error: describeError(error), draft: null, checks: [] };
      imageProblem = describeError(error);
    }
    const draft = draftOf(wanted, facts, profile.profile, recipe, project);
    return { error: null, draft, checks: await this.checks(draft.spec, imageProblem) };
  }

  private async checks(spec: InstallSpec, imageProblem: string | null): Promise<InstallCheck[]> {
    const { docker, files, hostRoot, hostScript } = this.dependencies;
    const text = INSTALL_TEXT.checks;
    const found = await hostScript(checkScript(spec), CHECK_TIMEOUT_MILLISECONDS);
    const said = new Map(
      found.output.split("\n").flatMap((line) => {
        const at = line.indexOf("=");
        return at < 0 ? [] : [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const];
      }),
    );
    const names = containerNamesOf(spec);
    const taken = (await Promise.all(names.map((name) => docker.inspect(name)))).some(
      (container) => container !== null,
    );
    const summaries = await docker.containerSummaries();
    const published = spec.port?.published ?? null;
    const portTaken =
      published !== null && summaries.some((summary) => summary.Ports?.some((port) => port.PublicPort === published));
    const denied = spec.mounts.find((mount) => isDeniedSource(mount.source));
    const place = said.get("place") ?? dirname(spec.folder);
    const available = (await files.filesystem(join(hostRoot, place)))?.availableBytes ?? null;
    const lowDisk = available !== null && available < LOW_DISK_BYTES;
    const compose = said.get("compose") ?? null;
    const noCompose = found.exitCode === INSTALL_EXIT.noCompose || compose === null;
    return [
      { key: "image", ok: imageProblem === null, detail: imageProblem ?? text.image },
      { key: "compose", ok: !noCompose, detail: noCompose ? text.noCompose : text.compose(compose) },
      {
        key: "folder",
        ok: said.get("taken") !== "1" && said.get("writable") === "1",
        detail:
          said.get("taken") === "1"
            ? text.folderTaken(spec.folder)
            : said.get("writable") === "1"
              ? text.folder
              : text.folderLocked(place),
      },
      { key: "name", ok: !taken, detail: taken ? text.nameTaken(names.join(", ")) : text.name },
      ...(spec.networks.length === 0
        ? []
        : [
            {
              key: "network" as const,
              ok: said.get("missing") === undefined,
              detail: said.get("missing") === undefined ? text.network : text.noNetwork(said.get("missing")!),
            },
          ]),
      ...(published === null
        ? []
        : [
            {
              key: "port" as const,
              ok: !portTaken,
              detail: portTaken ? text.portTaken(published) : text.port(published),
            },
          ]),
      { key: "disk", ok: !lowDisk, detail: lowDisk ? text.lowDisk : text.disk },
      {
        key: "mounts",
        ok: denied === undefined,
        detail: denied === undefined ? text.mounts : text.deniedMount(denied.source),
      },
    ];
  }

  async install(spec: InstallSpec, report: Pick<UpdateReport, "enter" | "pulled">): Promise<InstallResult> {
    const refusal = this.refusal();
    if (refusal !== null) return { succeeded: false, outcome: refusal, logsOf: null };
    const { docker, hostScript, wait, clock } = this.dependencies;
    const problems = (await this.checks(spec, null)).filter((check) => !check.ok);
    if (problems.length > 0) {
      return {
        succeeded: false,
        outcome: INSTALL_OUTCOMES.refused(spec.name, problems.map((check) => check.detail).join(" ")),
        logsOf: null,
      };
    }
    report.enter(UPDATE_PHASE.working);
    const written = await hostScript(writeScript(spec), WRITE_TIMEOUT_MILLISECONDS);
    if (written.exitCode !== 0) {
      return {
        succeeded: false,
        outcome: INSTALL_OUTCOMES.notWritten(spec.name, spec.folder, tail(written.output)),
        logsOf: null,
      };
    }
    report.enter(UPDATE_PHASE.pulling);
    // What the host already has is not fetched again: a newer one is for Updates to offer.
    for (const image of imagesOf(spec)) {
      if ((await docker.inspectImage(image)) === null) await docker.pull(image, (line) => report.pulled(line));
    }
    report.enter(UPDATE_PHASE.starting);
    const started = await hostScript(upScript(spec.folder), UP_TIMEOUT_MILLISECONDS);
    if (started.exitCode !== 0) {
      return {
        succeeded: false,
        outcome: INSTALL_OUTCOMES.notStarted(spec.name, tail(started.output)),
        logsOf: (await docker.inspect(spec.name)) === null ? null : spec.name,
      };
    }
    report.enter(UPDATE_PHASE.checking);
    const problem = await untilSettled(
      (name) => docker.inspect(name),
      spec.name,
      UPDATE_VERIFY,
      VERIFY_PROBLEMS,
      wait,
      clock,
    );
    return problem === null
      ? { succeeded: true, outcome: INSTALL_OUTCOMES.running(spec.name), logsOf: null }
      : { succeeded: false, outcome: INSTALL_OUTCOMES.startedBadly(spec.name, problem), logsOf: spec.name };
  }

  installOwn(own: OwnRun, report: Pick<UpdateReport, "enter" | "pulled">): Promise<InstallResult> {
    const refused: InstallResult = { succeeded: false, outcome: HOST_DEPLOY_REFUSALS.off, logsOf: null };
    return this.dependencies.own?.install(own, report) ?? Promise.resolve(refused);
  }

  /** Takes back what Autoheal installed, and nothing else: only a container carrying its label, in its own folder. */
  async uninstall(name: string, removeData: boolean): Promise<{ succeeded: boolean; outcome: string }> {
    const refusal = this.refusal();
    if (refusal !== null) return { succeeded: false, outcome: refusal };
    const { docker, hostScript } = this.dependencies;
    const labels = (await docker.inspect(name))?.Config.Labels ?? {};
    const folder = labels["com.docker.compose.project.working_dir"];
    if (labels[INSTALL_LABEL] === undefined || folder === undefined) {
      return { succeeded: false, outcome: INSTALL_OUTCOMES.notOurs(name) };
    }
    const taken = await hostScript(downScript(folder, removeData), DOWN_TIMEOUT_MILLISECONDS);
    if (taken.exitCode !== 0) {
      return { succeeded: false, outcome: INSTALL_OUTCOMES.notRemoved(name, tail(taken.output)) };
    }
    return {
      succeeded: true,
      outcome: removeData ? INSTALL_OUTCOMES.removedWithData(name) : INSTALL_OUTCOMES.removed(name, folder),
    };
  }
}

export interface InstallResult {
  succeeded: boolean;
  outcome: string;
  // Whose logs say what went wrong, where it got that far.
  logsOf: string | null;
}
