import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BACKUP_PASSPHRASE_BYTES,
  BACKUP_PASSPHRASE_ENCODING,
  BACKUP_PASSPHRASE_FILE_NAME,
  ROLE_ADMIN,
  SECRET_FILE_MODE,
  SETTING_KEYS,
  type Role,
} from "../../shared/constants.js";
import type { SettingsStore } from "../settings/settings-store.js";

export interface BackupPassphrase {
  passphrase: string;
  // Made by Autoheal rather than set in the environment: the first admin is shown it once.
  generated: boolean;
}

interface PassphraseSettings {
  dataDirectory: string;
  // From the environment; null when it sets none.
  backupPassphrase: string | null;
}

const passphraseFile = (dataDirectory: string) => join(dataDirectory, BACKUP_PASSPHRASE_FILE_NAME);

/** The passphrase backups are encrypted with: the environment's, else the one Autoheal made, else none yet. */
export function readBackupPassphrase(settings: PassphraseSettings): BackupPassphrase | null {
  if (settings.backupPassphrase !== null) {
    return { passphrase: settings.backupPassphrase, generated: false };
  }
  const path = passphraseFile(settings.dataDirectory);
  return existsSync(path) ? { passphrase: readFileSync(path, "utf8").trim(), generated: true } : null;
}

/** As `readBackupPassphrase`, making one on the first start; only Autoheal's user can read the file. */
export function ensureBackupPassphrase(settings: PassphraseSettings): BackupPassphrase & { madeNow: boolean } {
  const existing = readBackupPassphrase(settings);
  if (existing !== null) {
    return { ...existing, madeNow: false };
  }
  mkdirSync(settings.dataDirectory, { recursive: true });
  const passphrase = randomBytes(BACKUP_PASSPHRASE_BYTES).toString(BACKUP_PASSPHRASE_ENCODING);
  writeFileSync(passphraseFile(settings.dataDirectory), passphrase, { mode: SECRET_FILE_MODE });
  return { passphrase, generated: true, madeNow: true };
}

/** Shows the passphrase Autoheal made to the first admin who finishes setting up, and never again. */
export class BackupPassphraseNotice {
  constructor(
    private readonly store: SettingsStore,
    // Null when the .env sets the passphrase: its owner has it already.
    private readonly generated: string | null,
    private readonly clock: () => number = Date.now,
  ) {}

  takeFor(role: Role): string | null {
    if (this.generated === null || role !== ROLE_ADMIN) {
      return null;
    }
    if (this.store.read(SETTING_KEYS.passphraseShownAt, z.number()) !== null) {
      return null;
    }
    this.store.write(SETTING_KEYS.passphraseShownAt, this.clock());
    return this.generated;
  }
}
