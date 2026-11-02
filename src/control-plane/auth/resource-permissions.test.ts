import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { currentCode, fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type JobView, type TerminalView } from "../../shared/api.js";
import { HOST_SILENT_AFTER_MILLISECONDS, HTTP_HEADERS, RUNNER_CAPABILITIES } from "../../shared/constants.js";
import {
  RESOURCE_ACTIONS,
  type ResourceAction,
  type ResourceGrant,
  type ResourcePermissionsView,
} from "../../shared/resource-permissions.js";
import { RUNNER_ROUTES, type ContainerAccessWork, type WorkResponse } from "../../shared/protocol.js";
import { jobs } from "../database/schema.js";

const available = { status: "available", checkedAt: 1, remoteDigest: `sha256:${"a".repeat(64)}` } as const;
const member = { name: "app", composeProject: "project" };
describe("scoped operator capabilities", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let operator: Awaited<ReturnType<typeof fullySignedInUser>>;
  let hostId: string;
  let token: string;
  const grantPath = () => apiPath(API_ROUTES.userGrants, { userId: operator.userId });
  const containerPath = (route: string, name = "app", host = hostId) =>
    apiPath(route, { hostId: host, containerName: name });
  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    plane.runnerApp.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${token}`, [HTTP_HEADERS.runnerCapabilities]: RUNNER_CAPABILITIES },
    });
  const report = (supported = true) =>
    runner("POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({
        dryRun: false,
        containers: [
          containerSnapshot({
            name: "app",
            image: "ghcr.io/example/app:latest",
            composeProject: "project",
            updatePolicy: "auto",
            update: available,
          }),
          containerSnapshot({ name: "dependent", composeProject: "project" }),
          containerSnapshot({ name: "other", composeProject: "elsewhere" }),
          containerSnapshot({ name: "protected", composeProject: "project" }),
        ],
        protectedContainers: ["protected"],
      }),
      containerAccess: true,
      resourcePermissions: supported,
    });
  const grants = (
    actions: ResourceAction[],
    scope: ResourceGrant["scope"] = "container",
    resource: string | null = "app",
  ): ResourceGrant[] => [{ hostId, scope, resource, actions }];
  async function save(next: ResourceGrant[]) {
    const current = (await admin.get(grantPath())).json<ResourcePermissionsView>();
    const saved = await admin.put(grantPath(), { revision: current.revision, grants: next });
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json<ResourcePermissionsView>();
  }
  async function assertBoundToHost(path: string) {
    const noToken = await plane.runnerApp.inject({ method: "POST", url: path, payload: { members: [member] } });
    expect(noToken.statusCode).toBe(401);
    const other = (
      await admin.post(API_ROUTES.hosts, { label: `Other-${randomUUID().slice(0, 6)}` })
    ).json<EnrolledHostView>();
    const wrongHost = await plane.runnerApp.inject({
      method: "POST",
      url: path,
      payload: { members: [member] },
      headers: { authorization: `Bearer ${runnerTokenOf(other)}` },
    });
    expect(wrongHost.json()).toEqual({ authorized: false });
  }
  async function signBackIn() {
    plane.clock.now += 30_000;
    await operator.client.signIn("operator", operator.password);
    const verified = await operator.client.post(API_ROUTES.secondFactor, {
      code: currentCode(operator.secret, plane.clock.now),
    });
    expect(verified.statusCode, verified.body).toBe(204);
    await report();
  }
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    operator = await fullySignedInUser(plane, admin, "operator", "viewer");
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Lab" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    await report();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    plane.services.files.reset();
    plane.services.containerSettings.reset();
    plane.services.terminals.resetForRestore();
    await plane.app.close();
    await plane.runnerApp.close();
  });

  it("preserves viewer reads while denying each ungranted privileged resource action", async () => {
    expect((await operator.client.get(API_ROUTES.hosts)).statusCode).toBe(200);
    expect((await operator.client.get(API_ROUTES.containers)).statusCode).toBe(200);
    const attempts = [
      () => operator.client.post(containerPath(API_ROUTES.containerActions), { action: "restart" }),
      () => operator.client.post(containerPath(API_ROUTES.containerActions), { action: "update" }),
      () => operator.client.post(containerPath(API_ROUTES.containerActions), { action: "logs" }),
      () => operator.client.post(containerPath(API_ROUTES.terminals), { columns: 80, rows: 24 }),
      () => operator.client.post(containerPath(API_ROUTES.containerFiles), { operation: "read", path: "/data/file" }),
      () => operator.client.get(containerPath(API_ROUTES.containerSettings)),
    ];
    for (const attempt of attempts) expect((await attempt()).statusCode).toBe(403);
    for (const action of RESOURCE_ACTIONS)
      expect(() => plane.services.resourcePermissions.require(operator.userId, hostId, action, ["app"])).toThrow(
        "resource_forbidden",
      );
    for (const action of RESOURCE_ACTIONS) {
      await save(grants([action]));
      expect(() => plane.services.resourcePermissions.require(operator.userId, hostId, action, ["app"])).not.toThrow();
      expect(() => plane.services.resourcePermissions.require(operator.userId, hostId, action, ["other"])).toThrow();
      expect(() =>
        plane.services.resourcePermissions.require(operator.userId, randomUUID(), action, ["app"]),
      ).toThrow();
      for (const other of RESOURCE_ACTIONS.filter((item) => item !== action))
        expect(() => plane.services.resourcePermissions.require(operator.userId, hostId, other, ["app"])).toThrow();
    }
    await signBackIn();
    expect((await operator.client.get(API_ROUTES.users)).statusCode).toBe(403);
    expect((await operator.client.get(API_ROUTES.backups)).statusCode).toBe(403);
    expect(
      (await operator.client.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "check_updates" })).statusCode,
    ).toBe(403);
    expect(
      (await operator.client.put(apiPath(API_ROUTES.hostControl, { hostId }), { restartDefault: "restart" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await operator.client.post(apiPath(API_ROUTES.containerUpdates, { hostId }), { names: ["app"] })).statusCode,
    ).toBe(403);
  });
  it("uses optimistic revisions, validates grants and invalidates all target sessions without exposing grant contents in audit", async () => {
    const saved = await save(grants(["lifecycle"]));
    expect(saved.revision).toBe(1);
    expect((await operator.client.get(API_ROUTES.session)).statusCode).toBe(401);
    expect((await admin.put(grantPath(), { revision: 0, grants: [] })).statusCode).toBe(409);
    expect(
      (
        await admin.put(grantPath(), {
          revision: 1,
          grants: [{ hostId, scope: "host", resource: "wildcard", actions: ["terminal"] }],
        })
      ).statusCode,
    ).toBe(400);
    await signBackIn();
    expect((await operator.client.get(API_ROUTES.accountPermissions)).json()).toEqual(saved);
    expect((await operator.client.put(grantPath(), { revision: 1, grants: [] })).statusCode).toBe(403);
    const audit = plane.stdout.filter((line) => line.includes("user.grants_changed"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('"grantCount":1');
    expect(audit[0]).not.toContain('"actions"');
  });
  it("authorizes current full runner groups, preserves delegated identity and refuses stale or older runner capability", async () => {
    await save(grants(["update"]));
    await signBackIn();
    const response = await operator.client.post(containerPath(API_ROUTES.containerActions), { action: "update" });
    expect(response.statusCode, response.body).toBe(200);
    const job = response.json<JobView>();
    const delivered = (await runner("GET", RUNNER_ROUTES.work))
      .json<WorkResponse>()
      .jobs.find((item) => item.id === job.id)!;
    expect(delivered.operatorUserId).toBe(operator.userId);
    expect("allowWithoutCheckpoint" in delivered).toBe(false);
    await assertBoundToHost(apiPath(RUNNER_ROUTES.jobAuthorization, { jobId: job.id }));
    const authorize = (members: object[], id = job.id) =>
      runner("POST", apiPath(RUNNER_ROUTES.jobAuthorization, { jobId: id }), { members });
    expect((await authorize([member])).json()).toEqual({ authorized: true });
    expect((await authorize([member, { name: "dependent", composeProject: "project" }])).json()).toEqual({
      authorized: false,
    });
    await save(grants(["update"], "stack", "project"));
    expect((await authorize([member, { name: "dependent", composeProject: "project" }])).json()).toEqual({
      authorized: true,
    });
    expect((await authorize([member, { name: "other", composeProject: "elsewhere" }])).json()).toEqual({
      authorized: false,
    });
    expect((await authorize([member], randomUUID())).json()).toEqual({ authorized: false });
    await save([]);
    expect((await authorize([member])).json()).toEqual({ authorized: false });
    await save(grants(["lifecycle"]));
    await signBackIn();
    await report(false);
    expect(
      (await operator.client.post(containerPath(API_ROUTES.containerActions), { action: "restart" })).statusCode,
    ).toBe(409);
    await report(true);
    plane.clock.now += HOST_SILENT_AFTER_MILLISECONDS + 1;
    expect(
      (await operator.client.post(containerPath(API_ROUTES.containerActions), { action: "restart" })).statusCode,
    ).toBe(409);
  });
  it("denies revoked queued jobs and keeps protected-container checks despite a host-wide grant", async () => {
    await save(grants(["lifecycle"], "host", null));
    await signBackIn();
    expect(
      (await operator.client.post(containerPath(API_ROUTES.containerActions, "protected"), { action: "restart" }))
        .statusCode,
    ).toBe(422);
    const unrelated = (await admin.post(API_ROUTES.tasks, { title: "Unrelated administrative task" })).json<{
      id: string;
    }>();
    expect(
      (
        await operator.client.post(containerPath(API_ROUTES.containerActions), {
          action: "restart",
          taskId: unrelated.id,
        })
      ).json(),
    ).toEqual({ error: "invalid_target" });
    const created = (
      await operator.client.post(containerPath(API_ROUTES.containerActions), { action: "restart" })
    ).json<JobView>();
    await save([]);
    expect((await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs).toEqual([]);
    expect(
      plane.services.databaseHandle.database.select().from(jobs).where(eq(jobs.id, created.id)).get()?.status,
    ).toBe("failed");
  });
  it("retains delegated job identity through role changes and clears latent grants on demotion", async () => {
    await save(grants(["lifecycle"]));
    await signBackIn();
    const delegated = (
      await operator.client.post(containerPath(API_ROUTES.containerActions), { action: "restart" })
    ).json<JobView>();
    expect(
      (await admin.patch(apiPath(API_ROUTES.user, { userId: operator.userId }), { role: "admin" })).statusCode,
    ).toBe(200);
    const delivered = (await runner("GET", RUNNER_ROUTES.work))
      .json<WorkResponse>()
      .jobs.find((job) => job.id === delegated.id)!;
    expect(delivered.operatorUserId).toBe(operator.userId);
    await signBackIn();
    const formerAdmin = (
      await operator.client.post(containerPath(API_ROUTES.containerActions), { action: "pause" })
    ).json<JobView>();
    expect(
      (await admin.patch(apiPath(API_ROUTES.user, { userId: operator.userId }), { role: "viewer" })).statusCode,
    ).toBe(200);
    expect(plane.services.resourcePermissions.current(operator.userId).grants).toEqual([]);
    expect(
      (
        await runner("POST", apiPath(RUNNER_ROUTES.jobAuthorization, { jobId: delegated.id }), { members: [member] })
      ).json(),
    ).toEqual({ authorized: false });
    expect((await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs).toEqual([]);
    expect(plane.services.jobsService.view(formerAdmin.id).status).toBe("failed");
  });
  it("binds terminal execution and live output to the granting session, and closes it immediately on revocation", async () => {
    await save(grants(["terminal"]));
    await signBackIn();
    const opened = await operator.client.post(containerPath(API_ROUTES.terminals), { columns: 80, rows: 24 });
    expect(opened.statusCode, opened.body).toBe(200);
    const { id } = opened.json<TerminalView>();
    const access = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>();
    expect(access.terminals[0]?.operatorUserId).toBe(operator.userId);
    const authPath = apiPath(RUNNER_ROUTES.terminalAuthorization, { requestId: id });
    await assertBoundToHost(authPath);
    expect(
      (
        await runner("POST", apiPath(RUNNER_ROUTES.terminalAuthorization, { requestId: randomUUID() }), {
          members: [member],
        })
      ).json(),
    ).toEqual({ authorized: false });
    expect((await runner("POST", authPath, { members: [member] })).json()).toEqual({ authorized: true });
    const owner = plane.services.sessions.resolve(operator.client.sessionToken!)!;
    const events: object[] = [];
    plane.services.terminals.follow(owner, id, 0, (event) => events.push(event));
    await save([]);
    expect((await runner("POST", authPath, { members: [member] })).json()).toEqual({ authorized: false });
    plane.services.terminals.printed(
      plane.services.hostsService.authenticate(token)!,
      id,
      Buffer.from("must not leak").toString("base64"),
    );
    expect(events).toEqual([expect.objectContaining({ kind: "ended" })]);
    expect((await runner("GET", apiPath(RUNNER_ROUTES.terminalInput, { terminalId: id }))).json()).toMatchObject({
      closed: true,
      data: [],
    });
  });
  it("does not deliver delegated inside-access requests to a downgraded poll before its first heartbeat", async () => {
    await save(grants(["terminal", "files", "settings"]));
    await signBackIn();
    const delegatedShell = (
      await operator.client.post(containerPath(API_ROUTES.terminals), { columns: 80, rows: 24 })
    ).json<TerminalView>();
    const adminShell = (
      await admin.post(containerPath(API_ROUTES.terminals), { columns: 80, rows: 24 })
    ).json<TerminalView>();
    const filesAsked = vi.spyOn(plane.services.files, "ask");
    const settingsAsked = vi.spyOn(plane.services.containerSettings, "read");
    const delegatedFile = operator.client.post(containerPath(API_ROUTES.containerFiles), {
      operation: "read",
      path: "/data/delegated",
    });
    const adminFile = admin.post(containerPath(API_ROUTES.containerFiles), { operation: "read", path: "/data/admin" });
    const delegatedSettings = operator.client.get(containerPath(API_ROUTES.containerSettings));
    const adminSettings = admin.get(containerPath(API_ROUTES.containerSettings));
    await vi.waitFor(() => {
      expect(filesAsked).toHaveBeenCalledTimes(2);
      expect(settingsAsked).toHaveBeenCalledTimes(2);
    });
    // Retained heartbeat state says support=true; this particular poll must still assert it can read the protocol.
    expect(plane.services.hostsService.authenticate(token)!.resourcePermissions).toBe(true);
    const downgraded = await plane.runnerApp.inject({
      method: "GET",
      url: RUNNER_ROUTES.containerAccess,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(downgraded.statusCode).toBe(200);
    const legacy = downgraded.json<ContainerAccessWork>();
    expect(legacy.terminals).toEqual([expect.objectContaining({ id: adminShell.id, requestedBy: "admin" })]);
    expect(legacy.files).toEqual([expect.objectContaining({ path: "/data/admin", requestedBy: "admin" })]);
    expect(legacy.settings).toEqual([expect.objectContaining({ requestedBy: "admin" })]);
    expect(plane.services.hostsService.authenticate(token)!.resourcePermissions).toBe(true);
    const supported = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>();
    expect(supported.terminals).toEqual([
      expect.objectContaining({ id: delegatedShell.id, operatorUserId: operator.userId }),
    ]);
    expect(supported.files).toEqual([
      expect.objectContaining({ path: "/data/delegated", operatorUserId: operator.userId }),
    ]);
    expect(supported.settings).toEqual([expect.objectContaining({ operatorUserId: operator.userId })]);
    // Rejected legacy polling did not mark any delegated request handed-over or remove its queued payload.
    for (const request of [...legacy.files, ...supported.files])
      await runner("POST", apiPath(RUNNER_ROUTES.fileAnswer, { requestId: request.id }), {
        error: null,
        entries: null,
        truncated: false,
        content: "",
      });
    for (const request of [...legacy.settings, ...supported.settings])
      await runner("POST", apiPath(RUNNER_ROUTES.settingsAnswer, { requestId: request.id }), {
        error: null,
        settings: null,
      });
    expect((await adminFile).statusCode).toBe(200);
    expect((await delegatedFile).statusCode).toBe(200);
    expect((await adminSettings).statusCode).toBe(200);
    expect((await delegatedSettings).statusCode).toBe(200);
    for (const id of [delegatedShell.id, adminShell.id])
      await runner("POST", apiPath(RUNNER_ROUTES.terminalEnd, { terminalId: id }), { exitCode: 0, reason: null });
  });
  it("keeps file/settings answers session-bound and denies inside requests without the exact capability", async () => {
    await save(grants(["files", "settings"]));
    await signBackIn();
    const filePending = operator.client.post(containerPath(API_ROUTES.containerFiles), {
      operation: "read",
      path: "/data/value",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const access = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>();
    const request = access.files[0]!;
    expect(request.operatorUserId).toBe(operator.userId);
    const authPath = apiPath(RUNNER_ROUTES.fileAuthorization, { requestId: request.id });
    await assertBoundToHost(authPath);
    expect(
      (
        await runner("POST", apiPath(RUNNER_ROUTES.fileAuthorization, { requestId: randomUUID() }), {
          members: [member],
        })
      ).json(),
    ).toEqual({ authorized: false });
    expect((await runner("POST", authPath, { members: [member] })).json()).toEqual({ authorized: true });
    await save([]);
    expect((await runner("POST", authPath, { members: [member] })).json()).toEqual({ authorized: false });
    await runner("POST", apiPath(RUNNER_ROUTES.fileAnswer, { requestId: request.id }), {
      error: null,
      entries: null,
      truncated: false,
      content: Buffer.from("never delivered").toString("base64"),
    });
    expect((await filePending).statusCode).toBe(403);
    await save(grants(["settings"]));
    await signBackIn();
    const settingsPending = operator.client.get(containerPath(API_ROUTES.containerSettings));
    await new Promise((resolve) => setImmediate(resolve));
    const settingsRequest = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>()
      .settings[0]!;
    expect(settingsRequest.operatorUserId).toBe(operator.userId);
    await assertBoundToHost(apiPath(RUNNER_ROUTES.settingsAuthorization, { requestId: settingsRequest.id }));
    expect(
      (
        await runner("POST", apiPath(RUNNER_ROUTES.settingsAuthorization, { requestId: randomUUID() }), {
          members: [member],
        })
      ).json(),
    ).toEqual({ authorized: false });
    expect(
      (
        await runner("POST", apiPath(RUNNER_ROUTES.settingsAuthorization, { requestId: settingsRequest.id }), {
          members: [member],
        })
      ).json(),
    ).toEqual({ authorized: true });
    await save([]);
    expect(
      (
        await runner("POST", apiPath(RUNNER_ROUTES.settingsAuthorization, { requestId: settingsRequest.id }), {
          members: [member],
        })
      ).json(),
    ).toEqual({ authorized: false });
    await runner("POST", apiPath(RUNNER_ROUTES.settingsAnswer, { requestId: settingsRequest.id }), {
      error: null,
      settings: null,
    });
    expect((await settingsPending).statusCode).toBe(403);
  });
});
