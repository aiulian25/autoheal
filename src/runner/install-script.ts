import {
  COMPOSE_FILE,
  CONTAINER_NAME_KEY,
  ENV_FILE,
  INSTALLED_LINE,
  OWNED_FOLDER,
  composeOf,
  envLine,
  mountSourcesOf,
  type InstallSpec,
} from "../shared/install.js";

// Plain POSIX sh, for what a host has: busybox on a NAS as much as bash on Linux. Nothing here is ever a secret's
// value: those are made on the host as the .env is written.
export const shellQuoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const INSTALL_EXIT = {
  noCompose: 3,
  folderTaken: 4,
  folderChanged: 7,
  notOurs: 8,
  notItsFolder: 9,
  notTakenDown: 10,
  folderKept: 11,
} as const;

// A folder holding anything at all, a link, or a path that is no folder: someone's, so a first install keeps out. An
// empty one may be used, as one made a moment ago for it is; a link would send what is written here elsewhere.
export const FOLDER_IN_USE = '[ -L "$dir" ] || { [ -e "$dir" ] && { [ ! -d "$dir" ] || [ -n "$(ls -A "$dir")" ]; }; }';
// Run as root, as a helper is: whoever really keeps the folder above, through any link to it, keeps the app's files.
export const KEEPER_LINE = `keeper=$(stat -L -c '%u:%g' "$(dirname "$dir")")`;
export const COMPOSE_COMMANDS = { plugin: "docker compose", standalone: "docker-compose" } as const;

// A NAS keeps its tools outside what an SSH session's PATH has.
const PATH_LINE = 'PATH="$PATH:/usr/local/bin:/usr/syno/bin:/opt/bin"; export PATH';
const composeLine = [
  `if docker compose version >/dev/null 2>&1; then compose=${shellQuoted(COMPOSE_COMMANDS.plugin)}`,
  `elif command -v docker-compose >/dev/null 2>&1; then compose=${COMPOSE_COMMANDS.standalone}`,
  `else exit ${INSTALL_EXIT.noCompose}; fi`,
].join("\n");

export const COMPOSE_PREAMBLE = [PATH_LINE, composeLine].join("\n");

const sourcePath = (spec: InstallSpec, source: string) =>
  source.startsWith("./") ? `${spec.folder}/${source.slice(2)}` : source;

/** What only the host can say: which Compose it has, and whether the folder is free and can be made. */
export function checkScript(spec: Pick<InstallSpec, "folder" | "networks">): string {
  return [
    PATH_LINE,
    composeLine,
    `echo "compose=$compose"`,
    `dir=${shellQuoted(spec.folder)}`,
    `if ${FOLDER_IN_USE}; then echo taken=1; fi`,
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

/**
 * Writes its folder, data folders, Compose file and .env, refusing a folder that already holds anything, and marks
 * the folder as all the app's.
 */
export function writeScript(spec: InstallSpec): string {
  const encoded = Buffer.from(composeOf(spec)).toString("base64");
  const folders = mountSourcesOf(spec).map((source) => shellQuoted(sourcePath(spec, source)));
  const quotedFolders = folders.join(" ");
  const dataOwner = spec.owner ?? '"$keeper"';
  return [
    "set -e",
    PATH_LINE,
    `dir=${shellQuoted(spec.folder)}`,
    `if ${FOLDER_IN_USE}; then exit ${INSTALL_EXIT.folderTaken}; fi`,
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
    `printf '%s\\n' ${shellQuoted(OWNED_FOLDER.text)} > "$dir/${OWNED_FOLDER.file}"`,
    // A data folder already there is someone's, and may be reached through a link: only one made here is handed over.
    ...folders.map((folder, index) => `made${index}=; [ -e ${folder} ] || [ -L ${folder} ] || made${index}=1`),
    ...(folders.length === 0 ? [] : [`mkdir -p ${quotedFolders}`]),
    // The files go to whoever keeps the folder they are in, so a person can read them, and its data to whoever the app
    // runs as. Never through a link.
    'if [ "$(id -u)" = 0 ]; then',
    `  ${KEEPER_LINE}`,
    `  chown -h "$keeper" "$dir" "$dir/${COMPOSE_FILE}" "$dir/${ENV_FILE}" "$dir/${OWNED_FOLDER.file}"`,
    ...folders.map((folder, index) => `  [ -z "$made${index}" ] || chown -h ${dataOwner} ${folder}`),
    "fi",
  ].join("\n");
}

/** Starts what the files describe; its images are already here by then. */
export function upScript(folder: string): string {
  return ["set -e", PATH_LINE, composeLine, `cd ${shellQuoted(folder)}`, "$compose up -d"].join("\n");
}

// A file a person re-indented or saved on Windows still names its containers: lines are compared without their
// indentation, trailing spaces or line ending.
const TRIMMED_LINES = "sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'";
// The whole line naming this container, in either quotes or none; matched as text, so a name is never a pattern.
const namingLines = (name: string) =>
  [JSON.stringify(name), `'${name}'`, name]
    .map((value) => `-e ${shellQuoted(`${CONTAINER_NAME_KEY}: ${value}`)}`)
    .join(" ");

/**
 * Takes down what it started and its files, and its data folder only when asked and only where the folder is marked
 * as all the app's. An older install's folder, from before the mark, keeps what is in it.
 */
export function downScript(folder: string, name: string, removeData: boolean): string {
  const quoted = shellQuoted(folder);
  const files = `${quoted}/${COMPOSE_FILE} ${quoted}/${ENV_FILE}`;
  const owned = `${quoted}/${OWNED_FOLDER.file}`;
  const removal = removeData
    ? `if [ -f ${owned} ]; then rm -rf ${quoted}; else rm -f ${files}; exit ${INSTALL_EXIT.folderKept}; fi`
    : `rm -f ${files} ${owned}`;
  return [
    PATH_LINE,
    composeLine,
    `cd ${quoted} || exit 1`,
    // A label on a container can be set by others; only a Compose file Autoheal wrote says it installed the app,
    // and only one that names this container says the folder is its own, not another app's it was pointed at.
    `grep -qF ${shellQuoted(INSTALLED_LINE)} ${COMPOSE_FILE} || exit ${INSTALL_EXIT.notOurs}`,
    `${TRIMMED_LINES} ${COMPOSE_FILE} | grep -qxF ${namingLines(name)} || exit ${INSTALL_EXIT.notItsFolder}`,
    // Nothing goes unless Compose took the app down: its files are what anyone needs to take down what still runs.
    `${removeData ? "$compose down -v" : "$compose down"} || exit ${INSTALL_EXIT.notTakenDown}`,
    "cd /",
    removal,
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
