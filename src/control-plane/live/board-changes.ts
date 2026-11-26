import type Database from "better-sqlite3";
import { LIVE_EVENT } from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import type { LiveEvents } from "./live-events.js";

const BOARD_TABLES = ["tasks", "incidents"] as const;
const ROW_CHANGES = ["INSERT", "UPDATE", "DELETE"] as const;

// Counted on the connection itself: every row any writer adds, changes or removes in either table raises it, however
// it leaves the row's times. TEMP, so it needs no migration and goes with the connection.
const COUNTER = [
  "CREATE TEMP TABLE IF NOT EXISTS board_revision (value INTEGER NOT NULL)",
  "INSERT INTO temp.board_revision (value) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM temp.board_revision)",
  ...BOARD_TABLES.flatMap((table) =>
    ROW_CHANGES.map(
      (change) =>
        `CREATE TEMP TRIGGER IF NOT EXISTS board_${table}_${change.toLowerCase()} AFTER ${change} ON main.${table} ` +
        "BEGIN UPDATE temp.board_revision SET value = value + 1; END",
    ),
  ),
];
const READ_COUNTER = "SELECT value FROM temp.board_revision";
// Writes another process commits (a command run beside the dashboard) change the file's version instead.
const FILE_VERSION = "data_version";

/**
 * Tells the dashboards open now that the board changed: a task or an incident added, changed or gone, whoever wrote
 * it (a detector, a worker, a person, a runner's report, a restore). One look for the whole control plane, not one
 * poll for each open page.
 */
export class BoardChanges {
  private last: string | null = null;
  private counted: Database.Database | null = null;
  private readCounter: Database.Statement | null = null;

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly live: Pick<LiveEvents, "publish">,
  ) {}

  check() {
    const sqlite = this.databaseHandle.sqlite;
    // A restore opens a new connection: its counter starts again, and what it holds is news.
    const reopened = sqlite !== this.counted;
    if (reopened) {
      for (const statement of COUNTER) sqlite.exec(statement);
      this.counted = sqlite;
      this.readCounter = sqlite.prepare(READ_COUNTER);
    }
    const { value } = this.readCounter!.get() as { value: number };
    const revision = `${value}:${sqlite.pragma(FILE_VERSION, { simple: true })}`;
    const changed = this.last !== null && (reopened || revision !== this.last);
    this.last = revision;
    if (changed) this.live.publish({ kind: LIVE_EVENT.board });
  }
}
