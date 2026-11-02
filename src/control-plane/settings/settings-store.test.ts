import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type SettingsView, type IntegrationView } from "../../shared/api.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SETTING_KEYS } from "../../shared/constants.js";
import { DatabaseHandle } from "../database/connection.js";
import { settings } from "../database/schema.js";
import { SettingsStore } from "./settings-store.js";

const secret = "synthetic-private-token";

describe("stored settings validation", () => {
  let handle: DatabaseHandle;
  let store: SettingsStore;
  beforeEach(() => {
    handle = new DatabaseHandle(":memory:");
    store = new SettingsStore(handle);
  });
  afterEach(() => {
    handle.close();
    vi.restoreAllMocks();
  });
  it("treats malformed JSON as unset without logging its value or parser error", () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    handle.database
      .insert(settings)
      .values({ key: SETTING_KEYS.gotify, valueJson: `{"token":"${secret}",`, updatedAt: 1 })
      .run();
    expect(store.read(SETTING_KEYS.gotify, z.object({ token: z.string() }))).toBeNull();
    expect(printed).toHaveBeenCalled();
    const output = JSON.stringify(printed.mock.calls);
    expect(output).toContain(SETTING_KEYS.gotify);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("SyntaxError");
  });
});

describe("invalid settings diagnostics and repair", () => {
  let handle: DatabaseHandle;
  let store: SettingsStore;
  beforeEach(() => {
    handle = new DatabaseHandle(":memory:");
    store = new SettingsStore(handle);
  });
  afterEach(() => {
    handle.close();
    vi.restoreAllMocks();
  });

  it("rejects invalid shapes and bounds repeated diagnostics without exposing validation inputs", () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    store.write(SETTING_KEYS.ollama, { model: secret });
    const schema = z.object({ url: z.url(), model: z.number() });
    expect(store.read(SETTING_KEYS.ollama, schema)).toBeNull();
    expect(store.read(SETTING_KEYS.ollama, schema)).toBeNull();
    expect(store.invalidKeys()).toEqual([SETTING_KEYS.ollama]);
    expect(printed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(printed.mock.calls)).toContain("invalid shape");
    expect(JSON.stringify(printed.mock.calls)).not.toContain(secret);
    store.write(SETTING_KEYS.ollama, { url: "https://model.test", model: 1 });
    expect(store.read(SETTING_KEYS.ollama, schema)).toEqual({ url: "https://model.test", model: 1 });
    expect(store.invalidKeys()).toEqual([]);
    store.write(SETTING_KEYS.ollama, { model: secret });
    store.read(SETTING_KEYS.ollama, schema);
    expect(printed).toHaveBeenCalledTimes(2);
    store.remove(SETTING_KEYS.ollama);
    expect(store.invalidKeys()).toEqual([]);
  });

  it("checks unread malformed rows, ignores unknown keys and refreshes after direct database repair", () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    handle.database
      .insert(settings)
      .values([
        { key: SETTING_KEYS.ntfy, valueJson: `{"token":"${secret}",`, updatedAt: 1 },
        { key: secret, valueJson: "{", updatedAt: 1 },
      ])
      .run();
    expect(store.invalidKeys()).toEqual([SETTING_KEYS.ntfy]);
    expect(JSON.stringify(printed.mock.calls)).not.toContain(secret);
    handle.sqlite.prepare("UPDATE settings SET value_json = ? WHERE key = ?").run("{}", SETTING_KEYS.ntfy);
    expect(store.invalidKeys()).toEqual([]);
  });

  it("preserves missing settings and valid schema transformations without warning", () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(store.read(SETTING_KEYS.runnerAddress, z.string())).toBeNull();
    store.write(SETTING_KEYS.runnerAddress, " address ");
    expect(store.read(SETTING_KEYS.runnerAddress, z.string().trim())).toBe("address");
    expect(printed).not.toHaveBeenCalled();
  });

  it("does not turn a database failure into a configuration fallback", () => {
    handle.sqlite.exec("DROP TABLE settings");
    expect(() => store.read(SETTING_KEYS.gotify, z.unknown())).toThrow("no such table");
  });
});

it("starts with corrupt persisted settings, exposes graceful fallback and gives only administrators a redacted repair notice", async () => {
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  const directory = mkdtempSync(join(tmpdir(), "autoheal-invalid-settings-"));
  const databasePath = join(directory, "settings.sqlite");
  const seed = new DatabaseHandle(databasePath);
  const keys = [
    SETTING_KEYS.gotify,
    SETTING_KEYS.ntfy,
    SETTING_KEYS.homeAssistant,
    SETTING_KEYS.ollama,
    SETTING_KEYS.trustedProxies,
    SETTING_KEYS.hostUpdates,
    SETTING_KEYS.runnerAddress,
  ];
  seed.database
    .insert(settings)
    .values(keys.map((key) => ({ key, valueJson: `{"token":"${secret}",`, updatedAt: 1 })))
    .run();
  seed.close();
  let cp: TestControlPlane | undefined;
  try {
    cp = await startTestControlPlane({
      databasePath,
      trustedProxyAddresses: [],
      homeAssistant: { url: "https://ha.test", token: "environment-token" },
    });
    const { client: admin } = await fullySignedInAdmin(cp);
    const { client: viewer } = await fullySignedInUser(cp, admin, "reader", "viewer");
    const current = (await admin.get(API_ROUTES.settings)).json<SettingsView>();
    expect(current.invalidSettings?.sort()).toEqual([...keys].sort());
    expect(current.trustedProxies).toMatchObject({ source: null, addresses: [] });
    const integrations = await admin.get(API_ROUTES.integrations);
    expect(integrations.statusCode).toBe(200);
    expect(integrations.json<IntegrationView[]>().find((row) => row.kind === "gotify")).toMatchObject({
      source: null,
      url: null,
      tokenSet: false,
    });
    expect(integrations.json<IntegrationView[]>().find((row) => row.kind === "homeAssistant")).toMatchObject({
      source: "environment",
      url: "https://ha.test",
      tokenSet: true,
    });
    const model = await admin.get(API_ROUTES.ollamaSettings);
    expect(model.statusCode).toBe(200);
    expect(model.json()).toMatchObject({ source: "environment", url: "https://localhost:1" });
    const updates = await admin.get(API_ROUTES.hostUpdateSettings);
    expect(updates.statusCode).toBe(200);
    expect(updates.json()).toMatchObject({ windowStart: "03:00", windowEnd: "05:00" });
    expect((await viewer.get(API_ROUTES.settings)).json()).not.toHaveProperty("invalidSettings");
    const path = apiPath(API_ROUTES.integration, { kind: "gotify" });
    expect((await viewer.put(path, { url: "https://notify.test", token: "new-token" })).statusCode).toBe(403);
    expect((await admin.put(path, { url: "https://notify.test" })).json()).toEqual({
      error: "integration_token_required",
    });
    expect((await admin.put(path, { url: "https://notify.test", token: "new-token" })).statusCode).toBe(204);
    expect((await admin.get(API_ROUTES.settings)).json<SettingsView>().invalidSettings).not.toContain(
      SETTING_KEYS.gotify,
    );
    const exposed = JSON.stringify([
      current,
      integrations.json(),
      model.json(),
      updates.json(),
      printed.mock.calls,
      cp.stdout,
    ]);
    expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain("SyntaxError");
    expect(exposed).not.toContain("environment-token");
    expect(exposed).not.toContain("new-token");
  } finally {
    if (cp) {
      await cp.app.close();
      await cp.runnerApp.close();
      cp.services.databaseHandle.close();
    }
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
