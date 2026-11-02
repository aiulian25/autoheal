import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  CONFIG_MESSAGES,
  DEFAULT_AUTOHEAL_IMAGE,
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_OLLAMA_CONTEXT_TOKENS,
  DEFAULT_OLLAMA_MODEL,
  ENV_AUTOHEAL_IMAGE,
  ENV_BACKUP_PASSPHRASE,
  ENV_DATA_DIRECTORY,
  ENV_GOTIFY_TOKEN,
  ENV_GOTIFY_URL,
  ENV_HOME_ASSISTANT_TOKEN_FILE,
  ENV_HOME_ASSISTANT_URL,
  ENV_NTFY_TOKEN_FILE,
  ENV_NTFY_TOPIC,
  ENV_NTFY_URL,
  ENV_OFFBOX_BACKUP_DIRECTORY,
  ENV_OLLAMA_CONTEXT_TOKENS,
  ENV_OLLAMA_MODEL,
  ENV_OLLAMA_URL,
  ENV_PUBLIC_BASE_URL,
  ENV_TLS_CERTIFICATE_FILE,
  ENV_TLS_KEY_FILE,
  ENV_TRUSTED_PROXY_ADDRESSES,
  MINIMUM_BACKUP_PASSPHRASE_LENGTH,
  MINIMUM_OLLAMA_CONTEXT_TOKENS,
  NTFY_TOPIC_PATTERN,
} from "../shared/constants.js";
import {
  existingFile,
  httpsUrl,
  list,
  optionalSecretFile,
  optionalServiceUrl,
  optionalText,
  parseEnvironment,
  requireBothOrNeither,
  serviceUrl,
  wholeNumber,
} from "./environment-schema.js";
import {
  gotifySettings,
  type GotifySettings,
  type HomeAssistantSettings,
  type NtfySettings,
  type OllamaSettings,
} from "./shared-settings.js";

export interface ControlPlaneConfig {
  publicBaseUrl: string;
  publicOrigin: string;
  publicHost: string;
  // The dashboard's host name or address, without port: what Autoheal's own certificate is made for.
  publicHostname: string;
  // The operator's own certificate; null to let Autoheal make one and keep it in the data directory.
  tls: { certificateFile: string; keyFile: string } | null;
  trustedProxyAddresses: string[];
  dataDirectory: string;
  offboxBackupDirectory: string | null;
  // Null to let Autoheal make one and keep it in the data directory.
  backupPassphrase: string | null;
  ollama: OllamaSettings;
  gotify: GotifySettings | null;
  ntfy: NtfySettings | null;
  homeAssistant: HomeAssistantSettings | null;
  // The image new runners should run, in the install commands the dashboard gives.
  autohealImage: string;
}

// One trusted proxy: an address, or a range of them. Settings takes the same, within narrower bounds.
export const proxyAddress = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()], {
  error: CONFIG_MESSAGES.proxyAddress,
});

const controlPlaneEnvironmentSchema = z
  .object({
    [ENV_PUBLIC_BASE_URL]: httpsUrl(),
    [ENV_TLS_CERTIFICATE_FILE]: existingFile().optional(),
    [ENV_TLS_KEY_FILE]: existingFile().optional(),
    [ENV_TRUSTED_PROXY_ADDRESSES]: list(proxyAddress),
    [ENV_DATA_DIRECTORY]: optionalText().transform((directory) => directory ?? DEFAULT_DATA_DIRECTORY),
    [ENV_OFFBOX_BACKUP_DIRECTORY]: optionalText(),
    [ENV_BACKUP_PASSPHRASE]: optionalText().pipe(
      z.string().min(MINIMUM_BACKUP_PASSPHRASE_LENGTH, CONFIG_MESSAGES.passphraseLength).optional(),
    ),
    [ENV_OLLAMA_URL]: serviceUrl(),
    [ENV_OLLAMA_MODEL]: optionalText().transform((model) => model ?? DEFAULT_OLLAMA_MODEL),
    [ENV_OLLAMA_CONTEXT_TOKENS]: wholeNumber(MINIMUM_OLLAMA_CONTEXT_TOKENS, DEFAULT_OLLAMA_CONTEXT_TOKENS),
    [ENV_GOTIFY_URL]: optionalServiceUrl(),
    [ENV_GOTIFY_TOKEN]: optionalText(),
    [ENV_HOME_ASSISTANT_URL]: optionalServiceUrl(),
    [ENV_HOME_ASSISTANT_TOKEN_FILE]: optionalSecretFile(),
    [ENV_NTFY_URL]: optionalServiceUrl(),
    [ENV_NTFY_TOPIC]: optionalText().pipe(z.string().regex(NTFY_TOPIC_PATTERN, CONFIG_MESSAGES.ntfyTopic).optional()),
    [ENV_NTFY_TOKEN_FILE]: optionalSecretFile(),
    [ENV_AUTOHEAL_IMAGE]: optionalText().transform((image) => image ?? DEFAULT_AUTOHEAL_IMAGE),
  })
  .superRefine((values, context) => {
    requireBothOrNeither(values, context, ENV_TLS_CERTIFICATE_FILE, ENV_TLS_KEY_FILE);
    requireBothOrNeither(values, context, ENV_GOTIFY_URL, ENV_GOTIFY_TOKEN);
    requireBothOrNeither(values, context, ENV_HOME_ASSISTANT_URL, ENV_HOME_ASSISTANT_TOKEN_FILE);
    requireBothOrNeither(values, context, ENV_NTFY_URL, ENV_NTFY_TOPIC);
  });

// A token is read once, here; it never reaches the database, a log or the dashboard.
function ntfySettings(
  url: string | undefined,
  topic: string | undefined,
  tokenFile: string | undefined,
): NtfySettings | null {
  if (url === undefined || topic === undefined) {
    return null;
  }
  return { url, topic, token: tokenFile === undefined ? null : readFileSync(tokenFile, "utf8").trim() };
}

function homeAssistantSettings(url: string | undefined, tokenFile: string | undefined): HomeAssistantSettings | null {
  if (url === undefined || tokenFile === undefined) {
    return null;
  }
  return { url, token: readFileSync(tokenFile, "utf8").trim() };
}

export function loadControlPlaneConfig(environment: NodeJS.ProcessEnv): ControlPlaneConfig {
  const values = parseEnvironment(controlPlaneEnvironmentSchema, environment);
  const publicUrl = new URL(values[ENV_PUBLIC_BASE_URL]);
  const certificateFile = values[ENV_TLS_CERTIFICATE_FILE];
  const keyFile = values[ENV_TLS_KEY_FILE];
  return {
    publicBaseUrl: values[ENV_PUBLIC_BASE_URL],
    publicOrigin: publicUrl.origin,
    publicHost: publicUrl.host,
    publicHostname: publicUrl.hostname,
    tls: certificateFile === undefined || keyFile === undefined ? null : { certificateFile, keyFile },
    trustedProxyAddresses: values[ENV_TRUSTED_PROXY_ADDRESSES],
    dataDirectory: values[ENV_DATA_DIRECTORY],
    offboxBackupDirectory: values[ENV_OFFBOX_BACKUP_DIRECTORY] ?? null,
    backupPassphrase: values[ENV_BACKUP_PASSPHRASE] ?? null,
    ollama: {
      url: values[ENV_OLLAMA_URL],
      model: values[ENV_OLLAMA_MODEL],
      contextTokens: values[ENV_OLLAMA_CONTEXT_TOKENS],
    },
    gotify: gotifySettings(values[ENV_GOTIFY_URL], values[ENV_GOTIFY_TOKEN]),
    ntfy: ntfySettings(values[ENV_NTFY_URL], values[ENV_NTFY_TOPIC], values[ENV_NTFY_TOKEN_FILE]),
    homeAssistant: homeAssistantSettings(values[ENV_HOME_ASSISTANT_URL], values[ENV_HOME_ASSISTANT_TOKEN_FILE]),
    autohealImage: values[ENV_AUTOHEAL_IMAGE],
  };
}
