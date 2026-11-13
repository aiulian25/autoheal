import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeDockerEngine } from "../../../test/fakes/fake-docker-engine.js";
import type { FakeSshServer } from "../../../test/fakes/fake-ssh-server.js";
import type { TestClient, TestControlPlane } from "../../../test/support/control-plane.js";
import {
  RENEWED_PIN,
  renewRunnerCertificate,
  startEmbeddedSshHost,
  startedAndReported,
  until,
  type EmbeddedSshHost,
} from "../../../test/support/embedded-ssh-host.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type JobView,
  type SshHostDetailsView,
  type TerminalView,
} from "../../shared/api.js";
import {
  CONTAINER_ACCESS_REFUSALS,
  HOST_KIND,
  HOST_STATE,
  JOB_STATUS,
  ROOT_METHOD,
  SSH_HOST_FILES,
  SSH_READINESS,
  SSH_STATE,
} from "../../shared/constants.js";
import { TEST_BACKUP_PASSPHRASE } from "../../../test/support/control-plane.js";
import { sha256Hex } from "../../shared/hash.js";
import { SecretBox } from "../database/secret-box.js";
import type { HostProfileAnswer } from "../../shared/protocol.js";
import { eq } from "drizzle-orm";
import { hosts, jobs } from "../database/schema.js";
import type { Actor } from "../audit/audit-log.js";

const GUARD_LABEL = "autoheal.guard.state";
const GUARD_RECORD = "autoheal.guard.record";
const JOURNAL_LABEL = "autoheal.shutdown.journal";
const JOURNAL_RECORD = "autoheal.shutdown.record";

describe("an SSH host's runner inside the control plane", () => {
  let engine: FakeDockerEngine;
  let server: FakeSshServer;
  let controlPlane: TestControlPlane;
  let runnerServer: FastifyInstance;
  let admin: TestClient;
  let actor: Actor;
  let hostId: string;
  let hostFiles: string;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    ({ engine, server, controlPlane, runnerServer, admin, actor, hostId, hostFiles, stop } =
      await startEmbeddedSshHost());
  });

  afterEach(() => stop());

  const host = async () =>
    (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((candidate) => candidate.id === hostId)!;
  const online = () => until(host, (view) => view.lastHeartbeatAt !== null && view.containerCount === 2);
  const act = async (containerName: string, action: string) => {
    const asked = await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName }), { action });
    expect(asked.statusCode, asked.body).toBe(200);
    const { id } = asked.json<JobView>();
    return until(
      async () =>
        (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}&containerName=${containerName}`))
          .json<JobView[]>()
          .find((job) => job.id === id)!,
      (job) => job.status !== JOB_STATUS.pending && job.status !== JOB_STATUS.delivered,
    );
  };

  it("starts nothing before the control plane begins them, then reports the host's containers over loopback", async () => {
    expect(controlPlane.services.embeddedRunners.connectionOf(hostId)).toBeNull();
    expect((await host()).ssh).toBeNull();

    controlPlane.services.embeddedRunners.begin();
    // Its first report may go out before its event stream has connected, which the next report says.
    const view = await until(
      host,
      (latest) => latest.containerCount === 2 && latest.eventStreamConnected && latest.health !== null,
    );
    expect(view).toMatchObject({
      kind: HOST_KIND.ssh,
      ssh: { state: SSH_STATE.connected, reason: null },
      eventStreamConnected: true,
      containerCount: 2,
      runningCount: 2,
    });
    expect(Object.keys(view.ssh!)).toEqual(["state", "since", "reason"]);
    // The host's own stats, read over its session: none of this machine's.
    expect(view.health).toMatchObject({
      loadAverage: [1.25, 0.75, 0.5],
      memoryTotalBytes: 8_000_000 * 1024,
      uptimeSeconds: 3600.5,
      hostname: "mini",
      kernel: "6.8.0-87-generic",
      cpuCount: 1,
    });
    // Its live stats after two samples, five seconds apart.
    const sampled = await until(host, (latest) => latest.metrics !== null);
    expect(sampled.metrics).toMatchObject({ memory: { totalBytes: 8_000_000 * 1024 } });
  });

  it("carries on with the runner API's new key, which a renewed certificate brings", async () => {
    controlPlane.services.embeddedRunners.begin();
    await online();
    renewRunnerCertificate(runnerServer);
    controlPlane.services.keyChanged(RENEWED_PIN);
    expect((await startedAndReported(engine, "notes", host, (view) => view.containerCount === 3)).ssh).toMatchObject({
      state: SSH_STATE.connected,
    });
  });

  it("hears nothing of the host from a beat while its session is down: its runner here would beat on regardless", async () => {
    const row = () =>
      controlPlane.services.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get()!;
    controlPlane.services.inventoryService.recordHeartbeat(row(), heartbeatWith());
    expect((await host()).lastHeartbeatAt).toBeNull();

    controlPlane.services.embeddedRunners.begin();
    await online();
    expect((await host()).state).toBe(HOST_STATE.online);
  });

  it("takes new settings at once, reports a container that dies, and carries out a dashboard restart and stop", async () => {
    controlPlane.services.embeddedRunners.begin();
    expect(await online()).toMatchObject({ dryRun: true });
    const { sshHostsService } = controlPlane.services;
    sshHostsService.updateSettings(actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    await until(host, (view) => view.dryRun === false);

    engine.containers.get("tika")!.State = {
      Status: "exited",
      Running: false,
      ExitCode: 1,
      OOMKilled: false,
      Error: "",
    };
    engine.emit({ Type: "container", Action: "die", Actor: { Attributes: { name: "tika" } } });
    await until(host, (view) => view.problemCount === 1 && view.runningCount === 1);

    expect(await act("tika", "restart")).toMatchObject({ status: JOB_STATUS.succeeded });
    expect(engine.restarts).toEqual(["tika"]);
    expect(await act("paperless", "stop")).toMatchObject({ status: JOB_STATUS.succeeded });
    expect(engine.stops).toEqual(["paperless"]);
  });

  it("ends on one live session when the host's settings are saved twice in a row", async () => {
    controlPlane.services.embeddedRunners.begin();
    await online();
    const { sshHostsService } = controlPlane.services;
    const settings = sshHostsService.settingsOf(hostId);
    sshHostsService.updateSettings(actor, hostId, { ...settings, protectedContainers: ["tika"] });
    sshHostsService.updateSettings(actor, hostId, { ...settings, protectedContainers: ["paperless"] });
    const view = await until(host, (latest) => latest.protectedContainers.includes("paperless"));
    expect(view.protectedContainers).toEqual([
      "autoheal",
      "autoheal-autoheal-previous",
      "autoheal-self-update",
      "paperless",
    ]);
    // The first runner's late close must not end the session the second one runs on.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // And the old runner and its session stopped before the next one dialled: never two on one host. The first pair is
    // the probe when the host was added.
    expect(server.connections).toEqual(["ready", "closed", "ready", "closed", "ready"]);
    expect(controlPlane.services.embeddedRunners.connectionOf(hostId)).toMatchObject({ state: SSH_STATE.connected });
    const lastHeartbeat = (await host()).lastHeartbeatAt;
    controlPlane.clock.now += 1_000;
    engine.emit({ Type: "container", Action: "die", Actor: { Attributes: { name: "tika" } } });
    await until(host, (latest) => latest.lastHeartbeatAt !== lastHeartbeat);
  });

  // The host's date, as far from the control plane's clock as given, and systemd's list of what runs there.
  const hostClockOff = (milliseconds: number, runningUnits: readonly string[]) => {
    const reading = controlPlane.clock.now + milliseconds;
    const answered = server.exec;
    server.exec = (command) =>
      command === SSH_HOST_FILES.clockCommand
        ? { stdout: `${Math.floor(reading / 1000)}.${String(reading % 1000).padStart(3, "0")}000000\n` }
        : answered(command);
    mkdirSync(join(hostFiles, "run/systemd/units"), { recursive: true });
    runningUnits.forEach((unit) => writeFileSync(join(hostFiles, "run/systemd/units", `invocation:${unit}`), ""));
  };

  it("reads an SSH host's own clock over its session, and whether a time service keeps it", async () => {
    hostClockOff(-95_000, ["cron.service"]);
    controlPlane.services.embeddedRunners.begin();
    const view = await until(host, (latest) => latest.clockOffsetSeconds !== null && latest.health !== null);
    expect(view.clockOffsetSeconds).toBe(-95);
    expect(view.health?.ntpActive).toBe(false);
  });

  it("reads the clock of an SSH host without Docker too", async () => {
    server.readiness = "";
    hostClockOff(3 * 60_000, ["systemd-timesyncd.service"]);
    controlPlane.services.embeddedRunners.begin();
    const view = await until(host, (latest) => latest.docker === false && latest.clockOffsetSeconds !== null);
    expect(view.clockOffsetSeconds).toBe(180);
    expect(view.health?.ntpActive).toBe(true);
  });

  it("watches a host without Docker for its system alone, and looks after its containers once Docker is there", async () => {
    server.readiness = "";
    controlPlane.services.embeddedRunners.begin();
    const systemOnly = await until(host, (view) => view.lastHeartbeatAt !== null && view.health !== null);
    expect(systemOnly).toMatchObject({
      state: "online",
      docker: false,
      containerCount: 0,
      eventStreamConnected: false,
      health: { loadAverage: [1.25, 0.75, 0.5], hostname: "mini" },
    });
    expect(await until(host, (view) => view.metrics !== null)).toMatchObject({
      metrics: { memory: { totalBytes: 8_000_000 * 1024 } },
    });
    // No Docker means nothing to heal: no "healing paused" task for it.
    await controlPlane.services.detectorService.run();
    const tasks = (await admin.get(API_ROUTES.tasks)).json<{ title: string }[]>();
    expect(tasks.filter((task) => task.title.includes("mini"))).toEqual([]);

    // Docker is installed and the user joins its group: the next tick gives the host the full runner.
    server.readiness = `${SSH_READINESS.socketMark}\n${SSH_READINESS.usableMark}\n`;
    controlPlane.services.embeddedRunners.tick();
    expect(await until(host, (view) => view.docker === true && view.containerCount === 2)).toMatchObject({
      eventStreamConnected: true,
      runningCount: 2,
    });
  });

  it("works out how an SSH host is set up from its containers, over its session", async () => {
    controlPlane.services.embeddedRunners.begin();
    await online();
    const answer = (await admin.get(apiPath(API_ROUTES.hostProfile, { hostId }))).json<HostProfileAnswer>();
    expect(answer.error).toBeNull();
    expect(answer.profile).toMatchObject({ containers: 2 });
  });

  it("says a host without Docker has nothing to learn from, a NAS user outside its group say", async () => {
    server.readiness = "";
    controlPlane.services.embeddedRunners.begin();
    await until(host, (view) => view.docker === false && view.lastHeartbeatAt !== null);
    const answer = (await admin.get(apiPath(API_ROUTES.hostProfile, { hostId }))).json<HostProfileAnswer>();
    expect(answer).toEqual({ error: CONTAINER_ACCESS_REFUSALS.noDocker, profile: null });
  });

  it("opens a shell on a host without Docker over its session, as the SSH user, typed into from the dashboard", async () => {
    server.readiness = "";
    const { sshHostsService } = controlPlane.services;
    sshHostsService.updateSettings(actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    controlPlane.services.embeddedRunners.begin();
    await until(host, (view) => view.docker === false && view.hostTerminal === true);
    const opened = await admin.post(apiPath(API_ROUTES.hostTerminals, { hostId }), { columns: 100, rows: 30 });
    expect(opened.statusCode, opened.body).toBe(200);
    const { id, user } = opened.json<TerminalView>();
    expect(user).toBe("alex");
    await until(
      async () => server.shells,
      (shells) => shells.length === 1,
    );
    expect(server.shells[0]).toMatchObject({ term: "xterm-256color", columns: 100, rows: 30 });
    await admin.post(apiPath(API_ROUTES.terminalInput, { terminalId: id }), { data: "exit\r" });
    // Its stream answers in full once the shell has ended: what it printed, then how.
    const stream = await until(
      () => admin.get(apiPath(API_ROUTES.terminalStream, { terminalId: id })),
      (response) => response.body.includes("event: ended"),
    );
    expect(stream.body).toContain(`data: ${Buffer.from("exit\rlogout\r\n").toString("base64")}`);
    expect(stream.body).toContain('event: ended\ndata: {"exitCode":0,"reason":null}');
  });

  it("keeps the host's own shell and its installs closed when its settings say so, as a runner's .env does", async () => {
    const { sshHostsService } = controlPlane.services;
    const closed = { ...sshHostsService.settingsOf(hostId), dryRun: false, hostTerminal: false, hostDeploy: false };
    sshHostsService.updateSettings(actor, hostId, closed);
    controlPlane.services.embeddedRunners.begin();
    await until(host, (view) => view.lastHeartbeatAt !== null && view.hostTerminal === false && !view.hostDeploy);
    const shell = await admin.post(apiPath(API_ROUTES.hostTerminals, { hostId }), { columns: 100, rows: 30 });
    expect(shell.json()).toEqual({ error: "host_terminal_off" });
    const draft = await admin.post(apiPath(API_ROUTES.hostInstallDraft, { hostId }), { image: "example/app:1" });
    expect(draft.json()).toEqual({ error: "host_deploy_off" });
    expect(server.shells).toEqual([]);
  });

  it("checks a root password on the host before keeping it sealed, and refuses one that makes no root", async () => {
    server.sudoPassword = "alex's own";
    controlPlane.services.embeddedRunners.begin();
    await online();
    const root = apiPath(API_ROUTES.sshHostRoot, { hostId });
    expect((await admin.put(root, { password: "wrong" })).json()).toEqual({ error: "ssh_root_password_refused" });
    const saved = await admin.put(root, { password: "alex's own" });
    expect(saved.json<SshHostDetailsView>().rootMethod).toBe(ROOT_METHOD.sudo);
    const row = controlPlane.services.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get()!;
    expect(row.sshRootMethod).toBe(ROOT_METHOD.sudo);
    expect(row.sshRootPassword).not.toContain("alex's own");
    expect(JSON.stringify((await admin.get(apiPath(API_ROUTES.sshHost, { hostId }))).json())).not.toContain(
      "alex's own",
    );
    expect((await admin.delete(root)).statusCode).toBe(204);
    expect((await admin.get(apiPath(API_ROUTES.sshHost, { hostId }))).json<SshHostDetailsView>().rootMethod).toBeNull();
  });

  it("comes back after a control plane restart with the guard state it kept on the host, and stops when revoked", async () => {
    const runners = controlPlane.services.embeddedRunners;
    runners.begin();
    await online();
    const guardRevision = () =>
      [...engine.volumes.values()]
        .filter((volume) => volume.Labels?.[GUARD_LABEL] === "1")
        .map((volume) => (JSON.parse(volume.Labels![GUARD_RECORD]!) as { revision: number }).revision);
    // A first start finds nothing saved, and saves its first record.
    await until(guardRevision, (revisions) => revisions.length > 0);
    expect(guardRevision()).toEqual([1]);

    await runners.stop();
    expect(runners.connectionOf(hostId)).toBeNull();
    const silentSince = (await host()).lastHeartbeatAt;
    controlPlane.clock.now += 1_000;
    runners.begin();
    await until(host, (view) => view.lastHeartbeatAt !== silentSince && view.ssh?.state === SSH_STATE.connected);
    // The next start took up that record rather than starting afresh, which would save revision 1 again.
    expect(guardRevision()).toEqual([2]);

    controlPlane.services.hostsService.revoke(actor, hostId);
    await until(
      () => runners.connectionOf(hostId),
      (connection) => connection === null,
    );
  });

  // A host job a runner handed to systemd, as its record on the host says once that runner is gone.
  const handedOver = (extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const jobId = randomUUID();
    const name = `autoheal-shutdown-${id}-1`;
    const record = { version: 1, id, operation: `host:${jobId}`, target: "", step: 1, phase: "delegated", ...extra };
    const labels = { [JOURNAL_LABEL]: "1", [JOURNAL_RECORD]: JSON.stringify({ ...record, reference: jobId, at: 1 }) };
    engine.volumes.set(name, { Name: name, Labels: labels });
  };
  const journalVolumes = () => [...engine.volumes.values()].filter((volume) => volume.Labels?.[JOURNAL_LABEL] === "1");

  it("starts past a reboot that a runner up to 1.5.3 handed over with no boot to compare, as from the dashboard", async () => {
    handedOver({ bootId: null });
    controlPlane.services.embeddedRunners.begin();
    await online();
    expect(journalVolumes()).toEqual([]);
  });

  it("closes the files a start that failed opened, so trying again never runs the host out of sessions", async () => {
    server.sudoPassword = "alex's own";
    const runners = controlPlane.services.embeddedRunners;
    runners.begin();
    await online();
    // An upgrade handed to systemd whose status files are gone: a person has to look, and each start stops there,
    // once the root password the host's package jobs need has its runner follow them.
    handedOver();
    await admin.put(apiPath(API_ROUTES.sshHostRoot, { hostId }), { password: "alex's own" });
    await until(host, (view) => view.ssh?.reason?.includes("needs operator reconciliation") === true);
    // What the session keeps open of its own: each try has to give back what it opened, or sshd soon refuses more.
    const kept = server.openSessions;
    for (let tries = 0; tries < 4; tries += 1) {
      const before = server.sftpRequests;
      runners.tick();
      await until(
        () => server.sftpRequests,
        (requests) => requests > before,
      );
      await until(
        () => server.openSessions,
        (open) => open <= kept,
      );
    }
    // Still the full runner it tries, its Docker still asked for: not the host's system alone, for want of a channel.
    expect((await host()).ssh?.reason).toContain("needs operator reconciliation");
  });
});

describe("an SSH host's runner across a database restore", () => {
  let setup: EmbeddedSshHost;

  beforeEach(async () => {
    const databaseFile = join(mkdtempSync(join(tmpdir(), "autoheal-runner-restore-")), "autoheal.sqlite");
    setup = await startEmbeddedSshHost(undefined, databaseFile);
  });

  afterEach(() => setup.stop());

  const row = () => {
    const { controlPlane, hostId } = setup;
    return controlPlane.services.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get()!;
  };
  const online = () =>
    until(row, (host) => host.lastHeartbeatAt === setup.controlPlane.clock.now && host.dryRun !== null);
  const takeBackup = () => setup.controlPlane.services.backupService.create("manual", null);
  const restore = async (fileName: string) => {
    const { restoreService } = setup.controlPlane.services;
    const preview = await restoreService.prepareStored(setup.actor, fileName);
    await restoreService.confirm(setup.actor, preview.restoreId);
  };
  // A heartbeat from now on is told from every earlier one by its time.
  const nextBeat = () => {
    setup.controlPlane.clock.now += 1_000;
  };
  // The host enrolled anew since the backup: its runner holds a token the backup never knew.
  const rotateToken = async () => {
    const { controlPlane, hostId } = setup;
    const token = "a-token-the-backup-never-knew";
    controlPlane.services.databaseHandle.database
      .update(hosts)
      .set({
        tokenHash: sha256Hex(token),
        sshRunnerToken: SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE).seal(token),
      })
      .where(eq(hosts.id, hostId))
      .run();
    nextBeat();
    await controlPlane.services.embeddedRunners.open(hostId);
    await online();
  };

  it("carries on with the token and settings the restored database holds", async () => {
    const { controlPlane, actor, hostId } = setup;
    const { embeddedRunners, sshHostsService } = controlPlane.services;
    embeddedRunners.begin();
    await online();
    expect(row().dryRun).toBe(true);
    const backup = await takeBackup();

    sshHostsService.updateSettings(actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    await until(row, (host) => host.dryRun === false);
    await rotateToken();

    nextBeat();
    await restore(backup.fileName);

    expect((await online()).dryRun).toBe(true);
    expect(embeddedRunners.connectionOf(hostId)?.state).toBe(SSH_STATE.connected);
  });

  it("goes back to the token and settings it had when the restore fails after the swap", async () => {
    const { controlPlane, actor, hostId } = setup;
    const { embeddedRunners, sshHostsService, restoreService, databaseHandle } = controlPlane.services;
    embeddedRunners.begin();
    await online();
    const backup = await takeBackup();
    sshHostsService.updateSettings(actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    await until(row, (host) => host.dryRun === false);
    await rotateToken();

    const preview = await restoreService.prepareStored(actor, backup.fileName);
    // Fails once, after the hooks before it took up the restored file; the file put back then takes over.
    let first = true;
    databaseHandle.restore.onResume(() => {
      if (!first) return;
      first = false;
      throw new Error("post-swap failure");
    });
    nextBeat();
    await expect(restoreService.confirm(actor, preview.restoreId)).rejects.toThrow("post-swap failure");

    expect((await online()).dryRun).toBe(false);
  });

  it("leaves work the old runner already started to finish first, done once, before the new runner starts", async () => {
    const { controlPlane, actor, admin, engine, server, hostId } = setup;
    const { embeddedRunners, sshHostsService } = controlPlane.services;
    embeddedRunners.begin();
    await online();
    sshHostsService.updateSettings(actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    await until(row, (host) => host.dryRun === false);
    let release!: () => void;
    engine.restartHeldUntil = new Promise((resolve) => {
      release = resolve;
    });
    const backup = await takeBackup();
    const asked = await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName: "tika" }), {
      action: "restart",
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const jobId = asked.json<JobView>().id;
    await until(
      () => engine.restarts,
      (restarts) => restarts.length === 1,
    );

    nextBeat();
    const connections = server.connections.length;
    await restore(backup.fileName);

    // The restore did not wait on it, and nothing new reached the host while it runs.
    expect(controlPlane.services.databaseHandle.restore.busy).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(server.connections).toHaveLength(connections);
    expect(row().lastHeartbeatAt).not.toBe(controlPlane.clock.now);

    release();
    await online();
    expect(engine.restarts).toEqual(["tika"]);
    const restoredJobs = controlPlane.services.databaseHandle.database.select().from(jobs).all();
    expect(restoredJobs.map(({ id }) => id)).not.toContain(jobId);
  });
});
