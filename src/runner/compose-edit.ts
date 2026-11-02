import { dotenvLine } from "../shared/compose-lint.js";
import { COMPOSE_EDIT_PROBLEMS, MOUNT_KIND, RESTART_POLICY_ON_FAILURE } from "../shared/constants.js";
import { SECRET_NAME } from "../shared/install.js";
import type { ContainerSettings } from "../shared/protocol.js";
import { envFilesNamedIn } from "../shared/stacks.js";

type Pair = ContainerSettings["environment"][number];
type Port = ContainerSettings["ports"][number];
type Mount = ContainerSettings["mounts"][number];
type PairsKey = "environment" | "labels";

export interface SettingsChange {
  environment: { set: Pair[]; removed: string[] };
  labels: { set: Pair[]; removed: string[] };
  ports: { added: Port[]; removed: Port[] };
  mounts: { added: Mount[]; removed: Mount[] };
  restart: ContainerSettings["restart"] | null;
}

export interface ComposeEditInput {
  text: string;
  service: string;
  project: string;
  // The file ${VARIABLES} come from.
  environmentPath: string;
  folder: string;
  // Every settings file read, by path; null when it is not there yet.
  envTexts: ReadonlyMap<string, string | null>;
  change: SettingsChange;
}

export type ComposeEditResult = { problem: string } | { problem: null; text: string; envTexts: Map<string, string> };

// Compose's own labels: it sets them, so no file holds them.
const COMPOSE_OWN_LABEL = "com.docker.compose.";
const SECRET_LIKE = new RegExp(`${SECRET_NAME.source}|^(PUID|PGID)$`, "i");
const INDENT_STEP = 2;
const PLAIN_VALUE = /^[A-Za-z0-9_./:@%+,-]+$/;
const WHOLE_VARIABLE = /^\$\{([A-Za-z_]\w*)(?:[:?+-][^}]*)?\}$|^\$([A-Za-z_]\w*)$/;
const NUMERIC_PORT = /^\d+$/;

const pairKey = ({ name, value }: Pair) => JSON.stringify([name, value]);
const portKey = ({ target, protocol, published, address }: Port) =>
  JSON.stringify([target, protocol, published, address]);
const mountKey = ({ kind, source, target, readOnly }: Mount) => JSON.stringify([kind, source, target, readOnly]);

function pairsChange(before: readonly Pair[], after: readonly Pair[]) {
  const had = new Set(before.map(pairKey));
  const names = new Set(after.map(({ name }) => name));
  return {
    set: after.filter((pair) => !had.has(pairKey(pair))),
    removed: before.map(({ name }) => name).filter((name) => !names.has(name)),
  };
}

function listChange<Item>(before: readonly Item[], after: readonly Item[], keyOf: (item: Item) => string) {
  const had = new Set(before.map(keyOf));
  const has = new Set(after.map(keyOf));
  return {
    added: after.filter((item) => !had.has(keyOf(item))),
    removed: before.filter((item) => !has.has(keyOf(item))),
  };
}

/** Only what the person changed: the file keeps everything else, its variables and comments among them. */
export function settingsChange(before: ContainerSettings, after: ContainerSettings): SettingsChange {
  const ownLabel = ({ name }: Pair) => name.startsWith(COMPOSE_OWN_LABEL);
  const sameRestart = JSON.stringify(before.restart) === JSON.stringify(after.restart);
  return {
    environment: pairsChange(before.environment, after.environment),
    labels: pairsChange(
      before.labels.filter((pair) => !ownLabel(pair)),
      after.labels.filter((pair) => !ownLabel(pair)),
    ),
    ports: listChange(before.ports, after.ports, portKey),
    mounts: listChange(before.mounts, after.mounts, mountKey),
    restart: sameRestart ? null : after.restart,
  };
}

const isBlank = (line: string) => line.trim() === "" || line.trim().startsWith("#");
const indentOf = (line: string) => line.length - line.trimStart().length;
const restartText = ({ policy, retries }: ContainerSettings["restart"]) =>
  policy === RESTART_POLICY_ON_FAILURE && retries > 0 ? `${policy}:${retries}` : policy;
const escapedDollars = (value: string) => value.replaceAll("$", "$$$$");
const withoutComment = (text: string) => text.replace(/\s+#.*$/, "").trim();

function unquoted(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"')) {
    const closing = trimmed.lastIndexOf('"');
    return closing > 0 ? trimmed.slice(1, closing).replaceAll('\\"', '"').replaceAll("\\\\", "\\") : trimmed;
  }
  if (trimmed.startsWith("'")) {
    const closing = trimmed.lastIndexOf("'");
    return closing > 0 ? trimmed.slice(1, closing).replaceAll("''", "'") : trimmed;
  }
  return withoutComment(trimmed);
}

// The end of a block: the first line back at or above its indent, with the blank lines before that left outside it.
function blockEnd(lines: readonly string[], from: number, indent: number): number {
  let end = from;
  for (let at = from; at < lines.length; at += 1) {
    if (isBlank(lines[at]!)) continue;
    if (indentOf(lines[at]!) <= indent) break;
    end = at + 1;
  }
  return end;
}

interface Block {
  start: number;
  end: number;
  childIndent: number;
}

function serviceBlock(lines: readonly string[], service: string): Block | null {
  const top = lines.findIndex((line) => /^services:\s*(#.*)?$/.test(line));
  if (top < 0) return null;
  const end = blockEnd(lines, top + 1, 0);
  const first = lines.slice(top + 1, end).find((line) => !isBlank(line));
  if (first === undefined) return null;
  const indent = indentOf(first);
  const at = lines.findIndex(
    (line, index) =>
      index > top &&
      index < end &&
      indentOf(line) === indent &&
      new RegExp(`^["']?${service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?:\\s*(&\\S+\\s*)?(#.*)?$`).test(
        line.trim(),
      ),
  );
  if (at < 0) return null;
  const serviceEnd = blockEnd(lines, at + 1, indent);
  const child = lines.slice(at + 1, serviceEnd).find((line) => !isBlank(line));
  return { start: at + 1, end: serviceEnd, childIndent: child === undefined ? indent + INDENT_STEP : indentOf(child) };
}

interface Entry {
  line: number;
  inline: string;
  itemsEnd: number;
}

// A key of the service; its list's items may sit at the key's own indent, as YAML allows.
function entryOf(lines: readonly string[], block: Block, key: string): Entry | null {
  for (let at = block.start; at < block.end; at += 1) {
    const line = lines[at]!;
    if (indentOf(line) !== block.childIndent || !line.trimStart().startsWith(`${key}:`)) continue;
    let itemsEnd = at + 1;
    for (let next = at + 1; next < block.end; next += 1) {
      const candidate = lines[next]!;
      if (isBlank(candidate)) continue;
      const deeper = indentOf(candidate) > block.childIndent;
      const sameLevelItem = indentOf(candidate) === block.childIndent && candidate.trimStart().startsWith("- ");
      if (!deeper && !sameLevelItem) break;
      itemsEnd = next + 1;
    }
    return { line: at, inline: withoutComment(line.trimStart().slice(key.length + 1)), itemsEnd };
  }
  return null;
}

interface Item {
  from: number;
  to: number;
  isList: boolean;
  text: string;
}

// A comment above the next item belongs to that one.
function endOfItem(lines: readonly string[], from: number, next: number): number {
  let end = next;
  while (end > from + 1 && isBlank(lines[end - 1]!)) end -= 1;
  return end;
}

function itemsOf(lines: readonly string[], entry: Entry): Item[] {
  const first = lines.slice(entry.line + 1, entry.itemsEnd).find((line) => !isBlank(line));
  if (first === undefined) return [];
  const indent = indentOf(first);
  const isList = first.trimStart().startsWith("- ");
  const items: Item[] = [];
  for (let at = entry.line + 1; at < entry.itemsEnd; at += 1) {
    const line = lines[at]!;
    if (isBlank(line) || indentOf(line) !== indent) continue;
    const last = items.at(-1);
    if (last !== undefined) last.to = endOfItem(lines, last.from, at);
    items.push({ from: at, to: entry.itemsEnd, isList, text: isList ? line.trimStart().slice(2) : line.trimStart() });
  }
  return items;
}

const itemIndent = (lines: readonly string[], entry: Entry, block: Block) => {
  const first = lines.slice(entry.line + 1, entry.itemsEnd).find((line) => !isBlank(line));
  return first === undefined ? block.childIndent + INDENT_STEP : indentOf(first);
};

const isFlowOrAlias = (entry: Entry) => entry.inline !== "";

function appended(lines: string[], service: string, key: string, line: (isList: boolean) => string): string[] | string {
  const block = serviceBlock(lines, service);
  if (block === null) return COMPOSE_EDIT_PROBLEMS.serviceNotFound(service);
  const entry = entryOf(lines, block, key);
  if (entry === null) {
    const padding = " ".repeat(block.childIndent);
    const child = `${padding}${" ".repeat(INDENT_STEP)}${line(true)}`;
    return [...lines.slice(0, block.end), `${padding}${key}:`, child, ...lines.slice(block.end)];
  }
  if (isFlowOrAlias(entry)) return COMPOSE_EDIT_PROBLEMS.inlineBlock(key);
  const items = itemsOf(lines, entry);
  const isList = items[0]?.isList ?? true;
  const padding = " ".repeat(itemIndent(lines, entry, block));
  return [...lines.slice(0, entry.itemsEnd), `${padding}${line(isList)}`, ...lines.slice(entry.itemsEnd)];
}

// An emptied key goes too: Compose does not take a list with nothing under it everywhere.
function withoutItem(lines: string[], service: string, key: string, item: Item): string[] {
  const left = [...lines.slice(0, item.from), ...lines.slice(item.to)];
  const block = serviceBlock(left, service)!;
  const entry = entryOf(left, block, key);
  if (entry === null || itemsOf(left, entry).length > 0) return left;
  return [...left.slice(0, entry.line), ...left.slice(entry.itemsEnd)];
}

function pairOfItem(item: Item): { name: string; value: string | null } {
  if (item.isList) {
    const whole = unquoted(item.text);
    const separator = whole.indexOf("=");
    return separator < 0
      ? { name: whole, value: null }
      : { name: whole.slice(0, separator), value: whole.slice(separator + 1) };
  }
  const separator = item.text.indexOf(":");
  const name = unquoted(item.text.slice(0, separator));
  const raw = withoutComment(item.text.slice(separator + 1));
  return { name, value: raw === "" || raw === "~" || raw === "null" ? null : unquoted(raw) };
}

const pairLine = (isList: boolean, name: string, value: string) => {
  if (!isList) return `${name}: ${JSON.stringify(value)}`;
  const whole = `${name}=${value}`;
  return PLAIN_VALUE.test(value) ? whole : JSON.stringify(whole);
};
const prefixedPairLine = (isList: boolean, name: string, value: string) =>
  `${isList ? "- " : ""}${pairLine(isList, name, value)}`;

const envLinePattern = (name: string) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);

function withEnvValue(text: string | null, name: string, value: string): string {
  const lines = text === null || text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const pattern = envLinePattern(name);
  const line = dotenvLine(name, value);
  const replaced = lines.some((each) => pattern.test(each));
  const next = replaced ? lines.map((each) => (pattern.test(each) ? line : each)) : [...lines, line];
  return `${next.join("\n")}\n`;
}

function withoutEnvValue(text: string, name: string): string {
  const pattern = envLinePattern(name);
  return text
    .split("\n")
    .filter((line) => !pattern.test(line))
    .join("\n");
}

interface Editing {
  lines: string[];
  envTexts: Map<string, string | null>;
  touched: Set<string>;
}

function setEnv(editing: Editing, path: string, name: string, value: string) {
  editing.envTexts.set(path, withEnvValue(editing.envTexts.get(path) ?? null, name, value));
  editing.touched.add(path);
}

function namedEnvFiles(input: ComposeEditInput, lines: readonly string[], service: string): string[] {
  const block = serviceBlock(lines, service);
  if (block === null) return [];
  return envFilesNamedIn(lines.slice(block.start, block.end).join("\n")).map((path) => `${input.folder}/${path}`);
}

function pathHolding(editing: Editing, paths: readonly string[], name: string): string | null {
  const pattern = envLinePattern(name);
  // The last one a service names wins, in Compose as here.
  return paths.findLast((path) => (editing.envTexts.get(path) ?? "").split("\n").some((l) => pattern.test(l))) ?? null;
}

function setPair(input: ComposeEditInput, editing: Editing, key: PairsKey, { name, value }: Pair): string | null {
  const { service, environmentPath } = input;
  const block = serviceBlock(editing.lines, service);
  if (block === null) return COMPOSE_EDIT_PROBLEMS.serviceNotFound(service);
  const entry = entryOf(editing.lines, block, key);
  if (entry !== null && isFlowOrAlias(entry)) return COMPOSE_EDIT_PROBLEMS.inlineBlock(key);
  const item =
    entry === null ? undefined : itemsOf(editing.lines, entry).find((each) => pairOfItem(each).name === name);
  if (item !== undefined) {
    const current = pairOfItem(item).value;
    if (current === null) {
      setEnv(editing, environmentPath, name, value);
      return null;
    }
    const variable = WHOLE_VARIABLE.exec(current);
    if (variable !== null) {
      setEnv(editing, environmentPath, variable[1] ?? variable[2]!, value);
      return null;
    }
    if (current.replaceAll("$$", "").includes("$")) return COMPOSE_EDIT_PROBLEMS.variableInside(name);
    const padding = " ".repeat(indentOf(editing.lines[item.from]!));
    editing.lines = [
      ...editing.lines.slice(0, item.from),
      `${padding}${prefixedPairLine(item.isList, name, escapedDollars(value))}`,
      ...editing.lines.slice(item.to),
    ];
    return null;
  }
  if (key === "environment") {
    const holder = pathHolding(editing, namedEnvFiles(input, editing.lines, service), name);
    if (holder !== null) {
      setEnv(editing, holder, name, value);
      return null;
    }
  }
  const secret = key === "environment" && SECRET_LIKE.test(name);
  if (secret) setEnv(editing, environmentPath, name, value);
  const written = secret ? `\${${name}}` : escapedDollars(value);
  const next = appended(editing.lines, service, key, (isList) => prefixedPairLine(isList, name, written));
  if (typeof next === "string") return next;
  editing.lines = next;
  return null;
}

function removePair(input: ComposeEditInput, editing: Editing, key: PairsKey, name: string): string | null {
  const { service } = input;
  const block = serviceBlock(editing.lines, service);
  if (block === null) return COMPOSE_EDIT_PROBLEMS.serviceNotFound(service);
  const entry = entryOf(editing.lines, block, key);
  if (entry !== null && isFlowOrAlias(entry)) return COMPOSE_EDIT_PROBLEMS.inlineBlock(key);
  const item =
    entry === null ? undefined : itemsOf(editing.lines, entry).find((each) => pairOfItem(each).name === name);
  if (item !== undefined) editing.lines = withoutItem(editing.lines, service, key, item);
  if (key !== "environment") return null;
  const holder = pathHolding(editing, namedEnvFiles(input, editing.lines, service), name);
  if (holder === null) return null;
  editing.envTexts.set(holder, withoutEnvValue(editing.envTexts.get(holder) ?? "", name));
  editing.touched.add(holder);
  return null;
}

const PORT_ITEM = /^(?:(?<address>\[[^\]]+\]|[^:]+):)?(?<published>[^:]+):(?<target>\d+)(?:\/(?<protocol>\w+))?$/;

function portOfItem(item: Item) {
  const groups = PORT_ITEM.exec(unquoted(item.text))?.groups;
  if (groups === undefined) return null;
  return {
    published: groups.published!,
    target: Number(groups.target),
    protocol: groups.protocol ?? "tcp",
  };
}

const portLine = ({ address, published, target, protocol }: Port) =>
  `- "${address === "" ? "" : `${address.includes(":") ? `[${address}]` : address}:`}${published}:${target}/${protocol}"`;

// A published port given by a variable can only be matched by what it publishes to, which is what is being changed.
function portItemFor(lines: readonly string[], entry: Entry, port: Port): Item | undefined {
  const items = itemsOf(lines, entry);
  const sameTarget = items.filter((item) => {
    const parsed = portOfItem(item);
    return parsed !== null && parsed.target === port.target && parsed.protocol === port.protocol;
  });
  return (
    sameTarget.find((item) => portOfItem(item)!.published === String(port.published)) ??
    sameTarget.find((item) => !NUMERIC_PORT.test(portOfItem(item)!.published))
  );
}

function editPorts(input: ComposeEditInput, editing: Editing): string | null {
  const { added, removed } = input.change.ports;
  const { service } = input;
  const left = [...added];
  for (const port of removed) {
    const block = serviceBlock(editing.lines, service);
    if (block === null) return COMPOSE_EDIT_PROBLEMS.serviceNotFound(service);
    const entry = entryOf(editing.lines, block, "ports");
    if (entry === null) return COMPOSE_EDIT_PROBLEMS.portNotFound(port.published);
    if (isFlowOrAlias(entry)) return COMPOSE_EDIT_PROBLEMS.inlineBlock("ports");
    const item = portItemFor(editing.lines, entry, port);
    if (item === undefined) return COMPOSE_EDIT_PROBLEMS.portNotFound(port.published);
    const inPlace = left.findIndex(({ target, protocol }) => target === port.target && protocol === port.protocol);
    if (inPlace < 0) {
      editing.lines = withoutItem(editing.lines, service, "ports", item);
      continue;
    }
    const padding = " ".repeat(indentOf(editing.lines[item.from]!));
    const [replacement] = left.splice(inPlace, 1);
    editing.lines = [
      ...editing.lines.slice(0, item.from),
      `${padding}${portLine(replacement!)}`,
      ...editing.lines.slice(item.to),
    ];
  }
  for (const port of left) {
    const next = appended(editing.lines, service, "ports", () => portLine(port));
    if (typeof next === "string") return next;
    editing.lines = next;
  }
  return null;
}

function topLevelVolumeNames(lines: readonly string[]): { line: number; end: number; names: string[]; indent: number } {
  const line = lines.findIndex((each) => /^volumes:\s*(#.*)?$/.test(each));
  if (line < 0) return { line, end: lines.length, names: [], indent: INDENT_STEP };
  const end = blockEnd(lines, line + 1, 0);
  const first = lines.slice(line + 1, end).find((each) => !isBlank(each));
  const indent = first === undefined ? INDENT_STEP : indentOf(first);
  const names = lines
    .slice(line + 1, end)
    .filter((each) => !isBlank(each) && indentOf(each) === indent)
    .map((each) => unquoted(each.trim().split(":")[0]!));
  return { line, end, names, indent };
}

// Docker names a project's volume after it: the file calls it by its short name. One it does not know yet comes from
// outside the project, so Compose must be told it is not its own to make.
function volumeSourceFor(editing: Editing, project: string, name: string): string {
  const known = topLevelVolumeNames(editing.lines);
  const short = name.startsWith(`${project}_`) ? name.slice(project.length + 1) : name;
  if (known.names.includes(short)) return short;
  if (known.names.includes(name)) return name;
  const padding = " ".repeat(known.indent);
  const declared = [`${padding}"${name}":`, `${padding}${" ".repeat(INDENT_STEP)}external: true`];
  editing.lines =
    known.line < 0
      ? [
          ...editing.lines.filter((line, index, all) => index < all.length - 1 || line !== ""),
          "volumes:",
          ...declared,
          "",
        ]
      : [...editing.lines.slice(0, known.end), ...declared, ...editing.lines.slice(known.end)];
  return name;
}

const VOLUME_ITEM_TARGET = /^(?:.*?:)?(\/[^:]*?)(?::[^:]*)?$/;
const mountLine = (source: string, target: string, readOnly: boolean) =>
  `- "${source}:${target}${readOnly ? ":ro" : ""}"`;

function editMounts(input: ComposeEditInput, editing: Editing): string | null {
  const { added, removed } = input.change.mounts;
  const { service, project } = input;
  const left = [...added];
  for (const mount of removed) {
    const block = serviceBlock(editing.lines, service);
    if (block === null) return COMPOSE_EDIT_PROBLEMS.serviceNotFound(service);
    const entry = entryOf(editing.lines, block, "volumes");
    if (entry === null) return COMPOSE_EDIT_PROBLEMS.mountNotFound(mount.target);
    if (isFlowOrAlias(entry)) return COMPOSE_EDIT_PROBLEMS.inlineBlock("volumes");
    const item = itemsOf(editing.lines, entry).find(
      (each) => VOLUME_ITEM_TARGET.exec(unquoted(each.text))?.[1] === mount.target,
    );
    if (item === undefined) return COMPOSE_EDIT_PROBLEMS.mountNotFound(mount.target);
    const inPlace = left.findIndex(({ target }) => target === mount.target);
    if (inPlace < 0) {
      editing.lines = withoutItem(editing.lines, service, "volumes", item);
      continue;
    }
    const [replacement] = left.splice(inPlace, 1);
    const sameSource = replacement!.kind === mount.kind && replacement!.source === mount.source;
    const sourceEnd = unquoted(item.text).indexOf(`:${mount.target}`);
    if (sameSource && sourceEnd <= 0) return COMPOSE_EDIT_PROBLEMS.mountNotFound(mount.target);
    // Only its read-only tick changed: its source stays as the file wrote it, ./data or a variable.
    const source = sameSource ? unquoted(item.text).slice(0, sourceEnd) : sourceFor(editing, project, replacement!);
    const refreshed = serviceBlock(editing.lines, service)!;
    const moved = itemsOf(editing.lines, entryOf(editing.lines, refreshed, "volumes")!).find(
      (each) => VOLUME_ITEM_TARGET.exec(unquoted(each.text))?.[1] === mount.target,
    )!;
    const padding = " ".repeat(indentOf(editing.lines[moved.from]!));
    editing.lines = [
      ...editing.lines.slice(0, moved.from),
      `${padding}${mountLine(source, replacement!.target, replacement!.readOnly)}`,
      ...editing.lines.slice(moved.to),
    ];
  }
  for (const mount of left) {
    const source = sourceFor(editing, project, mount);
    const next = appended(editing.lines, service, "volumes", () => mountLine(source, mount.target, mount.readOnly));
    if (typeof next === "string") return next;
    editing.lines = next;
  }
  return null;
}

const sourceFor = (editing: Editing, project: string, mount: Mount) =>
  mount.kind === MOUNT_KIND.volume ? volumeSourceFor(editing, project, mount.source) : mount.source;

function editRestart(input: ComposeEditInput, editing: Editing): string | null {
  const { restart } = input.change;
  if (restart === null) return null;
  const block = serviceBlock(editing.lines, input.service);
  if (block === null) return COMPOSE_EDIT_PROBLEMS.serviceNotFound(input.service);
  const padding = " ".repeat(block.childIndent);
  const line = `${padding}restart: ${JSON.stringify(restartText(restart))}`;
  const entry = entryOf(editing.lines, block, "restart");
  editing.lines =
    entry === null
      ? [...editing.lines.slice(0, block.end), line, ...editing.lines.slice(block.end)]
      : [...editing.lines.slice(0, entry.line), line, ...editing.lines.slice(entry.line + 1)];
  return null;
}

/**
 * The new text of a Compose file and its settings files, changed line by line so its comments and layout stay. It
 * reads the block style nearly every Compose file is written in, and says so of what it cannot.
 * ponytail: no YAML library, so long-form ports and mounts, inline lists and aliases are refused; the caller leaves
 * the file alone then. Add the `yaml` package's document API if those turn up often.
 */
export function editedCompose(input: ComposeEditInput): ComposeEditResult {
  const { service, change, text, envTexts } = input;
  const editing: Editing = { lines: text.split("\n"), envTexts: new Map(envTexts), touched: new Set() };
  if (serviceBlock(editing.lines, service) === null) return { problem: COMPOSE_EDIT_PROBLEMS.serviceNotFound(service) };
  const steps: (() => string | null)[] = [
    ...change.environment.set.map((pair) => () => setPair(input, editing, "environment", pair)),
    ...change.environment.removed.map((name) => () => removePair(input, editing, "environment", name)),
    ...change.labels.set.map((pair) => () => setPair(input, editing, "labels", pair)),
    ...change.labels.removed.map((name) => () => removePair(input, editing, "labels", name)),
    () => editPorts(input, editing),
    () => editMounts(input, editing),
    () => editRestart(input, editing),
  ];
  for (const step of steps) {
    const problem = step();
    if (problem !== null) return { problem };
  }
  const changedEnvs = [...editing.touched].map((path) => [path, editing.envTexts.get(path) ?? ""] as const);
  return { problem: null, text: editing.lines.join("\n"), envTexts: new Map(changedEnvs) };
}

export const definesService = (text: string, service: string) => serviceBlock(text.split("\n"), service) !== null;

export interface ResolvedService {
  environment?: Record<string, string | null>;
  labels?: Record<string, string>;
  ports?: { target?: number; published?: string | number; protocol?: string; host_ip?: string }[];
  volumes?: { type?: string; source?: string; target?: string; read_only?: boolean }[];
  restart?: string;
}

const literal = (value: string | null | undefined) => value?.replaceAll("$$", "$");

/** Whether Compose itself, reading the edited files, gives the service what the person asked: never taken on trust. */
export function composeAgrees(resolved: ResolvedService | undefined, change: SettingsChange): boolean {
  if (resolved === undefined) return false;
  const environment = resolved.environment ?? {};
  const labels = resolved.labels ?? {};
  const ports = resolved.ports ?? [];
  const volumes = resolved.volumes ?? [];
  const hasPort = (port: Port) =>
    ports.some(
      (each) =>
        each.target === port.target &&
        (each.protocol ?? "tcp") === port.protocol &&
        Number(each.published) === port.published &&
        (each.host_ip ?? "") === port.address,
    );
  const hasMount = (mount: Mount) =>
    volumes.some(
      (each) =>
        each.target === mount.target &&
        each.type === mount.kind &&
        (each.read_only ?? false) === mount.readOnly &&
        (mount.kind === MOUNT_KIND.volume || each.source === mount.source),
    );
  return (
    change.environment.set.every(({ name, value }) => literal(environment[name]) === value) &&
    change.environment.removed.every((name) => !(name in environment)) &&
    change.labels.set.every(({ name, value }) => literal(labels[name]) === value) &&
    change.labels.removed.every((name) => !(name in labels)) &&
    change.ports.added.every(hasPort) &&
    !change.ports.removed.some(hasPort) &&
    change.mounts.added.every(hasMount) &&
    (change.restart === null || resolved.restart === restartText(change.restart))
  );
}

export const isEmptyChange = (change: SettingsChange) =>
  change.environment.set.length +
    change.environment.removed.length +
    change.labels.set.length +
    change.labels.removed.length +
    change.ports.added.length +
    change.ports.removed.length +
    change.mounts.added.length +
    change.mounts.removed.length ===
    0 && change.restart === null;
