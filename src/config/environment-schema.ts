import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  CONFIG_MESSAGES,
  HTTPS_PROTOCOL_PATTERN,
  LIST_SEPARATOR,
  SERVICE_PROTOCOL_PATTERN,
} from "../shared/constants.js";

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(CONFIG_MESSAGES.invalid(problems));
    this.name = "ConfigError";
  }
}

// An empty line in a .env file means "not set", not "set to nothing".
const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);

const requiredOr = (message: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? CONFIG_MESSAGES.required : message;

export const text = () => z.preprocess(blankToUndefined, z.string(CONFIG_MESSAGES.required));

export const optionalText = () => z.preprocess(blankToUndefined, z.string().optional());

export const httpsUrl = () =>
  z.preprocess(
    blankToUndefined,
    z.url({ protocol: HTTPS_PROTOCOL_PATTERN, error: requiredOr(CONFIG_MESSAGES.httpsUrl) }),
  );

export const optionalHttpsUrl = () =>
  z.preprocess(
    blankToUndefined,
    z.url({ protocol: HTTPS_PROTOCOL_PATTERN, error: CONFIG_MESSAGES.httpsUrl }).optional(),
  );

// Ollama, Home Assistant, Gotify, ntfy: plain http is accepted; the control plane warns about it.
export const serviceUrl = () =>
  z.preprocess(
    blankToUndefined,
    z.url({ protocol: SERVICE_PROTOCOL_PATTERN, error: requiredOr(CONFIG_MESSAGES.serviceUrl) }),
  );

export const optionalServiceUrl = () =>
  z.preprocess(
    blankToUndefined,
    z.url({ protocol: SERVICE_PROTOCOL_PATTERN, error: CONFIG_MESSAGES.serviceUrl }).optional(),
  );

export const existingFile = () => text().refine((path) => existsSync(path), CONFIG_MESSAGES.fileMissing);

// A secret kept in its own file (a Docker secret, a mounted file): it must exist and not be empty.
export const optionalSecretFile = () =>
  optionalText().pipe(
    z
      .string()
      .superRefine((path, context) => {
        if (!existsSync(path)) {
          context.addIssue({ code: "custom", message: CONFIG_MESSAGES.fileMissing });
          return;
        }
        if (readFileSync(path, "utf8").trim().length === 0) {
          context.addIssue({ code: "custom", message: CONFIG_MESSAGES.fileEmpty });
        }
      })
      .optional(),
  );

export const wholeNumber = (minimum: number, fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: CONFIG_MESSAGES.wholeNumber })
      .int(CONFIG_MESSAGES.wholeNumber)
      .min(minimum, CONFIG_MESSAGES.atLeast(minimum))
      .default(fallback),
  );

export const flag = (fallback: boolean) =>
  z.preprocess(blankToUndefined, z.stringbool({ error: CONFIG_MESSAGES.booleanFlag }).default(fallback));

export const list = <Item extends z.ZodType<string>>(item: Item) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(LIST_SEPARATOR)
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    z.array(item),
  );

export function requireBothOrNeither(
  values: Record<string, unknown>,
  context: z.RefinementCtx,
  first: string,
  second: string,
) {
  if (Boolean(values[first]) === Boolean(values[second])) {
    return;
  }
  context.addIssue({
    code: "custom",
    path: [values[first] ? second : first],
    message: CONFIG_MESSAGES.setBothOrNeither(first, second),
  });
}

export function parseEnvironment<Schema extends z.ZodType>(
  schema: Schema,
  environment: NodeJS.ProcessEnv,
): z.output<Schema> {
  const result = schema.safeParse(environment);
  if (result.success) {
    return result.data;
  }
  throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
}
