import {
  ENVIRONMENT_ENTRY_SEPARATOR,
  NOT_SECRET_VALUE_PATTERN,
  REDACTED,
  REDACTION_MINIMUM_VALUE_LENGTH,
  SECRET_PATTERNS,
  YAML_SECRET_KEY,
  redactedEnvironmentValue,
} from "./constants.js";

function secretEnvironmentValues(environment: readonly string[]): [name: string, value: string][] {
  return environment
    .flatMap((entry): [string, string][] => {
      const separatorAt = entry.indexOf(ENVIRONMENT_ENTRY_SEPARATOR);
      return separatorAt < 0 ? [] : [[entry.slice(0, separatorAt), entry.slice(separatorAt + 1)]];
    })
    .filter(([, value]) => value.length >= REDACTION_MINIMUM_VALUE_LENGTH && !NOT_SECRET_VALUE_PATTERN.test(value))
    .sort(([, first], [, second]) => second.length - first.length);
}

/**
 * Mask secrets before text leaves the host: the container's own environment values (from the
 * `docker inspect` the runner already does), then well-known token and password shapes.
 */
export function redactSecrets(text: string, environment: readonly string[] = []): string {
  const withoutEnvironmentValues = secretEnvironmentValues(environment).reduce(
    (redacted, [name, value]) => redacted.replaceAll(value, redactedEnvironmentValue(name)),
    text,
  );
  return SECRET_PATTERNS.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    withoutEnvironmentValues,
  );
}

const indentationOf = (line: string) => line.length - line.trimStart().length;

/**
 * Mask secrets in YAML before it leaves the host. A key named like a secret keeps its name and loses its value, however
 * that is written: bare words, a block, a quote that wraps, or a mapping of secrets indented under it. Then as text.
 */
export function redactYamlSecrets(yaml: string): string {
  const kept: string[] = [];
  let secretKeyColumn: number | null = null;
  for (const line of yaml.split("\n")) {
    const partOfSecret = secretKeyColumn !== null && (line.trim() === "" || indentationOf(line) > secretKeyColumn);
    if (partOfSecret) continue;
    const secret = YAML_SECRET_KEY.exec(line);
    secretKeyColumn = secret === null ? null : secret[1]!.length;
    kept.push(secret === null ? line : `${secret[1]}${secret[2]} ${REDACTED}`);
  }
  return redactSecrets(kept.join("\n"));
}
