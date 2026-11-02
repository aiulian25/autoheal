import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseHandle, databasePathIn } from "./connection.js";
import { hostControlMigration } from "./migrations/0010-host-control.js";
import { hostDefaultsMigration } from "./migrations/0013-host-defaults.js";
import { containerChoicesMigration } from "./migrations/0015-container-choices.js";
import { widgetKeyScopeMigration } from "./migrations/0035-widget-key-scope.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate, schemaVersionOf } from "./migrations/index.js";
import * as schema from "./schema.js";

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
}

const tables = Object.values(schema).filter((value) => is(value, SQLiteTable)) as SQLiteTable[];

describe("migrations", () => {
  let directory: string;
  let handle: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-database-"));
    handle = new DatabaseHandle(databasePathIn(join(directory, "nested")));
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("brings a fresh file to the latest schema version", () => {
    expect(schemaVersionOf(handle.sqlite)).toBe(LATEST_SCHEMA_VERSION);
    expect(migrate(handle.sqlite)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("creates exactly the tables and columns the Drizzle schema describes", () => {
    const created = handle.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    expect(created).toEqual(tables.map((table) => getTableConfig(table).name).sort());

    for (const table of tables) {
      const config = getTableConfig(table);
      const actual = (handle.sqlite.pragma(`table_info(${config.name})`) as ColumnInfo[])
        .map(({ name, notnull, pk }) => ({ name, notNull: notnull === 1 || pk > 0, primaryKey: pk > 0 }))
        .sort((first, second) => first.name.localeCompare(second.name));
      const compositePrimary = new Set(config.primaryKeys.flatMap(({ columns }) => columns.map(({ name }) => name)));
      const expected = config.columns
        .map(({ name, notNull, primary }) => ({
          name,
          notNull: notNull || primary || compositePrimary.has(name),
          primaryKey: primary || compositePrimary.has(name),
        }))
        .sort((first, second) => first.name.localeCompare(second.name));
      expect(actual, `table ${config.name}`).toEqual(expected);
    }
  });

  it("keeps the widget keys made before metrics keys as Homepage keys", () => {
    const sqlite = new Database(":memory:");
    for (const migration of MIGRATIONS.filter(({ version }) => version < widgetKeyScopeMigration.version)) {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${migration.version}`);
    }
    sqlite
      .prepare("insert into widget_keys (id, name, key_hash, key_hint, created_at) values (?, ?, ?, ?, ?)")
      .run("homepage", "Homepage", "hash", "abcd", 1);

    migrate(sqlite);

    expect(sqlite.prepare("select id, scope from widget_keys").all()).toEqual([{ id: "homepage", scope: "widget" }]);
    sqlite.close();
  });

  it("lets the hosts already there restart a failed container on their own, and a host added later ask first", () => {
    const sqlite = new Database(":memory:");
    for (const migration of MIGRATIONS.filter(({ version }) => version < hostControlMigration.version)) {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${migration.version}`);
    }
    const addHost = sqlite.prepare(
      "insert into hosts (id, label, token_hash, token_hint, enrolled_at) values (?, ?, ?, ?, ?)",
    );
    addHost.run("before", "Alder", "hash-before", "abcd", 1);

    migrate(sqlite);
    addHost.run("after", "Fedora", "hash-after", "efgh", 2);

    expect(sqlite.prepare("select id, restart_default, update_default from hosts order by enrolled_at").all()).toEqual([
      { id: "before", restart_default: "restart", update_default: "ask" },
      { id: "after", restart_default: "ask", update_default: "ask" },
    ]);
    sqlite.close();
  });

  it("splits a host's one default into its two questions, each host keeping what it meant", () => {
    const sqlite = new Database(":memory:");
    for (const migration of MIGRATIONS.filter(({ version }) => version < hostDefaultsMigration.version)) {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${migration.version}`);
    }
    const addHost = sqlite.prepare(
      "insert into hosts (id, label, token_hash, token_hint, enrolled_at, container_default) values (?, ?, ?, ?, ?, ?)",
    );
    addHost.run("asks", "Alder", "hash-asks", "abcd", 1, "ask");
    addHost.run("restarts", "Rowan", "hash-restarts", "efgh", 2, "restart");
    addHost.run("both", "Fedora", "hash-both", "ijkl", 3, "both");

    migrate(sqlite);

    expect(sqlite.prepare("select id, restart_default, update_default from hosts order by enrolled_at").all()).toEqual([
      { id: "asks", restart_default: "ask", update_default: "ask" },
      { id: "restarts", restart_default: "restart", update_default: "ask" },
      { id: "both", restart_default: "restart", update_default: "apply" },
    ]);
    sqlite.close();
  });

  it("turns each container's two ticks into answers, each container keeping what its ticks meant", () => {
    const sqlite = new Database(":memory:");
    for (const migration of MIGRATIONS.filter(({ version }) => version < containerChoicesMigration.version)) {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${migration.version}`);
    }
    sqlite
      .prepare("insert into hosts (id, label, token_hash, token_hint, enrolled_at) values (?, ?, ?, ?, ?)")
      .run("alder", "Alder", "hash-alder", "abcd", 1);
    const tick = sqlite.prepare(
      "insert into container_controls (host_id, container_name, restart_by_itself, update_by_itself, changed_at) values ('alder', ?, ?, ?, 1)",
    );
    tick.run("attic", 1, 0);
    tick.run("quantum", 0, 1);

    migrate(sqlite);

    expect(
      sqlite.prepare("select container_name, restart_choice, update_choice from container_controls order by id").all(),
    ).toEqual([
      { container_name: "attic", restart_choice: "restart", update_choice: "ask" },
      { container_name: "quantum", restart_choice: "ask", update_choice: "apply" },
    ]);
    sqlite.close();
  });

  it("keeps the audit trail append-only", () => {
    handle.sqlite
      .prepare(
        "insert into audit_events (id, occurred_at, actor_kind, actor_label, action) values ('e1', 1, 'system', 'test', 'x')",
      )
      .run();
    expect(() => handle.sqlite.prepare("update audit_events set action = 'y'").run()).toThrow(/append-only/);
    expect(() => handle.sqlite.prepare("delete from audit_events").run()).toThrow(/append-only/);
  });

  it("enforces roles and statuses in the database itself", () => {
    const insert = handle.sqlite.prepare(
      "insert into users (id, username, password_hash, role, created_at) values (?, ?, 'hash', ?, 1)",
    );
    insert.run("u1", "Admin", "admin");
    expect(() => insert.run("u2", "root", "superuser")).toThrow(/CHECK constraint/);
    expect(() => insert.run("u3", "ADMIN", "viewer")).toThrow(/UNIQUE constraint/);
  });

  it("refuses a database written by a newer Autoheal", () => {
    const path = join(directory, "newer.sqlite");
    const newer = new Database(path);
    newer.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    newer.close();
    expect(() => new DatabaseHandle(path)).toThrow(/only knows up to/);
  });
});
