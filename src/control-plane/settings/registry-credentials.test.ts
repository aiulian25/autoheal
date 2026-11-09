import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heartbeatWith } from "../../../test/support/inventory.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type AuditEventView, type EnrolledHostView, type HostView } from "../../shared/api.js";
import { AUDIT_ACTIONS, HTTP_STATUS } from "../../shared/constants.js";
import { RUNNER_ROUTES, type HeartbeatResponse } from "../../shared/protocol.js";
import type { RegistryCredentialTestView, RegistryCredentialView } from "../../shared/registry-credentials.js";
import { registryCredentials } from "../database/schema.js";

const PASSWORD = "ghp_a-token-nobody-else-may-see";
const credentialPath = (credentialId: string) => apiPath(API_ROUTES.registryCredential, { credentialId });
const testPath = (credentialId: string) => apiPath(API_ROUTES.registryCredentialTest, { credentialId });

describe("credentials for private registries", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let tokens: Record<string, string>;

  /** Two hosts, each with its runner's token, as a fleet with a private registry would have. */
  async function enrol(...labels: string[]) {
    const joined: Record<string, string> = {};
    for (const label of labels) {
      const enrolled = (await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>();
      const token = runnerTokenOf(enrolled);
      joined[label] = token;
      await heartbeatOf(token, label);
    }
    return joined;
  }
  const heartbeatOf = (token: string, hostLabel: string) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ hostLabel }),
      headers: { authorization: `Bearer ${token}` },
    });
  const registriesFor = async (token: string, hostLabel: string) =>
    (await heartbeatOf(token, hostLabel)).json<HeartbeatResponse>().registries ?? [];
  const hostIdOf = async (label: string) =>
    (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((host) => host.label === label)!.id;
  const views = async () => (await admin.get(API_ROUTES.registryCredentials)).json<RegistryCredentialView[]>();
  const add = (body: Record<string, unknown>) => admin.post(API_ROUTES.registryCredentials, body);
  const added = async (body: Record<string, unknown>) => (await add(body)).json<{ id: string }>().id;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    tokens = await enrol("Alder", "Birch");
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  it("keeps the password sealed and never answers with it", async () => {
    const id = await added({ registry: "ghcr.io", repository: "owner/app", username: "owner", password: PASSWORD });

    const view = (await views()).find((each) => each.id === id)!;
    expect(view).toMatchObject({ registry: "ghcr.io", repository: "owner/app", username: "owner", hostIds: [] });
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    const stored = controlPlane.services.databaseHandle.database.select().from(registryCredentials).all();
    expect(stored[0]!.sealedPassword).not.toContain(PASSWORD);
    expect(stored[0]!.sealedPassword.startsWith("sealed:")).toBe(true);
  });

  it("gives it only to the hosts it names, and to every host when it names none", async () => {
    const alder = await hostIdOf("Alder");
    await added({
      registry: "ghcr.io",
      repository: "owner/app",
      username: "owner",
      password: PASSWORD,
      hostIds: [alder],
    });

    expect(await registriesFor(tokens.Alder!, "Alder")).toEqual([
      { registry: "ghcr.io", repository: "owner/app", username: "owner", password: PASSWORD },
    ]);
    expect(await registriesFor(tokens.Birch!, "Birch")).toEqual([]);

    await added({ registry: "registry.example.com", username: "everyone", password: "second-secret" });
    expect((await registriesFor(tokens.Birch!, "Birch")).map(({ registry }) => registry)).toEqual([
      "registry.example.com",
    ]);
  });

  it("names Docker Hub by the one host it answers to, however the credential spells it", async () => {
    await added({ registry: "docker.io", username: "owner", password: PASSWORD });
    expect((await views())[0]!.registry).toBe("registry-1.docker.io");
    expect((await registriesFor(tokens.Alder!, "Alder"))[0]!.registry).toBe("registry-1.docker.io");
  });

  it("takes a rotated password from the next heartbeat on, and nothing once revoked", async () => {
    const id = await added({ registry: "ghcr.io", repository: "owner/app", username: "owner", password: PASSWORD });

    await admin.put(credentialPath(id), {
      registry: "ghcr.io",
      repository: "owner/app",
      username: "owner",
      password: "rotated-secret",
    });
    expect((await registriesFor(tokens.Alder!, "Alder"))[0]!.password).toBe("rotated-secret");

    expect((await admin.delete(credentialPath(id))).statusCode).toBe(HTTP_STATUS.noContent);
    expect(await registriesFor(tokens.Alder!, "Alder")).toEqual([]);
    expect(await views()).toEqual([]);
  });

  it("holds one credential per scope, and refuses a second for the same one", async () => {
    await added({ registry: "ghcr.io", repository: "owner/app", username: "owner", password: PASSWORD });
    const again = await add({
      registry: "ghcr.io",
      repository: "owner/app/",
      username: "someone",
      password: "another",
    });
    expect(again.json()).toEqual({ error: "registry_scope_taken" });
    // The same registry, a different repository, is its own scope.
    expect(
      (await add({ registry: "ghcr.io", repository: "owner/other", username: "o", password: "p" })).statusCode,
    ).toBe(HTTP_STATUS.ok);
  });

  it("refuses a host it does not know and a repository a registry would not accept", async () => {
    const unknown = await add({
      registry: "ghcr.io",
      username: "owner",
      password: PASSWORD,
      hostIds: ["6f1c9a1e-0000-4000-8000-000000000000"],
    });
    expect(unknown.json()).toEqual({ error: "host_not_found" });
    expect((await add({ registry: "ghcr.io", repository: "Owner/App", username: "o", password: "p" })).statusCode).toBe(
      HTTP_STATUS.badRequest,
    );
  });

  it("is for admins only: another user may not read, add or remove one", async () => {
    const id = await added({ registry: "ghcr.io", repository: "owner/app", username: "owner", password: PASSWORD });
    const other = (await fullySignedInUser(controlPlane, admin, "mira", "viewer")).client;

    expect((await other.get(API_ROUTES.registryCredentials)).statusCode).toBe(HTTP_STATUS.forbidden);
    expect(
      (await other.post(API_ROUTES.registryCredentials, { registry: "ghcr.io", username: "a", password: "b" }))
        .statusCode,
    ).toBe(HTTP_STATUS.forbidden);
    expect((await other.delete(credentialPath(id))).statusCode).toBe(HTTP_STATUS.forbidden);
  });

  it("records every change and every test in the audit log, with the scope and never the password", async () => {
    const id = await added({ registry: "ghcr.io", repository: "owner/app", username: "owner", password: PASSWORD });
    await admin.put(credentialPath(id), {
      registry: "ghcr.io",
      repository: "owner/app",
      username: "owner",
      password: "rotated-secret",
    });
    await admin.delete(credentialPath(id));

    const events = (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>();
    const actions = events.map(({ action }) => action);
    expect(actions).toContain(AUDIT_ACTIONS.registryCredentialAdded);
    expect(actions).toContain(AUDIT_ACTIONS.registryCredentialRotated);
    expect(actions).toContain(AUDIT_ACTIONS.registryCredentialRemoved);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain("rotated-secret");
    expect(events.find(({ action }) => action === AUDIT_ACTIONS.registryCredentialAdded)!.details).toMatchObject({
      scope: "ghcr.io/owner/app",
      username: "owner",
    });
  });

  it("will not try a credential against a repository outside its scope, and needs one for a whole registry", async () => {
    const narrow = await added({
      registry: "ghcr.io",
      repository: "owner/app",
      username: "owner",
      password: PASSWORD,
    });
    expect((await admin.post(testPath(narrow), { repository: "someone/else" })).json()).toEqual({
      error: "registry_repository_out_of_scope",
    });

    const wide = await added({ registry: "registry.example.com", username: "owner", password: PASSWORD });
    expect((await admin.post(testPath(wide), {})).json()).toEqual({ error: "registry_repository_needed" });
  });

  it("says what an asked-for test found, with nothing secret in the answer", async () => {
    const id = await added({
      registry: "localhost:1",
      repository: "owner/app",
      username: "owner",
      password: PASSWORD,
    });

    const answer = (await admin.post(testPath(id), {})).json<RegistryCredentialTestView>();

    expect(answer.reached).toBe(false);
    expect(answer.problem).toBeTruthy();
    expect(answer.problem).not.toContain(PASSWORD);
    const events = (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>();
    const tested = events.find(({ action }) => action === AUDIT_ACTIONS.registryCredentialTested)!;
    expect(tested.details).toMatchObject({ scope: "localhost:1/owner/app", repository: "owner/app", reached: false });
  });
});
