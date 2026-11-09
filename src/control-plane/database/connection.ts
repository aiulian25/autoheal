import { RestoreCoordinator } from "./restore-coordinator.js";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  DATABASE_FILE_NAME,
  IN_MEMORY_DATABASE,
  SQLITE_BUSY_TIMEOUT_MILLISECONDS,
  SQLITE_SIDE_FILES,
} from "../../shared/constants.js";
import { migrate } from "./migrations/index.js";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export const databasePathIn = (dataDirectory: string) => join(dataDirectory, DATABASE_FILE_NAME);

interface Connection {
  sqlite: Database.Database;
  database: AppDatabase;
}

function open(path: string): Connection {
  if (path !== IN_MEMORY_DATABASE) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    // Views and triggers in the file may not call application functions: matters when restoring a backup.
    sqlite.pragma("trusted_schema = OFF");
    sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MILLISECONDS}`);
    migrate(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { sqlite, database: drizzle({ client: sqlite, schema }) };
}

/** A database file that is being read for inspection only: nothing in it may run code. */
export function openReadOnly(path: string): Database.Database {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  sqlite.pragma("trusted_schema = OFF");
  return sqlite;
}

/**
 * The one shared connection. Services read `.database` on every call rather than keeping it,
 * so a restore can swap the file underneath them.
 */
export class DatabaseHandle {
  private connection: Connection;
  readonly restore = new RestoreCoordinator();
  // What waits for the transaction `atomically` runs to be kept; null outside one.
  private keptThen: (() => void)[] | null = null;

  constructor(readonly path: string) {
    this.connection = open(path);
  }

  get database(): AppDatabase {
    this.restore.assertCurrent();
    return this.connection.database;
  }

  get sqlite(): Database.Database {
    this.restore.assertCurrent();
    return this.connection.sqlite;
  }

  close() {
    this.connection.sqlite.close();
  }

  /**
   * `work` as one transaction: every write it makes is kept, or, when it throws, none. What it hands `afterCommit`
   * happens once its writes are kept, and never when they are not. One inside another is part of the outer one.
   */
  atomically<Result>(work: () => Result): Result {
    if (this.keptThen !== null) return work();
    const waiting: (() => void)[] = [];
    this.keptThen = waiting;
    try {
      const result = this.sqlite.transaction(work)();
      this.keptThen = null;
      waiting.forEach((then) => then());
      return result;
    } finally {
      this.keptThen = null;
    }
  }

  /** `then` now, or once the transaction `atomically` runs is kept. */
  afterCommit(then: () => void) {
    if (this.keptThen === null) then();
    else this.keptThen.push(then);
  }

  /**
   * Replace the database file and reopen it (running any newer migrations). Synchronous from
   * close to reopen, so no request can use the database half-swapped, and it always ends with an
   * open connection: if the replacement cannot be moved in or will not open, the previous
   * database (kept at `rollbackPath`) is back in place and the error is rethrown.
   */
  swapFile(replacementPath: string, rollbackPath: string) {
    this.restore.assertCurrent();
    this.close();
    try {
      this.moveIntoPlace(replacementPath);
    } catch (error) {
      // Nothing moved: the original file is untouched.
      this.connection = open(this.path);
      throw error;
    }
    try {
      this.connection = open(this.path);
      this.restore.replaced();
    } catch (error) {
      this.moveIntoPlace(rollbackPath);
      this.connection = open(this.path);
      throw error;
    }
  }

  /** Reopen the retained pre-restore snapshot when settlement or post-swap checks fail. */
  restorePrevious(rollbackPath: string) {
    this.restore.assertCurrent();
    this.close();
    try {
      this.moveIntoPlace(rollbackPath);
    } catch (error) {
      this.connection = open(this.path);
      throw error;
    }
    this.connection = open(this.path);
    this.restore.replaced();
  }

  private moveIntoPlace(source: string) {
    renameSync(source, this.path);
    for (const suffix of SQLITE_SIDE_FILES) {
      rmSync(`${this.path}${suffix}`, { force: true });
    }
  }
}
