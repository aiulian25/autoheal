import { LIVE_EVENT } from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import type { LiveEvents } from "./live-events.js";

// ponytail: both tables read whole each look; an index on updated_at once they hold many thousands of rows.
const BOARD_REVISION = `SELECT
  (SELECT count(*) FROM tasks) || ':' || (SELECT coalesce(max(updated_at), 0) FROM tasks) || ':' ||
  (SELECT count(*) FROM incidents) || ':' || (SELECT coalesce(max(updated_at), 0) FROM incidents) AS revision`;

/**
 * Tells the dashboards open now that the board changed: a task or an incident added, changed or gone, whoever wrote
 * it (a detector, a worker, a person, a runner's report, a restore). One look for the whole control plane, not one
 * poll for each open page.
 */
export class BoardChanges {
  private last: string | null = null;

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly live: Pick<LiveEvents, "publish">,
  ) {}

  check() {
    const { revision } = this.databaseHandle.sqlite.prepare(BOARD_REVISION).get() as { revision: string };
    const changed = this.last !== null && revision !== this.last;
    this.last = revision;
    if (changed) this.live.publish({ kind: LIVE_EVENT.board });
  }
}
