import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  COMPOSE_EDIT_PROBLEMS,
  COMPOSE_PROJECT_LABEL,
  JOB_ACTION,
  STACK_LIMITS,
  STACK_OUTCOMES,
  RESTART_POLICY_ALWAYS,
  RESTART_POLICY_UNLESS_STOPPED,
  UPDATE_VERIFY,
  VERIFY_PROBLEMS,
} from "../shared/constants.js";
import { isHostFolder } from "../shared/container-backups.js";
import { describeError } from "../shared/errors.js";
import { redactSecrets } from "../shared/redaction.js";
import {
  STACK_ASK,
  STACK_FILE_KIND,
  composeBuilds,
  envFilesNamedIn,
  STACK_DRIFT,
  type EditedStackFile,
  type StackAnswer,
  type StackDrift,
  type StackDriftReport,
  type StackCheck,
  type StackFile,
  type StackJobDetails,
  STACK_DATA_KEPT,
  type StackRemovalFacts,
  type StackRequest,
} from "../shared/stacks.js";
import type { ContainerSettings } from "../shared/protocol.js";
import {
  composeAgrees,
  definesService,
  editedCompose,
  isEmptyChange,
  settingsChange,
  type ResolvedService,
} from "./compose-edit.js";
import { settingsOf } from "./container-settings.js";
import type { ContainerSummary, DockerClient, ImageDetails } from "./docker-client.js";
import { restartPolicyOf, type ContainerDetails } from "./incident-report.js";
import type { HostScript } from "./installs.js";
import { COMPOSE_COMMANDS, shellQuoted } from "./install-script.js";
import { driftOf, reconcilableServices, type DeclaredService } from "./stack-drift.js";
import {
  EXIT_BLOCKED,
  JOURNAL_SEEN_LINE,
  PREVIOUS_SUFFIX,
  commitScript,
  journalPath,
  parseJournal,
  readJournalScript,
  recoveryScript,
  type StackCommit,
} from "./stack-transaction.js";
import { untilSettled } from "./settle-check.js";

export interface StacksDependencies {
  docker: Pick<DockerClient, "containerSummaries" | "networks" | "inspect" | "inspectImage">;
  hostScript: HostScript;
  imageExists: (image: string) => Promise<boolean | null>;
  settings: {
    containerAccess: boolean;
    hostDeploy: boolean;
    dryRun: boolean;
    protectedContainers: ReadonlySet<string>;
    selfContainerName: string;
  };
  wait: (milliseconds: number) => Promise<unknown>;
  clock: () => number;
}

const LABELS = {
  files: "com.docker.compose.project.config_files",
  folder: "com.docker.compose.project.working_dir",
  environment: "com.docker.compose.project.environment_file",
  service: "com.docker.compose.service",
  hash: "com.docker.compose.config-hash",
  oneOff: "com.docker.compose.oneoff",
} as const;
const ONE_OFF_VALUE = "True";
const EXITED_STATE = "exited";
const RESTARTS_WHATEVER_THE_EXIT: readonly string[] = [RESTART_POLICY_ALWAYS, RESTART_POLICY_UNLESS_STOPPED];
const READ_TIMEOUT_MILLISECONDS = 30_000;
const UP_TIMEOUT_MILLISECONDS = 10 * 60_000;
const QUICK_TIMEOUT_MILLISECONDS = 3 * 60_000;
const LOG_LINES = 200;
const DEFAULT_ENV_FILE = ".env";
const EXIT_NO_COMPOSE = 3;
const DRIFT_KEY_BYTES = 32;
const EXIT_FILES_MISSING = 4;
const BYTES_PER_KILOBYTE = 1024;
const OUTPUT_TAIL_CHARACTERS = 1_500;
const PATH_LINE = 'PATH="$PATH:/usr/local/bin:/usr/syno/bin:/opt/bin"; export PATH';
const COMPOSE_LINE = [
  `if docker compose version >/dev/null 2>&1; then compose=${shellQuoted(COMPOSE_COMMANDS.plugin)}`,
  `elif command -v docker-compose >/dev/null 2>&1; then compose=${COMPOSE_COMMANDS.standalone}`,
  `else exit ${EXIT_NO_COMPOSE}; fi`,
].join("\n");

const isOneOff = (container: ContainerSummary) => container.Labels?.[LABELS.oneOff] === ONE_OFF_VALUE;
// A setup step: ended well and stays ended, as a service meant to keep running would not.
const finishedItsWork = (details: ContainerDetails) =>
  details.State.Running !== true &&
  details.State.Status === EXITED_STATE &&
  details.State.ExitCode === 0 &&
  !RESTARTS_WHATEVER_THE_EXIT.includes(restartPolicyOf(details));
const nameOf = (container: ContainerSummary) => container.Names[0]?.replace(/^\//, "") ?? container.Id;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const tail = (output: string) => output.slice(-OUTPUT_TAIL_CHARACTERS).trim();
const isInside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
const withSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);
const overlap = (one: string, other: string) =>
  one === other || one.startsWith(withSlash(other)) || other.startsWith(withSlash(one));
const bindSources = (container: ContainerSummary) =>
  (container.Mounts ?? []).flatMap((mount) => (mount.Type === "bind" && mount.Source ? [mount.Source] : []));
const relativeTo = (folder: string, path: string) =>
  path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
const refused = (error: string): StackAnswer => ({ error });

/** How a lifecycle action on a whole stack went, as its job reports it. */
interface StackRun {
  succeeded: boolean;
  outcome: string;
  output: string | null;
}
const didNotRun = (outcome: string, output: string | null = null): StackRun => ({ succeeded: false, outcome, output });

interface Stack {
  project: string;
  folder: string;
  composeFiles: string[];
  environmentFile: string | null;
  members: ContainerSummary[];
}

// A marked block for each file, so what a shell prints around them is never taken for their contents.
function readFilesScript(mark: string, paths: readonly string[], folder: string | null = null): string {
  const lines = [`limit=${STACK_LIMITS.fileBytes}`];
  paths.forEach((path, index) => {
    const quoted = shellQuoted(path);
    lines.push(
      `echo "${mark} ${index} file"`,
      `if [ -f ${quoted} ]; then`,
      `  if [ "$(wc -c < ${quoted})" -gt "$limit" ]; then echo "${mark} ${index} big"; else base64 < ${quoted} | tr -d '\\n'; echo; fi`,
      `else echo "${mark} ${index} absent"; fi`,
      `[ -f ${shellQuoted(`${path}${PREVIOUS_SUFFIX}`)} ] && echo "${mark} ${index} previous"`,
    );
  });
  // Said alongside the first read, so that a read costs no extra trip to the host.
  if (folder !== null) lines.push(`[ -f ${shellQuoted(journalPath(folder))} ] && echo "${mark} ${JOURNAL_SEEN_LINE}"`);
  lines.push("exit 0");
  return lines.join("\n");
}

function parseFiles(mark: string, output: string) {
  const parsed = new Map<number, { text: string | null; big: boolean; hasPrevious: boolean; encoded: string[] }>();
  let current: number | null = null;
  for (const line of output.split("\n")) {
    if (!line.startsWith(`${mark} `)) {
      if (current !== null) parsed.get(current)!.encoded.push(line.trim());
      continue;
    }
    const [, indexText, what] = line.trim().split(" ");
    const index = Number(indexText);
    if (what === "file") {
      parsed.set(index, { text: "", big: false, hasPrevious: false, encoded: [] });
      current = index;
      continue;
    }
    const entry = parsed.get(index);
    if (entry === undefined) continue;
    if (what === "absent") entry.text = null;
    if (what === "big") entry.big = true;
    if (what === "previous") entry.hasPrevious = true;
    current = null;
  }
  for (const entry of parsed.values()) {
    if (entry.text !== null) entry.text = Buffer.from(entry.encoded.join(""), "base64").toString("utf8");
  }
  return parsed;
}

/** Written to its Compose file and recreated, whatever became of that; or left to be applied to the container alone. */
export type SettingsWrite =
  | { written: true; result: { succeeded: boolean; outcome: string; output?: string } }
  | { written: false; reason: string | null };

const NOT_THERE = /\b404\b|manifest unknown|not found/i;
const CONFIG_PATTERN = /^(\S+)\s+([0-9a-f]{16,})\s*$/;

/**
 * A stack's Compose file and settings, on the host, in the folder Compose itself says it started from. Nothing is
 * written without first reading as valid Compose and matching what was read; the last version is kept beside it.
 */
export class Stacks {
  // A second change while one is under way is refused, not queued: the asker may have given up by its turn.
  private readonly changing = new Set<string>();
  // Never leaves this runner: what a reported revision is keyed with.
  private readonly driftKey = randomBytes(DRIFT_KEY_BYTES);
  private driftReport: StackDriftReport | null = null;

  constructor(private readonly dependencies: StacksDependencies) {}

  private changeRefusal(stack: Stack): string | null {
    const { containerAccess, hostDeploy, dryRun, protectedContainers, selfContainerName } = this.dependencies.settings;
    if (!containerAccess) return STACK_OUTCOMES.accessOff;
    if (!hostDeploy) return STACK_OUTCOMES.deployOff;
    if (dryRun) return STACK_OUTCOMES.watching;
    const kept = stack.members.map(nameOf).find((name) => protectedContainers.has(name) || name === selfContainerName);
    return kept === undefined ? null : STACK_OUTCOMES.protectedMember(stack.project, kept);
  }

  /** One change to a stack's files at a time, on what an interrupted one left put right first. */
  private async whileChanging<Result>(
    stack: Stack,
    refuse: (reason: string) => Result,
    work: () => Promise<Result>,
  ): Promise<Result> {
    const refusal = this.changeRefusal(stack);
    if (refusal !== null) return refuse(refusal);
    if (this.changing.has(stack.project)) return refuse(STACK_OUTCOMES.beingChanged(stack.project));
    this.changing.add(stack.project);
    try {
      const unfinished = await this.recover(stack);
      return unfinished === null ? await work() : refuse(unfinished);
    } finally {
      this.changing.delete(stack.project);
    }
  }

  private async recover(stack: Stack): Promise<string | null> {
    const { hostScript } = this.dependencies;
    const mark = `AUTOHEAL-${randomUUID()}`;
    const journal = await hostScript(readJournalScript(stack.folder, mark), READ_TIMEOUT_MILLISECONDS);
    if (journal.exitCode !== 0) return STACK_OUTCOMES.unfinishedSave(tail(journal.output));
    const text = journal.output.split(`${mark}\n`)[1];
    if (text === undefined) return null;
    const isOurs = (path: string) =>
      !path.split("/").includes("..") &&
      (isInside(path, stack.folder) || stack.composeFiles.includes(path) || stack.environmentFile === path);
    const entries = parseJournal(text, isOurs);
    if (entries === null) return STACK_OUTCOMES.unfinishedSave(STACK_OUTCOMES.journalNotOurs);
    const recovered = await hostScript(recoveryScript(stack.folder, entries), READ_TIMEOUT_MILLISECONDS);
    return recovered.exitCode === 0 ? null : STACK_OUTCOMES.unfinishedSave(tail(recovered.output));
  }

  /** The last look at how stacks differ from their files; null where none could be taken. */
  currentDrift(): StackDriftReport | null {
    return this.driftReport;
  }

  /**
   * Every stack of this host compared with its files, by one script, so it costs one call however many there are.
   * It only reads. Passed over while a stack's files are being changed, when what they say is on its way to changing.
   * With container access off it looks at nothing, and says so, so what it said before does not stay on the dashboard.
   */
  async refreshDrift(): Promise<void> {
    if (!this.dependencies.settings.containerAccess) {
      this.driftReport = { checkedAt: this.dependencies.clock(), stacks: [] };
      return;
    }
    if (this.changing.size > 0) return;
    const projects = new Set(
      (await this.dependencies.docker.containerSummaries()).flatMap((container) => {
        const project = container.Labels?.[COMPOSE_PROJECT_LABEL];
        return project === undefined ? [] : [project];
      }),
    );
    const stacks: Stack[] = [];
    for (const project of [...projects].toSorted().slice(0, STACK_DRIFT.projects)) {
      const stack = await this.stackOf(project);
      if (stack !== null) stacks.push(stack);
    }
    const compared = await this.declaredBy(stacks);
    if (compared === null) return;
    const found = await Promise.all(stacks.map((stack, index) => this.driftFrom(stack, compared[index]!)));
    this.driftReport = { checkedAt: this.dependencies.clock(), stacks: found.flatMap((drift) => drift ?? []) };
  }

  // What Compose says of each stack now; null if the script itself did not run.
  private async declaredBy(stacks: readonly Stack[]) {
    const mark = `AUTOHEAL-${randomUUID()}`;
    const encoded = (index: number, what: string, command: string) => [
      `echo "${mark} ${index} ${what}"`,
      `${command} 2>/dev/null | base64 | tr -d '\\n'`,
      "echo",
    ];
    const script = [
      PATH_LINE,
      COMPOSE_LINE,
      ...stacks.flatMap((stack, index) => [
        ...encoded(index, "hashes", `$compose ${this.composeArguments(stack)} config --hash '*'`),
        ...encoded(index, "config", `$compose ${this.composeArguments(stack)} config --format json`),
      ]),
    ].join("\n");
    const ran = await this.dependencies.hostScript(script, STACK_DRIFT.scriptMilliseconds);
    if (ran.exitCode !== 0) return null;
    const lines = ran.output.split("\n");
    const after = (index: number, what: string) => {
      const at = lines.indexOf(`${mark} ${index} ${what}`);
      return at < 0 ? "" : (lines[at + 1] ?? "").trim();
    };
    return stacks.map((_, index) => {
      const hashes = new Map(
        Buffer.from(after(index, "hashes"), "base64")
          .toString("utf8")
          .split("\n")
          .flatMap((line) => {
            const match = CONFIG_PATTERN.exec(line.trim());
            return match === null ? [] : [[match[1]!, match[2]!] as const];
          }),
      );
      const { services } = parseConfig(after(index, "config"));
      return {
        hashes,
        declared: Object.keys(services).length === 0 ? null : (services as Record<string, DeclaredService>),
      };
    });
  }

  private async driftFrom(
    stack: Stack,
    { hashes, declared }: { hashes: ReadonlyMap<string, string>; declared: Record<string, DeclaredService> | null },
  ): Promise<StackDrift | null> {
    const { docker } = this.dependencies;
    const inspected = await Promise.all(stack.members.map(({ Id }) => docker.inspect(Id)));
    const members = await Promise.all(
      inspected
        .flatMap((details) => (details === null ? [] : [details]))
        .map(async (details) => {
          const image = details.Image === undefined ? null : await docker.inspectImage(details.Image);
          return {
            details,
            image: image === null ? null : { environment: image.Config?.Env ?? [], labels: image.Config?.Labels ?? {} },
          };
        }),
    );
    return driftOf(
      {
        project: stack.project,
        files: stack.composeFiles.map((path) => relativeTo(stack.folder, path)),
        declared,
        hashes,
        members,
      },
      this.driftKey,
    );
  }

  private async stackOf(project: string): Promise<Stack | null> {
    const members = (await this.dependencies.docker.containerSummaries()).filter(
      (container) => container.Labels?.[COMPOSE_PROJECT_LABEL] === project,
    );
    const labels = members[0]?.Labels ?? {};
    const folder = labels[LABELS.folder];
    const composeFiles = labels[LABELS.files]?.split(",").filter((path) => path !== "") ?? [];
    if (folder === undefined || composeFiles.length === 0) return null;
    const environmentFile = labels[LABELS.environment]?.split(",")[0] ?? null;
    return { project, folder, composeFiles, environmentFile, members };
  }

  private composeArguments(stack: Stack, overrides: ReadonlyMap<string, string> = new Map()) {
    const files = stack.composeFiles.flatMap((path) => ["-f", overrides.get(path) ?? shellQuoted(path)]);
    const environment = overrides.get(stack.environmentFile ?? `${stack.folder}/${DEFAULT_ENV_FILE}`);
    const known = stack.environmentFile === null ? [] : ["--env-file", shellQuoted(stack.environmentFile)];
    const envFile = environment === undefined ? known : ["--env-file", environment];
    return [
      "--project-directory",
      shellQuoted(stack.folder),
      "-p",
      shellQuoted(stack.project),
      ...files,
      ...envFile,
    ].join(" ");
  }

  /**
   * A command on the stack as `up` sees it. With its Compose files all gone it can still be reached by name, which then
   * means every container of the project; away from its folder, so no other file there is taken for it. With only some
   * gone, what is left would describe another stack, so nothing runs.
   */
  private lifecycleLine(stack: Stack, command: string, withFiles = ""): string {
    const quoted = stack.composeFiles.map(shellQuoted);
    const needed = stack.environmentFile === null ? quoted : [...quoted, shellQuoted(stack.environmentFile)];
    return [
      `if ${quoted.map((path) => `[ ! -f ${path} ]`).join(" && ")}; then`,
      `  cd /; $compose -p ${shellQuoted(stack.project)} ${command} 2>&1`,
      `elif ${needed.map((path) => `[ -f ${path} ]`).join(" && ")}; then`,
      `  $compose ${this.composeArguments(stack)} ${command}${withFiles} 2>&1`,
      "else",
      ...needed.map((path) => `  [ -f ${path} ] || echo ${path}`),
      `  exit ${EXIT_FILES_MISSING}`,
      "fi",
    ].join("\n");
  }

  private async read(stack: Stack, recovering = true): Promise<StackAnswer> {
    const { hostScript } = this.dependencies;
    const mark = `AUTOHEAL-${randomUUID()}`;
    const first = await hostScript(readFilesScript(mark, stack.composeFiles, stack.folder), READ_TIMEOUT_MILLISECONDS);
    // Nobody should open a mix of two versions. Within a change this is that change's own journal, or already handled.
    if (recovering && !this.changing.has(stack.project) && first.output.includes(`${mark} ${JOURNAL_SEEN_LINE}`)) {
      await this.whileChanging(
        stack,
        () => undefined,
        async () => undefined,
      );
      return this.read(stack, false);
    }
    if (first.exitCode !== 0) return refused(STACK_OUTCOMES.notRead(stack.project, tail(first.output)));
    const composes = parseFiles(mark, first.output);
    if ([...composes.values()].some((file) => file.big)) return refused(STACK_OUTCOMES.tooBig(stack.project));
    const composeTexts = stack.composeFiles.map((_, index) => composes.get(index)?.text ?? null);
    if (composeTexts.every((text) => text === null)) return refused(STACK_OUTCOMES.fileGone(stack.composeFiles[0]!));
    const named = composeTexts.flatMap((text) => (text === null ? [] : envFilesNamedIn(text)));
    const envPaths = [
      ...new Set([
        stack.environmentFile ?? `${stack.folder}/${DEFAULT_ENV_FILE}`,
        ...named.map((path) => `${stack.folder}/${path}`),
      ]),
    ].filter((path) => isInside(path, stack.folder));
    const second = await hostScript(readFilesScript(mark, envPaths), READ_TIMEOUT_MILLISECONDS);
    if (second.exitCode !== 0) return refused(STACK_OUTCOMES.notRead(stack.project, tail(second.output)));
    const envs = parseFiles(mark, second.output);
    const entry = (
      path: string,
      kind: StackFile["kind"],
      file: ReturnType<typeof parseFiles> extends Map<number, infer F> ? F | undefined : never,
    ): StackFile => ({
      path,
      kind,
      text: file?.text ?? null,
      hash: file?.text === null || file?.text === undefined ? null : hashOf(file.text),
      hasPrevious: file?.hasPrevious ?? false,
    });
    const files = [
      ...stack.composeFiles.map((path, index) => entry(path, STACK_FILE_KIND.compose, composes.get(index))),
      // Big settings files are left out rather than cut short.
      ...envPaths.flatMap((path, index) =>
        envs.get(index)?.big === true ? [] : [entry(path, STACK_FILE_KIND.env, envs.get(index))],
      ),
    ];
    return {
      error: null,
      files: {
        project: stack.project,
        folder: stack.folder,
        files,
        builds: composeTexts.some((text) => text !== null && composeBuilds(text)),
      },
    };
  }

  /** Has the host's own Compose read the edited files, without touching the real ones, and says what would change. */
  private async check(stack: Stack, edited: readonly EditedStackFile[]): Promise<StackCheck> {
    const { hostScript } = this.dependencies;
    const allowed = await this.allowedPaths(stack);
    const usable = edited.filter(({ path }) => allowed.has(path));
    const overrides = new Map(usable.map(({ path }, index) => [path, `"$work/${index}"`]));
    const writes = usable.map(
      ({ text }, index) =>
        `printf %s ${shellQuoted(Buffer.from(text).toString("base64"))} | base64 -d > "$work/${index}"`,
    );
    const mark = `AUTOHEAL-${randomUUID()}`;
    const script = [
      PATH_LINE,
      COMPOSE_LINE,
      "work=$(mktemp -d) || exit 1",
      `trap 'rm -rf "$work"' EXIT`,
      ...writes,
      `$compose ${this.composeArguments(stack, overrides)} config --hash '*' 2>&1 || exit 9`,
      `echo "${mark}"`,
      `$compose ${this.composeArguments(stack, overrides)} config --no-env-resolution --format json 2>/dev/null | base64 | tr -d '\\n'`,
    ].join("\n");
    const ran = await hostScript(script, READ_TIMEOUT_MILLISECONDS);
    const empty = { recreate: [], unchanged: [], added: [], removed: [], warnings: [] };
    if (ran.exitCode !== 0) {
      const named = usable.reduce(
        (output, { path }, index) =>
          output.replaceAll(new RegExp(`\\S*/${index}\\b`, "g"), relativeTo(stack.folder, path)),
        ran.output,
      );
      return { ...empty, problem: tail(named) || STACK_OUTCOMES.unreadable };
    }
    const [hashLines = "", encoded = ""] = ran.output.split(mark);
    const hashes = new Map(
      hashLines.split("\n").flatMap((line) => {
        const match = CONFIG_PATTERN.exec(line.trim());
        return match === null ? [] : [[match[1]!, match[2]!] as const];
      }),
    );
    const config = parseConfig(encoded);
    const envEdited = usable.some(({ path, text, hash }) => isEnvPath(stack, path) && hash !== hashOf(text));
    const members = stack.members.map((container) => ({
      name: nameOf(container),
      service: container.Labels?.[LABELS.service] ?? "",
      hash: container.Labels?.[LABELS.hash] ?? "",
      image: container.Image ?? "",
    }));
    const changed = members.filter(({ service, hash }) => {
      const wanted = hashes.get(service);
      if (wanted === undefined) return false;
      return wanted !== hash || (envEdited && (config.services[service]?.env_file?.length ?? 0) > 0);
    });
    const running = new Set(members.map(({ service }) => service));
    return {
      problem: null,
      recreate: changed.map(({ name }) => name),
      unchanged: members
        .filter((member) => hashes.has(member.service) && !changed.includes(member))
        .map(({ name }) => name),
      added: [...hashes.keys()].filter((service) => !running.has(service)),
      removed: members.filter(({ service }) => !hashes.has(service)).map(({ name }) => name),
      warnings: await this.warnings(stack, config, members),
    };
  }

  private async warnings(
    stack: Stack,
    config: ParsedConfig,
    members: readonly { service: string; image: string }[],
  ): Promise<string[]> {
    const warnings: string[] = [];
    const before = new Map(members.map(({ service, image }) => [service, image]));
    const newImages = new Set(
      Object.entries(config.services).flatMap(([service, { image }]) =>
        image === undefined || before.get(service) === image ? [] : [image],
      ),
    );
    for (const image of newImages) {
      if ((await this.dependencies.imageExists(image).catch(() => null)) === false) {
        warnings.push(STACK_OUTCOMES.imageNotFound(image));
      }
    }
    const others = (await this.dependencies.docker.containerSummaries()).filter(
      (container) => container.Labels?.[COMPOSE_PROJECT_LABEL] !== stack.project,
    );
    const published = new Map(
      others.flatMap((container) =>
        (container.Ports ?? []).flatMap((port) =>
          port.PublicPort === undefined ? [] : [[port.PublicPort, nameOf(container)] as const],
        ),
      ),
    );
    for (const { ports } of Object.values(config.services)) {
      for (const port of ports ?? []) {
        const taken = published.get(Number(port.published));
        if (taken !== undefined) warnings.push(STACK_OUTCOMES.portTaken(String(port.published), taken));
      }
    }
    return [...new Set(warnings)];
  }

  private async allowedPaths(stack: Stack): Promise<ReadonlySet<string>> {
    const read = await this.read(stack);
    const known = new Set((read.files?.files ?? []).map(({ path }) => path));
    known.add(stack.environmentFile ?? `${stack.folder}/${DEFAULT_ENV_FILE}`);
    return known;
  }

  /**
   * In place, with its owner and mode kept: its copy takes them first, then its new contents, then its name. A .env
   * that is new is readable only by its owner. Refused if the file changed since it was read, or would not read.
   */
  private async save(stack: Stack, edited: readonly EditedStackFile[]): Promise<StackAnswer> {
    const current = await this.read(stack);
    if (current.files == null) return refused(current.error ?? STACK_OUTCOMES.unreadable);
    for (const { path, hash } of edited) {
      const file = current.files.files.find((each) => each.path === path);
      if (file === undefined && !isEnvPath(stack, path)) return refused(STACK_OUTCOMES.notItsFile(path));
      if ((file?.hash ?? null) !== hash)
        return refused(STACK_OUTCOMES.changedMeanwhile(relativeTo(stack.folder, path)));
    }
    const check = await this.check(stack, edited);
    if (check.problem !== null) return refused(STACK_OUTCOMES.notSaved(check.problem));
    // Compose took its time, and someone at the host may have saved meanwhile.
    const latest = await this.read(stack);
    if (latest.files == null) return refused(latest.error ?? STACK_OUTCOMES.unreadable);
    const moved = edited.find(
      ({ path, hash }) => (latest.files?.files.find((file) => file.path === path)?.hash ?? null) !== hash,
    );
    if (moved !== undefined) return refused(STACK_OUTCOMES.changedMeanwhile(relativeTo(stack.folder, moved.path)));
    return this.commit(stack, {
      folder: stack.folder,
      writes: edited.map(({ path, text }) => ({ path, text })),
      forgetPrevious: latest.files.files
        .filter(({ path, hasPrevious }) => hasPrevious && !edited.some((each) => each.path === path))
        .map(({ path }) => path),
      keepPrevious: true,
    });
  }

  private async restore(stack: Stack): Promise<StackAnswer> {
    const read = await this.read(stack);
    const kept = (read.files?.files ?? []).filter((file) => file.hasPrevious);
    if (kept.length === 0) return refused(STACK_OUTCOMES.nothingKept);
    return this.commit(stack, {
      folder: stack.folder,
      writes: kept.map(({ path }) => ({ path, copyOf: `${path}${PREVIOUS_SUFFIX}` })),
      forgetPrevious: [],
      keepPrevious: false,
    });
  }

  private async commit(stack: Stack, commit: StackCommit): Promise<StackAnswer> {
    const written = await this.dependencies.hostScript(commitScript(commit), READ_TIMEOUT_MILLISECONDS);
    if (written.exitCode === EXIT_BLOCKED) return refused(STACK_OUTCOMES.unfinishedSave(tail(written.output)));
    if (written.exitCode !== 0) return refused(STACK_OUTCOMES.notWritten(tail(written.output)));
    return this.read(stack);
  }

  // Every container's last lines, in time order: a stack fails between its containers.
  private async logs(stack: Stack): Promise<StackAnswer> {
    const script = [
      PATH_LINE,
      COMPOSE_LINE,
      `$compose -p ${shellQuoted(stack.project)} logs --no-color --timestamps --tail=${LOG_LINES} 2>&1`,
    ].join("\n");
    const ran = await this.dependencies.hostScript(
      script.replace(" --no-log-prefix=false", ""),
      READ_TIMEOUT_MILLISECONDS,
    );
    const lines = ran.output.split("\n").filter((line) => line.trim() !== "");
    const time = (line: string) => /\d{4}-\d{2}-\d{2}T[\d:.]+/.exec(line)?.[0] ?? "";
    const ordered = lines.toSorted((first, second) => time(first).localeCompare(time(second)));
    return { error: null, logs: redactSecrets(ordered.join("\n")).slice(-STACK_LIMITS.logCharacters) };
  }

  // Where each path really is on the host, past any link; null where the host cannot say.
  private async canonicalPaths(paths: readonly string[]): Promise<Map<string, string | null>> {
    const lines = paths.map((path, index) => `echo "canonical ${index} $(readlink -f -- ${shellQuoted(path)})"`);
    const ran = await this.dependencies.hostScript([...lines, "exit 0"].join("\n"), READ_TIMEOUT_MILLISECONDS);
    const answers = new Map(
      [...ran.output.matchAll(/^canonical (\d+) (.*)$/gm)].map(([, index, path]) => [Number(index), path!.trim()]),
    );
    return new Map(paths.map((path, index) => [path, answers.get(index) || null]));
  }

  /**
   * Which of a stack's folders are verifiably its alone. Being inside its folder does not make one so: another
   * container, running or not, may mount it, or something in or above it, under any name a link gives it. Only what is
   * inside its folder once links are followed, with no one else near it, may go; what cannot be told stays.
   */
  private async ownedData(stack: Stack, inside: readonly string[]) {
    const members = new Set(stack.members.map(({ Id }) => Id));
    const others = (await this.dependencies.docker.containerSummaries()).filter(({ Id }) => !members.has(Id));
    const otherPaths = others.flatMap(bindSources);
    const where = await this.canonicalPaths([...new Set([stack.folder, ...inside, ...otherPaths])]);
    const folder = where.get(stack.folder) ?? null;
    const anyOtherUnknown = otherPaths.some((path) => where.get(path) === null);
    const usersOf = (path: string) =>
      others
        .filter((other) => bindSources(other).some((source) => overlap(where.get(source) ?? source, path)))
        .map(nameOf);
    const data: string[] = [];
    const kept: StackRemovalFacts["kept"] = [];
    for (const path of inside) {
      const real = where.get(path) ?? null;
      const usedBy = real === null ? [] : usersOf(real);
      if (real !== null && isHostFolder(real)) kept.push({ path, why: STACK_DATA_KEPT.host, usedBy });
      else if (usedBy.length > 0) kept.push({ path, why: STACK_DATA_KEPT.shared, usedBy });
      else if (real === null || folder === null || anyOtherUnknown || real === folder || !isInside(real, folder))
        kept.push({ path, why: STACK_DATA_KEPT.unresolved, usedBy });
      else data.push(real);
    }
    return { data: [...new Set(data)], kept };
  }

  private async removalFacts(stack: Stack): Promise<StackAnswer> {
    const networks = await this.dependencies.docker.networks();
    const on = new Set(stack.members.flatMap((container) => Object.keys(container.NetworkSettings?.Networks ?? {})));
    const own = networks.filter(({ Name, Labels }) => Labels?.[COMPOSE_PROJECT_LABEL] === stack.project && Name !== "");
    const ownNames = new Set(own.map(({ Name }) => Name));
    const sources = [...new Set(stack.members.flatMap(bindSources))];
    const inside = sources.filter((source) => isInside(source, stack.folder) && source !== stack.folder);
    const { data, kept } = await this.ownedData(stack, inside);
    const sizes = await this.dependencies.hostScript(
      [...data.map((path) => `du -sk ${shellQuoted(path)} 2>/dev/null`), "exit 0"].join("\n"),
      READ_TIMEOUT_MILLISECONDS,
    );
    const sizeOf = (path: string) => {
      const line = sizes.output.split("\n").find((each) => each.trim().endsWith(`\t${path}`));
      const kilobytes = line === undefined ? Number.NaN : Number.parseInt(line, 10);
      return Number.isNaN(kilobytes) ? null : kilobytes * BYTES_PER_KILOBYTE;
    };
    const facts: StackRemovalFacts = {
      containers: stack.members.map(nameOf),
      networks: [...ownNames],
      sharedNetworks: [...on].filter((name) => !ownNames.has(name)),
      data: data.map((path) => ({ path, sizeBytes: sizeOf(path) })),
      kept,
      outside: sources.filter((source) => !isInside(source, stack.folder)),
    };
    return { error: null, removal: facts };
  }

  async answer(request: StackRequest): Promise<StackAnswer> {
    try {
      if (!this.dependencies.settings.containerAccess) return refused(STACK_OUTCOMES.accessOff);
      const stack = await this.stackOf(request.project);
      if (stack === null) return refused(STACK_OUTCOMES.notCompose(request.project));
      if (request.kind === STACK_ASK.read) return await this.read(stack);
      if (request.kind === STACK_ASK.check) return { error: null, check: await this.check(stack, request.files) };
      if (request.kind === STACK_ASK.save) {
        return await this.whileChanging(stack, refused, () => this.save(stack, request.files));
      }
      if (request.kind === STACK_ASK.restore)
        return await this.whileChanging(stack, refused, () => this.restore(stack));
      if (request.kind === STACK_ASK.logs) return await this.logs(stack);
      return await this.removalFacts(stack);
    } catch (error) {
      return refused(describeError(error));
    }
  }

  private async resolvedService(stack: Stack, service: string): Promise<ResolvedService | undefined> {
    return (await this.resolvedConfig(stack)).services[service];
  }

  private async resolvedConfig(stack: Stack): Promise<ParsedConfig> {
    const mark = `AUTOHEAL-${randomUUID()}`;
    const script = [
      PATH_LINE,
      COMPOSE_LINE,
      `echo "${mark}"`,
      `$compose ${this.composeArguments(stack)} config --format json 2>/dev/null | base64 | tr -d '\\n'`,
    ].join("\n");
    const ran = await this.dependencies.hostScript(script, READ_TIMEOUT_MILLISECONDS);
    return parseConfig(ran.output.split(mark)[1] ?? "");
  }

  private serviceUp(stack: Stack, service: string, running: boolean) {
    const command = running ? "up -d" : "up --no-start";
    const script = [
      PATH_LINE,
      COMPOSE_LINE,
      `$compose ${this.composeArguments(stack)} ${command} --no-deps ${shellQuoted(service)} 2>&1`,
    ].join("\n");
    return this.dependencies.hostScript(script, UP_TIMEOUT_MILLISECONDS);
  }

  /**
   * A person's Edit settings, into the file the container comes from, so the next `up` keeps them: only what they
   * changed, and only this service recreated. A file that cannot take it safely is left as it was; one that was
   * written but did not work is put back, with the container brought back from it.
   */
  async applySettings(name: string, wanted: ContainerSettings): Promise<SettingsWrite> {
    const { docker } = this.dependencies;
    const details = await docker.inspect(name);
    const project = details?.Config.Labels?.[COMPOSE_PROJECT_LABEL];
    const service = details?.Config.Labels?.[LABELS.service];
    if (details === null || details === undefined || project === undefined || service === undefined) {
      return { written: false, reason: null };
    }
    const stack = await this.stackOf(project);
    if (stack === null) return { written: false, reason: STACK_OUTCOMES.notCompose(project) };
    return this.whileChanging(
      stack,
      (reason): SettingsWrite => ({ written: false, reason }),
      () => this.writeSettings(name, wanted, details, stack, service),
    );
  }

  private async writeSettings(
    name: string,
    wanted: ContainerSettings,
    details: ContainerDetails,
    stack: Stack,
    service: string,
  ): Promise<SettingsWrite> {
    const { docker } = this.dependencies;
    const { project } = stack;
    const image = details.Image === undefined ? null : await docker.inspectImage(details.Image);
    const change = settingsChange(settingsOf(details, image?.Config ?? {}), wanted);
    if (isEmptyChange(change)) return { written: false, reason: null };
    const read = await this.read(stack);
    if (read.files == null) return { written: false, reason: read.error ?? STACK_OUTCOMES.unreadable };
    const files = read.files.files;
    const compose = files.findLast(
      ({ kind, text }) => kind === STACK_FILE_KIND.compose && text !== null && definesService(text, service),
    );
    if (compose === undefined) {
      return { written: false, reason: COMPOSE_EDIT_PROBLEMS.serviceNotFound(service) };
    }
    const environmentPath = stack.environmentFile ?? `${stack.folder}/${DEFAULT_ENV_FILE}`;
    const edit = editedCompose({
      text: compose.text!,
      service,
      project,
      environmentPath,
      folder: stack.folder,
      envTexts: new Map(
        files.flatMap(({ kind, path, text }) => (kind === STACK_FILE_KIND.env ? [[path, text] as const] : [])),
      ),
      change,
    });
    if (edit.problem !== null) return { written: false, reason: edit.problem };
    const envEdits = [...edit.envTexts].map(([path, text]) => ({
      path,
      text,
      file: files.find((each) => each.path === path),
    }));
    // One read leaves out as too big must not be replaced by the little written here.
    if (envEdits.some(({ file }) => file === undefined)) {
      return { written: false, reason: STACK_OUTCOMES.tooBig(project) };
    }
    const edited: EditedStackFile[] = [
      ...(edit.text === compose.text ? [] : [{ path: compose.path, text: edit.text, hash: compose.hash }]),
      ...envEdits.map(({ path, text, file }) => ({ path, text, hash: file!.hash })),
    ];
    const saved = await this.save(stack, edited);
    if (saved.files == null) return { written: false, reason: saved.error ?? STACK_OUTCOMES.unreadable };
    if (!composeAgrees(await this.resolvedService(stack, service), change)) {
      await this.restore(stack);
      return { written: false, reason: COMPOSE_EDIT_PROBLEMS.disagrees };
    }
    const running = details.State.Running === true;
    const file = relativeTo(stack.folder, compose.path);
    const putBack = async () => {
      await this.restore(stack);
      await this.serviceUp(stack, service, running);
    };
    const ran = await this.serviceUp(stack, service, running);
    if (ran.exitCode !== 0) {
      await putBack();
      return {
        written: true,
        result: {
          succeeded: false,
          outcome: STACK_OUTCOMES.settingsNotApplied(name),
          output: redactSecrets(tail(ran.output)),
        },
      };
    }
    if (!running) {
      return { written: true, result: { succeeded: true, outcome: STACK_OUTCOMES.settingsWrittenStopped(name, file) } };
    }
    const problem = await this.settled(stack, service);
    if (problem !== null) {
      await putBack();
      return {
        written: true,
        result: { succeeded: false, outcome: STACK_OUTCOMES.settingsCameBackBadly(name, problem) },
      };
    }
    return { written: true, result: { succeeded: true, outcome: STACK_OUTCOMES.settingsWritten(name, file) } };
  }

  /**
   * Null once everything this change should have left is there and well; otherwise what is not. With a service, that
   * service alone; without one, every service Compose says the stack has now, and only those: a container of a service
   * since taken out of the file, or one `compose run` left, is not this change's doing.
   */
  private async settled(stack: Stack, service?: string): Promise<string | null> {
    const wanted = service === undefined ? await this.wantedServices(stack) : new Set([service]);
    if (wanted === null) return STACK_OUTCOMES.servicesUnknown;
    const members = (await this.stackOf(stack.project))?.members ?? [];
    const after = members.filter((each) => wanted.has(each.Labels?.[LABELS.service] ?? "") && !isOneOff(each));
    const present = new Set(after.map((each) => each.Labels?.[LABELS.service]));
    const missing = [...wanted].filter((name) => !present.has(name));
    if (missing.length > 0) return STACK_OUTCOMES.servicesMissing(missing);
    for (const container of after) {
      const problem = await this.problemWith(stack, container);
      if (problem !== null) return `${nameOf(container)}: ${problem}`;
    }
    return null;
  }

  private async problemWith(stack: Stack, container: ContainerSummary): Promise<string | null> {
    const { docker, wait, clock } = this.dependencies;
    const name = nameOf(container);
    const problem = await untilSettled(
      (each) => docker.inspect(each),
      name,
      UPDATE_VERIFY,
      VERIFY_PROBLEMS,
      wait,
      clock,
    );
    if (problem === null) return null;
    const service = container.Labels?.[LABELS.service];
    const upBefore = stack.members.some((each) => each.Labels?.[LABELS.service] === service && each.State !== "exited");
    const details = await docker.inspect(name);
    return !upBefore && details !== null && finishedItsWork(details) ? null : problem;
  }

  // What Compose would start now: it leaves out services behind a profile that is off. Null when it cannot say.
  private async wantedServices(stack: Stack): Promise<ReadonlySet<string> | null> {
    const services = Object.entries((await this.resolvedConfig(stack)).services);
    if (services.length === 0) return null;
    const startsNone = ({ scale, deploy }: (typeof services)[number][1]) => (deploy?.replicas ?? scale) === 0;
    return new Set(services.filter(([, resolved]) => !startsNone(resolved)).map(([name]) => name));
  }

  /** The members a job stops on purpose: Autoheal must not take that for a failure. */
  async membersOf(project: string): Promise<string[]> {
    return ((await this.stackOf(project))?.members ?? []).map(nameOf);
  }

  async run(action: string, details: StackJobDetails): Promise<StackRun> {
    const stack = await this.stackOf(details.project);
    if (stack === null) return didNotRun(STACK_OUTCOMES.notCompose(details.project));
    // Held for the whole of it, not only to start from files an interrupted save left whole: Compose reads those
    // files as it runs, and what it brought up is looked at afterwards, so a save waits its turn instead of cutting
    // in. Another project's is its own lock, and a body that throws or times out still gives this one up.
    return this.whileChanging(stack, didNotRun, () => this.lifecycle(action, details, stack));
  }

  private async lifecycle(action: string, details: StackJobDetails, stack: Stack): Promise<StackRun> {
    const reconciling = action === JOB_ACTION.stackUp ? details.reconcile : undefined;
    let reconciled: string[] = [];
    if (reconciling !== undefined) {
      const [compared] = (await this.declaredBy([stack])) ?? [];
      const drift = compared === undefined ? null : await this.driftFrom(stack, compared);
      // Compared afresh: what was reviewed may be gone or have changed, and the host's own say decides.
      if (drift === null || drift.revision !== reconciling.revision) {
        return didNotRun(STACK_OUTCOMES.driftChanged(stack.project));
      }
      reconciled = reconcilableServices(drift);
      if (reconciled.length === 0) return didNotRun(STACK_OUTCOMES.driftChanged(stack.project));
    }
    const named = reconciled.map(shellQuoted).join(" ");
    const command: Record<string, { line: string; timeout: number }> = {
      [JOB_ACTION.stackUp]: {
        line:
          reconciling === undefined
            ? `$compose ${this.composeArguments(stack)} up -d 2>&1`
            : `$compose ${this.composeArguments(stack)} up -d --force-recreate --no-deps ${named} 2>&1`,
        timeout: UP_TIMEOUT_MILLISECONDS,
      },
      [JOB_ACTION.stackRebuild]: {
        line: `$compose ${this.composeArguments(stack)} up -d --build 2>&1`,
        timeout: UP_TIMEOUT_MILLISECONDS,
      },
      [JOB_ACTION.stackStop]: { line: this.lifecycleLine(stack, "stop"), timeout: QUICK_TIMEOUT_MILLISECONDS },
      [JOB_ACTION.stackStart]: { line: this.lifecycleLine(stack, "start"), timeout: QUICK_TIMEOUT_MILLISECONDS },
      [JOB_ACTION.stackRemove]: {
        // Removing a stack takes every container of it, as by name, a service since taken out of its files included.
        line: this.lifecycleLine(stack, details.removeData ? "down -v" : "down", " --remove-orphans"),
        timeout: QUICK_TIMEOUT_MILLISECONDS,
      },
    };
    const chosen = command[action];
    if (chosen === undefined) return didNotRun(STACK_OUTCOMES.notCompose(details.project));
    const facts = action === JOB_ACTION.stackRemove && details.removeData ? await this.removalFacts(stack) : null;
    const dataLines = (facts?.removal?.data ?? []).map(({ path }) => `rm -rf ${shellQuoted(path)}`);
    const script = [
      PATH_LINE,
      COMPOSE_LINE,
      `cd ${shellQuoted(stack.folder)} 2>/dev/null || cd /`,
      chosen.line,
      ...(dataLines.length === 0 ? [] : ["code=$?", "[ $code -eq 0 ] || exit $code", ...dataLines]),
    ].join("\n");
    const ran = await this.dependencies.hostScript(script, chosen.timeout);
    const output = redactSecrets(tail(ran.output));
    if (ran.exitCode === EXIT_FILES_MISSING) return didNotRun(STACK_OUTCOMES.filesMissing(stack.project), output);
    if (ran.exitCode !== 0) return didNotRun(STACK_OUTCOMES.failed(stack.project), output);
    if (action === JOB_ACTION.stackUp || action === JOB_ACTION.stackRebuild) {
      const problem = await this.settled(stack);
      void this.refreshDrift().catch(() => undefined);
      if (problem !== null) return didNotRun(STACK_OUTCOMES.cameBackBadly(problem), output);
      const outcome =
        reconciling === undefined
          ? STACK_OUTCOMES.up(stack.project)
          : STACK_OUTCOMES.reconciled(stack.project, reconciled);
      return { succeeded: true, outcome, output };
    }
    const kept = (facts?.removal?.kept ?? []).map(({ path }) => path);
    const withDataOutcome =
      kept.length === 0
        ? STACK_OUTCOMES.removedWithData(stack.project)
        : STACK_OUTCOMES.removedKeepingData(stack.project, kept.join(", "));
    const removedOutcome = details.removeData ? withDataOutcome : STACK_OUTCOMES.removed(stack.project);
    const done: Record<string, string> = {
      [JOB_ACTION.stackStop]: STACK_OUTCOMES.stopped(stack.project),
      [JOB_ACTION.stackStart]: STACK_OUTCOMES.started(stack.project),
      [JOB_ACTION.stackRemove]: removedOutcome,
    };
    return { succeeded: true, outcome: done[action] ?? "", output: null };
  }
}

interface ParsedConfig {
  services: Record<
    string,
    ResolvedService & { image?: string; env_file?: unknown[]; scale?: number; deploy?: { replicas?: number } }
  >;
}

function parseConfig(encoded: string): ParsedConfig {
  try {
    const parsed = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8")) as Partial<ParsedConfig>;
    return { services: parsed.services ?? {} };
  } catch {
    return { services: {} };
  }
}

function isEnvPath(stack: Stack, path: string): boolean {
  return !stack.composeFiles.includes(path) && isInside(path, stack.folder);
}

/** Whether an image can be pulled, without pulling it: the host's copy counts, and null means it could not be told. */
export function imageExistsWith(
  inspectImage: (reference: string) => Promise<ImageDetails | null>,
  remoteDigest: (reference: string) => Promise<string | null>,
) {
  return async (image: string): Promise<boolean | null> => {
    if ((await inspectImage(image)) !== null) return true;
    try {
      return (await remoteDigest(image)) !== null;
    } catch (error) {
      return NOT_THERE.test(describeError(error)) ? false : null;
    }
  };
}
