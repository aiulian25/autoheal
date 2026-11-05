import { chmodSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { DATABASE_FILE_NAME, INTEGRITY_OK, SELF_UPDATE, SQLITE_SIDE_FILES } from "../../shared/constants.js";
import { join } from "node:path";
import { inspectSnapshot } from "../backups/backup-service.js";
import { openReadOnly } from "../database/connection.js";

const OWNER_ONLY = 0o600;
const BEING_WRITTEN = ".next";

export interface DatabaseSnapshot {
  path: string;
  schemaVersion: number;
}

export interface SelfUpdateDatabase {
  snapshot(): Promise<DatabaseSnapshot>;
  // Whether restoreIfNeeded would put the copy back: asked before it does, so the fence is written first.
  needsRestore(snapshot: DatabaseSnapshot): boolean;
  restoreIfNeeded(snapshot: DatabaseSnapshot): boolean;
  discard(snapshot: DatabaseSnapshot): void;
}

/**
 * A sidecar runner keeps no database: nothing to copy before its container is replaced, nothing to put back after.
 * Everything else about the swap — the recreate, the health watch, the roll-back — is the same as the control plane's.
 */
export const NO_DATABASE: SelfUpdateDatabase = {
  snapshot: async () => ({ path: "", schemaVersion: 0 }),
  needsRestore: () => false,
  restoreIfNeeded: () => false,
  discard: () => undefined,
};

function verified(path: string): number {
  const { integrity, schemaVersion } = inspectSnapshot(path);
  if (integrity !== INTEGRITY_OK) throw new Error(`database check failed: ${integrity}`);
  return schemaVersion;
}

/** The current file's schema, or null when it does not read as a sound database. */
function soundVersion(path: string): number | null {
  try {
    return verified(path);
  } catch {
    return null;
  }
}

/**
 * The database the update helper protects, with no container using it: a checked copy from before the new version
 * can migrate it, and that copy put back when the old version could not open what is there. Same volume, so it needs
 * no key of its own: its secrets stay sealed with the passphrase both versions are given.
 */
export class SelfUpdateDatabaseFiles implements SelfUpdateDatabase {
  private readonly database: string;
  private readonly kept: string;

  constructor(dataDirectory: string) {
    this.database = join(dataDirectory, DATABASE_FILE_NAME);
    this.kept = join(dataDirectory, SELF_UPDATE.snapshotFile);
  }

  async snapshot(): Promise<DatabaseSnapshot> {
    const next = `${this.kept}${BEING_WRITTEN}`;
    rmSync(next, { force: true });
    const sqlite = openReadOnly(this.database);
    try {
      await sqlite.backup(next);
    } finally {
      sqlite.close();
    }
    chmodSync(next, OWNER_ONLY);
    const schemaVersion = verified(next);
    renameSync(next, this.kept);
    return { path: this.kept, schemaVersion };
  }

  /** A sound file on the same schema is kept, with what was written since: only a migrated or damaged one goes back. */
  needsRestore(snapshot: DatabaseSnapshot): boolean {
    return soundVersion(this.database) !== snapshot.schemaVersion;
  }

  /**
   * Whether it had to go back; only a migrated or damaged file costs the changes written since the copy.
   * Side files go before the move: a stale journal must never meet the old file.
   */
  restoreIfNeeded(snapshot: DatabaseSnapshot): boolean {
    if (!this.needsRestore(snapshot)) return false;
    const next = `${this.database}${BEING_WRITTEN}`;
    copyFileSync(snapshot.path, next);
    chmodSync(next, OWNER_ONLY);
    if (verified(next) !== snapshot.schemaVersion) throw new Error("the kept database is not the one it should be");
    for (const suffix of SQLITE_SIDE_FILES) {
      rmSync(`${this.database}${suffix}`, { force: true });
    }
    renameSync(next, this.database);
    if (verified(this.database) !== snapshot.schemaVersion) throw new Error("the database did not go back");
    return true;
  }

  discard(snapshot: DatabaseSnapshot) {
    rmSync(snapshot.path, { force: true });
  }
}
