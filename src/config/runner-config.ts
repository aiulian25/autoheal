import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ABSOLUTE_PATH_PREFIX,
  RUNNER_TOKEN_PATTERN,
  CONFIG_MESSAGES,
  DEFAULT_DOCKER_SOCKET_PATH,
  DEFAULT_DRY_RUN,
  DEFAULT_HOST_DBUS_DIRECTORY,
  DEFAULT_HOST_LABEL,
  DEFAULT_HOST_ROOT,
  DEFAULT_OLLAMA_CONTEXT_TOKENS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SELF_CONTAINER_NAME,
  DEFAULT_UPDATE_CHECKPOINT_LIMIT_GB,
  ENV_RUNNER_TOKEN,
  ENV_CONTROL_PLANE_URL,
  ENV_DOCKER_SOCKET_PATH,
  ENV_DRY_RUN,
  ENV_GOTIFY_TOKEN,
  ENV_GOTIFY_URL,
  ENV_HOST_DBUS_DIRECTORY,
  ENV_HOST_FILESYSTEMS,
  ENV_HOST_LABEL,
  ENV_HOST_PACKAGES,
  ENV_CONTAINER_ACCESS,
  ENV_HOST_DEPLOY,
  ENV_HOST_TERMINAL,
  ENV_HOST_TERMINAL_USER,
  ENV_HOST_ROOT,
  ENV_JOIN_CODE,
  ENV_OLLAMA_CONTEXT_TOKENS,
  ENV_OLLAMA_MODEL,
  ENV_OLLAMA_URL,
  ENV_PROTECTED_CONTAINERS,
  ENV_PUBLIC_BASE_URL,
  ENV_SELF_CONTAINER_NAME,
  ENV_UPDATE_CHECKPOINT_LIMIT_GB,
  BYTES_PER_GIGABYTE,
  HOST_LABEL_DISALLOWED,
  HOST_LABEL_MAXIMUM_LENGTH,
  HOST_LABEL_PATTERN,
  HOST_LABEL_REPLACEMENT,
  HOST_NAME_FILE,
  JOIN_DIRECTORY,
  JOIN_FILE_NAME,
  MINIMUM_OLLAMA_CONTEXT_TOKENS,
  HOST_PACKAGES,
  CONTAINER_ACCESS,
  CONTAINER_ACCESS_SETTINGS,
  HOST_DEPLOY,
  HOST_DEPLOY_SETTINGS,
  HOST_TERMINAL,
  HOST_TERMINAL_HELPER,
  HOST_TERMINAL_SETTINGS,
  HOST_PACKAGES_SETTINGS,
  type HostPackagesSetting,
  SELF_UPDATE,
} from "../shared/constants.js";
import { decodeJoinCode, type JoinDetails } from "../shared/join-code.js";
import {
  ConfigError,
  flag,
  list,
  optionalHttpsUrl,
  optionalServiceUrl,
  optionalText,
  parseEnvironment,
  requireBothOrNeither,
  wholeNumber,
} from "./environment-schema.js";
import { gotifySettings, type GotifySettings, type OllamaSettings } from "./shared-settings.js";

export interface ControlPlaneSettings {
  url: string;
  token: string;
  // The control plane's public key, from a join code; null for an older setup that trusts a CA.
  pin: string | null;
}

export interface RunnerConfig {
  hostLabel: string;
  selfContainerName: string;
  controlPlane: ControlPlaneSettings | null;
  // Where the join code came from, when it was the join volume: read again if the control plane's key changes.
  joinFile: string | null;
  // Null to use the dashboard's address, which the control plane sends.
  publicBaseUrl: string | null;
  // Null to use the control plane's Ollama, which it sends; required for a runner on its own.
  ollama: OllamaSettings | null;
  gotify: GotifySettings | null;
  dryRun: boolean;
  // Always contains the runner's own container.
  protectedContainers: ReadonlySet<string>;
  dockerSocketPath: string;
  hostRoot: string;
  hostFilesystems: string[];
  // What this host lets its runner do with its packages; only its own .env can raise it.
  hostPackages: HostPackagesSetting;
  hostDbusDirectory: string;
  // Whether a person may open shells, browse files and edit containers here from the dashboard.
  containerAccess: boolean;
  // Whether an admin may open a shell on the host itself from the dashboard.
  hostTerminal: boolean;
  // Whose login shell that is on a runner's host; root where none is named.
  hostTerminalUser: string | null;
  hostDeploy: boolean;
  // How much of a container's data an update keeps aside first; 0 keeps none.
  checkpointLimitBytes: number;
}

export const DEFAULT_JOIN_FILE = join(JOIN_DIRECTORY, JOIN_FILE_NAME);

const joinCode = () =>
  optionalText().pipe(
    z
      .string()
      .transform((code, context) => {
        const details = decodeJoinCode(code.trim());
        if (details === null) {
          context.addIssue({ code: "custom", message: CONFIG_MESSAGES.joinCode });
          return z.NEVER;
        }
        return details;
      })
      .optional(),
  );

const runnerEnvironmentSchema = z
  .object({
    [ENV_HOST_LABEL]: optionalText().pipe(z.string().regex(HOST_LABEL_PATTERN, CONFIG_MESSAGES.hostLabel).optional()),
    [ENV_SELF_CONTAINER_NAME]: optionalText().transform((name) => name ?? DEFAULT_SELF_CONTAINER_NAME),
    [ENV_JOIN_CODE]: joinCode(),
    [ENV_CONTROL_PLANE_URL]: optionalHttpsUrl(),
    [ENV_RUNNER_TOKEN]: optionalText().pipe(
      z.string().regex(RUNNER_TOKEN_PATTERN, CONFIG_MESSAGES.runnerToken).optional(),
    ),
    [ENV_PUBLIC_BASE_URL]: optionalHttpsUrl(),
    [ENV_OLLAMA_URL]: optionalServiceUrl(),
    [ENV_OLLAMA_MODEL]: optionalText().transform((model) => model ?? DEFAULT_OLLAMA_MODEL),
    [ENV_OLLAMA_CONTEXT_TOKENS]: wholeNumber(MINIMUM_OLLAMA_CONTEXT_TOKENS, DEFAULT_OLLAMA_CONTEXT_TOKENS),
    [ENV_GOTIFY_URL]: optionalServiceUrl(),
    [ENV_GOTIFY_TOKEN]: optionalText(),
    [ENV_DRY_RUN]: flag(DEFAULT_DRY_RUN),
    [ENV_PROTECTED_CONTAINERS]: list(z.string()),
    [ENV_DOCKER_SOCKET_PATH]: optionalText().transform((path) => path ?? DEFAULT_DOCKER_SOCKET_PATH),
    [ENV_HOST_ROOT]: optionalText().transform((path) => path ?? DEFAULT_HOST_ROOT),
    // None listed: every local disk the host has mounted.
    [ENV_HOST_FILESYSTEMS]: list(z.string().startsWith(ABSOLUTE_PATH_PREFIX, CONFIG_MESSAGES.absolutePaths)),
    [ENV_HOST_PACKAGES]: optionalText().pipe(
      z.enum(HOST_PACKAGES_SETTINGS, { error: CONFIG_MESSAGES.hostPackages }).default(HOST_PACKAGES.off),
    ),
    [ENV_CONTAINER_ACCESS]: optionalText().pipe(
      z.enum(CONTAINER_ACCESS_SETTINGS, { error: CONFIG_MESSAGES.containerAccess }).default(CONTAINER_ACCESS.on),
    ),
    [ENV_HOST_DEPLOY]: optionalText().pipe(
      z.enum(HOST_DEPLOY_SETTINGS, { error: CONFIG_MESSAGES.hostDeploy }).default(HOST_DEPLOY.on),
    ),
    [ENV_HOST_TERMINAL]: optionalText().pipe(
      z.enum(HOST_TERMINAL_SETTINGS, { error: CONFIG_MESSAGES.hostTerminal }).default(HOST_TERMINAL.on),
    ),
    [ENV_HOST_TERMINAL_USER]: optionalText().pipe(
      z.string().regex(HOST_TERMINAL_HELPER.userName, CONFIG_MESSAGES.hostTerminalUser).optional(),
    ),
    [ENV_HOST_DBUS_DIRECTORY]: optionalText().pipe(
      z.string().startsWith(ABSOLUTE_PATH_PREFIX, CONFIG_MESSAGES.absolutePaths).default(DEFAULT_HOST_DBUS_DIRECTORY),
    ),
    [ENV_UPDATE_CHECKPOINT_LIMIT_GB]: wholeNumber(0, DEFAULT_UPDATE_CHECKPOINT_LIMIT_GB),
  })
  .superRefine((values, context) => {
    // A join code carries both; CONTROL_PLANE_URL alone then only moves where it points.
    if (values[ENV_JOIN_CODE] === undefined) {
      requireBothOrNeither(values, context, ENV_CONTROL_PLANE_URL, ENV_RUNNER_TOKEN);
    }
    requireBothOrNeither(values, context, ENV_GOTIFY_URL, ENV_GOTIFY_TOKEN);
  });

/** The join code the control plane left for this machine's runner in the shared volume, if any. */
export function joinCodeInFile(path: string): JoinDetails | null {
  return existsSync(path) ? decodeJoinCode(readFileSync(path, "utf8").trim()) : null;
}

/** The host's own name, made into a label: what a runner calls its host unless told otherwise. */
function hostnameLabel(hostRoot: string): string | null {
  const path = join(hostRoot, HOST_NAME_FILE);
  if (!existsSync(path)) {
    return null;
  }
  const label = readFileSync(path, "utf8")
    .trim()
    .replace(HOST_LABEL_DISALLOWED, HOST_LABEL_REPLACEMENT)
    .slice(0, HOST_LABEL_MAXIMUM_LENGTH);
  return HOST_LABEL_PATTERN.test(label) ? label : null;
}

function controlPlaneOf(
  fromEnvironment: JoinDetails | undefined,
  fromFile: JoinDetails | null,
  legacy: { url: string | undefined; token: string | undefined },
): ControlPlaneSettings | null {
  const joined = fromEnvironment ?? fromFile;
  if (joined !== null) {
    return { ...joined, url: legacy.url ?? joined.url };
  }
  if (legacy.url === undefined || legacy.token === undefined) {
    return null;
  }
  return { url: legacy.url, token: legacy.token, pin: null };
}

export function loadRunnerConfig(environment: NodeJS.ProcessEnv, joinFile: string = DEFAULT_JOIN_FILE): RunnerConfig {
  const values = parseEnvironment(runnerEnvironmentSchema, environment);
  const fromFile = values[ENV_JOIN_CODE] === undefined ? joinCodeInFile(joinFile) : null;
  const controlPlane = controlPlaneOf(values[ENV_JOIN_CODE], fromFile, {
    url: values[ENV_CONTROL_PLANE_URL],
    token: values[ENV_RUNNER_TOKEN],
  });
  const ollamaUrl = values[ENV_OLLAMA_URL];
  // On its own, a runner has nobody else to tell it where Ollama is.
  if (controlPlane === null && ollamaUrl === undefined) {
    throw new ConfigError([`${ENV_OLLAMA_URL}: ${CONFIG_MESSAGES.runnerNeedsOllama}`]);
  }
  const ollama =
    ollamaUrl === undefined
      ? null
      : { url: ollamaUrl, model: values[ENV_OLLAMA_MODEL], contextTokens: values[ENV_OLLAMA_CONTEXT_TOKENS] };
  const selfContainerName = values[ENV_SELF_CONTAINER_NAME];
  const hostRoot = values[ENV_HOST_ROOT];
  return {
    hostLabel: values[ENV_HOST_LABEL] ?? hostnameLabel(hostRoot) ?? DEFAULT_HOST_LABEL,
    selfContainerName,
    controlPlane,
    joinFile: fromFile === null ? null : joinFile,
    publicBaseUrl: values[ENV_PUBLIC_BASE_URL] ?? null,
    ollama,
    gotify: gotifySettings(values[ENV_GOTIFY_URL], values[ENV_GOTIFY_TOKEN]),
    dryRun: values[ENV_DRY_RUN],
    // Itself, and what its own update runs beside it: the helper doing the swap and the copy kept for going back.
    protectedContainers: new Set([
      ...values[ENV_PROTECTED_CONTAINERS],
      selfContainerName,
      `${selfContainerName}${SELF_UPDATE.previousSuffix}`,
      SELF_UPDATE.helperName,
    ]),
    dockerSocketPath: values[ENV_DOCKER_SOCKET_PATH],
    hostRoot,
    hostFilesystems: values[ENV_HOST_FILESYSTEMS],
    hostPackages: values[ENV_HOST_PACKAGES],
    hostDbusDirectory: values[ENV_HOST_DBUS_DIRECTORY],
    containerAccess: values[ENV_CONTAINER_ACCESS] === CONTAINER_ACCESS.on,
    hostTerminal: values[ENV_HOST_TERMINAL] === HOST_TERMINAL.on,
    hostTerminalUser: values[ENV_HOST_TERMINAL_USER] ?? null,
    hostDeploy: values[ENV_HOST_DEPLOY] === HOST_DEPLOY.on,
    checkpointLimitBytes: values[ENV_UPDATE_CHECKPOINT_LIMIT_GB] * BYTES_PER_GIGABYTE,
  };
}
