import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type AuditEventView, type EnrolledHostView } from "../../shared/api.js";
import { AUDIT_ACTIONS, HTTP_STATUS } from "../../shared/constants.js";
import type { ImageTrustView } from "./image-trust-service.js";
import { trustedPublishers } from "../database/schema.js";
import { RUNNER_ROUTES, type HeartbeatResponse } from "../../shared/protocol.js";

const keyPair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const pemOf = (pair: ReturnType<typeof keyPair>) => pair.publicKey.export({ type: "spki", format: "pem" }).toString();
// A pasted key is kept as its public part in SPKI PEM: one pasted that way keeps its text, the whitespace settled.
const OWNER_KEY = pemOf(keyPair()).trim();
const privatePemOf = (pair: ReturnType<typeof keyPair>) =>
  pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("requiring a signed image before an update", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let runnerToken: string;

  const view = async () => (await admin.get(API_ROUTES.imageTrust)).json<ImageTrustView>();
  const addPublisher = (body: Record<string, unknown>) => admin.post(API_ROUTES.imageTrust, body);
  const addRule = (body: Record<string, unknown>) => admin.post(API_ROUTES.imageTrustRules, body);
  const heartbeat = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: heartbeatWith({ hostLabel: "Alder" }),
        headers: { authorization: `Bearer ${runnerToken}` },
      })
    ).json<HeartbeatResponse>();

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    runnerToken = runnerTokenOf(enrolled);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  it("tells a runner nothing about trust until a publisher and a rule are set up", async () => {
    expect((await heartbeat()).imageTrust).toBeUndefined();

    await addPublisher({ name: "example", publicKey: OWNER_KEY });
    await addRule({ registry: "ghcr.io", repository: "example/app" });

    const answer = await heartbeat();
    expect(answer.imageTrust?.publishers).toEqual([{ name: "example", publicKey: OWNER_KEY }]);
    expect(answer.imageTrust?.required).toEqual([{ registry: "ghcr.io", repository: "example/app", publishers: [] }]);
  });

  it("gives the policy a new revision whenever it changes, so runners ask again", async () => {
    await addPublisher({ name: "example", publicKey: OWNER_KEY });
    const first = (await heartbeat()).imageTrust!.revision;

    await addRule({ registry: "ghcr.io", repository: "example/app" });
    const second = (await heartbeat()).imageTrust!.revision;
    expect(second).not.toBe(first);

    const ruleId = (await view()).rules[0]!.id;
    await admin.delete(apiPath(API_ROUTES.imageTrustRule, { ruleId }));
    expect((await heartbeat()).imageTrust!.revision).not.toBe(second);
  });

  it("never gives two different policies the same revision, whatever the clock does between changes", async () => {
    await addPublisher({ name: "example", publicKey: OWNER_KEY });
    await addRule({ registry: "ghcr.io", repository: "example/first" });
    const start = controlPlane.clock.now;
    controlPlane.clock.now += 100;
    await addRule({ registry: "ghcr.io", repository: "example/second" });
    const before = (await heartbeat()).imageTrust!.revision;

    const first = (await view()).rules.find(({ repository }) => repository === "example/first")!;
    await admin.delete(apiPath(API_ROUTES.imageTrustRule, { ruleId: first.id }));
    // Set back, as a time sync can: the new rule is dated before the newest one kept.
    controlPlane.clock.now = start + 50;
    await addRule({ registry: "ghcr.io", repository: "example/third" });
    expect((await heartbeat()).imageTrust!.revision).not.toBe(before);
  });

  it("refuses a key that does not read as a public key, and keeps nothing", async () => {
    expect((await addPublisher({ name: "example", publicKey: "not a key at all" })).json()).toEqual({
      error: "publisher_key_invalid",
    });
    expect((await view()).publishers).toEqual([]);
  });

  it("refuses a private key pasted where its public half goes, keeping nothing and saying none of it", async () => {
    const pair = keyPair();

    const refused = await addPublisher({ name: "example", publicKey: privatePemOf(pair) });

    expect(refused.json()).toEqual({ error: "publisher_key_invalid" });
    expect(refused.body).not.toContain("PRIVATE KEY");
    expect((await view()).publishers).toEqual([]);
  });

  it("gives runners only the public half of a key a row kept from before private ones were refused", async () => {
    const pair = keyPair();
    controlPlane.services.databaseHandle.database
      .insert(trustedPublishers)
      .values({ name: "example", publicKey: privatePemOf(pair), createdBy: "admin", createdAt: 1 })
      .run();

    const given = (await heartbeat()).imageTrust?.publishers;

    expect(given).toEqual([{ name: "example", publicKey: pemOf(pair).trim() }]);
    expect((await view()).publishers[0]!.publicKey).not.toContain("PRIVATE KEY");
  });

  it("says what kind of key each publisher has, and never calls it a secret", async () => {
    await addPublisher({ name: "example", publicKey: OWNER_KEY });

    const publishers = (await view()).publishers;

    expect(publishers[0]).toMatchObject({ name: "example", keyType: "ec", publicKey: OWNER_KEY });
  });

  it("will not name a publisher twice, nor a rule for a scope already covered", async () => {
    await addPublisher({ name: "example", publicKey: OWNER_KEY });
    expect((await addPublisher({ name: "example", publicKey: pemOf(keyPair()) })).json()).toEqual({
      error: "publisher_name_taken",
    });

    await addRule({ registry: "ghcr.io", repository: "example/app" });
    expect((await addRule({ registry: "ghcr.io", repository: "example/app" })).json()).toEqual({
      error: "trust_scope_taken",
    });
  });

  it("refuses a rule naming a publisher it does not know, and one with no key set up at all", async () => {
    expect((await addRule({ registry: "ghcr.io", publishers: ["nobody"] })).json()).toEqual({
      error: "publisher_needed",
    });

    await addPublisher({ name: "example", publicKey: OWNER_KEY });
    expect((await addRule({ registry: "ghcr.io", publishers: ["nobody"] })).json()).toEqual({
      error: "publisher_not_found",
    });
  });

  it("keeps a publisher a rule names until that rule has gone", async () => {
    await addPublisher({ name: "example", publicKey: OWNER_KEY });
    await addRule({ registry: "ghcr.io", repository: "example/app", publishers: ["example"] });

    const path = apiPath(API_ROUTES.imageTrustPublisher, { name: "example" });
    expect((await admin.delete(path)).json()).toEqual({ error: "publisher_in_use" });

    const ruleId = (await view()).rules[0]!.id;
    await admin.delete(apiPath(API_ROUTES.imageTrustRule, { ruleId }));
    expect((await admin.delete(path)).statusCode).toBe(HTTP_STATUS.noContent);
    expect((await heartbeat()).imageTrust).toBeUndefined();
  });

  it("is for admins only", async () => {
    const other = (await fullySignedInUser(controlPlane, admin, "mira", "viewer")).client;

    expect((await other.get(API_ROUTES.imageTrust)).statusCode).toBe(HTTP_STATUS.forbidden);
    expect((await other.post(API_ROUTES.imageTrust, { name: "x", publicKey: OWNER_KEY })).statusCode).toBe(
      HTTP_STATUS.forbidden,
    );
    expect((await other.post(API_ROUTES.imageTrustRules, { registry: "ghcr.io" })).statusCode).toBe(
      HTTP_STATUS.forbidden,
    );
  });

  it("records every change to the policy in the audit log", async () => {
    await addPublisher({ name: "example", publicKey: OWNER_KEY });
    await addRule({ registry: "ghcr.io", repository: "example/app" });
    const ruleId = (await view()).rules[0]!.id;
    await admin.delete(apiPath(API_ROUTES.imageTrustRule, { ruleId }));

    const actions = (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>().map(({ action }) => action);

    expect(actions).toContain(AUDIT_ACTIONS.trustedPublisherAdded);
    expect(actions).toContain(AUDIT_ACTIONS.imageTrustRuleAdded);
    expect(actions).toContain(AUDIT_ACTIONS.imageTrustRuleRemoved);
  });
});
