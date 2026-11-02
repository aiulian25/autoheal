import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SelfUpdateOutcome } from "../../shared/api.js";
import { SELF_UPDATE, SELF_UPDATE_FINAL, SELF_UPDATE_PHASE, SELF_UPDATE_STATUS } from "../../shared/constants.js";

const snapshotSchema = z.object({ path: z.string(), schemaVersion: z.number().int() });

// What a later helper needs to take up an update that stopped, by ids that do not change. Kept here, not in the
// database, which is the thing being replaced.
const recoverySchema = z.object({
  version: z.literal(SELF_UPDATE.recoveryVersion),
  phase: z.enum(SELF_UPDATE_PHASE),
  original: z.string(),
  name: z.string(),
  snapshot: snapshotSchema.nullable(),
});
export type SelfUpdateRecovery = z.infer<typeof recoverySchema>;
export type JournalledOutcome = SelfUpdateOutcome & { recovery?: SelfUpdateRecovery | null };

const outcomeSchema = z.object({
  status: z.enum(SELF_UPDATE_STATUS),
  from: z.string(),
  to: z.string(),
  reference: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  message: z.string(),
  recovery: recoverySchema.nullable().default(null),
});

// Its own lines, kept with the outcome: whether the control plane has put the finished update in the audit log yet.
const storedSchema = outcomeSchema.extend({ audited: z.boolean().default(false) });
type StoredOutcome = z.infer<typeof storedSchema>;

/** The last update of Autoheal itself, in the data volume: written by its helper, read by the control plane after. */
export class SelfUpdateOutcomeFile {
  private readonly path: string;

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, SELF_UPDATE.outcomeFile);
  }

  read(): StoredOutcome | null {
    if (!existsSync(this.path)) {
      return null;
    }
    const parsed = storedSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
    return parsed.success ? parsed.data : null;
  }

  // Whole or not at all: written beside it, then moved over it.
  write(outcome: JournalledOutcome, audited = false) {
    const next = `${this.path}.next`;
    writeFileSync(next, JSON.stringify({ ...outcome, audited }));
    renameSync(next, this.path);
  }
}

/** An update that began and neither finished nor failed: what is needed to take it up again, or null. */
export const unfinishedRecovery = (outcome: JournalledOutcome | null): SelfUpdateRecovery | null => {
  if (outcome === null || SELF_UPDATE_FINAL.includes(outcome.status)) return null;
  return outcome.recovery ?? null;
};
