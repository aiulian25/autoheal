import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, containerIdOf } from "../../../test/fakes/fake-docker-engine.js";
import {
  TEST_BACKUP_PASSPHRASE,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { runningContainer, until } from "../../../test/support/embedded-ssh-host.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { localRunnerPorts } from "../../runner/application.js";
import { API_ROUTES, apiPath, type HostView } from "../../shared/api.js";
import { HOST_KIND, JOIN_FILE_NAME, LOCAL_HOST } from "../../shared/constants.js";
import { publicKeyPin, sha256Hex } from "../../shared/hash.js";
import { decodeJoinCode } from "../../shared/join-code.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { SecretBox } from "../database/secret-box.js";
import { buildRunnerServer } from "../runner-api/runner-server.js";
import { hosts as hostsTable } from "../database/schema.js";
import { newToken } from "../hosts/hosts-service.js";
import { LocalHostRunner } from "./local-host-runner.js";
import { LocalHostService } from "./local-host-service.js";

const TLS = {
  cert: readFileSync("test/fixtures/tls/server.pem"),
  key: readFileSync("test/fixtures/tls/server-key.pem"),
};
const PIN = publicKeyPin(new X509Certificate(TLS.cert).publicKey);
// The control plane's own container, as compose names it.
const OWN = "autoheal-control-plane";
const RUNNER_CONTAINER = "autoheal";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("the control plane's own machine, looked after in place", () => {
  let engine: FakeDockerEngine;
  let controlPlane: TestControlPlane;
  let runnerServer: FastifyInstance;
  let admin: TestClient;
  let folders: string;
  let joinDirectory: string;
  let service: LocalHostService;
  let runner: LocalHostRunner;

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    engine.add(runningContainer(OWN, { Id: containerIdOf(OWN) }));
    engine.add(runningContainer("paperless"));
    folders = mkdtempSync(join(tmpdir(), "autoheal-local-host-"));
    joinDirectory = join(folders, "join");
    const hostRoot = join(folders, "root");
    mkdirSync(joinDirectory);
    mkdirSync(join(hostRoot, "etc"), { recursive: true });
    writeFileSync(join(hostRoot, "etc", "hostname"), "rowan\n");
    const port = await freePort();
    controlPlane = await startTestControlPlane({
      runners: { pin: PIN, image: "autoheal:test", apiUrl: `https://127.0.0.1:${port}` },
    });
    controlPlane.clock.now = Date.now();
    runnerServer = await buildRunnerServer(TLS, controlPlane.services);
    await runnerServer.listen({ host: "127.0.0.1", port });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const { databaseHandle, auditLog, hostsService } = controlPlane.services;
    service = new LocalHostService(
      databaseHandle,
      auditLog,
      SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE),
      hostsService,
      () => controlPlane.clock.now,
      joinDirectory,
    );
    runner = new LocalHostRunner({
      hosts: service,
      controlPlane: { url: `https://127.0.0.1:${port}`, pin: PIN },
      // What the machine's .env says, as its runner container read it.
      environment: {
        DOCKER_SOCKET_PATH: engine.socketPath,
        HOST_ROOT: hostRoot,
        DRY_RUN: "0",
        PROTECTED_CONTAINERS: "npm",
      },
      ownContainer: containerIdOf(OWN),
      // Nothing run on the machine the tests run on: no nvidia-smi.
      portsOf: (config) => ({ ...localRunnerPorts(config), hostCommand: async () => "" }),
    });
  });

  afterEach(async () => {
    await runner.stop();
    await runnerServer.close();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await engine.close();
    rmSync(folders, { recursive: true, force: true });
  });

  const hosts = async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>();
  const local = async () => (await hosts()).find((host) => host.kind === HOST_KIND.local);
  const heartbeat = async (token: string) =>
    (
      await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: heartbeatWith(),
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode;

  it("adds the machine as a host of its own, named by its first report, never acting on Autoheal's own containers", async () => {
    runner.begin();
    const host = await until(local, (view) => view?.label === "rowan" && view.containerCount === 2);
    expect(host).toMatchObject({ dryRun: false, state: "online" });
    expect(host!.protectedContainers).toEqual(
      expect.arrayContaining([OWN, `${OWN}-autoheal-previous`, "autoheal-self-update", "npm"]),
    );
    expect(runner.inPlaceOf(host!.id)).toEqual({ problem: null });
  });

  it("takes over the machine's runner host with its history, and waits while that runner's container still runs", async () => {
    controlPlane.services.hostsService.ensureLocalRunner(joinDirectory);
    const code = decodeJoinCode(readFileSync(join(joinDirectory, JOIN_FILE_NAME), "utf8"))!;
    expect(await heartbeat(code.token)).toBe(200);
    const before = (await hosts())[0]!;
    engine.add(
      runningContainer(RUNNER_CONTAINER, {
        Config: {
          Image: "autoheal:local",
          Env: [],
          Labels: {},
          Tty: false,
          Cmd: ["/nodejs/bin/node", "/app/dist/server/main.js", "runner"],
        } as never,
      }),
    );

    runner.begin();
    expect(runner.inPlaceOf(before.id)).not.toBeNull();
    await until(
      () => runner.inPlaceOf(before.id),
      (inPlace) => inPlace?.problem === LOCAL_HOST.runnerStillThere,
    );
    expect(await local()).toMatchObject({ id: before.id, enrolledAt: before.enrolledAt });
    // Its runner container's token opens nothing now.
    expect(await heartbeat(code.token)).toBe(401);

    engine.remove(RUNNER_CONTAINER);
    runner.tick();
    await until(local, (view) => view?.containerCount === 2);
    expect(runner.inPlaceOf(before.id)).toEqual({ problem: null });
  });

  it("stops once its host is revoked, and starts again when it is added again", async () => {
    runner.begin();
    const host = (await until(local, (view) => view?.containerCount === 2))!;
    const revoked = await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: host.id }));
    expect(revoked.statusCode, revoked.body).toBe(200);
    runner.tick();
    expect(runner.inPlaceOf(host.id)).toBeNull();

    // Fleet's "Add this machine again": the same host, with a new token.
    const again = await admin.post(API_ROUTES.localHostReenroll);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<HostView>()).toMatchObject({ id: host.id, kind: HOST_KIND.local });
    runner.tick();
    await until(
      () => runner.inPlaceOf(host.id),
      (inPlace) => inPlace?.problem === null,
    );
  });

  it("takes up the token a restore brought back, and starts only once its old runner has stopped", async () => {
    runner.begin();
    const host = (await until(local, (view) => view?.containerCount === 2))!;
    await until(local, (view) => view?.dryRun === false);
    let release!: () => void;
    engine.restartHeldUntil = new Promise((resolve) => {
      release = resolve;
    });
    const asked = await admin.post(
      apiPath(API_ROUTES.containerActions, { hostId: host.id, containerName: "paperless" }),
      {
        action: "restart",
      },
    );
    expect(asked.statusCode, asked.body).toBe(200);
    await until(
      () => engine.restarts,
      (restarts) => restarts.length === 1,
    );

    const token = newToken();
    controlPlane.services.databaseHandle.database
      .update(hostsTable)
      .set({
        tokenHash: sha256Hex(token),
        sshRunnerToken: SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE).seal(token),
      })
      .where(eq(hostsTable.id, host.id))
      .run();
    controlPlane.clock.now += 1_000;
    runner.pause();
    runner.resume();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await local())?.lastHeartbeatAt).not.toBe(controlPlane.clock.now);

    release();
    await until(local, (view) => view?.lastHeartbeatAt === controlPlane.clock.now);
    expect(engine.restarts).toEqual(["paperless"]);
  });

  it("takes the token of the file a failed restore puts back, over the one it had just started with", async () => {
    runner.begin();
    const host = (await until(local, (view) => view?.containerCount === 2))!;
    runner.pause();
    runner.resume();
    const token = newToken();
    controlPlane.services.databaseHandle.database
      .update(hostsTable)
      .set({
        tokenHash: sha256Hex(token),
        sshRunnerToken: SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE).seal(token),
      })
      .where(eq(hostsTable.id, host.id))
      .run();
    controlPlane.clock.now += 1_000;
    runner.resume();
    await until(local, (view) => view?.lastHeartbeatAt === controlPlane.clock.now);
    expect(await heartbeat(token)).toBeLessThan(400);
  });
});
