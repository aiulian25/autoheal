import {
  COMPOSE_FILE,
  ENV_FILE,
  INSTALLED_LINE,
  composeOf,
  envLine,
  mountSourcesOf,
  type InstallSpec,
} from "../shared/install.js";

// Plain POSIX sh, for what a host has: busybox on a NAS as much as bash on Linux. Nothing here is ever a secret's
// value: those are made on the host as the .env is written.
export const shellQuoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const INSTALL_EXIT = { noCompose: 3, folderTaken: 4, folderChanged: 7, notOurs: 8 } as const;
export const COMPOSE_COMMANDS = { plugin: "docker compose", standalone: "docker-compose" } as const;

// A NAS keeps its tools outside what an SSH session's PATH has.
const PATH_LINE = 'PATH="$PATH:/usr/local/bin:/usr/syno/bin:/opt/bin"; export PATH';
const composeLine = [
  `if docker compose version >/dev/null 2>&1; then compose=${shellQuoted(COMPOSE_COMMANDS.plugin)}`,
  `elif command -v docker-compose >/dev/null 2>&1; then compose=${COMPOSE_COMMANDS.standalone}`,
  `else exit ${INSTALL_EXIT.noCompose}; fi`,
].join("\n");

export const COMPOSE_PREAMBLE = [PATH_LINE, composeLine].join("\n");

const composePath = (spec: Pick<InstallSpec, "folder">) => `${spec.folder}/${COMPOSE_FILE}`;
const sourcePath = (spec: InstallSpec, source: string) =>
  source.startsWith("./") ? `${spec.folder}/${source.slice(2)}` : source;

/** What only the host can say: which Compose it has, and whether the folder is free and can be made. */
export function checkScript(spec: Pick<InstallSpec, "folder" | "networks">): string {
  return [
    PATH_LINE,
    composeLine,
    `echo "compose=$compose"`,
    `[ -e ${shellQuoted(composePath(spec))} ] && echo taken=1`,
    // The nearest folder that is there is the one a new folder is made in.
    `place=${shellQuoted(spec.folder)}`,
    'while [ ! -e "$place" ] && [ "$place" != "/" ]; do place=$(dirname "$place"); done',
    '[ -w "$place" ] && echo writable=1',
    'echo "place=$place"',
    ...spec.networks.map(
      (network) => `docker network inspect ${shellQuoted(network)} >/dev/null 2>&1 || echo missing=${network}`,
    ),
    "exit 0",
  ].join("\n");
}

/** Writes its folder, data folders, Compose file and .env, refusing a folder that already holds an app. */
export function writeScript(spec: InstallSpec): string {
  const encoded = Buffer.from(composeOf(spec)).toString("base64");
  const folders = mountSourcesOf(spec).map((source) => sourcePath(spec, source));
  const quotedFolders = folders.map(shellQuoted).join(" ");
  return [
    "set -e",
    PATH_LINE,
    `dir=${shellQuoted(spec.folder)}`,
    `[ -e "$dir/${COMPOSE_FILE}" ] && exit ${INSTALL_EXIT.folderTaken}`,
    // Readable by the host's people, as their other app folders are: only the .env is kept to its owner.
    "umask 022",
    'mkdir -p "$dir"',
    "secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c \"$1\"; }",
    `(umask 077; : > "$dir/${ENV_FILE}")`,
    `chmod 600 "$dir/${ENV_FILE}"`,
    ...spec.environment.map((entry) => `printf '%s\\n' ${shellQuoted(envLine(entry))} >> "$dir/${ENV_FILE}"`),
    ...spec.secrets.map(
      (entry) => `printf '${entry.name}=%s\\n' "$(secret ${entry.characters})" >> "$dir/${ENV_FILE}"`,
    ),
    `printf %s ${shellQuoted(encoded)} | base64 -d > "$dir/${COMPOSE_FILE}"`,
    ...(folders.length === 0 ? [] : [`mkdir -p ${quotedFolders}`]),
    // Run as root, as a helper is: the files go to whoever keeps the folder they are in, so a person can read them,
    // and its data to whoever the app runs as.
    'if [ "$(id -u)" = 0 ]; then',
    `  keeper=$(stat -c '%u:%g' "$(dirname "$dir")")`,
    `  chown "$keeper" "$dir" "$dir/${COMPOSE_FILE}" "$dir/${ENV_FILE}"`,
    ...(folders.length === 0 ? [] : [`  chown ${spec.owner ?? '"$keeper"'} ${quotedFolders}`]),
    "fi",
  ].join("\n");
}

/** Starts what the files describe; its images are already here by then. */
export function upScript(folder: string): string {
  return ["set -e", PATH_LINE, composeLine, `cd ${shellQuoted(folder)}`, "$compose up -d"].join("\n");
}

/** Takes down what it started and its files, and its data folder only when asked. */
export function downScript(folder: string, removeData: boolean): string {
  const quoted = shellQuoted(folder);
  return [
    PATH_LINE,
    composeLine,
    `cd ${quoted} || exit 1`,
    // A label on a container can be set by others; only a Compose file Autoheal wrote says it installed the app.
    `grep -qF ${shellQuoted(INSTALLED_LINE)} ${COMPOSE_FILE} || exit ${INSTALL_EXIT.notOurs}`,
    removeData ? "$compose down -v" : "$compose down",
    "cd /",
    removeData ? `rm -rf ${quoted}` : `rm -f ${quoted}/${COMPOSE_FILE} ${quoted}/${ENV_FILE}`,
  ].join("\n");
}

/**
 * Has the host's own Compose read someone's file and say what it means, without starting anything: in a throwaway
 * folder, its variables filled in from the project's settings, and written as they are if one it requires has no value.
 */
export function parseComposeScript(text: string, settings: string | null = null): string {
  const encoded = Buffer.from(text).toString("base64");
  // An older Compose (Synology's 2.20) has no --no-env-resolution: it reads the file without it, as it can.
  const older = "docker compose -f compose.yml config --no-path-resolution --format json";
  const config = `${older} --no-env-resolution`;
  return [
    PATH_LINE,
    "work=$(mktemp -d) || exit 1",
    `trap 'rm -rf "$work"' EXIT`,
    'cd "$work" || exit 1',
    `printf %s ${shellQuoted(encoded)} | base64 -d > compose.yml`,
    ...(settings === null
      ? []
      : [`printf %s ${shellQuoted(Buffer.from(settings).toString("base64"))} | base64 -d > .env`]),
    `read=$(${config} 2>/dev/null) || read=$(${older} 2>/dev/null) || read=$(${config} --no-interpolate 2>/dev/null) || read=$(${older} --no-interpolate 2>&1)`,
    `printf %s "$read" | tr -d '\\n'`,
  ].join("\n");
}
