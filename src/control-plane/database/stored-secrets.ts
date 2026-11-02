import type Database from "better-sqlite3";
import { SETTING_KEYS } from "../../shared/constants.js";
import { isSealed, type SecretBox } from "./secret-box.js";

interface StoredSecret {
  value: string;
  replace: (sealed: string) => void;
}

interface UserSecrets {
  id: string;
  active: string | null;
  pending: string | null;
}

// The settings that keep a secret, and where: each one's token, and a webhook's address, which holds Discord's and
// Slack's key.
const INTEGRATION_SECRETS = [
  { key: SETTING_KEYS.gotify, fields: ["token"] },
  { key: SETTING_KEYS.ntfy, fields: ["token"] },
  { key: SETTING_KEYS.homeAssistant, fields: ["token"] },
  { key: SETTING_KEYS.webhook, fields: ["url", "token"] },
  { key: SETTING_KEYS.router, fields: ["password"] },
] as const;

const secretIn = (value: string | null, write: (sealed: string) => unknown): StoredSecret[] =>
  value === null ? [] : [{ value, replace: (sealed) => void write(sealed) }];

function parsedObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function userSecrets(sqlite: Database.Database): StoredSecret[] {
  const rows = sqlite
    .prepare("SELECT id, totp_secret AS active, totp_pending_secret AS pending FROM users")
    .all() as UserSecrets[];
  const writer = (column: "totp_secret" | "totp_pending_secret", id: string) => (sealed: string) =>
    sqlite.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(sealed, id);
  return rows.flatMap((user) => [
    ...secretIn(user.active, writer("totp_secret", user.id)),
    ...secretIn(user.pending, writer("totp_pending_secret", user.id)),
  ]);
}

// A backup from before the settings table has none to read.
function integrationSecrets(sqlite: Database.Database): StoredSecret[] {
  const hasSettings =
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() !== undefined;
  if (!hasSettings) {
    return [];
  }
  return INTEGRATION_SECRETS.flatMap(({ key, fields }) => {
    const row = sqlite.prepare("SELECT value_json AS json FROM settings WHERE key = ?").get(key) as
      { json: string } | undefined;
    const setting = row === undefined ? null : parsedObject(row.json);
    if (setting === null) {
      return [];
    }
    return fields.flatMap((field) => {
      const value = setting[field];
      if (typeof value !== "string") {
        return [];
      }
      // Each sealed field goes into the same object, so sealing a webhook's token keeps its sealed address.
      return secretIn(value, (sealed) => {
        setting[field] = sealed;
        sqlite.prepare("UPDATE settings SET value_json = ? WHERE key = ?").run(JSON.stringify(setting), key);
      });
    });
  });
}

// Secret columns kept row by row: SSH keys and their passphrases, and an SSH host's runner token.
const COLUMN_SECRETS = [
  { table: "ssh_keys", column: "private_key" },
  { table: "ssh_keys", column: "passphrase" },
  { table: "hosts", column: "ssh_runner_token" },
  { table: "hosts", column: "ssh_root_password" },
] as const;

// Only where the table has the column: a backup from before them has none.
function columnSecrets(sqlite: Database.Database): StoredSecret[] {
  return COLUMN_SECRETS.flatMap(({ table, column }) => {
    const columns = sqlite.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[];
    if (!columns.some(({ name }) => name === column)) {
      return [];
    }
    const rows = sqlite
      .prepare(`SELECT rowid AS rowId, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as { rowId: number; value: string }[];
    return rows.flatMap(({ rowId, value }) =>
      secretIn(value, (sealed) =>
        sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(sealed, rowId),
      ),
    );
  });
}

/**
 * Every secret the database keeps: each account's authenticator seed, in use or being set up, each integration's
 * token, a webhook's address, each SSH key and its passphrase, and each SSH host's runner token.
 */
function storedSecrets(sqlite: Database.Database): StoredSecret[] {
  return [...userSecrets(sqlite), ...integrationSecrets(sqlite), ...columnSecrets(sqlite)];
}

const countUnreadable = (secrets: readonly StoredSecret[], secretBox: SecretBox) =>
  secrets.filter((secret) => isSealed(secret.value) && secretBox.open(secret.value) === null).length;

/** Seals what an older Autoheal left in plain text, and counts the sealed values this key cannot open. */
export function sealStoredSecrets(sqlite: Database.Database, secretBox: SecretBox) {
  return sqlite.transaction(() => {
    const secrets = storedSecrets(sqlite);
    const plain = secrets.filter((secret) => !isSealed(secret.value));
    plain.forEach((secret) => secret.replace(secretBox.seal(secret.value)));
    return { sealed: plain.length, unreadable: countUnreadable(secrets, secretBox) };
  })();
}

/** The sealed secrets in a database, a backup's included, that this key cannot open. */
export function unreadableSecrets(sqlite: Database.Database, secretBox: SecretBox): number {
  return countUnreadable(storedSecrets(sqlite), secretBox);
}
