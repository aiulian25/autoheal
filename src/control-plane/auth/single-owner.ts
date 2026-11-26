import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  OPEN_TASK_STATUSES,
  ROLE_ADMIN,
  SINGLE_OWNER_MESSAGES,
  SYSTEM_ACTOR_LABEL,
  TARGET_USER,
  USER_STATUS_ACTIVE,
  USER_STATUS_DEACTIVATED,
} from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import { openReadOnly, type DatabaseHandle } from "../database/connection.js";

export interface Person {
  id: string;
  username: string;
}

/** Whose this Autoheal is: one person's, nobody's yet, or more than it can choose between. */
export type OwnerLookup = { kind: "owner"; person: Person } | { kind: "nobody" } | { kind: "unclear"; admins: number };

const TABLE_EXISTS = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?";
const ACTIVE_ADMINS = "SELECT id, username FROM users WHERE role = ? AND status = ? ORDER BY username";
const SET_UP_WITH = "SELECT target_id AS id FROM audit_events WHERE action = ? AND target_id IS NOT NULL";
const OTHERS_ACTIVE = "SELECT id, username FROM users WHERE status = ? AND id IS NOT ? ORDER BY username";
const OPEN_STATUSES = OPEN_TASK_STATUSES.map((status) => `'${status}'`).join(", ");

// Run in this order: the others are signed out before anything they held is let go of.
const KEEP_FROM_SIGNING_IN = [
  `UPDATE users SET status = '${USER_STATUS_DEACTIVATED}' WHERE status = '${USER_STATUS_ACTIVE}' AND id IS NOT ?`,
  "DELETE FROM sessions WHERE user_id IS NOT ?",
  "DELETE FROM passkeys WHERE user_id IS NOT ?",
  "DELETE FROM recovery_codes WHERE user_id IS NOT ?",
  `UPDATE tasks SET assignee_user_id = NULL
   WHERE assignee_user_id IS NOT NULL AND assignee_user_id IS NOT ? AND status IN (${OPEN_STATUSES})`,
];

const hasTable = (sqlite: Database.Database, name: string) => sqlite.prepare(TABLE_EXISTS).get(name) !== undefined;

/** The admins this Autoheal was set up with, by account: renamed since, perhaps, but never another account. */
export function setUpWith(sqlite: Database.Database): ReadonlySet<string> {
  const rows = sqlite.prepare(SET_UP_WITH).all(AUDIT_ACTIONS.adminBootstrapped) as { id: string }[];
  return new Set(rows.map(({ id }) => id));
}

/**
 * The one person this Autoheal is for: its only active admin or, of several, the one it was set up with. Nobody yet
 * while no admin is active; unclear while several are and none of them is the first.
 */
export function ownerOf(sqlite: Database.Database): OwnerLookup {
  if (!hasTable(sqlite, "users")) return { kind: "nobody" };
  const admins = sqlite.prepare(ACTIVE_ADMINS).all(ROLE_ADMIN, USER_STATUS_ACTIVE) as Person[];
  if (admins.length === 0) return { kind: "nobody" };
  if (admins.length === 1) return { kind: "owner", person: admins[0]! };
  const first = setUpWith(sqlite);
  const original = admins.filter(({ id }) => first.has(id));
  return original.length === 1 ? { kind: "owner", person: original[0]! } : { kind: "unclear", admins: admins.length };
}

/** Whose a database file is, read without opening it for writing: nobody's while there is no file yet. */
export function ownerOfFile(databasePath: string): OwnerLookup {
  if (!existsSync(databasePath)) return { kind: "nobody" };
  const sqlite = openReadOnly(databasePath);
  try {
    return ownerOf(sqlite);
  } finally {
    sqlite.close();
  }
}

/**
 * A database that cannot say whose it is is refused before it is opened: it is left exactly as it was, so the version
 * it came from still runs on it.
 */
export function assertOwnerClear(databasePath: string) {
  const owner = ownerOfFile(databasePath);
  if (owner.kind === "unclear") throw new Error(SINGLE_OWNER_MESSAGES.unclear(owner.admins));
}

/**
 * Leaves the owner the only one who signs in: the one `chosen` on the host, or else whoever `ownerOf` names. Everyone
 * else stays a name in the history, signed out and without passkeys or recovery codes, and the
 * open tasks the others held go back to nobody. Says who was kept from signing in.
 */
export function keepOneOwner(
  databaseHandle: DatabaseHandle,
  auditLog: AuditLog,
  chosen: Person | null = null,
): string[] {
  const sqlite = databaseHandle.sqlite;
  const owner: OwnerLookup = chosen === null ? ownerOf(sqlite) : { kind: "owner", person: chosen };
  if (owner.kind === "unclear") throw new Error(SINGLE_OWNER_MESSAGES.unclear(owner.admins));
  const ownerId = owner.kind === "owner" ? owner.person.id : null;
  const others = sqlite.prepare(OTHERS_ACTIVE).all(USER_STATUS_ACTIVE, ownerId) as Person[];
  const changed = databaseHandle.atomically(() =>
    KEEP_FROM_SIGNING_IN.reduce((total, statement) => total + sqlite.prepare(statement).run(ownerId).changes, 0),
  );
  if (changed > 0) {
    auditLog.record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AUDIT_ACTIONS.oneOwnerKept,
      ...(ownerId === null ? {} : { targetKind: TARGET_USER, targetId: ownerId }),
      details: {
        owner: owner.kind === "owner" ? owner.person.username : null,
        keptFromSigningIn: others.map(({ username }) => username),
      },
    });
  }
  return others.map(({ username }) => username);
}
