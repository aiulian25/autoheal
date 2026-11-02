import {
  ENVIRONMENT_ENTRY_SEPARATOR,
  NOT_SECRET_VALUE_PATTERN,
  REDACTION_MINIMUM_VALUE_LENGTH,
  SECRET_PATTERNS,
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
