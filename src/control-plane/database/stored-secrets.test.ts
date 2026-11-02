import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TEST_BACKUP_PASSPHRASE, startTestControlPlane } from "../../../test/support/control-plane.js";
import { IN_MEMORY_DATABASE, SETTING_KEYS } from "../../shared/constants.js";
import { DatabaseHandle } from "./connection.js";
import { identityMigration } from "./migrations/0001-identity.js";
import { SecretBox, isSealed } from "./secret-box.js";
import { sealStoredSecrets, unreadableSecrets } from "./stored-secrets.js";

const box = SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE);
const otherBox = SecretBox.fromPassphrase("another-backup-passphrase-0123456789abcdef");
const SEED = "JBSWY3DPEHPK3PXP";
const PENDING_SEED = "KRSXG5CTMVRXEZLU";

function addUser(sqlite: Database.Database, active: string | null, pending: string | null = null) {
  const id = randomUUID();
  sqlite
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, totp_secret, totp_pending_secret) VALUES (?, ?, ?, 'viewer', 0, ?, ?)",
    )
    .run(id, `user-${id}`, "hash", active, pending);
  return id;
}

const secretsOf = (sqlite: Database.Database, id: string) =>
  sqlite.prepare("SELECT totp_secret AS active, totp_pending_secret AS pending FROM users WHERE id = ?").get(id) as {
    active: string | null;
    pending: string | null;
  };

function setSetting(sqlite: Database.Database, key: string, json: string) {
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, 0)").run(key, json);
}

const settingOf = (sqlite: Database.Database, key: string) =>
  (sqlite.prepare("SELECT value_json AS json FROM settings WHERE key = ?").get(key) as { json: string }).json;

describe("the secrets the database keeps", () => {
  it("seals plain authenticator seeds and integration tokens once, and leaves everything else as it was", () => {
    const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
    const sqlite = handle.sqlite;
    const plain = addUser(sqlite, SEED, PENDING_SEED);
    const withoutCode = addUser(sqlite, null);
    const alreadySealed = box.seal(SEED);
    const sealedBefore = addUser(sqlite, alreadySealed);
    setSetting(
      sqlite,
      SETTING_KEYS.gotify,
      JSON.stringify({ url: "https://gotify.lan", topic: null, token: "app-token" }),
    );
    const openTopic = JSON.stringify({ url: "https://ntfy.sh", topic: "home", token: null });
    setSetting(sqlite, SETTING_KEYS.ntfy, openTopic);
    setSetting(sqlite, SETTING_KEYS.homeAssistant, "{ not json");
    const notASecret = JSON.stringify({ token: "kept-as-it-is" });
    setSetting(sqlite, SETTING_KEYS.hostUpdates, notASecret);
    // A webhook's address is a secret too, beside its token.
    const hook = "https://discord.com/api/webhooks/1/key";
    setSetting(
      sqlite,
      SETTING_KEYS.webhook,
      JSON.stringify({ url: hook, topic: null, token: "bearer", format: "json" }),
    );

    // An SSH key and its passphrase, and an SSH host's runner token, as an older build might have left them.
    sqlite
      .prepare(
        "INSERT INTO ssh_keys (id, name, public_line, fingerprint, private_key, passphrase, created_at) VALUES ('k1', 'own', 'ssh-ed25519 AAAA', 'SHA256:x', 'PRIVATE KEY', 'its passphrase', 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO hosts (id, label, token_hash, token_hint, enrolled_at, kind, ssh_runner_token) VALUES ('h1', 'cedar2', 'hash', 'abcd', 0, 'ssh', 'ahk_token')",
      )
      .run();

    expect(sealStoredSecrets(sqlite, box)).toEqual({ sealed: 8, unreadable: 0 });
    const sshKey = sqlite.prepare("SELECT private_key AS key, passphrase FROM ssh_keys").get() as Record<
      string,
      string
    >;
    const runnerToken = sqlite.prepare("SELECT ssh_runner_token AS token FROM hosts").get() as { token: string };
    expect([box.open(sshKey.key!), box.open(sshKey.passphrase!), box.open(runnerToken.token)]).toEqual([
      "PRIVATE KEY",
      "its passphrase",
      "ahk_token",
    ]);
    const { active, pending } = secretsOf(sqlite, plain);
    expect([box.open(active!), box.open(pending!)]).toEqual([SEED, PENDING_SEED]);
    expect(secretsOf(sqlite, withoutCode)).toEqual({ active: null, pending: null });
    expect(secretsOf(sqlite, sealedBefore).active).toBe(alreadySealed);
    const gotify = JSON.parse(settingOf(sqlite, SETTING_KEYS.gotify));
    expect(gotify).toMatchObject({ url: "https://gotify.lan", topic: null });
    expect(isSealed(gotify.token)).toBe(true);
    expect(box.open(gotify.token)).toBe("app-token");
    expect(settingOf(sqlite, SETTING_KEYS.ntfy)).toBe(openTopic);
    expect(settingOf(sqlite, SETTING_KEYS.homeAssistant)).toBe("{ not json");
    expect(settingOf(sqlite, SETTING_KEYS.hostUpdates)).toBe(notASecret);
    const webhook = JSON.parse(settingOf(sqlite, SETTING_KEYS.webhook));
    expect([box.open(webhook.url), box.open(webhook.token), webhook.format]).toEqual([hook, "bearer", "json"]);

    expect(sealStoredSecrets(sqlite, box)).toEqual({ sealed: 0, unreadable: 0 });
    expect(secretsOf(sqlite, plain).active).toBe(active);
    handle.close();
  });

  it("counts what another passphrase sealed, and leaves it for a person to replace", () => {
    const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
    const sqlite = handle.sqlite;
    const foreign = otherBox.seal(SEED);
    const user = addUser(sqlite, foreign);
    setSetting(
      sqlite,
      SETTING_KEYS.gotify,
      JSON.stringify({ url: "https://gotify.lan", topic: null, token: otherBox.seal("app-token") }),
    );
    const webhook = { url: otherBox.seal("https://hooks.slack.com/services/T/B/key"), topic: null, token: null };
    setSetting(sqlite, SETTING_KEYS.webhook, JSON.stringify({ ...webhook, format: "slack" }));

    sqlite
      .prepare(
        "INSERT INTO ssh_keys (id, name, public_line, fingerprint, private_key, created_at) VALUES ('k1', 'own', 'ssh-ed25519 AAAA', 'SHA256:x', ?, 0)",
      )
      .run(otherBox.seal("PRIVATE KEY"));

    expect(sealStoredSecrets(sqlite, box)).toEqual({ sealed: 0, unreadable: 4 });
    expect(secretsOf(sqlite, user).active).toBe(foreign);
    expect(unreadableSecrets(sqlite, box)).toBe(4);
    expect(unreadableSecrets(sqlite, otherBox)).toBe(0);
    handle.close();
  });

  it("reads a backup from before the settings table, where plain secrets are not unreadable", () => {
    const sqlite = new Database(IN_MEMORY_DATABASE);
    sqlite.exec(identityMigration.sql);
    addUser(sqlite, SEED);
    expect(unreadableSecrets(sqlite, box)).toBe(0);
    addUser(sqlite, otherBox.seal(SEED));
    expect(unreadableSecrets(sqlite, box)).toBe(1);
    sqlite.close();
  });

  it("is sealed before the control plane's services read any of it", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "autoheal-secrets-")), "autoheal.sqlite");
    const older = new DatabaseHandle(databasePath);
    const user = addUser(older.sqlite, SEED);
    setSetting(
      older.sqlite,
      SETTING_KEYS.gotify,
      JSON.stringify({ url: "https://gotify.lan", topic: null, token: "app-token" }),
    );
    older.close();

    const controlPlane = await startTestControlPlane({ databasePath });
    expect(controlPlane.services.integrationsService.gotify()).toEqual({
      url: "https://gotify.lan",
      token: "app-token",
    });
    const sqlite = controlPlane.services.databaseHandle.sqlite;
    expect(box.open(secretsOf(sqlite, user).active!)).toBe(SEED);
    expect(settingOf(sqlite, SETTING_KEYS.gotify)).not.toContain("app-token");
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });
});
