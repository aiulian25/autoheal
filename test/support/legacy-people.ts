import { randomUUID } from "node:crypto";
import { hashPassword } from "../../src/control-plane/auth/password-hashing.js";
import type { DatabaseHandle } from "../../src/control-plane/database/connection.js";
import { onePersonMigration } from "../../src/control-plane/database/migrations/0079-one-person.js";

// What every legacy person signs in with, in tests.
export const LEGACY_PASSWORD = "legacy-quietly-orbiting-42";

export interface LegacyPerson {
  username: string;
  role?: "admin" | "viewer";
  status?: "active" | "deactivated";
}

const ONE_PERSON_TRIGGERS = "DROP TRIGGER IF EXISTS users_one_person; DROP TRIGGER IF EXISTS users_one_active;";
const ADD = `INSERT INTO users (id, username, password_hash, role, status, must_change_password, created_at)
VALUES (?, ?, ?, ?, ?, 0, ?)`;

/** The database's rule against a second person lifted, as on a file from before it: for making one in tests. */
export const withoutOnePersonRule = (handle: DatabaseHandle) => handle.sqlite.exec(ONE_PERSON_TRIGGERS);

/**
 * People the Users page could add before Autoheal was one person's, each signing in with LEGACY_PASSWORD. The
 * database's rule against them is lifted while they go in, then put back. Their ids, by username.
 */
export async function addLegacyPeople(
  handle: DatabaseHandle,
  people: readonly LegacyPerson[],
): Promise<Map<string, string>> {
  const passwordHash = await hashPassword(LEGACY_PASSWORD);
  const ids = new Map<string, string>();
  withoutOnePersonRule(handle);
  try {
    const add = handle.sqlite.prepare(ADD);
    for (const { username, role = "viewer", status = "active" } of people) {
      const id = randomUUID();
      add.run(id, username, passwordHash, role, status, Date.now());
      ids.set(username, id);
    }
  } finally {
    handle.sqlite.exec(onePersonMigration.sql);
  }
  return ids;
}
