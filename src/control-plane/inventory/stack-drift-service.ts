import { and, eq, notInArray } from "drizzle-orm";
import { stackDriftSchema, type StackDriftReport, type StackDriftView } from "../../shared/stacks.js";
import type { DatabaseHandle } from "../database/connection.js";
import { stackDrift } from "../database/schema.js";

/** What each host last said of how its stacks differ from their files. A stack it no longer mentions has caught up. */
export class StackDriftService {
  constructor(private readonly databaseHandle: DatabaseHandle) {}

  private get database() {
    return this.databaseHandle.database;
  }

  /** Each report arrives with every heartbeat, and only one taken since the last changes anything. */
  record(hostId: string, report: StackDriftReport) {
    const rows = this.database.select().from(stackDrift).where(eq(stackDrift.hostId, hostId)).all();
    if (rows.some(({ lastObservedAt }) => lastObservedAt === report.checkedAt)) return;
    this.database.transaction(() => {
      const projects = report.stacks.map(({ project }) => project);
      this.database
        .delete(stackDrift)
        .where(and(eq(stackDrift.hostId, hostId), notInArray(stackDrift.project, projects)))
        .run();
      for (const drift of report.stacks) {
        const fields = { driftJson: JSON.stringify(drift), lastObservedAt: report.checkedAt };
        this.database
          .insert(stackDrift)
          .values({ hostId, project: drift.project, firstSeenAt: report.checkedAt, ...fields })
          .onConflictDoUpdate({ target: [stackDrift.hostId, stackDrift.project], set: fields })
          .run();
      }
    });
  }

  ofHost(hostId: string): StackDriftView[] {
    return this.database
      .select()
      .from(stackDrift)
      .where(eq(stackDrift.hostId, hostId))
      .all()
      .map(({ driftJson, firstSeenAt, lastObservedAt }) => ({
        ...stackDriftSchema.parse(JSON.parse(driftJson)),
        firstSeenAt,
        lastObservedAt,
      }));
  }
}
