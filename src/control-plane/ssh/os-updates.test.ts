import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { startEmbeddedSshHost, until, type EmbeddedSshHost } from "../../../test/support/embedded-ssh-host.js";
import {
  API_ERRORS,
  API_ROUTES,
  apiPath,
  type HostPackagesView,
  type HostView,
  type JobView,
} from "../../shared/api.js";
import {
  HOST_PACKAGE_LOG_DIRECTORY,
  HOST_PACKAGE_OUTCOMES,
  JOB_STATUS,
  ROOT_METHOD,
  SSH_PACKAGE_RUNS,
  SSH_READINESS,
} from "../../shared/constants.js";
import { hosts, jobs } from "../database/schema.js";

const SUDO_PASSWORD = "alex's own";
// What apt's check leaves in its log, as on a Debian 13 host.
const CHECK_LOG = `== dpkg-audit
== exit 0
== refresh
== exit 0
== upgrade
Inst openssl [3.5.1-1] (3.5.1-1+deb13u1 Debian-Security:13/stable-security [amd64])
Inst curl [8.14.1-2] (8.14.1-2+deb13u2 Debian:13.1/stable [amd64])
== exit 0
== dist-upgrade
Inst openssl [3.5.1-1] (3.5.1-1+deb13u1 Debian-Security:13/stable-security [amd64])
Inst curl [8.14.1-2] (8.14.1-2+deb13u2 Debian:13.1/stable [amd64])
== exit 0
`;
// What a host with apt, booted by systemd, with its D-Bus socket, shows its user.
const HOST = {
  "usr/bin/apt-get": "",
  "run/systemd/system/.keep": "",
  "run/dbus/system_bus_socket": "",
  "etc/os-release": 'NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\n',
};

interface UnitStarts {
  count: number;
  // Set by a test that needs the unit still going: it ends only when this is called.
  held: boolean;
  end: () => void;
}

/**
 * The host's side of a package job: the root command really run by sh, with the host's folders moved under its test
 * root and systemd-run standing in for systemd. The unit is not started here: its log is left as apt's check leaves
 * it, and its stop script runs as systemd runs it, with the unit's result in the environment.
 */
function hostRunning(setup: EmbeddedSshHost, unitStarts: UnitStarts) {
  const root = setup.hostFiles;
  const moved = (text: string) =>
    text
      .replaceAll(SSH_PACKAGE_RUNS.directory, `${root}${SSH_PACKAGE_RUNS.directory}`)
      .replaceAll(HOST_PACKAGE_LOG_DIRECTORY, `${root}${HOST_PACKAGE_LOG_DIRECTORY}`);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "systemd-run"), `#!/bin/sh\nprintf '%s\\0' "$@" > "${root}/systemd-run.args"\n`);
  chmodSync(join(root, "bin", "systemd-run"), 0o755);
  const otherwise = setup.server.exec;
  return (command: string) => {
    if (!command.includes(SSH_PACKAGE_RUNS.systemdRun)) return otherwise(command);
    const ran = spawnSync("sh", ["-c", moved(command)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
    });
    if (ran.status !== 0) return { stderr: ran.stderr, exitCode: ran.status ?? 1 };
    unitStarts.count += 1;
    const asked = readFileSync(join(root, "systemd-run.args"), "utf8").split("\0");
    const runScript = asked.at(-2)!;
    const statusScript = asked
      .find((argument) => argument.startsWith("--property=ExecStopPost="))!
      .split(" ")
      .at(-1)!;
    const log = /'([^']+\.log)'/.exec(readFileSync(runScript, "utf8"))![1]!;
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, CHECK_LOG);
    const end = () =>
      spawnSync("/bin/sh", [statusScript], {
        env: { PATH: process.env.PATH, SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" },
      });
    if (unitStarts.held) unitStarts.end = end;
    else end();
    return { exitCode: 0 };
  };
}

describe("operating system updates on an SSH host, as root with its saved password", () => {
  let setup: EmbeddedSshHost;

  afterEach(() => setup.stop());

  const prepare = async (docker: boolean, rootSaved: boolean, databasePath?: string) => {
    setup = await startEmbeddedSshHost(undefined, databasePath);
    const { server, controlPlane, actor, hostId, hostFiles } = setup;
    for (const [path, content] of Object.entries(HOST)) {
      mkdirSync(dirname(join(hostFiles, path)), { recursive: true });
      writeFileSync(join(hostFiles, path), content);
    }
    server.readiness = docker ? `${SSH_READINESS.socketMark}\n${SSH_READINESS.usableMark}\n` : "";
    server.sudoPassword = SUDO_PASSWORD;
    const unitStarts: UnitStarts = { count: 0, held: false, end: () => {} };
    server.exec = hostRunning(setup, unitStarts);
    const { sshHostsService, embeddedRunners } = controlPlane.services;
    sshHostsService.updateSettings(actor, hostId, { ...sshHostsService.settingsOf(hostId), hostPackages: "check" });
    if (rootSaved) sshHostsService.saveRootPassword(actor, hostId, SUDO_PASSWORD, ROOT_METHOD.sudo);
    embeddedRunners.begin();
    await until(
      async () => (await setup.admin.get(API_ROUTES.hosts)).json<HostView[]>().find((host) => host.id === hostId)!,
      (host) => host.docker === docker && host.health?.packages?.manager === "apt",
    );
    return unitStarts;
  };

  const check = async () => {
    const { admin, hostId } = setup;
    const asked = await admin.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "check_packages" });
    expect(asked.statusCode, asked.body).toBe(200);
    const { id } = asked.json<JobView>();
    return until(
      async () =>
        (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}`)).json<JobView[]>().find((job) => job.id === id)!,
      (job) => job.status !== JOB_STATUS.pending && job.status !== JOB_STATUS.delivered,
    );
  };

  it.each([
    ["without Docker", false],
    ["with Docker", true],
  ])("checks a host %s for updates, as a runner host's check does", async (_name, docker) => {
    const unitStarts = await prepare(docker, true);
    const job = await check();
    expect(job.status, job.outcome ?? "").toBe(JOB_STATUS.succeeded);
    expect(job.outcome).toBe(HOST_PACKAGE_OUTCOMES.checked(2, 0, 0));
    expect(unitStarts.count).toBe(1);
    // Ran as root through sudo; the password on no command line.
    expect(setup.server.rootCommands).toHaveLength(1);
    expect(setup.server.commands.join("\n")).not.toContain(SUDO_PASSWORD);
    const view = (
      await setup.admin.get(apiPath(API_ROUTES.hostPackages, { hostId: setup.hostId }))
    ).json<HostPackagesView>();
    // Security updates first, as on a runner host's page.
    expect(view.packages.map(({ name, security }) => [name, security])).toEqual([
      ["openssl", true],
      ["curl", false],
    ]);
  });

  it("takes no container or image work for a host without Docker, saying why, and its packages' still", async () => {
    await prepare(false, true);
    const { admin, hostId } = setup;
    const images = await admin.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "check_updates" });
    expect(images.statusCode).toBe(409);
    expect(images.json()).toEqual({ error: API_ERRORS.hostHasNoDocker });
    const jobs = (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}`)).json<JobView[]>();
    expect(jobs.map(({ action }) => action)).not.toContain("check_updates");
    expect((await check()).status).toBe(JOB_STATUS.succeeded);
  });

  describe("across a database restore", () => {
    const databaseFile = () => join(mkdtempSync(join(tmpdir(), "autoheal-updates-restore-")), "autoheal.sqlite");
    const restore = async (fileName: string) => {
      const { restoreService } = setup.controlPlane.services;
      const preview = await restoreService.prepareStored(setup.actor, fileName);
      await restoreService.confirm(setup.actor, preview.restoreId);
    };
    const database = () => setup.controlPlane.services.databaseHandle.database;
    const askCheck = async () => {
      const { admin, hostId } = setup;
      const asked = await admin.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "check_packages" });
      expect(asked.statusCode, asked.body).toBe(200);
      return asked.json<JobView>().id;
    };
    const beatAfterRestore = () => {
      setup.controlPlane.clock.now += 1_000;
      const { hostId, controlPlane } = setup;
      return () =>
        until(
          () => database().select().from(hosts).where(eq(hosts.id, hostId)).get()!,
          (host) => host.lastHeartbeatAt === controlPlane.clock.now,
        );
    };

    it("follows a unit still running to its end without starting it again, the restored job's outcome standing", async () => {
      const unitStarts = await prepare(true, true, databaseFile());
      unitStarts.held = true;
      const jobId = await askCheck();
      const job = () => database().select().from(jobs).where(eq(jobs.id, jobId)).get()!;
      await until(
        () => unitStarts.count,
        (count) => count === 1,
      );
      await until(job, ({ status }) => status === JOB_STATUS.delivered);
      const backup = await setup.controlPlane.services.backupService.create("manual", null);

      const beat = beatAfterRestore();
      await restore(backup.fileName);
      // Its unit runs on, and the host is not left silent for as long as it takes.
      await beat();
      const settled = job();
      expect(settled.status).toBe(JOB_STATUS.expired);

      unitStarts.end();
      const reported = setup.controlPlane.clock.now;
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(setup.controlPlane.clock.now).toBe(reported);
      expect(job()).toEqual(settled);
      expect(unitStarts.count).toBe(1);
      expect(setup.server.rootCommands).toHaveLength(1);
    }, 30_000);

    it("runs without a root password saved after the backup, as the restored file says", async () => {
      const unitStarts = await prepare(true, false, databaseFile());
      const { actor, controlPlane, hostId } = setup;
      const backup = await controlPlane.services.backupService.create("manual", null);
      controlPlane.services.sshHostsService.saveRootPassword(actor, hostId, SUDO_PASSWORD, ROOT_METHOD.sudo);
      const beat = beatAfterRestore();
      await restore(backup.fileName);
      await beat();

      const { id } = controlPlane.services.hostPackages.request({ kind: "user", actor }, hostId, "check_packages", []);
      const finished = await until(
        () => database().select().from(jobs).where(eq(jobs.id, id)).get()!,
        ({ status }) => status !== JOB_STATUS.pending && status !== JOB_STATUS.delivered,
      );
      expect(finished).toMatchObject({ status: JOB_STATUS.failed, outcome: HOST_PACKAGE_OUTCOMES.noRootPassword });
      expect(unitStarts.count).toBe(0);
    });
  });

  it("refuses a job on a host whose root password is not saved, saying where to save it", async () => {
    const unitStarts = await prepare(false, false);
    const job = await check();
    expect(job).toMatchObject({ status: JOB_STATUS.failed, outcome: HOST_PACKAGE_OUTCOMES.noRootPassword });
    expect(unitStarts.count).toBe(0);
    expect(setup.server.rootCommands).toEqual([]);
  });
});
