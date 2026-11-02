import { COMPOSE_IMPORT, DOCKER_RUN_FLAGS, PROJECT_PAGE } from "../shared/constants.js";
import { imageFromAddress, isValidImage, projectOf, type ProjectHints, type ProjectPage } from "../shared/install.js";

// A stranger's README is data, nothing more: read for what it names, each piece checked, never run. Its host paths
// are not taken, and neither is anything that gives a container power over its host; what was left out is said.
const CONTINUED_LINE = /\\\r?\n\s*/g;
const DOCKER_RUN = /^\s*(?:\$\s*|sudo\s+)*docker\s+run\s+(.+)$/gm;
const COMPOSE_IMAGE = /^\s*-?\s*image:\s*["']?([^\s"'#]+)/gm;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USABLE_VALUE = /^[^\n\r'\0$`<>{}]{0,256}$/;
const IDS_AND_ZONE = new Set(["PUID", "PGID", "TZ"]);
const SOCKET = "docker.sock";

function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

const unquotedColon = (value: string) => value.split(":");

function addFlag(hints: ProjectHints, flag: string, value: string) {
  if (flag === "-p" || flag === "--publish") {
    const target = Number(unquotedColon(value).at(-1)?.split("/")[0]);
    if (Number.isInteger(target) && target > 0 && target < 65536) hints.ports.push(target);
    return;
  }
  if (flag === "-v" || flag === "--volume") {
    const [source = "", target = ""] = unquotedColon(value);
    if (source.includes(SOCKET)) hints.leftOut.push(PROJECT_PAGE.leftOut.socket);
    else if (target.startsWith("/")) hints.volumes.push(target);
    return;
  }
  if (flag === "-e" || flag === "--env") {
    const at = value.indexOf("=");
    const name = at < 0 ? value : value.slice(0, at);
    const given = at < 0 ? "" : value.slice(at + 1);
    if (VARIABLE.test(name) && !IDS_AND_ZONE.has(name)) {
      hints.environment.push({ name, value: USABLE_VALUE.test(given) ? given : "" });
    }
    return;
  }
  if (flag === "--network" || flag === "--net") {
    if (value === "host") hints.leftOut.push(PROJECT_PAGE.leftOut.hostNetwork);
    return;
  }
  if (flag === "--cap-add") hints.leftOut.push(PROJECT_PAGE.leftOut.capability(value));
  if (flag === "--device") hints.leftOut.push(PROJECT_PAGE.leftOut.device);
}

/** What one `docker run` line says: its image, what it serves and keeps, and what it wants set. */
export function parseDockerRun(line: string): ProjectHints | null {
  const hints: ProjectHints = { image: "", ports: [], volumes: [], environment: [], leftOut: [] };
  const tokens = words(line);
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!;
    if (!token.startsWith("-")) {
      if (!isValidImage(token)) return null;
      return { ...hints, image: token };
    }
    if (token === "--privileged") {
      hints.leftOut.push(PROJECT_PAGE.leftOut.privileged);
      continue;
    }
    const equals = token.indexOf("=");
    if (token.startsWith("--") && equals > 0) {
      addFlag(hints, token.slice(0, equals), token.slice(equals + 1));
      continue;
    }
    if ((DOCKER_RUN_FLAGS as readonly string[]).includes(token)) {
      addFlag(hints, token, tokens[at + 1] ?? "");
      at += 1;
    }
  }
  return null;
}

export function hintsInReadme(readme: string): { hints: ProjectHints | null; composeImages: string[] } {
  const joined = readme.replace(CONTINUED_LINE, " ");
  for (const [, line] of joined.matchAll(DOCKER_RUN)) {
    const hints = parseDockerRun(line ?? "");
    if (hints !== null) return { hints, composeImages: [] };
  }
  const composeImages = [...joined.matchAll(COMPOSE_IMAGE)].map((match) => match[1] ?? "").filter(isValidImage);
  return { hints: null, composeImages: [...new Set(composeImages)] };
}

const plainHints = (image: string): ProjectHints => ({ image, ports: [], volumes: [], environment: [], leftOut: [] });

async function textOf(
  fetchImplementation: typeof fetch,
  url: string,
  characters: number = PROJECT_PAGE.readCharacters,
): Promise<string | null> {
  const response = await fetchImplementation(url, {
    signal: AbortSignal.timeout(PROJECT_PAGE.timeoutMilliseconds),
  }).catch(() => null);
  if (response === null || !response.ok) return null;
  const text = await response.text().catch(() => null);
  return text === null ? null : text.slice(0, characters);
}

/**
 * What a project's page says to run. A registry's own page names its image outright; a GitHub project is read, its
 * README first, then a Compose file; failing those, an image under the project's own name is tried by the caller.
 */
export async function readProjectPage(
  address: string,
  fetchImplementation: typeof fetch = fetch,
  wantedFile: string | null = null,
): Promise<ProjectPage> {
  const image = imageFromAddress(address);
  if (image !== null) return { kind: "found", hints: plainHints(image) };
  const project = projectOf(address);
  if (project === null) return { kind: "unknownSite" };
  const raw = (file: string) => `${PROJECT_PAGE.rawBase}/${project.owner}/${project.name}/HEAD/${file}`;
  let saysCompose = false;
  if (wantedFile === null) {
    for (const file of PROJECT_PAGE.readmeFiles) {
      const readme = await textOf(fetchImplementation, raw(file));
      if (readme === null) continue;
      const found = hintsInReadme(readme);
      if (found.hints !== null) return { kind: "found", hints: found.hints };
      saysCompose = PROJECT_PAGE.mentionsCompose.test(readme);
      break;
    }
  }
  const files = await composeFilesOf(project, fetchImplementation);
  const file = wantedFile !== null && files.includes(wantedFile) ? wantedFile : files[0];
  const text = file === undefined ? null : await textOf(fetchImplementation, raw(file));
  if (file !== undefined && text !== null) {
    const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return { kind: "compose", text, files, file, folder, owner: project.owner, name: project.name };
  }
  if (saysCompose) return { kind: "composeOnly" };
  return {
    kind: "guess",
    candidates: [`ghcr.io/${project.owner}/${project.name}:latest`, `${project.owner}/${project.name}:latest`],
  };
}

const rank = (path: string) => {
  const at = COMPOSE_IMPORT.simplestFirst.findIndex((word) => path.toLowerCase().includes(word));
  return at < 0 ? COMPOSE_IMPORT.simplestFirst.length : at;
};

function pathsIn(listing: string | null): string[] | null {
  if (listing === null) return null;
  try {
    const tree = (JSON.parse(listing) as { tree?: { path?: unknown; type?: unknown }[] }).tree;
    if (tree === undefined) return null;
    return tree.flatMap((entry) => (entry.type === "blob" && typeof entry.path === "string" ? [entry.path] : []));
  } catch {
    return null;
  }
}

// The Compose files a project keeps for installing, simplest first. GitHub lists them; if it will not (it limits how
// often it answers), the usual names are tried.
async function composeFilesOf(
  project: { owner: string; name: string },
  fetchImplementation: typeof fetch,
): Promise<string[]> {
  const listing = await textOf(
    fetchImplementation,
    COMPOSE_IMPORT.treeUrl(project.owner, project.name),
    COMPOSE_IMPORT.listingCharacters,
  );
  const paths = pathsIn(listing);
  const found = (paths ?? [])
    .filter((path) => COMPOSE_IMPORT.fileName.test(path) && !COMPOSE_IMPORT.notForInstalling.test(path))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
    .slice(0, COMPOSE_IMPORT.filesOffered);
  if (paths !== null) return found;
  const usual: string[] = [];
  for (const file of PROJECT_PAGE.composeFiles) {
    const raw = `${PROJECT_PAGE.rawBase}/${project.owner}/${project.name}/HEAD/${file}`;
    if ((await textOf(fetchImplementation, raw)) !== null) usual.push(file);
  }
  return usual;
}

/** The settings a project's Compose file expects: its own `.env`, or the example it keeps to be copied to one. */
export async function readProjectSettings(
  page: { owner: string; name: string; folder: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<string | null> {
  for (const file of COMPOSE_IMPORT.settingsFiles) {
    const text = await readProjectFile(page, file, fetchImplementation);
    if (text !== null) return text;
  }
  return null;
}

/** A file beside a project's Compose file, such as the env file it names. Never outside the project. */
export async function readProjectFile(
  page: { owner: string; name: string; folder: string },
  file: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string | null> {
  const relative = file.replace(/^\.\//, "");
  if (relative.startsWith("/") || relative.split("/").includes("..")) return null;
  const path = page.folder === "" ? relative : `${page.folder}/${relative}`;
  return textOf(fetchImplementation, `${PROJECT_PAGE.rawBase}/${page.owner}/${page.name}/HEAD/${path}`);
}
