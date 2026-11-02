import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDockerEngine, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { loadRunnerConfig } from "../config/runner-config.js";
import type { ContainerJob, FileRequest, HostJob } from "../shared/protocol.js";
import { ApplicationBackupJournal } from "./application-backup-journal.js";
import { createRuntime, createContainerAccess } from "./application.js";
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
