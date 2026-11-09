import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server as TlsServer } from "node:tls";
import type { FastifyInstance } from "fastify";
import type { Actor } from "../../src/control-plane/audit/audit-log.js";
import { buildRunnerServer } from "../../src/control-plane/runner-api/runner-server.js";
import { API_ROUTES, type AssignableView } from "../../src/shared/api.js";
import type { ContainerDetails } from "../../src/runner/incident-report.js";
import { publicKeyPin } from "../../src/shared/hash.js";
import { FakeDockerEngine, exitedContainer } from "../fakes/fake-docker-engine.js";
import { FakeSshServer } from "../fakes/fake-ssh-server.js";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "./control-plane.js";
import { fullySignedInAdmin } from "./second-factor.js";

const USER = "alex";
const TLS = {
  cert: readFileSync("test/fixtures/tls/server.pem"),
  key: readFileSync("test/fixtures/tls/server-key.pem"),
};
const PIN = publicKeyPin(new X509Certificate(TLS.cert).publicKey);
// The runner API's certificate renewed with a new key, as many renewals bring one.
const RENEWED_TLS = {
  cert: readFileSync("test/fixtures/tls/untrusted-server.pem"),
  key: readFileSync("test/fixtures/tls/untrusted-server-key.pem"),
};
export const RENEWED_PIN = publicKeyPin(new X509Certificate(RENEWED_TLS.cert).publicKey);
const SETTLE_MILLISECONDS = 15_000;
// The host's own /proc, as its user reads it over SSH.
const HOST_FILES = {
  "proc/loadavg": "1.25 0.75 0.50 1/300 4242\n",
  "proc/meminfo": "MemTotal:       8000000 kB\nMemAvailable:    6000000 kB\n",
  "proc/uptime": "3600.5 7000.1\n",
  "proc/stat": "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 100 0 50 800 50 0 0 0 0 0\n",
  "proc/diskstats": "",
  "proc/sys/kernel/osrelease": "6.8.0-87-generic\n",
  "etc/hostname": "mini\n",
};

export const runningContainer = (name: string, overrides: Partial<ContainerDetails> = {}): ContainerDetails => {
  const container = exitedContainer(name, overrides);
  return { ...container, State: { ...container.State, Status: "running", Running: true } };
};

/** Reads until it is done, for what a runner reports within seconds. */
export async function until<Value>(
  read: () => Promise<Value> | Value,
  done: (value: Value) => boolean,
): Promise<Value> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > SETTLE_MILLISECONDS) throw new Error(`not yet: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The runner API serves the renewed certificate from its next connection, as the control plane's daily check has it
 * do, and the connections open now are closed: until they end they would keep the certificate they started with.
 */
export function renewRunnerCertificate(runnerServer: FastifyInstance) {
  (runnerServer.server as unknown as TlsServer).setSecureContext(RENEWED_TLS);
  runnerServer.server.closeAllConnections();
}

/**
 * A container started on the host, and its runner's reports read until they show it. The start is told again at each
 * look, so a report that failed is followed by another within seconds, not at the next heartbeat.
 */
export function startedAndReported<Value>(
  engine: FakeDockerEngine,
  name: string,
  read: () => Promise<Value>,
  done: (value: Value) => boolean,
): Promise<Value> {
  engine.add(runningContainer(name));
  return until(async () => {
    engine.emit({ Type: "container", Action: "start", Actor: { Attributes: { name } } });
    return read();
  }, done);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface EmbeddedSshHost {
  engine: FakeDockerEngine;
  server: FakeSshServer;
  controlPlane: TestControlPlane;
  // The runner API the host's runner reaches, on loopback.
  runnerServer: FastifyInstance;
  admin: TestClient;
  actor: Actor;
  hostId: string;
  // The host's / as SFTP serves it.
  hostFiles: string;
  stop: () => Promise<void>;
}

/**
 * An SSH host added to a test control plane: the fake engine behind the fake SSH server, its /proc served over SFTP,
 * the runner API on loopback over TLS with a pinned certificate, as the embedded runners reach it. Its runner starts
 * once the test begins the control plane's embedded runners.
 */
export async function startEmbeddedSshHost(
  containers: readonly ContainerDetails[] = [runningContainer("paperless"), runningContainer("tika")],
  // A file of its own for a test that restores it: the in-memory default cannot be swapped.
  databasePath?: string,
): Promise<EmbeddedSshHost> {
  const hostFiles = mkdtempSync(join(tmpdir(), "autoheal-embedded-host-"));
  for (const [path, content] of Object.entries(HOST_FILES)) {
    mkdirSync(dirname(join(hostFiles, path)), { recursive: true });
    writeFileSync(join(hostFiles, path), content);
  }
  const engine = await FakeDockerEngine.start();
  containers.forEach((container) => engine.add(container));
  const key = FakeSshServer.newHostKey();
  const server = await FakeSshServer.start(USER, [key], engine.socketPath);
  server.filesRoot = hostFiles;
  const port = await freePort();
  const controlPlane = await startTestControlPlane({
    runners: { pin: PIN, image: "autoheal:test", apiUrl: `https://127.0.0.1:${port}` },
    ...(databasePath === undefined ? {} : { databasePath }),
  });
  // The runner checks the maintenance policy's time against its own clock.
  controlPlane.clock.now = Date.now();
  const runnerServer: FastifyInstance = await buildRunnerServer(TLS, controlPlane.services);
  await runnerServer.listen({ host: "127.0.0.1", port });
  const admin = (await fullySignedInAdmin(controlPlane)).client;
  const adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
  const actor: Actor = { userId: adminId, username: "admin", ip: "127.0.0.1", requestId: "test" };
  const { sshKeysService, sshHostsService } = controlPlane.services;
  const stored = sshKeysService.add(actor, "alex's key", key, null);
  const pending = await sshHostsService.add(actor, {
    label: "mini",
    address: "127.0.0.1",
    port: server.port,
    user: USER,
    keyId: stored.id,
  });
  const hostId = sshHostsService.confirm(actor, pending.pendingId).id;
  const stop = async () => {
    await controlPlane.services.embeddedRunners.stop();
    await runnerServer.close();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await server.stop();
    await engine.close();
    rmSync(hostFiles, { recursive: true, force: true });
  };
  return { engine, server, controlPlane, runnerServer, admin, actor, hostId, hostFiles, stop };
}
