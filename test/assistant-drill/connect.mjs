// The drill's admin connects the assistant and has it ask before updating, as its card will: a Jarvis key in their
// name, the webhook ID sealed as Autoheal seals it, and the switch on. Run inside the control plane's container.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "/app/node_modules/better-sqlite3/lib/index.js";
import { SecretBox } from "/app/dist/server/control-plane/database/secret-box.js";

const [passphrase] = process.argv.slice(2);
const database = new Database("/data/autoheal.sqlite");
const admin = database.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
const now = Date.now();
const keyId = randomUUID();
const secret = randomBytes(32).toString("base64url");
database
  .prepare(
    "INSERT INTO widget_keys (id, name, key_hash, key_hint, created_by, created_at, scope) VALUES (?, 'Jarvis', ?, ?, ?, ?, 'jarvis')",
  )
  .run(keyId, createHash("sha256").update(secret).digest("hex"), secret.slice(-4), admin.id, now);
const webhookId = `autoheal-${randomBytes(24).toString("base64url")}`;
const connection = {
  webhookId: SecretBox.fromPassphrase(passphrase).seal(webhookId),
  keyId,
  paused: false,
  askUpdates: true,
};
database
  .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('integration.jarvis', ?, ?)")
  .run(JSON.stringify(connection), now);
