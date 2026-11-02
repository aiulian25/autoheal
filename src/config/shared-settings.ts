import type { WebhookFormat } from "../shared/constants.js";

export interface OllamaSettings {
  url: string;
  model: string;
  contextTokens: number;
}

export interface GotifySettings {
  url: string;
  token: string;
}

export interface HomeAssistantSettings {
  url: string;
  token: string;
}

export interface NtfySettings {
  url: string;
  topic: string;
  // An access token for a protected topic; null for an open one.
  token: string | null;
}

export interface WebhookSettings {
  url: string;
  // A bearer token, for a receiver that wants one; null when the key is in the address, as Discord's and Slack's are.
  token: string | null;
  format: WebhookFormat;
}

export function gotifySettings(url: string | undefined, token: string | undefined): GotifySettings | null {
  if (url === undefined || token === undefined) {
    return null;
  }
  return { url, token };
}
