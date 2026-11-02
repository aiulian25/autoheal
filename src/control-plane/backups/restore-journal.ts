import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RESTORE_JOURNAL_FILE } from "../../shared/constants.js";

const schema = z.object({
  version: z.literal(1),
  restoreId: z.uuid(),
  phase: z.enum(["safety-backup", "retaining-previous", "swapping", "settling", "committed"]),
  databasePath: z.string(),
  snapshotPath: z.string(),
  rollbackPath: z.string(),
  safetyBackup: z.string().nullable(),
});
export type RestoreRecord = z.infer<typeof schema>;

/** Lives outside SQLite and the temporary directory, so an interrupted swap cannot erase its recovery identity. */
export class RestoreJournal {
  private readonly path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, RESTORE_JOURNAL_FILE);
  }

  assertClean() {
    if (!existsSync(this.path)) return;
    // Invalid records also block startup; never delete recovery material based on an untrusted phase.
    schema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    throw new Error(
      `Interrupted database restore requires operator recovery. Preserve ${this.path}, its safety backup and previous database before restarting.`,
    );
  }

  save(record: RestoreRecord) {
    const descriptor = openSync(`${this.path}.tmp`, "w", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(schema.parse(record)));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(`${this.path}.tmp`, this.path);
    this.syncDirectory();
  }

  complete() {
    unlinkSync(this.path);
    this.syncDirectory();
  }
  private syncDirectory() {
    const descriptor = openSync(this.directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
