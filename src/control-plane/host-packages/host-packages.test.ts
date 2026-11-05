import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type HostPackagesView,
  type HostUpdateSettingsView,
  type JobView,
  type TaskDetailView,
  type TaskSummaryView,
} from "../../shared/api.js";
import type { PackageCheck, PackageFacts, WorkResponse } from "../../shared/protocol.js";
import { HOST_PACKAGE_FIRST_CHECK_RETRY_MILLISECONDS } from "../../shared/constants.js";
import { osUpdatesKey } from "./host-packages-service.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";

const BOOT = "8c2f3c1e-5b7a-4d36-9e0f-1a2b3c4d5e6f";
const NEXT_BOOT = "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
// 21 October 2026, 03:30 in London: inside the default window.
const IN_WINDOW = Date.UTC(2026, 9, 21, 2, 30);

const facts = (overrides: Partial<PackageFacts> = {}): PackageFacts => ({
  setting: "apply",
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: [],
  kernelWaiting: null,
  timeZone: "Europe/Lisbon",
  recentChanges: [],
  ...overrides,
});

const pending = (name: string, origin: string) => ({ name, installed: "1.0", candidate: "1.1", origins: [origin] });
const CHECK: PackageCheck = {
  refreshed: true,
  refreshProblem: null,
  needsRepair: false,
  upgradable: [
    pending("openssl", "Debian-Security:13/stable-security"),
    pending("curl", "Debian:13.1/stable"),
    pending("containerd.io", "Docker CE:trixie/stable"),
    pending("postgresql-17", "Debian:13.1/stable"),
    pending("linux-image-amd64", "Debian-Security:13/stable-security"),
  ],
  keptBack: [pending("systemd", "Debian:13.1/stable")],
  removable: [],
  rebootRequired: null,
};
const OLD_KERNEL = { name: "linux-image-6.12.48+deb13-amd64", installed: "6.12.48-1" };
const NOTHING: PackageCheck = { ...CHECK, upgradable: [], keptBack: [] };

describe("a host's own packages", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    await report();
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  async function report(packages: Partial<PackageFacts> = {}, bootId = BOOT, uptimeSeconds = 86_400) {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({
        dryRun: false,
        host: hostHealth({ bootId, uptimeSeconds, packages: facts(packages) }),
      }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  }
  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const takeWork = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;
  const answer = (jobId: string, result: object) => runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId }), result);
  const progress = async (jobId: string, output: string) =>
    (await runner("POST", apiPath(RUNNER_ROUTES.jobProgress, { jobId }), { output })).statusCode;
  const ask = (payload: object) => admin.post(apiPath(API_ROUTES.hostActions, { hostId }), payload);
  const view = async () => (await admin.get(apiPath(API_ROUTES.hostPackages, { hostId }))).json<HostPackagesView>();
  const openTasks = async () => (await admin.get(`${API_ROUTES.tasks}?status=open`)).json<TaskSummaryView[]>();
  const detect = () => controlPlane.services.detectorService.run();
  // A night later the admin's session has long expired: read what the dashboard would show directly.
  const nightlyComments = () => {
    const task = controlPlane.services.tasksService.openFor(osUpdatesKey(hostId));
    return JSON.stringify(controlPlane.services.tasksService.detail(task!.id));
  };

  async function checked(check: PackageCheck = CHECK) {
    expect((await ask({ action: "check_packages" })).statusCode).toBe(200);
    const [job] = await takeWork();
    expect(job).toMatchObject({ action: "check_packages", containerName: "", packages: [] });
    expect(
      (await answer(job!.id, { succeeded: true, outcome: "Checked.", output: null, packages: check })).statusCode,
    ).toBe(204);
  }

  it("shows what the host's files say before any check, and that nothing is pending yet", async () => {
    expect(await view()).toMatchObject({
      facts: { setting: "apply", unsupported: null, timeZone: "Europe/Lisbon" },
      checkedAt: null,
      packages: [],
      running: null,
      window: { securityInWindow: true, windowStart: "03:00", windowEnd: "05:00" },
    });
  });

  it("sorts what a check found: Autoheal's security fixes, and what the rules hold for a person", async () => {
    await checked();

    const packages = await view();

    expect(packages.checkedAt).toBe(controlPlane.clock.now);
    expect(
      Object.fromEntries(packages.packages.map(({ name, kind, security, held }) => [name, { kind, security, held }])),
    ).toEqual({
      openssl: { kind: "routine", security: true, held: false },
      curl: { kind: "routine", security: false, held: false },
      "containerd.io": { kind: "container_runtime", security: false, held: true },
      "postgresql-17": { kind: "keeps_data", security: false, held: true },
      "linux-image-amd64": { kind: "kernel", security: true, held: false },
    });
    expect(packages.automatic).toEqual(["openssl", "linux-image-amd64"]);
    expect(packages.forPerson).toEqual(["curl", "containerd.io", "postgresql-17"]);
    expect(packages.keptBack.map(({ name }) => name)).toEqual(["systemd"]);
    expect(packages.recent[0]).toMatchObject({ action: "check_packages", status: "succeeded" });
  });

  it("leaves the distribution's security fixes to unattended-upgrades where it is on", async () => {
    await report({ unattendedUpgrades: true });
    await checked();

    expect(await view()).toMatchObject({
      automatic: [],
      unattended: ["openssl", "linux-image-amd64"],
      forPerson: ["curl", "containerd.io", "postgresql-17"],
    });
  });

  it("opens one task for what waits, saying what Autoheal does tonight, and closes it once nothing is pending", async () => {
    await checked();
    await detect();

    const [task] = await openTasks();
    expect(task).toMatchObject({ title: "OS updates on Alder: 5, 2 security", priority: "low" });
    const { description } = (await admin.get(apiPath(API_ROUTES.task, { taskId: task!.id }))).json<TaskDetailView>();
    expect(description).toContain(
      "Autoheal installs these security fixes in tonight's window: openssl, linux-image-amd64.",
    );
    expect(description).toContain("Held for you: containerd.io, postgresql-17.");
    expect(description).toContain("Waiting for you: curl.");

    await checked(NOTHING);
    await detect();
    expect(await openTasks()).toEqual([]);
  });

  it("makes the task medium when a security fix waits for a person", async () => {
    await report({ setting: "check" });
    await checked();
    await detect();

    expect((await openTasks())[0]).toMatchObject({ priority: "medium" });
  });

  it("asks a reboot of the host when a newer kernel waits, saying what for", async () => {
    await report({ kernelWaiting: "6.12.57+deb13-amd64", rebootPackages: ["linux-base"] });
    await detect();

    const [task] = await openTasks();
    expect(task?.title).toBe("Alder needs a reboot");
    const { description } = (await admin.get(apiPath(API_ROUTES.task, { taskId: task!.id }))).json<TaskDetailView>();
    expect(description).toBe(
      "It waits for linux-base. Kernel 6.12.57+deb13-amd64 starts at the next boot. Rebooting is yours: Autoheal never reboots a host by itself.",
    );
  });

  it("upgrades only what the last check offered, one package job at a time", async () => {
    expect((await ask({ action: "upgrade_packages", packages: ["curl"] })).json()).toMatchObject({
      error: "packages_not_offered",
    });
    await checked();

    expect((await ask({ action: "upgrade_packages", packages: ["curl", "not-offered"] })).statusCode).toBe(422);
    const upgrade = (await ask({ action: "upgrade_packages", packages: ["curl"] })).json<JobView>();
    expect(upgrade).toMatchObject({ action: "upgrade_packages", status: "pending" });
    expect((await ask({ action: "check_packages" })).json()).toMatchObject({ error: "host_packages_busy" });
    for (const action of ["upgrade_packages", "repair_packages", "autoremove_packages", "reboot"]) {
      expect((await ask({ action, packages: ["curl"] })).json()).toMatchObject({ error: "host_packages_busy" });
    }

    const [job] = await takeWork();
    expect(job).toMatchObject({ id: upgrade.id, packages: ["curl"] });
    for (const action of ["upgrade_packages", "repair_packages", "autoremove_packages", "reboot"]) {
      expect((await ask({ action, packages: ["curl"] })).json()).toMatchObject({ error: "host_packages_busy" });
    }
    expect((await view()).running).toMatchObject({ id: upgrade.id, status: "delivered" });
  });

  it.each([
    [{ setting: "off" as const }, { action: "upgrade_packages", packages: ["openssl"] }, "host_packages_not_allowed"],
    // Any admin may reboot or shut down whatever the setting; only a host whose systemd can't be asked refuses.
    [{ unsupported: "no_systemd" as const }, { action: "reboot" }, "host_packages_unsupported"],
    [{ setting: "off" as const }, { action: "autoremove_packages" }, "host_packages_not_allowed"],
    [{ setting: "off" as const }, { action: "check_packages" }, "host_packages_not_allowed"],
    [{ unsupported: "no_systemd" as const }, { action: "check_packages" }, "host_packages_unsupported"],
  ])("refuses what the host's own .env or its system does not allow (%o)", async (hostFacts, payload, error) => {
    await checked();
    await report(hostFacts);

    const refused = await ask(payload);

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error });
  });

  it("lets a person install what is listed on a host set to check, but never Autoheal or Ollama by themselves", async () => {
    await checked();
    await report({ setting: "check" });

    const upgrade = await ask({ action: "upgrade_packages", packages: ["curl"] });

    expect(upgrade.json()).toMatchObject({ action: "upgrade_packages", status: "pending" });
    expect(() => controlPlane.services.hostPackages.requireUpgrade(hostId, ["openssl"])).toThrow();
  });

  it("checks again by itself after an upgrade, so the page and the task follow at once", async () => {
    await checked();
    const upgrade = (await ask({ action: "upgrade_packages", packages: ["curl"] })).json<JobView>();
    await takeWork();

    await answer(upgrade.id, { succeeded: true, outcome: "Upgraded curl.", output: null });

    expect(await takeWork()).toEqual([expect.objectContaining({ action: "check_packages", requestedBy: "Autoheal" })]);
  });

  it("drops what an upgrade installed as it ends, before the check after it answers", async () => {
    await checked();
    const before = (await view()).packages.map(({ name }) => name);
    expect(before).toContain("curl");
    const upgrade = (await ask({ action: "upgrade_packages", packages: ["curl"] })).json<JobView>();
    await takeWork();

    await answer(upgrade.id, { succeeded: true, outcome: "Upgraded curl.", output: null });

    expect((await view()).packages.map(({ name }) => name)).toEqual(before.filter((name) => name !== "curl"));
  });

  it("keeps the list as it was when an upgrade fails", async () => {
    await checked();
    const before = (await view()).packages.map(({ name }) => name);
    const upgrade = (await ask({ action: "upgrade_packages", packages: ["curl"] })).json<JobView>();
    await takeWork();

    await answer(upgrade.id, { succeeded: false, outcome: "Could not upgrade curl.", output: null });

    expect((await view()).packages.map(({ name }) => name)).toEqual(before);
  });

  it("lists what nothing needs any more, removes it when asked, and checks again", async () => {
    await checked({ ...CHECK, removable: [OLD_KERNEL] });
    expect((await view()).removable).toEqual([OLD_KERNEL]);

    const removal = (await ask({ action: "autoremove_packages", packages: ["ignored"] })).json<JobView>();
    const [job] = await takeWork();
    expect(job).toMatchObject({ id: removal.id, action: "autoremove_packages", packages: [] });
    await answer(removal.id, {
      succeeded: true,
      outcome: "Removed the packages nothing needed any more.",
      output: null,
    });

    expect((await view()).removable).toEqual([]);
    expect(await takeWork()).toEqual([expect.objectContaining({ action: "check_packages", requestedBy: "Autoheal" })]);
  });

  it("shows a running job's output as it comes, until its result replaces it", async () => {
    await checked();
    const upgrade = (await ask({ action: "upgrade_packages", packages: ["curl"] })).json<JobView>();
    expect(await progress(upgrade.id, "not delivered yet")).toBe(404);
    await takeWork();

    expect(await progress(upgrade.id, "Unpacking curl ...\n")).toBe(204);
    expect((await view()).running).toMatchObject({ id: upgrade.id, output: "Unpacking curl ...\n" });

    await answer(upgrade.id, { succeeded: true, outcome: "Upgraded curl.", output: "Setting up curl ...\n" });
    expect(await progress(upgrade.id, "too late")).toBe(404);
    const done = (await admin.get(apiPath(API_ROUTES.job, { jobId: upgrade.id }))).json<JobView>();
    expect(done.output).toBe("Setting up curl ...\n");
  });

  it("takes dnf's word that a reboot is needed, until the host boots again", async () => {
    await report({ manager: "dnf" });
    await checked({ ...CHECK, rebootRequired: true });
    expect((await view()).rebootRequired).toBe(true);
    await detect();
    expect((await openTasks()).map(({ title }) => title)).toContain("Alder needs a reboot");

    controlPlane.clock.now += 10 * 60_000;
    await report({ manager: "dnf" }, NEXT_BOOT, 60);

    expect((await view()).rebootRequired).toBe(false);
  });

  it.each([
    [{ id: "debian", versionId: "13" }, false, null],
    [
      { id: "debian", versionId: "12" },
      true,
      { title: "Proxmox VE 8 on Alder gets no security fixes any more", priority: "high" },
    ],
  ])("says how long %o gets security fixes, a task once they end (Proxmox: %s)", async (release, proxmox, task) => {
    await report({ release, proxmox });
    await detect();

    const lifecycle = (await view()).lifecycle;
    expect(lifecycle?.status).toBe(task === null ? "supported" : "unsupported");
    const titles = (await openTasks()).filter(({ title }) => title.includes("security fixes"));
    expect(titles).toEqual(task === null ? [] : [expect.objectContaining(task)]);
  });

  it("in the host's window checks first, then takes the security fixes it may, once a night", async () => {
    await checked();
    await detect();
    controlPlane.clock.now = IN_WINDOW;
    await report();

    controlPlane.services.hostPackages.tick();
    const [nightlyCheck] = await takeWork();
    expect(nightlyCheck).toMatchObject({ action: "check_packages", requestedBy: "Autoheal" });
    controlPlane.services.hostPackages.tick();
    expect(await takeWork()).toEqual([]);

    await answer(nightlyCheck!.id, { succeeded: true, outcome: "Checked.", output: null, packages: CHECK });
    controlPlane.services.hostPackages.tick();
    const [fixes] = await takeWork();
    expect(fixes).toMatchObject({ action: "upgrade_packages", packages: ["openssl", "linux-image-amd64"] });

    await answer(fixes!.id, { succeeded: true, outcome: "Upgraded openssl, linux-image-amd64.", output: null });
    expect(nightlyComments()).toContain(
      "Tonight's security fixes, in the host's window: Upgraded openssl, linux-image-amd64.",
    );

    // The check after it, then nothing more tonight.
    const [after] = await takeWork();
    await answer(after!.id, { succeeded: true, outcome: "Checked.", output: null, packages: CHECK });
    controlPlane.services.hostPackages.tick();
    expect(await takeWork()).toEqual([]);
  });

  it("outside the window, or when the owner said no, takes nothing by itself", async () => {
    await checked();
    controlPlane.services.hostPackages.tick();
    expect(await takeWork()).toEqual([]);

    const saved = await admin.put(API_ROUTES.hostUpdateSettings, {
      securityInWindow: false,
      windowStart: "03:00",
      windowEnd: "05:00",
    });
    expect(saved.json<HostUpdateSettingsView>()).toEqual({
      securityInWindow: false,
      windowStart: "03:00",
      windowEnd: "05:00",
    });
    controlPlane.clock.now = IN_WINDOW;
    await report();
    controlPlane.services.hostPackages.tick();
    const [nightlyCheck] = await takeWork();
    await answer(nightlyCheck!.id, { succeeded: true, outcome: "Checked.", output: null, packages: CHECK });
    controlPlane.services.hostPackages.tick();

    expect(await takeWork()).toEqual([]);
    expect(controlPlane.services.hostPackages.view(hostId).automatic).toEqual([]);
  });

  it("checks a host as soon as its .env allows it, not at night, and an hour apart while that fails", async () => {
    controlPlane.services.hostPackages.tick();
    const [first] = await takeWork();
    expect(first).toMatchObject({ action: "check_packages", requestedBy: "Autoheal" });
    await answer(first!.id, { succeeded: false, outcome: "It failed: E: Temporary failure resolving", output: null });
    controlPlane.services.hostPackages.tick();
    expect(await takeWork()).toEqual([]);

    controlPlane.clock.now += HOST_PACKAGE_FIRST_CHECK_RETRY_MILLISECONDS + 60_000;
    await report();
    controlPlane.services.hostPackages.tick();
    const [again] = await takeWork();
    await answer(again!.id, { succeeded: true, outcome: "Checked.", output: null, packages: CHECK });
    // An hour later the admin's session has expired: what the page would show, read directly.
    expect(controlPlane.services.hostPackages.view(hostId).packages.map(({ name }) => name)).toContain("openssl");

    // Checked once: the nightly check does the rest.
    controlPlane.clock.now += HOST_PACKAGE_FIRST_CHECK_RETRY_MILLISECONDS + 60_000;
    await report();
    controlPlane.services.hostPackages.tick();
    expect(await takeWork()).toEqual([]);
  });

  it("checks nothing on a host whose .env keeps its packages off", async () => {
    await report({ setting: "off" });
    controlPlane.services.hostPackages.tick();
    expect(await takeWork()).toEqual([]);
  });

  it("takes window times as HH:MM only", async () => {
    const refused = await admin.put(API_ROUTES.hostUpdateSettings, {
      securityInWindow: true,
      windowStart: "3am",
      windowEnd: "05:00",
    });
    expect(refused.statusCode).toBe(400);
  });

  it("knows a reboot happened when the host comes back from a new boot, if its runner could not say", async () => {
    const reboot = (await ask({ action: "reboot" })).json<JobView>();
    await takeWork();
    controlPlane.clock.now += 3 * 60_000;

    await report({}, NEXT_BOOT);

    const job = (await admin.get(apiPath(API_ROUTES.job, { jobId: reboot.id }))).json<JobView>();
    expect(job).toMatchObject({ status: "succeeded", outcome: "Rebooted: the host was back 3 min later." });
  });
});
