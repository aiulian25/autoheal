import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SelfUpdateOutcome } from "../../shared/api.js";
import {
  SELF_UPDATE,
  SELF_UPDATE_FINAL,
  SELF_UPDATE_PHASE,
  SELF_UPDATE_RECORD,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_UNREADABLE,
} from "../../shared/constants.js";

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
export type JournalledOutcome = SelfUpdateOutcome & { recovery?: SelfUpdateRecovery | null; dataRestored?: boolean };

const outcomeSchema = z.object({
  status: z.enum(SELF_UPDATE_STATUS),
  from: z.string(),
  to: z.string(),
  reference: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  message: z.string(),
  recovery: recoverySchema.nullable().default(null),
  // Written before the database file moves and before anything starts on it: whichever control plane comes up then
  // has work in hand that its hosts may already have carried out, and must settle it rather than hand it out again.
  dataRestored: z.boolean().default(false),
});

// Its own lines, kept with the outcome: what the control plane has done about it since, which the helper never writes.
const storedSchema = outcomeSchema.extend({
  audited: z.boolean().default(false),
  settled: z.boolean().default(false),
});
export type StoredOutcome = z.infer<typeof storedSchema>;
/** What a control plane has done about a record it read, kept beside the update the helper wrote. */
export type SelfUpdateHandled = { audited?: boolean; settled?: boolean };

/**
 * What the file held: nothing, an update, or bytes this version cannot make sense of. The last is kept apart from the
 * first on purpose, as an unreadable record may be an update that never finished, and starting another would write
 * over the only evidence of it.
 */
export type SelfUpdateRecord =
  | { state: typeof SELF_UPDATE_RECORD.absent }
  | { state: typeof SELF_UPDATE_RECORD.valid; outcome: StoredOutcome }
  | { state: typeof SELF_UPDATE_RECORD.unreadable; reason: string };

/** The update it holds, or null where there is none to read; an unreadable record is no record of an update. */
export const outcomeIn = (record: SelfUpdateRecord): StoredOutcome | null =>
  record.state === SELF_UPDATE_RECORD.valid ? record.outcome : null;

/** Why the record cannot be read, in words for a person; null while it can be. */
export const unreadableReason = (record: SelfUpdateRecord): string | null =>
  record.state === SELF_UPDATE_RECORD.unreadable ? record.reason : null;

/** The last update of Autoheal itself, in the data volume: written by its helper, read by the control plane after. */
export class SelfUpdateOutcomeFile {
  private readonly path: string;

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, SELF_UPDATE.outcomeFile);
  }

  // Decoding and shape are judged apart, and neither throws: a file that cannot be read is a state of its own, and
  // the bytes behind it stay on disk and out of the answer.
  read(): SelfUpdateRecord {
    if (!existsSync(this.path)) {
      return { state: SELF_UPDATE_RECORD.absent };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return { state: SELF_UPDATE_RECORD.unreadable, reason: SELF_UPDATE_UNREADABLE.notJson };
    }
    const parsed = storedSchema.safeParse(decoded);
    if (!parsed.success) {
      return { state: SELF_UPDATE_RECORD.unreadable, reason: SELF_UPDATE_UNREADABLE.notTheShape };
    }
    return { state: SELF_UPDATE_RECORD.valid, outcome: parsed.data };
  }

  // Whole or not at all: written beside it, then moved over it. The settled mark stays with the update it was made for,
  // whoever writes next, as a helper does at each step: only a new update starts without it.
  write(outcome: JournalledOutcome, handled: SelfUpdateHandled = {}) {
    const next = `${this.path}.next`;
    const settled = handled.settled ?? this.settledFor(outcome);
    const stored = { ...outcome, audited: handled.audited ?? false, settled };
    writeFileSync(next, JSON.stringify(stored));
    renameSync(next, this.path);
  }

  private settledFor(outcome: JournalledOutcome): boolean {
    const stored = outcomeIn(this.read());
    return stored !== null && stored.settled && stored.startedAt === outcome.startedAt && stored.to === outcome.to;
  }
}

/** An update that began and neither finished nor failed: what is needed to take it up again, or null. */
export const unfinishedRecovery = (outcome: JournalledOutcome | null): SelfUpdateRecovery | null => {
  if (outcome === null || SELF_UPDATE_FINAL.includes(outcome.status)) return null;
  return outcome.recovery ?? null;
};
