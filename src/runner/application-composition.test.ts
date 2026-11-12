import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDockerEngine, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { containerSnapshot, heartbeatWith } from "../../test/support/inventory.js";
import { loadRunnerConfig } from "../config/runner-config.js";
import { ownCertificate } from "../control-plane/tls/certificate.js";
import {
  HOST_TERMINAL_HELPER,
  HTTP_HEADERS,
  JOB_ACTION,
  RUNNER_UPDATE_REPORT,
  SELF_UPDATE,
  SELF_UPDATE_TEXT,
} from "../shared/constants.js";
import {
  RUNNER_ROUTES,
  type ContainerJob,
  type FileRequest,
  type Heartbeat,
  type HostJob,
} from "../shared/protocol.js";
import { ApplicationBackupJournal } from "./application-backup-journal.js";
import { createRuntime, createContainerAccess, fitted, startRunner, watchEvents } from "./application.js";
import { DockerClient } from "./docker-client.js";
import { ControlPlaneClient } from "./control-plane-client.js";

describe("application backup runner composition", () => {
  let engine: FakeDockerEngine, root: string;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    root = mkdtempSync(join(tmpdir(), "autoheal-app-compose-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });
  const configuration = () => ({
    ...loadRunnerConfig(
      { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
      join(root, "no-join"),
    ),
    containerAccess: true,
    dryRun: false,
    hostPackages: "apply" as const,
  });
  async function seed() {
    const app = exitedContainer("app", { Id: "source-app" });
    engine.add(app);
    const journal = new ApplicationBackupJournal(new DockerClient(engine.socketPath));
    await journal.initialize();
    const record = await journal.save({
      version: 1,
      id: randomUUID(),
      attempt: 0,
      revision: 0,
      operation: "restore",
      phase: "restoring",
      artifactId: randomUUID(),
      members: [{ name: "app", id: app.Id!, running: true, restartPolicy: { Name: "always", MaximumRetryCount: 0 } }],
      blocked: true,
      result: null,
    });
    return { app, record };
  }
  it("loads interrupted recovery before jobs/healing, preserving the block in standalone mode", async () => {
    const { app, record } = await seed();
    const runtime = await createRuntime(configuration());
    expect(runtime.controlPlane).toBeNull();
    expect(runtime.applicationBackups.hasPendingRecovery()).toBe(true);
    expect(runtime.guard.externalRecoveryBlocked("app")).toBe(true);
    expect(runtime.guard.externalRecoveryBlocked("renamed", app.Id)).toBe(true);
    expect(runtime.applicationBackups.journal.records.get(record.id)?.result).toMatchObject({
      ok: false,
      recoveryRequired: true,
    });
    const job: ContainerJob = {
      id: randomUUID(),
      containerName: "app",
      action: "start",
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    };
    expect(await runtime.jobs!.run(job)).toMatchObject({
      succeeded: false,
      outcome: expect.stringContaining("Application data recovery is incomplete"),
    });
    expect(engine.restarts).toEqual([]);
    await runtime.applicationBackups.flush();
    expect(runtime.applicationBackups.hasPendingRecovery()).toBe(true);
  });
  it("fails startup on an unreadable application journal before any mutation can run", async () => {
    engine.volumes.set("invalid-application-record", {
      Name: "invalid-application-record",
      Labels: { "autoheal.application-backup.journal": "1", "autoheal.application-backup.record": "not-json" },
    });
    await expect(createRuntime(configuration())).rejects.toThrow("Application recovery journal is unreadable");
    expect(engine.restarts).toEqual([]);
  });
  it("wires host mutations to pending application recovery in the real approved-work composition", async () => {
    await seed();
    for (const path of ["usr/bin", "run/systemd/system", "run/dbus"]) mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, "usr/bin/apt-get"), "");
    writeFileSync(join(root, "run/dbus/system_bus_socket"), "");
    const job: HostJob = {
      id: randomUUID(),
      containerName: "",
      action: "reboot",
      packages: [],
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    };
    vi.spyOn(ControlPlaneClient.prototype, "takeWork").mockResolvedValue({ items: [], jobs: [job] });
    const reported = vi.spyOn(ControlPlaneClient.prototype, "reportJobResult").mockResolvedValue({});
    const runtime = await createRuntime({
      ...configuration(),
      controlPlane: { url: "https://localhost:1", token: "fixture", pin: null },
    });
    await runtime.approvedWork!.runOnce();
    await runtime.approvedWork!.settled();
    await vi.waitFor(() => expect(runtime.approvedWork!.pendingResults).toBe(1));
    await runtime.approvedWork!.flush();
    expect(reported).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        succeeded: false,
        outcome: expect.stringContaining("application backup recovery is incomplete"),
      }),
    );
  });
  it("rechecks file access after waiting for the writer lock instead of touching partially restored data", async () => {
    const app = exitedContainer("app", { Id: "source-app" });
    engine.add(app);
    const runtime = await createRuntime({
      ...configuration(),
      controlPlane: { url: "https://localhost:1", token: "fixture", pin: null },
    });
    const access = createContainerAccess(runtime)!;
    const lease = await runtime.guard.operations.acquire(["name:app"]);
    const request: FileRequest = {
      id: randomUUID(),
      containerName: "app",
      operation: "write",
      path: "/data/value",
      to: null,
      content: Buffer.from("fixture").toString("base64"),
      requestedBy: "admin",
    };
    const answer = access.dependencies.files.answer(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.applicationBackups.journal.save({
      version: 1,
      id: randomUUID(),
      attempt: 0,
      revision: 0,
      operation: "restore",
      phase: "restoring",
      artifactId: randomUUID(),
      members: [{ name: "app", id: app.Id!, running: false, restartPolicy: { Name: "no", MaximumRetryCount: 0 } }],
      blocked: true,
      result: null,
    });
    lease.release();
    expect(await answer).toMatchObject({ error: expect.stringContaining("Application data recovery is incomplete") });
    expect(engine.execs.size).toBe(0);
  });
});

describe("what a runner says it can do", () => {
  let engine: FakeDockerEngine, root: string, server: Server | null;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    root = mkdtempSync(join(tmpdir(), "autoheal-capabilities-"));
    server = null;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });
  const configuration = () => ({
    ...loadRunnerConfig(
      { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
      join(root, "no-join"),
    ),
    containerAccess: true,
    dryRun: false,
  });
  // A dashboard of its own: it answers what a starting runner asks, and keeps what each heartbeat named and said.
  async function dashboard() {
    const material = ownCertificate(join(root, "tls"), ["127.0.0.1"], Date.now()).material;
    const heartbeats: { named: string[]; heartbeat: Heartbeat }[] = [];
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      // Held, as a long poll is, until the runner stops.
      if (request.url === RUNNER_ROUTES.containerAccess) return;
      void buffer(request).then((body) => {
        if (request.url === RUNNER_ROUTES.heartbeat) {
          const header = String(request.headers[HTTP_HEADERS.runnerCapabilities] ?? "");
          heartbeats.push({
            named: header.split(",").filter((name) => name !== ""),
            heartbeat: JSON.parse(String(body)),
          });
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url === RUNNER_ROUTES.work ? { items: [], jobs: [] } : {}));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    return { connection: { url, token: "fixture", pin: material.pin }, heartbeats };
  }

  it("takes up the host's runs an earlier runner left going before it settles what was cut short", async () => {
    const { connection } = await dashboard();
    const runtime = await createRuntime({ ...configuration(), controlPlane: connection });
    const order: string[] = [];
    const settle = runtime.results.settleInterrupted.bind(runtime.results);
    runtime.results.settleInterrupted = async () => {
      order.push("settle what was cut short");
      await settle();
    };
    const resume = runtime.approvedWork!.resumeHostRuns.bind(runtime.approvedWork);
    runtime.approvedWork!.resumeHostRuns = async () => {
      order.push("take up the host's runs");
      await resume();
    };

    const stop = await startRunner(runtime);
    await stop();

    expect(order).toEqual(["take up the host's runs", "settle what was cut short"]);
  });

  it.each([
    ["everything a tag change needs on", {}, true],
    ["container access off", { containerAccess: false }, false],
    ["installs off", { hostDeploy: false }, false],
    ["no data kept aside before an update", { checkpointLimitBytes: 0 }, false],
    ["dry-run", { dryRun: true }, false],
  ])("names the same in its requests as in its heartbeat, with %s", async (_settings, settings, changesTags) => {
    const { connection, heartbeats } = await dashboard();
    const runtime = await createRuntime({ ...configuration(), ...settings, controlPlane: connection });
    const stop = await startRunner(runtime);
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(0), { timeout: 5_000 });
    await stop();
    const [{ named, heartbeat }] = heartbeats as [(typeof heartbeats)[number]];
    // As old dashboards read them: these names, and these fields.
    const always = [
      "application-backups",
      "application-boot-drills",
      "operation-previews",
      "resource-permissions",
      "rollouts",
    ];
    expect(named.toSorted()).toEqual([...always, ...(changesTags ? ["tag-changes"] : [])].toSorted());
    expect(heartbeat).toMatchObject({
      applicationBackups: true,
      operationPreviews: true,
      resourcePermissions: true,
      rollouts: true,
      serviceProbes: true,
      probeAttempts: true,
      tagChanges: changesTags,
    });
  });
});

describe("a sidecar runner updating itself", () => {
  let engine: FakeDockerEngine, root: string;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    root = mkdtempSync(join(tmpdir(), "autoheal-runner-update-"));
  });
  afterEach(async () => {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds its Docker socket where DOCKER_SOCKET_PATH puts it, and gives the helper that socket's group", async () => {
    const RELEASE = "ghcr.io/example/autoheal:1.2.0";
    const NEW = `sha256:${"2".repeat(64)}`;
    const HOST_SOCKET = "/run/user/1000/docker.sock";
    // Its socket is not at /var/run/docker.sock in its container: the engine's own, wherever that is.
    const config = loadRunnerConfig(
      { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
      join(root, "no-join"),
    );
    engine.add(
      exitedContainer(config.selfContainerName, {
        Id: "runner-id",
        Image: `sha256:${"1".repeat(64)}`,
        Config: { Image: "ghcr.io/example/autoheal:1.0.0", Tty: false, Env: [] },
        Mounts: [{ Type: "bind", Source: HOST_SOCKET, Destination: engine.socketPath, RW: true }],
      }),
    );
    engine.imageIds.set(RELEASE, NEW);
    engine.imageLabels.set(NEW, {});
    const runtime = await createRuntime(config);
    runtime.fromControlPlane = { release: { image: RELEASE } } as never;
    const job: ContainerJob = {
      id: randomUUID(),
      containerName: "",
      action: JOB_ACTION.updateRunner,
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    };
    expect(await runtime.jobs!.run(job)).toMatchObject({ succeeded: true });
    const helper = engine.creations.find(({ name }) => name === SELF_UPDATE.helperName)!.specification;
    expect(helper.HostConfig).toMatchObject({
      Binds: [`${HOST_SOCKET}:/var/run/docker.sock`, `${SELF_UPDATE.runnerVolume}:/data`],
      GroupAdd: [String(statSync(engine.socketPath).gid)],
    });
  });
});

describe("private registries a runner is allowed", () => {
  let engine: FakeDockerEngine, root: string;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    root = mkdtempSync(join(tmpdir(), "autoheal-registries-"));
  });
  afterEach(async () => {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("pulls a covered image with the credential the control plane allowed, and others with none", async () => {
    const runtime = await createRuntime(
      loadRunnerConfig(
        { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
        join(root, "no-join"),
      ),
    );
    expect(runtime.registries.allowed).toEqual([]);

    // What the answer to its heartbeat carries.
    runtime.registries.allowed = [
      { registry: "ghcr.io", repository: "owner/app", username: "owner", password: "a-token" },
    ];
    await runtime.docker.pull("ghcr.io/owner/app:2");
    await runtime.docker.pull("ghcr.io/someone/else:2");
    await runtime.docker.pull("nginx:1.27");

    expect(engine.pullCredentials.get("ghcr.io/owner/app:2")).toEqual({
      username: "owner",
      password: "a-token",
      serveraddress: "ghcr.io",
    });
    expect(engine.pullCredentials.has("ghcr.io/someone/else:2")).toBe(false);
    expect(engine.pullCredentials.has("nginx:1.27")).toBe(false);
  });

  it("stops using a credential the control plane no longer allows", async () => {
    const runtime = await createRuntime(
      loadRunnerConfig(
        { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
        join(root, "no-join"),
      ),
    );
    runtime.registries.allowed = [
      { registry: "ghcr.io", repository: "owner/app", username: "owner", password: "a-token" },
    ];
    await runtime.docker.pull("ghcr.io/owner/app:2");

    runtime.registries.allowed = [];
    await runtime.docker.pull("ghcr.io/owner/app:3");

    expect(engine.pullCredentials.has("ghcr.io/owner/app:2")).toBe(true);
    expect(engine.pullCredentials.has("ghcr.io/owner/app:3")).toBe(false);
  });
});

describe("Docker's event stream, once it falls silent", () => {
  // Looks at the container listing this often, where a runner looks every 30 s.
  const LOOK_EVERY = 50;
  let engine: FakeDockerEngine, root: string;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    engine.add(exitedContainer("paperless", { State: { Status: "running", Running: true, ExitCode: 0 } }));
    root = mkdtempSync(join(tmpdir(), "autoheal-silent-events-"));
  });
  afterEach(async () => {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  // A runner of its own, following the stream until the test is done with it.
  async function following() {
    const runtime = await createRuntime(
      loadRunnerConfig(
        { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
        join(root, "no-join"),
      ),
    );
    const caughtUp = vi.spyOn(runtime.watcher, "catchUp");
    const stopping = new AbortController();
    const listedBefore = engine.listings;
    const watching = watchEvents(runtime, stopping.signal, LOOK_EVERY);
    // Caught up on connecting, and a first look at the listing taken.
    await vi.waitFor(() => expect(engine.listings).toBeGreaterThanOrEqual(listedBefore + 2));
    const stop = async () => {
      stopping.abort();
      await watching;
      runtime.watcher.stop();
      await Promise.all([runtime.watcher.settled(), runtime.lifecycle.settled()]);
      clearTimeout(runtime.reportTimer ?? undefined);
    };
    return { caughtUp, stop };
  }
  const dies = (diedAt: number) =>
    engine.add(
      exitedContainer("paperless", {
        State: { Status: "exited", Running: false, ExitCode: 1, FinishedAt: new Date(diedAt).toISOString() },
      }),
    );

  it("connects again when a container went down and the stream said nothing, catching up from its last word", async () => {
    const { caughtUp, stop } = await following();
    const diedAt = Date.now();
    dies(diedAt);

    await vi.waitFor(() => expect(caughtUp).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(engine.eventStreamsOpened).toBe(2);
    const [snapshots, , since] = caughtUp.mock.calls[1]!;
    expect(snapshots.find((snapshot) => snapshot.name === "paperless")).toMatchObject({ state: "exited" });
    // From when it last knew the stream worked, not from when it noticed: the container went down in between.
    expect(since).toBeLessThanOrEqual(diedAt);
    await stop();
  });

  it("keeps a stream that is only quiet, and one that tells of the container going down", async () => {
    const { caughtUp, stop } = await following();
    const quiet = engine.listings;
    await vi.waitFor(() => expect(engine.listings).toBeGreaterThanOrEqual(quiet + 3));
    dies(Date.now());
    engine.emit({ Type: "container", Action: "die", Actor: { Attributes: { name: "paperless" } } });
    const looked = engine.listings;
    await vi.waitFor(() => expect(engine.listings).toBeGreaterThanOrEqual(looked + 4));

    expect(engine.eventStreamsOpened).toBe(1);
    expect(caughtUp).toHaveBeenCalledTimes(1);
    await stop();
  });
});

describe("a runner whose clock is off from the control plane's", () => {
  const TEN_MINUTES = 10 * 60 * 1000;
  let engine: FakeDockerEngine, root: string, server: Server | null;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    engine.add(exitedContainer("paperless", { State: { Status: "running", Running: true, ExitCode: 0 } }));
    root = mkdtempSync(join(tmpdir(), "autoheal-clock-off-"));
    server = null;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps automatic recovery paused, still takes the rest of every answer, and says how far off it is", async () => {
    const material = ownCertificate(join(root, "tls"), ["127.0.0.1"], Date.now()).material;
    const heartbeats: Heartbeat[] = [];
    const receivedAt: number[] = [];
    const settings = {
      publicBaseUrl: "https://autoheal.example.test",
      ollama: { url: "https://ollama.example.test", model: "qwen3:4b-instruct", contextTokens: 16_384 },
    };
    // A control plane whose clock is ten minutes behind this runner's.
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      if (request.url === RUNNER_ROUTES.containerAccess) return;
      void buffer(request).then((body) => {
        if (request.url === RUNNER_ROUTES.heartbeat) {
          heartbeats.push(JSON.parse(String(body)));
          receivedAt.push(Date.now());
        }
        const maintenance = { generation: 1, observedAt: Date.now() - TEN_MINUTES, windows: [] };
        const answers: Record<string, unknown> = {
          [RUNNER_ROUTES.heartbeat]: { ...settings, control: { maintenance } },
          [RUNNER_ROUTES.work]: { items: [], jobs: [] },
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(answers[request.url ?? ""] ?? {}));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const runtime = await createRuntime({
      ...loadRunnerConfig(
        { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
        join(root, "no-join"),
      ),
      controlPlane: { url, token: "fixture", pin: material.pin },
    });
    const stop = await startRunner(runtime);
    await vi.waitFor(() => expect(runtime.fromControlPlane).not.toBeNull(), { timeout: 5_000 });
    // A container that changes is reported at once: a report after the first answer.
    await engine.waitForEventStream();
    engine.emit({ Type: "container", Action: "start", Actor: { Attributes: { name: "paperless" } } });
    await vi.waitFor(() => expect(heartbeats.some((heartbeat) => heartbeat.host === null)).toBe(true), {
      timeout: 5_000,
    });
    await stop();

    // Its full reports carry its own clock as they leave, which the control plane sets against its own; a report of
    // its containers alone carries none.
    expect(Math.abs(heartbeats[0]!.hostClock! - receivedAt[0]!)).toBeLessThan(5_000);
    for (const report of heartbeats) expect(report.hostClock === undefined).toBe(report.host === null);
    expect(runtime.fromControlPlane).toMatchObject(settings);
    expect(runtime.reachingControlPlane).toBe(true);
    expect(runtime.maintenance!.held("paperless")).toBe(true);
    expect(heartbeats[0]!.clockSkewSeconds).toBeUndefined();
    expect(Math.abs(heartbeats.at(-1)!.clockSkewSeconds! - TEN_MINUTES / 1000)).toBeLessThanOrEqual(1);
  });
});

describe("a runner whose Docker cannot list its containers for a moment", () => {
  let engine: FakeDockerEngine, root: string, server: Server | null;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    engine.add(exitedContainer("paperless", { State: { Status: "running", Running: true, ExitCode: 0 } }));
    root = mkdtempSync(join(tmpdir(), "autoheal-stale-list-"));
    server = null;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("sends the last list it had, saying so, and says no more once Docker answers again", async () => {
    const material = ownCertificate(join(root, "tls"), ["127.0.0.1"], Date.now()).material;
    const heartbeats: Heartbeat[] = [];
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      if (request.url === RUNNER_ROUTES.containerAccess) return;
      void buffer(request).then((body) => {
        if (request.url === RUNNER_ROUTES.heartbeat) heartbeats.push(JSON.parse(String(body)));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url === RUNNER_ROUTES.work ? { items: [], jobs: [] } : {}));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const runtime = await createRuntime({
      ...loadRunnerConfig(
        { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
        join(root, "no-join"),
      ),
      controlPlane: { url, token: "fixture", pin: material.pin },
    });
    const stop = await startRunner(runtime);
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(0), { timeout: 5_000 });
    await engine.waitForEventStream();
    // A container that changes is reported at once.
    const changes = () =>
      engine.emit({ Type: "container", Action: "start", Actor: { Attributes: { name: "paperless" } } });

    engine.failListings = true;
    changes();
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(1), { timeout: 5_000 });
    engine.failListings = false;
    changes();
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(2), { timeout: 5_000 });
    await stop();

    const [fresh, stale, again] = heartbeats as [Heartbeat, Heartbeat, Heartbeat];
    expect(fresh.containersStale).toBeUndefined();
    expect(fresh.containers.map((container) => container.name)).toEqual(["paperless"]);
    expect(stale).toMatchObject({ containersStale: true, containers: fresh.containers });
    expect(again.containersStale).toBeUndefined();
  });
});

describe("a heartbeat too large for the runner API", () => {
  const LIMIT = 1024 * 1024;
  const bulk = (characters: number) => "x".repeat(characters);
  const base = heartbeatWith({ containers: [containerSnapshot({ name: "paperless" })] });

  it("goes as it is while it fits", () => {
    expect(fitted(base, LIMIT)).toBe(base);
  });

  it("leaves out the least needed first, only what it carries, until it fits, and says what", () => {
    const oversized = {
      ...base,
      topology: { filler: bulk(LIMIT) } as never,
      networks: [{ filler: bulk(LIMIT / 2) }] as never,
      volumes: [{ filler: bulk(LIMIT / 2) }] as never,
    };
    const sent = fitted(oversized, LIMIT);
    expect(sent.trimmed).toEqual(["topology", "networks"]);
    expect(sent.topology).toBeUndefined();
    expect(sent.networks).toBeUndefined();
    expect(sent.volumes).toEqual(oversized.volumes);
    expect(sent.containers).toEqual(base.containers);
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(LIMIT);
  });

  it("keeps its containers whatever else goes, its system facts last", () => {
    const sent = fitted({ ...base, volumes: [{ filler: bulk(2 * LIMIT) }] as never }, LIMIT);
    expect(sent.trimmed).toEqual(["volumes"]);
    expect(sent.host).toEqual(base.host);
    const crowded = fitted({ ...base, containers: Array.from({ length: 3 }, () => base.containers[0]!) }, 100);
    expect(crowded.trimmed).toEqual(["host"]);
    expect(crowded.host).toBeNull();
    expect(crowded.containers).toHaveLength(3);
  });
});

describe("a report made because containers changed", () => {
  let engine: FakeDockerEngine, root: string, server: Server | null;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    engine.add(exitedContainer("paperless", { State: { Status: "running", Running: true, ExitCode: 0 } }));
    root = mkdtempSync(join(tmpdir(), "autoheal-change-report-"));
    server = null;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("carries the containers alone, the rest left to the full report as the dashboard keeps it", async () => {
    // How its last update went, as the helper left it: in the full report only.
    const FINISHED = "2026-11-09T16:35:50.123456789Z";
    engine.add(
      exitedContainer(SELF_UPDATE.helperName, {
        State: { Status: "exited", Running: false, ExitCode: 1, FinishedAt: FINISHED },
        Config: { Image: "ghcr.io/example/autoheal:1.2.0", Labels: { [SELF_UPDATE.label]: "1" } },
      }),
      `${SELF_UPDATE_TEXT.started}\n${SELF_UPDATE_TEXT.notHealthy}\n`,
    );
    const material = ownCertificate(join(root, "tls"), ["127.0.0.1"], Date.now()).material;
    const heartbeats: Heartbeat[] = [];
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      if (request.url === RUNNER_ROUTES.containerAccess) return;
      void buffer(request).then((body) => {
        if (request.url === RUNNER_ROUTES.heartbeat) heartbeats.push(JSON.parse(String(body)));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url === RUNNER_ROUTES.work ? { items: [], jobs: [] } : {}));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const runtime = await createRuntime({
      ...loadRunnerConfig(
        { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
        join(root, "no-join"),
      ),
      controlPlane: { url, token: "fixture", pin: material.pin },
    });
    const stop = await startRunner(runtime);
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(0), { timeout: 5_000 });
    await engine.waitForEventStream();
    engine.emit({ Type: "container", Action: "start", Actor: { Attributes: { name: "paperless" } } });
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(1), { timeout: 5_000 });
    await stop();

    const [full, change] = heartbeats as [Heartbeat, Heartbeat];
    expect(full.volumes).toBeDefined();
    expect(full.unusedImages).toBeDefined();
    expect(full.runnerUpdate).toEqual({
      state: RUNNER_UPDATE_REPORT.state.failed,
      finishedAt: Date.parse(FINISHED),
      message: SELF_UPDATE_TEXT.notHealthy,
    });
    expect(full.containers.map((container) => container.name)).not.toContain(SELF_UPDATE.helperName);
    expect(change.containers.map((container) => container.name)).toEqual(["paperless"]);
    expect(change).toMatchObject({ host: null });
    for (const part of ["volumes", "unusedImages", "networks", "topology", "stackDrift", "runnerUpdate"] as const) {
      expect(change[part]).toBeUndefined();
    }
  });
});

describe("a runner starting where an earlier one stopped mid-shell", () => {
  let engine: FakeDockerEngine, root: string;
  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    root = mkdtempSync(join(tmpdir(), "autoheal-left-helpers-"));
  });
  afterEach(async () => {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("removes the privileged helper that runner left before it starts anything", async () => {
    const left = exitedContainer(`${HOST_TERMINAL_HELPER.containerPrefix}left`, {
      Config: {
        Image: "sha256:autoheal",
        Tty: false,
        Env: [],
        Labels: { [HOST_TERMINAL_HELPER.label]: HOST_TERMINAL_HELPER.labelValue },
      },
    });
    engine.add({ ...left, State: { ...left.State, Status: "running", Running: true } });
    engine.add(exitedContainer("paperless"));
    const runtime = await createRuntime(
      loadRunnerConfig(
        { OLLAMA_URL: "https://localhost:1", DOCKER_SOCKET_PATH: engine.socketPath, HOST_ROOT: root },
        join(root, "no-join"),
      ),
    );
    const stop = await startRunner(runtime);
    await stop();
    const removed = engine.removals.map((removal) => removal.split("?")[0]);
    expect(removed).toContain(`${HOST_TERMINAL_HELPER.containerPrefix}left`);
    expect(removed).not.toContain("paperless");
  });
});
