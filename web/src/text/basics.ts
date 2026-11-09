import { MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from "../../../src/shared/constants.js";

// What the dashboard's constants and its text are both built from, apart from either: each text file uses
// them without reading constants.ts, which reads the text files.

export const SEPARATOR = " · ";

export const SECONDS_PER_MINUTE = MILLISECONDS_PER_MINUTE / MILLISECONDS_PER_SECOND;

// The sections of the settings page, each an anchor the rest of the dashboard can link to.
export const SETTINGS_SECTIONS = {
  connections: "connections",
  notifications: "notifications",
  schedules: "schedules",
  backups: "backups",
  people: "people",
  system: "system",
  account: "account",
} as const;
