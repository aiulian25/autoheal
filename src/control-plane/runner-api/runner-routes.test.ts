import { APP_VERSION } from "../../shared/constants.js";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type HostView } from "../../shared/api.js";
import { RUNNER_BODY_LIMIT_BYTES, HOST_SILENT_AFTER_MILLISECONDS } from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { hosts } from "../database/schema.js";
import { buildRunnerServer } from "./runner-server.js";

const heartbeat = heartbeatWith();

const fixture = (name: string) => readFileSync(`test/fixtures/tls/${name}`);

describe("host enrolment and the runner API", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const enroll = async (label: string) => {
    const enrolled = (await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>();
    return { ...enrolled, token: runnerTokenOf(enrolled) };
  };
  const sendHeartbeat = (token: string | null, payload: object = heartbeat) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  const listedHost = async (label: string) =>
    (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((host) => host.label === label)!;

  it("shows a new host's token once and stores only its hash", async () => {
    const { host, token } = await enroll("HP");
    expect(token).toMatch(/^ahk_[A-Za-z0-9_-]{43}$/);
    expect(host).toMatchObject({ label: "HP", state: "never_seen", tokenHint: token.slice(-4) });
    const stored = JSON.stringify(controlPlane.services.databaseHandle.database.select().from(hosts).all());
    expect(stored).not.toContain(token);
    expect(JSON.stringify(await admin.get(API_ROUTES.hosts))).not.toContain(token);
    expect((await admin.post(API_ROUTES.hosts, { label: "hp" })).json()).toEqual({ error: "host_label_taken" });
  });

  it("records heartbeats from enrolled runners, and tells them where Ollama and the dashboard are", async () => {
    const { token } = await enroll("HP");
    const answer = await sendHeartbeat(token);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      publicBaseUrl: "https://localhost",
      ollama: { url: "https://localhost:1", model: "qwen3:4b-instruct", contextTokens: 16_384 },
      // The exact release this control plane runs, which "Update runner" moves a sidecar to: never a moving tag.
      release: { image: `ghcr.io/aiulian25/autoheal:${APP_VERSION}`, version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
      // A host added now asks first for everything, until its page says otherwise.
      control: {
        restartByDefault: false,
        restart: { paperless: false },
        whenFailingByDefault: "ask",
        whenFailing: { paperless: "ask" },
        undoFailedUpdates: [],
        clearBuildCache: false,
        restartsResetAt: {},
      },
    });
    expect(await listedHost("HP")).toMatchObject({
      state: "online",
      runnerVersion: "2.0.0",
      dryRun: true,
      eventStreamConnected: true,
      protectedContainers: ["autoheal", "npm"],
      restartBudget: { paperless: 1 },
    });
    controlPlane.clock.now += HOST_SILENT_AFTER_MILLISECONDS + 1;
    expect((await listedHost("HP")).state).toBe("silent");
  });

  it("refuses missing, wrong and revoked tokens", async () => {
    const { host, token } = await enroll("HP");
    expect((await sendHeartbeat(null)).statusCode).toBe(401);
    expect((await sendHeartbeat(`ahk_${"x".repeat(43)}`)).json()).toEqual({ error: "unknown_runner" });
    expect((await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: host.id }))).json()).toMatchObject({
      state: "revoked",
    });
    expect((await sendHeartbeat(token)).statusCode).toBe(401);
  });

  it("rejects malformed and oversized payloads", async () => {
    const { token } = await enroll("HP");
    expect((await sendHeartbeat(token, { ...heartbeat, dryRun: "yes" })).statusCode).toBe(400);
    const oversized = { ...heartbeat, runnerVersion: "x".repeat(RUNNER_BODY_LIMIT_BYTES) };
    expect((await sendHeartbeat(token, oversized)).statusCode).toBe(413);
  });

  it("lets viewers see the fleet but not change it", async () => {
    const { host } = await enroll("HP");
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.get(API_ROUTES.hosts)).statusCode).toBe(200);
    expect((await viewer.post(API_ROUTES.hosts, { label: "Alder" })).statusCode).toBe(403);
    expect((await viewer.post(apiPath(API_ROUTES.hostRevoke, { hostId: host.id }))).statusCode).toBe(403);
  });

  describe("over real HTTPS", () => {
    const serveWith = async (certificate: string, key: string) => {
      const server = await buildRunnerServer({ cert: fixture(certificate), key: fixture(key) }, controlPlane.services);
      await server.listen({ host: "127.0.0.1", port: 0 });
      return { server, port: (server.server.address() as AddressInfo).port };
    };

    it("talks to a control plane whose certificate comes from the trusted CA", async () => {
      const { token } = await enroll("HP");
      const { server, port } = await serveWith("server.pem", "server-key.pem");
      try {
        const response = await fetch(`https://localhost:${port}${RUNNER_ROUTES.heartbeat}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(heartbeat),
        });
        expect(response.status).toBe(200);
      } finally {
        await server.close();
      }
    });

    it("refuses a server whose certificate comes from anyone else", async () => {
      const { server, port } = await serveWith("untrusted-server.pem", "untrusted-server-key.pem");
      try {
        const attempt = fetch(`https://localhost:${port}${RUNNER_ROUTES.heartbeat}`, { method: "POST" });
        await expect(attempt).rejects.toThrow(/fetch failed/);
      } finally {
        await server.close();
      }
    });
  });
});
