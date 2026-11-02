import { DOCKER_RUN_TEXT } from "./constants.js";
import { SECRET_NAME } from "./install.js";

export const DOCKER_RUN_COMMAND = /^\s*(?:sudo\s+)?docker\s+(?:container\s+)?run\b/;

export interface ConvertedRun {
  compose: string;
  env: string;
  // Flags with no place in a Compose file, or that this does not read: said, not silently lost.
  leftOut: string[];
  suggestedName: string;
}

const PLAIN = /^[A-Za-z0-9_./:@%+,=-]+$/;
const IN_ENV = /^(PUID|PGID)$/;
const SECRET_LIKE = (name: string) => IN_ENV.test(name) || SECRET_NAME.test(name);
const SLUG_CHARACTERS = /[^a-z0-9_-]+/g;

/** The words of a shell command, as a shell would split them: quotes and line continuations, nothing expanded. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  const source = command.replace(/\\\r?\n/g, " ");
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && source[at + 1] !== undefined) {
        at += 1;
        word = `${word ?? ""}${source[at]}`;
      } else word = `${word ?? ""}${character}`;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      word ??= "";
      continue;
    }
    if (character === "\\" && source[at + 1] !== undefined) {
      at += 1;
      word = `${word ?? ""}${source[at]}`;
      continue;
    }
    if (/\s/.test(character)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word = `${word ?? ""}${character}`;
  }
  if (word !== null) words.push(word);
  return words;
}

const yamlText = (value: string) => (PLAIN.test(value) && !/^[\d.]+$/.test(value) ? value : JSON.stringify(value));
const composeText = (value: string) => value.replaceAll("$", "$$$$");
const envLineOf = (name: string, value: string) => {
  if (PLAIN.test(value) || value === "") return `${name}=${value}`;
  return value.includes("'") ? `${name}=${JSON.stringify(value)}` : `${name}='${value}'`;
};

// Flags with a value, by each spelling, and the Compose key each becomes.
const LIST_KEYS: Record<string, string> = {
  "--cap-add": "cap_add",
  "--cap-drop": "cap_drop",
  "--device": "devices",
  "--dns": "dns",
  "--add-host": "extra_hosts",
  "--tmpfs": "tmpfs",
  "--security-opt": "security_opt",
  "--sysctl": "sysctls",
  "--env-file": "env_file",
  "--group-add": "group_add",
};
const TEXT_KEYS: Record<string, string> = {
  "--hostname": "hostname",
  "-h": "hostname",
  "--user": "user",
  "-u": "user",
  "--workdir": "working_dir",
  "-w": "working_dir",
  "--entrypoint": "entrypoint",
  "--memory": "mem_limit",
  "-m": "mem_limit",
  "--cpus": "cpus",
  "--shm-size": "shm_size",
  "--pid": "pid",
  "--ipc": "ipc",
  "--runtime": "runtime",
  "--stop-signal": "stop_signal",
  "--platform": "platform",
  "--restart": "restart",
};
const SWITCH_KEYS: Record<string, string> = {
  "--privileged": "privileged",
  "--read-only": "read_only",
  "--init": "init",
  "--tty": "tty",
  "-t": "tty",
  "--interactive": "stdin_open",
  "-i": "stdin_open",
};
// Mean nothing once it is a Compose app, so they go without a word.
const NO_MEANING = new Set(["-d", "--detach", "--rm"]);
const SPECIAL_WITH_VALUE = new Set([
  "--name",
  "-p",
  "--publish",
  "-e",
  "--env",
  "-v",
  "--volume",
  "--network",
  "--net",
  "-l",
  "--label",
]);
const VALUELESS_OTHERS = new Set(["-P", "--publish-all", "--no-healthcheck"]);

interface RunFacts {
  name: string | null;
  ports: string[];
  environment: { name: string; value: string | null }[];
  volumes: string[];
  networks: string[];
  labels: string[];
  lists: Map<string, string[]>;
  texts: Map<string, string>;
  switches: Set<string>;
  leftOut: string[];
  image: string | null;
  command: string[];
}

function addValue(facts: RunFacts, flag: string, value: string) {
  if (flag === "--name") facts.name = value;
  else if (flag === "-p" || flag === "--publish") facts.ports.push(value);
  else if (flag === "-v" || flag === "--volume") facts.volumes.push(value);
  else if (flag === "--network" || flag === "--net") facts.networks.push(value);
  else if (flag === "-l" || flag === "--label") facts.labels.push(value);
  else if (flag === "-e" || flag === "--env") {
    const at = value.indexOf("=");
    facts.environment.push(
      at < 0 ? { name: value, value: null } : { name: value.slice(0, at), value: value.slice(at + 1) },
    );
  } else if (LIST_KEYS[flag] !== undefined) {
    const key = LIST_KEYS[flag]!;
    facts.lists.set(key, [...(facts.lists.get(key) ?? []), value]);
  } else if (TEXT_KEYS[flag] !== undefined) facts.texts.set(TEXT_KEYS[flag]!, value);
}

const takesValue = (flag: string) =>
  SPECIAL_WITH_VALUE.has(flag) || LIST_KEYS[flag] !== undefined || TEXT_KEYS[flag] !== undefined;

function factsOf(words: readonly string[]): RunFacts {
  const facts: RunFacts = {
    name: null,
    ports: [],
    environment: [],
    volumes: [],
    networks: [],
    labels: [],
    lists: new Map(),
    texts: new Map(),
    switches: new Set(),
    leftOut: [],
    image: null,
    command: [],
  };
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    if (!word.startsWith("-") || word === "-") {
      facts.image = word;
      facts.command = words.slice(at + 1);
      return facts;
    }
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    const flag = equals > 0 ? word.slice(0, equals) : word;
    if (NO_MEANING.has(flag)) continue;
    if (SWITCH_KEYS[flag] !== undefined) {
      facts.switches.add(SWITCH_KEYS[flag]!);
      continue;
    }
    if (takesValue(flag)) {
      if (equals > 0) addValue(facts, flag, word.slice(equals + 1));
      else {
        addValue(facts, flag, words[at + 1] ?? "");
        at += 1;
      }
      continue;
    }
    // Short flags together, such as -dit or -it.
    if (/^-[a-zA-Z]{2,}$/.test(word)) {
      const letters = [...word.slice(1)].map((letter) => `-${letter}`);
      if (letters.every((letter) => NO_MEANING.has(letter) || SWITCH_KEYS[letter] !== undefined)) {
        letters.forEach((letter) => {
          if (SWITCH_KEYS[letter] !== undefined) facts.switches.add(SWITCH_KEYS[letter]!);
        });
        continue;
      }
    }
    facts.leftOut.push(word);
    // Unknown flags may take a value: one that plainly is no image is taken as theirs.
    const next = words[at + 1];
    const looksValue = next !== undefined && !next.startsWith("-") && words[at + 2] !== undefined;
    if (equals < 0 && !VALUELESS_OTHERS.has(flag) && looksValue) at += 1;
  }
  return facts;
}

const list = (key: string, items: readonly string[]) => [
  `    ${key}:`,
  ...items.map((item) => `      - ${yamlText(item)}`),
];

const isNamedVolume = (mount: string) => {
  const source = mount.split(":")[0]!;
  return mount.includes(":") && !source.startsWith("/") && !source.startsWith(".") && !source.startsWith("~");
};

/** A `docker run` command as a Compose file and .env: passwords and IDs in the .env, what has no place said aloud. */
export function dockerRunToCompose(command: string): ConvertedRun | { problem: string } {
  const words = shellWords(command.split(/(?:^|\s)(?:&&|;|\|)\s/)[0] ?? "");
  const start = words.indexOf("run");
  if (start < 0) return { problem: DOCKER_RUN_TEXT.notRun };
  const facts = factsOf(words.slice(start + 1));
  if (facts.image === null) return { problem: DOCKER_RUN_TEXT.noImage };
  const last = facts.image.split("/").at(-1)!.split(/[:@]/)[0]!;
  const service = (facts.name ?? last).toLowerCase().replace(SLUG_CHARACTERS, "-").replace(/^-+/, "") || "app";
  const envLines: string[] = [];
  const environment = facts.environment.map(({ name, value }) => {
    if (value === null) {
      envLines.push(`${name}=`);
      return `\${${name}}`;
    }
    if (SECRET_LIKE(name)) {
      envLines.push(envLineOf(name, value));
      return `\${${name}}`;
    }
    return composeText(value);
  });
  const lines = ["services:", `  ${service}:`, `    image: ${facts.image}`];
  if (facts.name !== null) lines.push(`    container_name: ${facts.name}`);
  for (const [key, value] of facts.texts) {
    lines.push(`    ${key}: ${key === "restart" ? JSON.stringify(value) : yamlText(value)}`);
  }
  for (const key of facts.switches) lines.push(`    ${key}: true`);
  const networkMode = facts.networks.find((name) => ["host", "none", "bridge"].includes(name) || /:/.test(name));
  const networks = facts.networks.filter((name) => name !== networkMode);
  if (networkMode !== undefined) lines.push(`    network_mode: ${networkMode}`);
  if (facts.ports.length > 0) lines.push("    ports:", ...facts.ports.map((port) => `      - ${JSON.stringify(port)}`));
  if (facts.environment.length > 0) {
    lines.push("    environment:");
    facts.environment.forEach(({ name }, index) => {
      const value = environment[index]!;
      const whole = `${name}=${value}`;
      lines.push(`      - ${/^[A-Za-z0-9_./:@%+,=${}-]+$/.test(whole) ? whole : JSON.stringify(whole)}`);
    });
  }
  if (facts.volumes.length > 0) lines.push(...list("volumes", facts.volumes));
  if (facts.labels.length > 0) lines.push(...list("labels", facts.labels));
  for (const [key, items] of facts.lists) lines.push(...list(key, items));
  if (networks.length > 0) lines.push(...list("networks", networks));
  if (facts.command.length > 0) lines.push(`    command: ${JSON.stringify(facts.command)}`);
  const named = [...new Set(facts.volumes.filter(isNamedVolume).map((mount) => mount.split(":")[0]!))];
  // By its own name, as docker run would: an existing volume keeps being the one in use.
  if (named.length > 0) {
    lines.push("", "volumes:", ...named.flatMap((name) => [`  ${name}:`, `    name: ${name}`]));
  }
  if (networks.length > 0) {
    lines.push("", "networks:", ...networks.flatMap((name) => [`  ${name}:`, "    external: true"]));
  }
  return {
    compose: `${lines.join("\n")}\n`,
    env: envLines.length === 0 ? "" : `${envLines.join("\n")}\n`,
    leftOut: facts.leftOut,
    suggestedName: service,
  };
}
