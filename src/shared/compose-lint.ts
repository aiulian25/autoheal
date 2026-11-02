import { DOCKER_SOCKET_PATH, OWN_COMPOSE_TEXT } from "./constants.js";
import { SECRET_NAME, isDeniedSource } from "./install.js";
import { OWN_FILE, OWN_ISSUE_LEVEL, type OwnFix, type OwnIssue } from "./own-compose.js";

const text = OWN_COMPOSE_TEXT;
const PLAIN_ENV_VALUE = /^[A-Za-z0-9_./:@%+,-]*$/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const VARIABLE = /(?<!\$)\$(?:\{([A-Za-z_]\w*)(:?[-+?][^}]*)?\}|([A-Za-z_]\w*))/g;
const COMPOSE_OWN_VARIABLE = /^(COMPOSE_|DOCKER_)/;
const MAP_OR_LIST_PAIR = /^(\s*)(- )?(["']?)([A-Za-z_]\w*)\3\s*(:\s|=)\s*(.+?)\s*$/;
const PASS_THROUGH = /^\s*-\s+["']?([A-Za-z_]\w*)["']?\s*$/;
const NEAR_NAME_DISTANCE = 2;
const INDENT_STEP = 2;

const isBlank = (line: string) => line.trim() === "" || line.trim().startsWith("#");
const indentOf = (line: string) => line.length - line.trimStart().length;
const linesOf = (file: string) => file.split("\n").map((line) => line.replace(/\r$/, ""));

const compose = (level: OwnIssue["level"], line: number | null, message: string, fix: OwnFix | null = null) =>
  ({ level, file: OWN_FILE.compose, line, message, fix }) satisfies OwnIssue;

/** One line of a .env, quoted only as much as Compose needs to read the value back as it is. */
export function dotenvLine(name: string, value: string): string {
  if (PLAIN_ENV_VALUE.test(value)) return `${name}=${value}`;
  if (!value.includes("'")) return `${name}='${value}'`;
  return `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
}

export const envNamesIn = (env: string) =>
  linesOf(env).flatMap((line, index) => {
    const name = isBlank(line) ? undefined : ENV_LINE.exec(line)?.[1];
    return name === undefined ? [] : [{ name, line: index + 1 }];
  });

function distance(first: string, second: string): number {
  let row = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let at = 1; at <= first.length; at += 1) {
    const next = [at];
    for (let other = 1; other <= second.length; other += 1) {
      const same = first[at - 1] === second[other - 1] ? 0 : 1;
      next.push(Math.min(next[other - 1]! + 1, row[other]! + 1, row[other - 1]! + same));
    }
    row = next;
  }
  return row[second.length]!;
}

interface Used {
  name: string;
  line: number;
  optional: boolean;
}

function variablesIn(lines: readonly string[]): Used[] {
  return lines.flatMap((line, index) =>
    isBlank(line)
      ? []
      : [...line.matchAll(VARIABLE)].map((match) => ({
          name: match[1] ?? match[3]!,
          line: index + 1,
          optional: match[2] !== undefined && !match[2].includes("?"),
        })),
  );
}

// The key a line sits under, for a list item at its parent's own indent as much as a deeper one.
function parentKeyOf(lines: readonly string[], index: number): string | null {
  const indent = indentOf(lines[index]!);
  const isItem = lines[index]!.trimStart().startsWith("- ");
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at]!;
    if (isBlank(line) || line.trimStart().startsWith("- ")) continue;
    const above = indentOf(line);
    if (above < indent || (isItem && above === indent)) return line.trim().split(":")[0] ?? null;
  }
  return null;
}

/** What can be told from the files alone, once Compose can read them. The same on the page and on the host. */
export function lintOwnFiles(composeFile: string, env: string): OwnIssue[] {
  const lines = linesOf(composeFile);
  const defined = envNamesIn(env);
  const definedNames = new Set(defined.map(({ name }) => name));
  const used = variablesIn(lines);
  const missing = [
    ...new Map(
      used.filter(({ name, optional }) => !optional && !definedNames.has(name)).map((each) => [each.name, each]),
    ).values(),
  ];
  const usedNames = new Set(used.map(({ name }) => name));
  const passed = new Set(lines.flatMap((line) => PASS_THROUGH.exec(line)?.[1] ?? []));
  const readsEnv = lines.some((line, index) => {
    const named = /\.env["']?\s*$/.test(line);
    return named && (line.includes("env_file") || parentKeyOf(lines, index)?.endsWith("env_file") === true);
  });
  const unused = defined.filter(
    ({ name }) => !usedNames.has(name) && !passed.has(name) && !readsEnv && !COMPOSE_OWN_VARIABLE.test(name),
  );
  const nearMissing = (name: string) =>
    missing.find((each) => distance(each.name, name) <= NEAR_NAME_DISTANCE)?.name ?? null;
  const envLines = linesOf(env);
  const issues: OwnIssue[] = [];
  for (const { name, line } of missing) {
    const typo = unused.find((each) => nearMissing(each.name) === name);
    issues.push(
      compose(
        OWN_ISSUE_LEVEL.error,
        line,
        typo === undefined ? text.variableMissing(name) : text.variableNear(name, typo.name),
        typo === undefined ? { label: text.addToEnv, lines: [], env: [{ name, value: null }] } : null,
      ),
    );
  }
  for (const { name, line } of unused) {
    const near = nearMissing(name);
    const fix: OwnFix | null =
      near === null
        ? null
        : {
            label: text.renameTo(near),
            lines: [
              {
                file: OWN_FILE.env,
                line,
                text: envLines[line - 1]!.replace(name, near),
              },
            ],
            env: [],
          };
    issues.push({
      level: OWN_ISSUE_LEVEL.warning,
      file: OWN_FILE.env,
      line,
      message: near === null ? text.unusedSetting(name) : text.unusedNear(name, near),
      fix,
    });
  }
  lines.forEach((line, index) => {
    if (isBlank(line)) return;
    const pair = MAP_OR_LIST_PAIR.exec(line);
    if (pair !== null && SECRET_NAME.test(pair[4]!) && !pair[4]!.endsWith("_FILE")) {
      const value = pair[6]!.replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
      const isSetting = parentKeyOf(lines, index) === "environment";
      if (isSetting && value !== "" && !value.includes("$")) {
        const name = pair[4]!;
        const reference = pair[2] === undefined ? `${name}: \${${name}}` : `- ${name}=\${${name}}`;
        issues.push(
          compose(OWN_ISSUE_LEVEL.warning, index + 1, text.passwordInFile, {
            label: text.moveToEnv,
            lines: [{ file: OWN_FILE.compose, line: index + 1, text: `${pair[1]}${reference}` }],
            env: [{ name, value }],
          }),
        );
      }
    }
    const mount = /^\s*-\s+["']?([^"':\s]+):[^"'\s]+["']?\s*$/.exec(line)?.[1];
    if (mount === undefined || parentKeyOf(lines, index) !== "volumes") return;
    if (mount === DOCKER_SOCKET_PATH) issues.push(compose(OWN_ISSUE_LEVEL.warning, index + 1, text.socket));
    else if (mount.startsWith("/") && isDeniedSource(mount)) {
      issues.push(compose(OWN_ISSUE_LEVEL.warning, index + 1, text.hostSystem(mount)));
    }
  });
  return issues;
}

/** The first line whose indent cannot be right, with what it would be if it were: it says where Compose only guesses. */
export function misplacedLine(file: string): OwnIssue | null {
  const lines = linesOf(file);
  const tab = lines.findIndex((line) => /^\s*\t/.test(line));
  if (tab >= 0) {
    return compose(OWN_ISSUE_LEVEL.error, tab + 1, text.tab, {
      label: text.fixIt,
      lines: [
        {
          file: OWN_FILE.compose,
          line: tab + 1,
          text: lines[tab]!.replace(/^\s+/, (space) => space.replaceAll("\t", " ".repeat(INDENT_STEP))),
        },
      ],
      env: [],
    });
  }
  const levels: { indent: number; key: string }[] = [];
  let scalarAt: number | null = null;
  let previous: { line: string; index: number } | null = null;
  for (const [index, line] of lines.entries()) {
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    if (scalarAt !== null && indent > scalarAt) continue;
    scalarAt = null;
    const trimmed = line.trim();
    const isItem = trimmed.startsWith("- ");
    const before = previous;
    const opensBlock = before === null || /:\s*(#.*)?$/.test(before.line) || before.line.trimStart().startsWith("- ");
    if (before !== null && indent > indentOf(before.line) && !opensBlock) {
      // Under a line with no colon at all, the colon is what is missing.
      if (!before.line.includes(":")) {
        return compose(OWN_ISSUE_LEVEL.error, before.index + 1, text.colonMissing(before.line.trim()), {
          label: text.fixIt,
          lines: [{ file: OWN_FILE.compose, line: before.index + 1, text: `${before.line}:` }],
          env: [],
        });
      }
      return compose(OWN_ISSUE_LEVEL.error, index + 1, text.tooDeep(keyOf(trimmed), keyOf(before.line.trim())), {
        label: text.fixIt,
        lines: [{ file: OWN_FILE.compose, line: index + 1, text: `${" ".repeat(indentOf(before.line))}${trimmed}` }],
        env: [],
      });
    }
    let popped: { indent: number; key: string } | null = null;
    while (levels.length > 0 && levels.at(-1)!.indent > indent) popped = levels.pop()!;
    const top = levels.at(-1);
    if (popped !== null && top !== undefined && top.indent < indent && !isItem) {
      // Between two levels. What comes under it says which: a child at the deeper level makes it a parent, one above.
      const next = lines.slice(index + 1).find((each) => !isBlank(each));
      const parentOfThatLevel = /:\s*(#.*)?$/.test(trimmed) && next !== undefined && indentOf(next) === popped.indent;
      const target = parentOfThatLevel ? top : popped;
      return compose(
        OWN_ISSUE_LEVEL.error,
        index + 1,
        text.notLinedUp(keyOf(trimmed), indent, target.key, target.indent),
        {
          label: text.fixIt,
          lines: [{ file: OWN_FILE.compose, line: index + 1, text: `${" ".repeat(target.indent)}${trimmed}` }],
          env: [],
        },
      );
    }
    if (top === undefined || top.indent < indent) levels.push({ indent, key: keyOf(trimmed) });
    else top.key = keyOf(trimmed);
    if (/:\s*[|>][+-]?\s*(#.*)?$/.test(line)) scalarAt = indent;
    previous = { line, index };
  }
  return null;
}

const keyOf = (line: string) => line.replace(/^- /, "").split(":")[0]!.trim();

/** The line a place Compose names, such as services.wiki.ports.0, is written on. */
export function lineOfPath(file: string, path: string): number | null {
  const lines = linesOf(file);
  let from = 0;
  let indent = -1;
  let found: number | null = null;
  for (const segment of path.split(".")) {
    const isIndex = /^\d+$/.test(segment);
    let seen = 0;
    let hit: number | null = null;
    for (let at = from; at < lines.length; at += 1) {
      const line = lines[at]!;
      if (isBlank(line)) continue;
      const here = indentOf(line);
      const isItem = line.trimStart().startsWith("- ");
      if (here < indent || (here === indent && !isItem)) break;
      if (isIndex && isItem) {
        if (seen === Number(segment)) {
          hit = at;
          break;
        }
        seen += 1;
      }
      if (
        !isIndex &&
        new RegExp(`^["']?${segment.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}["']?\\s*:`).test(line.trim())
      ) {
        hit = at;
        break;
      }
    }
    if (hit === null) return found === null ? null : found + 1;
    found = hit;
    from = hit + 1;
    indent = indentOf(lines[hit]!);
  }
  return found === null ? null : found + 1;
}

const lineWith = (file: string, pattern: RegExp) => {
  const at = linesOf(file).findIndex((line) => !isBlank(line) && pattern.test(line));
  return at < 0 ? null : at + 1;
};

const YAML_ERROR = /go-yaml load error.*? at L(\d+)\.C\d+(?:-L(\d+)\.C\d+)?: (.+)$|yaml: line (\d+): (.+)$/m;

function yamlWords(said: string): string {
  if (/quoted scalar|unexpected end of stream/.test(said)) return text.quoteOpen;
  if (/mapping values are not allowed/.test(said)) return text.colonOut;
  return text.cannotRead(said);
}

/** What Compose said when it would not read the files, in plain words and at the line that needs changing. */
export function issuesOfComposeError(output: string, composeFile: string): OwnIssue[] {
  const said = output
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.includes("level=warning"))
    .join("\n")
    .trim();
  const yaml = YAML_ERROR.exec(said);
  if (yaml !== null) {
    const misplaced = misplacedLine(composeFile);
    if (misplaced !== null) return [misplaced];
    const line = Number(yaml[2] ?? yaml[1] ?? yaml[4]);
    return [compose(OWN_ISSUE_LEVEL.error, line, yamlWords(yaml[3] ?? yaml[5] ?? ""))];
  }
  const envLine = /\.env: line (\d+): (.+)$/m.exec(said);
  if (envLine !== null) {
    return [
      {
        level: OWN_ISSUE_LEVEL.error,
        file: OWN_FILE.env,
        line: Number(envLine[1]),
        message: text.envLine(envLine[2]!),
        fix: null,
      },
    ];
  }
  const required = /required variable (\w+) is missing a value/.exec(said);
  if (required !== null) {
    const name = required[1]!;
    return [
      compose(
        OWN_ISSUE_LEVEL.error,
        lineWith(composeFile, new RegExp(`\\$\\{?${name}\\b`)),
        text.variableMissing(name),
        { label: text.addToEnv, lines: [], env: [{ name, value: null }] },
      ),
    ];
  }
  const noImage = /service "([^"]+)" has neither an image nor a build context/.exec(said);
  if (noImage !== null) {
    return [
      compose(OWN_ISSUE_LEVEL.error, lineOfPath(composeFile, `services.${noImage[1]}`), text.noImage(noImage[1]!)),
    ];
  }
  const dependency = /service "([^"]+)" depends on undefined service "([^"]+)"/.exec(said);
  if (dependency !== null) {
    const [, service, other] = dependency as unknown as [string, string, string];
    return [
      compose(
        OWN_ISSUE_LEVEL.error,
        lineOfPath(composeFile, `services.${service}.depends_on`),
        text.noSuchService(service, other),
      ),
    ];
  }
  const undefinedThing = /service "([^"]+)" refers to undefined (volume|network) (\S+?):?(?:\s|$)/.exec(said);
  if (undefinedThing !== null) {
    const [, service, kind, name] = undefinedThing as unknown as [string, string, string, string];
    return [
      compose(
        OWN_ISSUE_LEVEL.error,
        lineOfPath(composeFile, `services.${service}.${kind}s`),
        text.undefinedThing(kind, name),
      ),
    ];
  }
  const validating = /validating [^:]+: (\S+) (.+)$/m.exec(said);
  if (validating !== null) {
    const path = validating[1]!;
    const unknownKey = /false schema|not allowed/.test(validating[2]!);
    const last = path.split(".").at(-1)!;
    return [
      compose(
        OWN_ISSUE_LEVEL.error,
        lineOfPath(composeFile, path),
        unknownKey ? text.unknownSetting(last) : text.wrongShape(last, validating[2]!),
      ),
    ];
  }
  const envFile = /env file \S*?([^/\s]+) not found/.exec(said);
  if (envFile !== null) {
    return [
      compose(
        OWN_ISSUE_LEVEL.error,
        lineWith(composeFile, new RegExp(envFile[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
        text.envFileMissing(envFile[1]!),
      ),
    ];
  }
  if (/empty compose file|no service/.test(said)) return [compose(OWN_ISSUE_LEVEL.error, 1, text.noServices)];
  const value = /invalid \w+: (\S+)/.exec(said)?.[1];
  const line =
    value === undefined ? null : lineWith(composeFile, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return [compose(OWN_ISSUE_LEVEL.error, line, text.composeSaid(said))];
}

/** The files after a fix: its lines replaced, its settings set in the .env, a password made up where none is given. */
export function withFix(
  files: { compose: string; env: string },
  fix: OwnFix,
  makeSecret: () => string,
): { compose: string; env: string } {
  const edited = (file: string, kind: OwnFix["lines"][number]["file"]) => {
    const lines = file.split("\n");
    for (const change of fix.lines) {
      if (change.file === kind && change.line <= lines.length) lines[change.line - 1] = change.text;
    }
    return lines.join("\n");
  };
  let env = edited(files.env, OWN_FILE.env);
  for (const { name, value } of fix.env) {
    const line = dotenvLine(name, value ?? (SECRET_NAME.test(name) ? makeSecret() : ""));
    const lines = env === "" ? [] : env.replace(/\n$/, "").split("\n");
    const at = lines.findIndex((each) => ENV_LINE.exec(each)?.[1] === name);
    if (at >= 0) lines[at] = line;
    else lines.push(line);
    env = `${lines.join("\n")}\n`;
  }
  return { compose: edited(files.compose, OWN_FILE.compose), env };
}

/** Compose's own name for a project, from the folder it is started in. */
export const projectNameOf = (folder: string) =>
  (folder.split("/").at(-1) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+/, "");

/** The first service a file names, to call the app by until a person says otherwise. */
export function firstServiceOf(file: string): string | null {
  const lines = linesOf(file);
  const top = lines.findIndex((line) => /^services:\s*(#.*)?$/.test(line));
  if (top < 0) return null;
  const first = lines.slice(top + 1).find((line) => !isBlank(line));
  if (first === undefined || indentOf(first) === 0) return null;
  return keyOf(first.trim()).replace(/^["']|["']$/g, "") || null;
}

export const hasBlockingIssue = (issues: readonly OwnIssue[]) =>
  issues.some(({ level }) => level === OWN_ISSUE_LEVEL.error);
