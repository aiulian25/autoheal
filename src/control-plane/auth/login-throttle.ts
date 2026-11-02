import { and, eq, gte, lt, max, sql, type SQL } from "drizzle-orm";
import {
  LOGIN_ATTEMPT_RETENTION_MILLISECONDS,
  LOGIN_FAILURE_WINDOW_MILLISECONDS,
  LOGIN_FREE_FAILURES,
  LOGIN_DELAY_GROWTH,
  LOGIN_FREE_FAILURES_PER_ADDRESS,
  LOGIN_MAXIMUM_DELAY_SECONDS,
  MILLISECONDS_PER_SECOND,
} from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import { loginAttempts } from "../database/schema.js";

interface FailureCount {
  count: number;
  latest: number | null;
}

/**
 * Growing delays after repeated failures, per account-and-address and per address. Never a
 * hard lockout. Counts only failures since the last success and within the window.
 */
export class LoginThrottle {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly clock: () => number = Date.now,
  ) {}

  retryAfterSeconds(username: string, ip: string): number {
    const now = this.clock();
    const forPair = this.recentFailures(and(eq(loginAttempts.username, username), eq(loginAttempts.ip, ip))!, now);
    const forAddress = this.recentFailures(eq(loginAttempts.ip, ip), now);
    const excess = Math.max(forPair.count - LOGIN_FREE_FAILURES, forAddress.count - LOGIN_FREE_FAILURES_PER_ADDRESS);
    const latest = Math.max(forPair.latest ?? 0, forAddress.latest ?? 0);
    if (excess <= 0) {
      return 0;
    }
    const delaySeconds = Math.min(LOGIN_DELAY_GROWTH ** (excess - 1), LOGIN_MAXIMUM_DELAY_SECONDS);
    const remaining = latest + delaySeconds * MILLISECONDS_PER_SECOND - now;
    return remaining > 0 ? Math.ceil(remaining / MILLISECONDS_PER_SECOND) : 0;
  }

  record(username: string, ip: string, succeeded: boolean) {
    const now = this.clock();
    const database = this.databaseHandle.database;
    database.insert(loginAttempts).values({ username, ip, succeeded, createdAt: now }).run();
    database
      .delete(loginAttempts)
      .where(lt(loginAttempts.createdAt, now - LOGIN_ATTEMPT_RETENTION_MILLISECONDS))
      .run();
  }

  private recentFailures(scope: SQL, now: number): FailureCount {
    const database = this.databaseHandle.database;
    const lastSuccess = database
      .select({ at: max(loginAttempts.createdAt) })
      .from(loginAttempts)
      .where(and(scope, eq(loginAttempts.succeeded, true)))
      .get()?.at;
    const since = Math.max(now - LOGIN_FAILURE_WINDOW_MILLISECONDS, lastSuccess ?? 0);
    // Inclusive: a failure in the same millisecond as the last success still counts.
    const result = database
      .select({ count: sql<number>`count(*)`, latest: max(loginAttempts.createdAt) })
      .from(loginAttempts)
      .where(and(scope, eq(loginAttempts.succeeded, false), gte(loginAttempts.createdAt, since)))
      .get();
    return { count: result?.count ?? 0, latest: result?.latest ?? null };
  }
}
