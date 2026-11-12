import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  HIGHEST_PORT,
  HOST_DEPLOY_REFUSALS,
  INSTALL_OUTCOMES,
  OWN_COMPOSE_TEXT,
  PORT_PROTOCOL,
  UPDATE_PHASE,
  UPDATE_VERIFY,
  VERIFY_PROBLEMS,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { hasBlockingIssue, issuesOfComposeError, lintOwnFiles, projectNameOf } from "../shared/compose-lint.js";
import { COMPOSE_FILE, ENV_FILE } from "../shared/install.js";
import {
  OWN_FILE,
  OWN_ISSUE_LEVEL,
  type OwnCheck,
  type OwnCheckRun,
  type OwnIssue,
  type OwnRetry,
  type OwnRun,
} from "../shared/own-compose.js";
import type { ContainerSummary, DockerClient } from "./docker-client.js";
import type { HostFiles } from "./host-files.js";
import { answerHostProfile } from "./host-profile.js";
import {
  checkScript,
  COMPOSE_PREAMBLE,
  FOLDER_IN_USE,
  INSTALL_EXIT,
  KEEPER_LINE,
  shellQuoted,
  upScript,
} from "./install-script.js";
import type { HostScript, InstallResult } from "./installs.js";
import { untilSettled } from "./settle-check.js";
import type { UpdateReport } from "./update-progress.js";

export interface OwnComposeDependencies {
  docker: Pick<DockerClient, "inspect" | "inspectImage" | "containerSummaries" | "pull" | "networks" | "allVolumes">;
  files: Pick<HostFiles, "filesystem" | "system">;
  hostRoot: string;
  hostScript: HostScript;
  imageExists: (image: string) => Promise<boolean | null>;
  settings: {
    hostDeploy: boolean;
    containerAccess: boolean;
    dryRun: boolean;
    selfContainerName: string;
    protectedContainers: ReadonlySet<string>;
  };
  maintenanceHeld: (name: string) => boolean;
  wait: (milliseconds: number) => Promise<unknown>;
  clock: () => number;
}

interface Service {
  image?: string;
  container_name?: string;
  ports?: { published?: string | number; target?: number; protocol?: string; host_ip?: string }[];
  volumes?: { type?: string; source?: string }[];
  networks?: Record<string, unknown>;
  build?: unknown;
}
// A published binding: two meet on the same port and transport, at the same address or where either takes them all.
interface Binding {
  protocol: string;
  address: string;
  port: number;
}
const EVERY_ADDRESS: ReadonlySet<string> = new Set(["", "0.0.0.0", "::"]);
const overlap = (one: Binding, other: Binding) =>
  one.port === other.port &&
  one.protocol === other.protocol &&
  (one.address === other.address || EVERY_ADDRESS.has(one.address) || EVERY_ADDRESS.has(other.address));

interface Config {
  name?: string;
  services?: Record<string, Service>;
  networks?: Record<string, { name?: string; external?: boolean }>;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}

const READ_TIMEOUT_MILLISECONDS = 30_000;
const WRITE_TIMEOUT_MILLISECONDS = 60_000;
const OUTPUT_CHARACTERS = 800;
const STANDIN_PROJECT = "own-compose";
const tail = (output: string) => output.trim().slice(-OUTPUT_CHARACTERS);
const encoded = (text: string) => shellQuoted(Buffer.from(text).toString("base64"));
const nameOf = (container: ContainerSummary) => container.Names[0]?.replace(/^\//, "") ?? container.Id;
const projectOf = (container: ContainerSummary) => container.Labels?.[COMPOSE_PROJECT_LABEL];
const isDefined = <Item>(item: Item | undefined): item is Item => item !== undefined;

// In a throwaway folder named as the real one, so Compose reads it under the name it will really have.
function readScript(mark: string, project: string, { compose, env }: Pick<OwnRun, "compose" | "env">): string {
  return [
    COMPOSE_PREAMBLE,
    "work=$(mktemp -d) || exit 1",
    `trap 'rm -rf "$work"' EXIT`,
    `mkdir "$work"/${shellQuoted(project)} && cd "$work"/${shellQuoted(project)} || exit 1`,
    `printf %s ${encoded(compose)} | base64 -d > ${COMPOSE_FILE}`,
    `printf %s ${encoded(env)} | base64 -d > ${ENV_FILE}`,
    `read=$($compose config --no-path-resolution --format json 2>"$work/said")`,
    "code=$?",
    `echo "${mark}"`,
    'printf %s "$read" | base64 | tr -d "\\n"',
    "echo",
    `echo "${mark}"`,
    `sed "s#$work/${project}/##g" "$work/said"`,
    `echo "${mark}"`,
    'echo "$code"',
    "exit 0",
  ].join("\n");
}

const SAME_MARK = "same=1";
const writtenAs = (file: string, expected: string) =>
  `[ "$(sha256sum "$dir/${file}" | cut -d' ' -f1)" = ${shellQuoted(expected)} ]`;
// A file that is not there is what an install that stopped early left. One that differs is someone's since then.
const stillAsWritten = (file: string, expected: string) => `[ ! -e "$dir/${file}" ] || ${writtenAs(file, expected)}`;
// What the failed install left: nothing at all, or its own Compose file as it wrote it (written right after its
// folder), with its settings as written or not yet there. A folder holding anything else is someone else's.
const folderAsWritten = ({ composeSha256, envSha256 }: OwnRetry) =>
  `! { ${FOLDER_IN_USE}; } || { [ ! -L "$dir" ] && [ -f "$dir/${COMPOSE_FILE}" ] && ${writtenAs(COMPOSE_FILE, composeSha256)} && { ${stillAsWritten(ENV_FILE, envSha256)}; }; }`;
const retryFolderScript = (folder: string, retry: OwnRetry) =>
  [`dir=${shellQuoted(folder)}`, `if ${folderAsWritten(retry)}; then echo ${SAME_MARK}; fi`].join("\n");

function writeOwnScript({ folder, compose, env, retry }: OwnRun, binds: readonly string[]): string {
  const quoted = binds.map((source) => shellQuoted(`${folder}/${source.slice(2)}`)).join(" ");
  return [
    "set -e",
    `dir=${shellQuoted(folder)}`,
    retry === null
      ? `if ${FOLDER_IN_USE}; then exit ${INSTALL_EXIT.folderTaken}; fi`
      : `{ ${folderAsWritten(retry)}; } || exit ${INSTALL_EXIT.folderChanged}`,
    "umask 022",
    'mkdir -p "$dir"',
    `printf %s ${encoded(compose)} | base64 -d > "$dir/${COMPOSE_FILE}"`,
    ...(env === ""
      ? []
      : [
          `(umask 077; : > "$dir/${ENV_FILE}")`,
          `chmod 600 "$dir/${ENV_FILE}"`,
          `printf %s ${encoded(env)} | base64 -d > "$dir/${ENV_FILE}"`,
        ]),
    // Made here, or Docker would make them for root and the app could not write to them.
    ...(binds.length === 0 ? [] : [`mkdir -p ${quoted}`]),
    'if [ "$(id -u)" = 0 ]; then',
    `  ${KEEPER_LINE}`,
    `  chown -h "$keeper" "$dir" "$dir/${COMPOSE_FILE}"`,
    ...(env === "" ? [] : [`  chown -h "$keeper" "$dir/${ENV_FILE}"`]),
    ...(binds.length === 0 ? [] : [`  chown -h "$keeper" ${quoted}`]),
    "fi",
  ].join("\n");
}

const relativeBinds = (config: Config) => [
  ...new Set(
    Object.values(config.services ?? {}).flatMap((service) =>
      (service.volumes ?? []).flatMap(({ type, source }) =>
        type === "bind" && source?.startsWith("./") && !source.split("/").includes("..") ? [source] : [],
      ),
    ),
  ),
];

const composeIssue = (line: number | null, message: string, level: OwnIssue["level"] = OWN_ISSUE_LEVEL.error) => ({
  level,
  file: OWN_FILE.compose,
  line,
  message,
  fix: null,
});

function linesWith(file: string, pattern: RegExp): number | null {
  const at = file.split("\n").findIndex((line) => !line.trim().startsWith("#") && pattern.test(line));
  return at < 0 ? null : at + 1;
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A person's own Compose file and .env: read by the host's own Compose as they type, then written to an ordinary
 * folder exactly as they are and started. Nothing about them is kept anywhere else, so any other tool can take over.
 */
export class OwnCompose {
  constructor(private readonly dependencies: OwnComposeDependencies) {}

  private refusal(): string | null {
    const { hostDeploy, containerAccess, dryRun } = this.dependencies.settings;
    if (!hostDeploy) return HOST_DEPLOY_REFUSALS.off;
    if (!containerAccess) return HOST_DEPLOY_REFUSALS.accessOff;
    return dryRun ? HOST_DEPLOY_REFUSALS.dryRun : null;
  }

  private async read(project: string, files: Pick<OwnRun, "compose" | "env">) {
    const mark = `AUTOHEAL-${randomUUID()}`;
    const ran = await this.dependencies.hostScript(readScript(mark, project, files), READ_TIMEOUT_MILLISECONDS);
    const [, json = "", said = "", code = "1"] = ran.output.split(mark);
    if (ran.exitCode !== 0 || code.trim() !== "0") return { config: null, said: said || ran.output };
    try {
      return { config: JSON.parse(Buffer.from(json.trim(), "base64").toString("utf8")) as Config, said };
    } catch {
      return { config: null, said };
    }
  }

  private async hostIssues(
    config: Config,
    files: Pick<OwnRun, "compose" | "env" | "retry">,
    project: string,
    folder: string | null,
  ): Promise<OwnIssue[]> {
    const { docker, hostScript, imageExists } = this.dependencies;
    const text = OWN_COMPOSE_TEXT;
    const issues: OwnIssue[] = [];
    const summaries = await docker.containerSummaries();
    // A retry's own are those of its project in its folder: no name alone makes another's app its own.
    const isOwn = (container: ContainerSummary) =>
      files.retry !== null &&
      folder !== null &&
      projectOf(container) === project &&
      container.Labels?.[COMPOSE_WORKING_DIR_LABEL] === folder;
    const others = summaries.filter((container) => !isOwn(container));
    issues.push(...this.ownMemberIssues(summaries.filter(isOwn)));
    const services = Object.entries(config.services ?? {});
    if (others.some((container) => projectOf(container) === project))
      issues.push(composeIssue(null, text.nameTaken(project)));
    if (folder !== null) {
      const found = await hostScript(checkScript({ folder, networks: [] }), READ_TIMEOUT_MILLISECONDS);
      if (found.exitCode === INSTALL_EXIT.noCompose) issues.push(composeIssue(null, text.noCompose));
      if (files.retry === null && /^taken=1$/m.test(found.output)) {
        issues.push(composeIssue(null, text.folderTaken(folder)));
      }
      if (files.retry !== null) {
        const same = await hostScript(retryFolderScript(folder, files.retry), READ_TIMEOUT_MILLISECONDS);
        if (!same.output.includes(SAME_MARK)) issues.push(composeIssue(null, text.folderChanged(folder)));
      }
      if (!/^writable=1$/m.test(found.output)) issues.push(composeIssue(null, text.folderLocked(folder)));
    }
    const published = others.flatMap((container) =>
      (container.Ports ?? []).flatMap((port) =>
        port.PublicPort === undefined
          ? []
          : [{ protocol: port.Type, address: port.IP ?? "", port: port.PublicPort, holder: nameOf(container) }],
      ),
    );
    const holderOf = (wanted: Binding) => published.find((binding) => overlap(binding, wanted))?.holder;
    for (const [, service] of services) {
      for (const { published: port, protocol = PORT_PROTOCOL.tcp, host_ip: address = "" } of service.ports ?? []) {
        const wanted = { protocol, address, port: Number(port) };
        const holder = holderOf(wanted);
        if (holder === undefined) continue;
        const number = wanted.port;
        const line = linesWith(files.compose, new RegExp(`(^|[^\\d])${number}:`));
        // The next port free for the same binding, and none past the last there is.
        let free = number + 1;
        while (free <= HIGHEST_PORT && holderOf({ ...wanted, port: free }) !== undefined) free += 1;
        const original = line === null ? null : files.compose.split("\n")[line - 1]!;
        issues.push({
          ...composeIssue(line, text.portTaken(number, holder)),
          fix:
            line === null || original === null || free > HIGHEST_PORT
              ? null
              : {
                  label: text.usePort(free),
                  lines: [
                    {
                      file: OWN_FILE.compose,
                      line,
                      text: original.replace(new RegExp(`(^|[^\\d])${number}:`), `$1${free}:`),
                    },
                  ],
                  env: [],
                },
        });
      }
    }
    const names = new Set(others.map(nameOf));
    for (const [, service] of services) {
      if (service.container_name !== undefined && names.has(service.container_name)) {
        const line = linesWith(files.compose, new RegExp(`container_name:\\s*["']?${escaped(service.container_name)}`));
        issues.push(composeIssue(line, text.containerTaken(service.container_name)));
      }
      if (service.image !== undefined && service.build === undefined) {
        const found = await imageExists(service.image).catch(() => null);
        if (found === false) {
          const line = linesWith(files.compose, new RegExp(`image:\\s*["']?${escaped(service.image)}`));
          issues.push(composeIssue(line, text.imageMissing(service.image)));
        }
      }
      if (service.build !== undefined) {
        const line = linesWith(files.compose, /^\s*build\s*:/);
        issues.push(composeIssue(line, text.builds, OWN_ISSUE_LEVEL.warning));
      }
    }
    const networks = new Set((await docker.networks()).map(({ Name }) => Name));
    for (const [key, network] of Object.entries(config.networks ?? {})) {
      const name = network.name ?? key;
      if (network.external === true && !networks.has(name)) {
        issues.push(
          composeIssue(linesWith(files.compose, new RegExp(`^\\s*"?${escaped(key)}"?:`)), text.networkMissing(name)),
        );
      }
    }
    const volumes = new Set((await docker.allVolumes()).map(({ Name }) => Name));
    for (const [key, volume] of Object.entries(config.volumes ?? {})) {
      const name = volume.name ?? key;
      if (volume.external === true && !volumes.has(name)) {
        issues.push(
          composeIssue(linesWith(files.compose, new RegExp(`^\\s*"?${escaped(key)}"?:`)), text.volumeMissing(name)),
        );
      }
    }
    return issues;
  }

  // What a retry would replace, looked at now. The same limits as any other change to a container.
  private ownMemberIssues(members: readonly ContainerSummary[]): OwnIssue[] {
    const { settings, maintenanceHeld } = this.dependencies;
    const text = OWN_COMPOSE_TEXT;
    return members.flatMap((container) => {
      const name = nameOf(container);
      if (name === settings.selfContainerName) return [composeIssue(null, text.memberIsSelf(name))];
      if (settings.protectedContainers.has(name)) return [composeIssue(null, text.memberProtected(name))];
      return maintenanceHeld(name) ? [composeIssue(null, text.memberHeld(name))] : [];
    });
  }

  private planOf(config: Config, project: string): NonNullable<OwnCheck["plan"]> {
    const services = Object.entries(config.services ?? {});
    const port = services
      .flatMap(([, service]) => service.ports ?? [])
      .map(({ published }) => Number(published))
      .find((number) => Number.isInteger(number) && number > 0);
    const made = <Item extends { name?: string; external?: boolean }>(group: Record<string, Item> | undefined) =>
      Object.entries(group ?? {})
        .filter(([, each]) => each.external !== true)
        .map(([key, each]) => each.name ?? `${project}_${key}`);
    return {
      project,
      containers: services.map(([name, service]) => service.container_name ?? `${project}-${name}-1`),
      networks: made(config.networks),
      volumes: made(config.volumes),
      port: port ?? null,
    };
  }

  /** What is wrong with these files on this host, and where, for the page to show as a person types. */
  async check(body: OwnCheckRun): Promise<OwnCheck> {
    const { docker, files, hostRoot, settings } = this.dependencies;
    const { profile } = await answerHostProfile({ docker, files, hostRoot, containerAccess: settings.containerAccess });
    const parent = body.folder === null ? (profile?.composeFolder?.path ?? null) : dirname(body.folder);
    const parentProjects = profile?.composeFolder?.projects ?? null;
    const project = body.folder === null ? STANDIN_PROJECT : projectNameOf(body.folder) || STANDIN_PROJECT;
    const { config, said } = await this.read(project, body);
    if (config === null) {
      return { readable: false, issues: issuesOfComposeError(said, body.compose), parent, parentProjects, plan: null };
    }
    const named = config.name ?? project;
    return {
      readable: true,
      issues: await this.hostIssues(config, body, named, body.folder),
      parent,
      parentProjects,
      plan: this.planOf(config, named),
    };
  }

  async install(own: OwnRun, report: Pick<UpdateReport, "enter" | "pulled">): Promise<InstallResult> {
    const refused = this.refusal();
    const name = projectNameOf(own.folder);
    if (refused !== null) return { succeeded: false, outcome: refused, logsOf: null };
    const { docker, hostScript, wait, clock } = this.dependencies;
    const { config, said } = await this.read(name, own);
    const issues =
      config === null
        ? issuesOfComposeError(said, own.compose)
        : [
            ...(await this.hostIssues(config, own, config.name ?? name, own.folder)),
            ...lintOwnFiles(own.compose, own.env),
          ];
    if (config === null || hasBlockingIssue(issues)) {
      const reasons = issues.filter(({ level }) => level === OWN_ISSUE_LEVEL.error).map(({ message }) => message);
      return { succeeded: false, outcome: INSTALL_OUTCOMES.refused(name, reasons.join(" ")), logsOf: null };
    }
    report.enter(UPDATE_PHASE.working);
    const written = await hostScript(writeOwnScript(own, relativeBinds(config)), WRITE_TIMEOUT_MILLISECONDS);
    if (written.exitCode === INSTALL_EXIT.folderChanged) {
      const reason = OWN_COMPOSE_TEXT.folderChanged(own.folder);
      return { succeeded: false, outcome: INSTALL_OUTCOMES.refused(name, reason), logsOf: null };
    }
    if (written.exitCode !== 0) {
      return {
        succeeded: false,
        outcome: INSTALL_OUTCOMES.notWritten(name, own.folder, tail(written.output)),
        logsOf: null,
      };
    }
    report.enter(UPDATE_PHASE.pulling);
    try {
      const images = Object.values(config.services ?? {})
        .filter(({ build }) => build === undefined)
        .map(({ image }) => image)
        .filter(isDefined);
      for (const image of new Set(images)) {
        if ((await docker.inspectImage(image)) === null) await docker.pull(image, (line) => report.pulled(line));
      }
    } catch (error) {
      return { succeeded: false, outcome: INSTALL_OUTCOMES.notStarted(name, describeError(error)), logsOf: null };
    }
    report.enter(UPDATE_PHASE.starting);
    const started = await hostScript(upScript(own.folder), this.upTimeout);
    if (started.exitCode !== 0) {
      return { succeeded: false, outcome: INSTALL_OUTCOMES.notStarted(name, tail(started.output)), logsOf: null };
    }
    report.enter(UPDATE_PHASE.checking);
    const project = config.name ?? name;
    const members = (await docker.containerSummaries()).filter((container) => projectOf(container) === project);
    for (const container of members) {
      const member = nameOf(container);
      const details = await docker.inspect(member);
      // What ran once and finished, such as a setup step, is not a failure; what stopped with an error is.
      if (container.State === "exited") {
        if ((details?.State.ExitCode ?? 0) === 0) continue;
        return {
          succeeded: false,
          outcome: INSTALL_OUTCOMES.startedBadly(member, OWN_COMPOSE_TEXT.exited),
          logsOf: member,
        };
      }
      const problem = await untilSettled(
        (each) => docker.inspect(each),
        member,
        UPDATE_VERIFY,
        VERIFY_PROBLEMS,
        wait,
        clock,
      );
      if (problem !== null)
        return { succeeded: false, outcome: INSTALL_OUTCOMES.startedBadly(member, problem), logsOf: member };
    }
    return { succeeded: true, outcome: INSTALL_OUTCOMES.running(name), logsOf: null };
  }

  private readonly upTimeout = 10 * 60_000;
}
