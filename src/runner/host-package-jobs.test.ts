import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostPackagesSetting } from "../shared/constants.js";
import type { HostJob } from "../shared/protocol.js";
import type { ContainerSummary } from "./docker-client.js";
import { HostPackageJobs } from "./host-package-jobs.js";
import type { ContainerDetails } from "./incident-report.js";
import { RemedyGuard } from "./remedy-guard.js";

const JOB = "0b8c3c5e-6a52-4f7e-9d3c-2f6d7a1b9e10";
const OWN_IMAGE = "sha256:4a1b2c3d";
const NOW = Date.UTC(2026, 9, 22, 2, 0, 0);
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
Inst systemd [257.8-1] (257.9-1 Debian:13.1/stable [amd64])
== exit 0
`;

const DNF_CHECK_LOG = `== refresh
== exit 0
== installed
openssl-libs 1:3.2.4-3.fc42 x86_64
curl 8.11.1-4.fc42 x86_64
== exit 0
== upgrades
openssl-libs 1:3.2.4-4.fc42 x86_64 updates
curl 8.11.1-5.fc42 x86_64 updates
== exit 0
== security
openssl-libs
== exit 0
== unneeded
== exit 0
== reboot
No core libraries or services have been updated since boot-up.
Reboot should not be necessary.
== exit 0
`;

const job = (overrides: Partial<HostJob> = {}): HostJob => ({
  id: JOB,
  containerName: "",
  action: "check_packages",
  packages: [],
  requestedBy: "admin",
  expiresAt: NOW + 60_000,
  ...overrides,
});

interface Scenario {
  applicationRecoveryPending?: () => boolean;
  onProgress?: (text: string) => void;
  onWait?: () => void;
  pause?: Promise<void>;
  // What the helper prints; null to print nothing.
  helperSays: string | null;
  // What the unit leaves on the host once it ends, written when the runner first waits for it.
  unit?: { verb: string; log: string; status: string | null };
  running: string[];
  // Containers running once the run ended.
  runningAfter?: string[];
  journal?: ConstructorParameters<typeof HostPackageJobs>[0]["journal"];
}

describe("package jobs on the runner's host", () => {
  let hostRoot: string;
  let clock: number;
  let created: { name: string; specification: Record<string, unknown> }[];
  let removed: string[];
  let guard: RemedyGuard;
  let heldWhileRunning: boolean[];
  let progress: [string, string][];

  beforeEach(() => {
    hostRoot = mkdtempSync(join(tmpdir(), "autoheal-host-jobs-"));
    clock = NOW;
    created = [];
    removed = [];
    guard = new RemedyGuard(new Set());
    heldWhileRunning = [];
    progress = [];
  });

  afterEach(() => rmSync(hostRoot, { recursive: true, force: true }));

  const supportedHost = (manager: "apt-get" | "dnf" = "apt-get") => {
    for (const path of ["usr/bin", "run/systemd/system", "run/dbus"]) {
      mkdirSync(join(hostRoot, path), { recursive: true });
    }
    writeFileSync(join(hostRoot, "usr/bin", manager), "");
    writeFileSync(join(hostRoot, "run/dbus/system_bus_socket"), "");
  };

  const leaveRun = (verb: string, log: string, status: string | null) => {
    mkdirSync(join(hostRoot, "var/log/autoheal"), { recursive: true });
    writeFileSync(join(hostRoot, `var/log/autoheal/${JOB}-${verb}.log`), log);
    if (status !== null) {
      writeFileSync(join(hostRoot, `var/log/autoheal/${JOB}-${verb}.status`), `${status}\n`);
    }
  };

  function jobsFor(scenario: Scenario, hostPackages: HostPackagesSetting = "apply", dryRun = false) {
    let ended = false;
    const summaries = (): ContainerSummary[] =>
      (ended ? (scenario.runningAfter ?? scenario.running) : scenario.running).map((name) => ({
        Id: name,
        Names: [`/${name}`],
        State: "running",
        Status: "Up",
      }));
    return new HostPackageJobs({
      docker: {
        inspect: async (name: string) =>
          ({
            Name: `/${name}`,
            Image: OWN_IMAGE,
            State: { Running: false },
            Config: {},
          }) as unknown as ContainerDetails,
        create: async (name: string, specification: Record<string, unknown>) => {
          created.push({ name, specification });
          return "helper-id";
        },
        start: async () => undefined,
        logs: async () => scenario.helperSays ?? "",
        remove: async (name: string) => {
          removed.push(name);
        },
        containerSummaries: async () => summaries(),
      },
      guard,
      journal: scenario.journal,
      applicationRecoveryPending: scenario.applicationRecoveryPending,
      progress: async (jobId, output) => {
        progress.push([jobId, output]);
        scenario.onProgress?.(output);
      },
      settings: {
        hostPackages,
        dryRun,
        hostRoot,
        selfContainerName: "autoheal",
        hostDbusDirectory: "/run/dbus",
      },
      now: () => clock,
      // Each wait moves the clock on; the first one is when the unit ends.
      sleep: async (milliseconds) => {
        scenario.onWait?.();
        await scenario.pause;
        heldWhileRunning.push(guard.isHeld("anything"));
        clock += milliseconds;
        if (scenario.unit !== undefined && !ended) {
          leaveRun(scenario.unit.verb, scenario.unit.log, scenario.unit.status);
        }
        ended = true;
      },
    });
  }

  it.each([
    ["off", "check_packages", "Refused: this host's HOST_PACKAGES is off. Its own .env allows checks"],
    ["off", "upgrade_packages", "Refused: this host's HOST_PACKAGES is off."],
    ["check", "upgrade_packages", "Refused: this host's HOST_PACKAGES is check."],
  ] as const)("with HOST_PACKAGES=%s, refuses %s without starting anything", async (setting, action, outcome) => {
    supportedHost();
    const result = await jobsFor({ helperSays: null, running: [] }, setting).run(job({ action }));

    expect(result).toMatchObject({ succeeded: false, outcome: expect.stringContaining(outcome) });
    expect(created).toEqual([]);
  });

  it.each([
    ["reboot", "reboot", "Rebooting the host now."],
    ["shutdown", "shutdown", "Shutting the host down now."],
  ] as const)("%s goes ahead whatever HOST_PACKAGES says: any admin may ask for it", async (action, verb, outcome) => {
    supportedHost();
    // Asked by the runner as it goes down: systemd stops the unit with a signal.
    const result = await jobsFor(
      { helperSays: '{"outcome":"started"}', running: [], unit: { verb, log: "", status: "signal killed TERM" } },
      "off",
    ).run(job({ action }));
    expect(result).toMatchObject({ succeeded: true, outcome });
    expect(created).toHaveLength(1);
  });

  it("refuses on a host whose packages it cannot reach, saying why", async () => {
    const result = await jobsFor({ helperSays: null, running: [] }).run(job());
    expect(result.outcome).toBe(
      "This host has neither apt nor dnf: Autoheal looks after Debian, Ubuntu, Fedora and RHEL-family packages.",
    );
    expect(created).toEqual([]);
  });

  it("refuses a repair on a dnf host, which has nothing like dpkg's half-done state", async () => {
    supportedHost("dnf");
    const result = await jobsFor({ helperSays: null, running: [] }).run(job({ action: "repair_packages" }));

    expect(result.outcome).toBe("Refused: repairing is for dpkg; dnf hosts have nothing like it.");
    expect(created).toEqual([]);
  });

  it("in dry-run, says what an upgrade, a repair, a removal or a reboot would do, and does none of them", async () => {
    supportedHost();
    const jobs = jobsFor({ helperSays: null, running: [] }, "apply", true);

    expect((await jobs.run(job({ action: "upgrade_packages", packages: ["openssl", "curl"] }))).outcome).toBe(
      "DRY RUN: would upgrade openssl, curl.",
    );
    expect((await jobs.run(job({ action: "repair_packages" }))).outcome).toBe(
      "DRY RUN: would finish what dpkg left half-done.",
    );
    expect((await jobs.run(job({ action: "autoremove_packages" }))).outcome).toBe(
      "DRY RUN: would remove the packages nothing needs any more.",
    );
    expect((await jobs.run(job({ action: "reboot" }))).outcome).toBe("DRY RUN: would reboot.");
    expect(created).toEqual([]);
  });

  it("checks through a locked-down helper from its own image, and reads what the check found", async () => {
    supportedHost();
    const scenario = {
      helperSays: '{"outcome":"started"}\n',
      unit: { verb: "check", log: CHECK_LOG, status: "success exited 0" },
      running: ["paperless"],
    };

    const result = await jobsFor(scenario, "check", true).run(job());

    expect(created).toEqual([
      {
        name: `autoheal-helper-${JOB}`,
        specification: {
          Image: OWN_IMAGE,
          Cmd: ["host-helper", "apt", "check", JOB],
          User: "0",
          Labels: { "com.autoheal.helper": "true" },
          NetworkDisabled: true,
          Healthcheck: { Test: ["NONE"] },
          HostConfig: {
            Binds: ["/run/dbus:/run/dbus"],
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            // Without these, AppArmor or SELinux would keep it from the host's D-Bus.
            SecurityOpt: ["no-new-privileges:true", "label=disable", "apparmor=unconfined"],
            NetworkMode: "none",
            Memory: 64 * 1024 * 1024,
            PidsLimit: 32,
          },
        },
      },
    ]);
    expect(removed).toEqual([`autoheal-helper-${JOB}`]);
    expect(result).toMatchObject({ succeeded: true, outcome: "2 to upgrade, 1 kept back." });
    expect(result.packages).toMatchObject({ removable: [], rebootRequired: null });
    expect(result.packages?.upgradable.map(({ name }) => name)).toEqual(["openssl", "curl"]);
    expect(result.packages?.keptBack.map(({ name }) => name)).toEqual(["systemd"]);
    // What it found is all in the result: apt's own words are kept for what changes packages.
    expect(result.output).toBeNull();
    // A check changes nothing, so healing carries on as usual.
    expect(heldWhileRunning).not.toContain(true);
  });

  it("checks a dnf host with dnf, security fixes named by its advisories", async () => {
    supportedHost("dnf");
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "check", log: DNF_CHECK_LOG, status: "success exited 0" },
      running: [],
    };

    const result = await jobsFor(scenario, "check").run(job());

    expect(created[0]?.specification).toMatchObject({ Cmd: ["host-helper", "dnf", "check", JOB] });
    expect(result).toMatchObject({ succeeded: true, outcome: "2 to upgrade." });
    expect(result.packages?.upgradable.map(({ name, security }) => [name, security])).toEqual([
      ["openssl-libs", true],
      ["curl", false],
    ]);
    expect(result.packages?.rebootRequired).toBe(false);
  });

  it("sends the log on while the run goes on, once each time it grew", async () => {
    supportedHost();
    leaveRun("upgrade", "Unpacking openssl (3.5.1-1+deb13u1) ...\n", null);
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "upgrade", log: "Unpacking openssl ...\nSetting up openssl ...\n", status: "success exited 0" },
      running: [],
    };

    await jobsFor(scenario).run(job({ action: "upgrade_packages", packages: ["openssl"] }));

    expect(progress).toEqual([[JOB, "Unpacking openssl (3.5.1-1+deb13u1) ...\n"]]);
  });

  it("finishes the host-owned upgrade after its helper exits even when progress delivery is disconnected", async () => {
    supportedHost();
    leaveRun("upgrade", "Installing openssl ...\n", null);
    const result = await jobsFor({
      helperSays: '{"outcome":"started"}',
      running: [],
      onProgress: () => {
        throw new Error("Progress connection closed");
      },
      onWait: () => {
        // Removing the short-lived launcher does not stop the host's systemd package unit.
        expect(removed).toHaveLength(1);
        expect(guard.isHeld("anything")).toBe(true);
      },
      unit: { verb: "upgrade", log: "Setting up openssl ...\n", status: "success exited 0" },
    }).run(job({ action: "upgrade_packages", packages: ["openssl"] }));
    expect(result).toMatchObject({ succeeded: true, outcome: "Upgraded openssl.", output: "Setting up openssl ...\n" });
    expect(progress).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(guard.isHeld("anything")).toBe(false);
  });

  it("removes what nothing needs any more", async () => {
    supportedHost();
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "autoremove", log: "Removing linux-image-6.12.38+deb13-amd64 ...\n", status: "success exited 0" },
      running: [],
    };

    const result = await jobsFor(scenario).run(job({ action: "autoremove_packages" }));

    expect(created[0]?.specification).toMatchObject({ Cmd: ["host-helper", "apt", "autoremove", JOB] });
    expect(result).toMatchObject({
      succeeded: true,
      outcome: "Removed the packages nothing needed any more.",
      output: "Removing linux-image-6.12.38+deb13-amd64 ...\n",
    });
  });

  it("upgrades the named packages with healing standing aside, and names what did not come back", async () => {
    supportedHost();
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "upgrade", log: "Setting up openssl (3.5.1-1+deb13u1) ...\n", status: "success exited 0" },
      running: ["paperless", "tika"],
      runningAfter: ["paperless"],
    };

    const result = await jobsFor(scenario).run(job({ action: "upgrade_packages", packages: ["openssl"] }));

    expect(created[0]?.specification).toMatchObject({ Cmd: ["host-helper", "apt", "upgrade", JOB, "openssl"] });
    expect(result).toMatchObject({ succeeded: true, outcome: "Upgraded openssl. Not running again yet: tika." });
    expect(heldWhileRunning[0]).toBe(true);
    expect(guard.isHeld("tika")).toBe(false);
  });

  it("asks for a record bound to the host's boot for a reboot, and for none for an upgrade", async () => {
    supportedHost();
    const asked: { operation: string; reboot: boolean | undefined }[] = [];
    const journal = {
      run: async <Result>(
        operation: string,
        _target: string,
        work: () => Promise<Result>,
        options: { reboot?: boolean } = {},
      ) => {
        asked.push({ operation, reboot: options.reboot });
        return work();
      },
      delegate: async () => undefined,
    };
    for (const [action, verb] of [
      ["reboot", "reboot"],
      ["upgrade_packages", "upgrade"],
    ] as const) {
      const jobs = jobsFor({
        helperSays: '{"outcome":"started"}',
        running: [],
        unit: { verb, log: "", status: "success exited 0" },
        journal,
      });
      await jobs.run(job({ action }));
    }
    expect(asked).toEqual([
      { operation: `host:${JOB}`, reboot: true },
      { operation: `host:${JOB}`, reboot: false },
    ]);
  });

  it.each(["upgrade_packages", "reboot"] as const)(
    "queues %s before any helper starts when containers are locked",
    async (action) => {
      supportedHost();
      const lease = await guard.operations.acquire(["name:paperless"]);
      let queued!: () => void;
      const waiting = new Promise<void>((resolve) => {
        queued = resolve;
      });
      const verb = action === "reboot" ? "reboot" : "upgrade";
      const jobs = jobsFor({
        helperSays: '{"outcome":"started"}',
        running: [],
        unit: { verb, log: "", status: "success exited 0" },
        onProgress: (text) => {
          if (text.startsWith("Waiting")) {
            queued();
          }
        },
      });
      const result = jobs.run(job({ action }));
      await waiting;
      expect(created).toEqual([]);
      expect(guard.operations.tryAcquire(["name:other"])).toBeNull();
      lease.release();
      expect((await result).succeeded).toBe(true);
      expect(created).toHaveLength(1);
    },
  );

  it("excludes container mutations throughout a host upgrade and releases them afterwards", async () => {
    supportedHost();
    let entered!: () => void;
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = jobsFor({
      helperSays: '{"outcome":"started"}',
      running: [],
      unit: { verb: "upgrade", log: "", status: "success exited 0" },
      onWait: entered,
      pause,
    }).run(job({ action: "upgrade_packages" }));
    await running;
    let queued!: () => void;
    let changed = false;
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const container = guard.operations.containers(
      async () => ({ resources: ["name:paperless"] }),
      async () => {
        changed = true;
      },
      queued,
    );
    await waiting;
    expect(changed).toBe(false);
    finish();
    await result;
    await container;
    expect(changed).toBe(true);
    expect(guard.isHeld("paperless")).toBe(false);
  });

  it("reports apt's own words when the run failed", async () => {
    supportedHost();
    const log = "Reading package lists...\nE: Unable to locate package nothing-here\n";
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "upgrade", log, status: "exit-code exited 100" },
      running: [],
    };

    const result = await jobsFor(scenario).run(job({ action: "upgrade_packages", packages: ["nothing-here"] }));

    expect(result).toMatchObject({ succeeded: false, outcome: "It failed: E: Unable to locate package nothing-here" });
  });

  it.each([
    ['{"outcome":"busy"}', "Refused: a package run is already going on on this host."],
    ['{"outcome":"failed","reason":"Access denied"}', "Could not ask the host's systemd: Access denied"],
    ["Usage: main.js host-helper …", "Could not ask the host's systemd: Usage: main.js host-helper …"],
  ])("passes on what the helper said: %s", async (helperSays, outcome) => {
    supportedHost();
    const result = await jobsFor({ helperSays, running: [] }).run(job());

    expect(result).toEqual({ succeeded: false, outcome, output: null });
    expect(removed).toHaveLength(1);
  });

  it("reboots through the host's systemd, holding healing back while it goes down", async () => {
    supportedHost("dnf");
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "reboot", log: "", status: "success exited 0" },
      running: ["paperless"],
      runningAfter: [],
    };

    const result = await jobsFor(scenario).run(job({ action: "reboot" }));

    expect(result).toEqual({ succeeded: true, outcome: "Rebooting the host now.", output: null });
    expect(created[0]?.specification).toMatchObject({ Cmd: ["host-helper", "dnf", "reboot", JOB] });
    expect(heldWhileRunning[0]).toBe(true);
  });

  it("takes a reboot run the shutdown stopped as the host going down", async () => {
    supportedHost();
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "reboot", log: "", status: "signal killed TERM" },
      running: [],
    };

    const result = await jobsFor(scenario).run(job({ action: "reboot" }));

    expect(result).toMatchObject({ succeeded: true, outcome: "Rebooting the host now." });
  });

  it("does not reboot a Proxmox host while it backs up, and says so in its own words", async () => {
    supportedHost();
    const answer = '[{"type":"vzdump","id":"101","status":"running"}]';
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: {
        verb: "reboot",
        log: `${answer}\nNot rebooting: a Proxmox backup is running on this node.\n`,
        status: "exit-code exited 3",
      },
      running: [],
    };

    const result = await jobsFor(scenario).run(job({ action: "reboot" }));

    expect(result).toMatchObject({
      succeeded: false,
      outcome: "Not rebooting: a Proxmox backup is running on this node.",
      output: expect.stringContaining(answer),
    });
  });

  it("does not reboot while a person's container action is still going on", async () => {
    supportedHost();
    guard.hold("paperless");

    const result = await jobsFor({ helperSays: null, running: [] }).run(job({ action: "reboot" }));

    expect(result.outcome).toBe("Not rebooting: paperless is being changed right now.");
    expect(created).toEqual([]);
  });

  it("gives up on a run with no result past its time, and says where to look", async () => {
    supportedHost();
    const scenario = {
      helperSays: '{"outcome":"started"}',
      unit: { verb: "check", log: "", status: null },
      running: [],
    };

    const result = await jobsFor(scenario).run(job());

    expect(result).toMatchObject({ succeeded: false, outcome: expect.stringMatching(/^No result after 35 minutes/) });
  });

  it("keeps resumed host work exclusive until its result is collected", async () => {
    supportedHost();
    leaveRun("upgrade", "", null);
    utimesSync(join(hostRoot, `var/log/autoheal/${JOB}-upgrade.log`), new Date(NOW), new Date(NOW));
    let release!: () => void;
    let waiting!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const jobs = jobsFor({
      helperSays: null,
      running: [],
      pause: paused,
      onWait: waiting,
      unit: { verb: "upgrade", log: "finished", status: "success exited 0" },
    });
    const runs = await jobs.followable();
    await entered;
    expect(guard.operations.tryAcquire(["name:paperless"])).toBeNull();
    release();
    expect(await runs[0]?.result).toMatchObject({ succeeded: true });
    const lease = guard.operations.tryAcquire(["name:paperless"]);
    expect(lease).not.toBeNull();
    lease?.release();
  });

  it.each(["upgrade_packages", "repair_packages", "autoremove_packages", "reboot"] as const)(
    "refuses %s while application recovery is pending without creating a helper",
    async (action) => {
      supportedHost();
      const result = await jobsFor({ helperSays: null, running: [], applicationRecoveryPending: () => true }).run(
        job({ action }),
      );
      expect(result).toMatchObject({
        succeeded: false,
        outcome: expect.stringContaining("application backup recovery is incomplete"),
      });
      expect(created).toEqual([]);
      expect(guard.isHeld("anything")).toBe(false);
    },
  );
  it("rechecks pending application recovery after waiting for the host lock", async () => {
    supportedHost();
    let pending = false;
    const lease = await guard.operations.acquire(["name:paperless"]);
    let queued!: () => void;
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const jobs = jobsFor({
      helperSays: null,
      running: [],
      applicationRecoveryPending: () => pending,
      onProgress: (text) => {
        if (text.startsWith("Waiting")) queued();
      },
    });
    const result = jobs.run(job({ action: "reboot" }));
    await waiting;
    pending = true;
    lease.release();
    expect(await result).toMatchObject({
      succeeded: false,
      outcome: expect.stringContaining("application backup recovery is incomplete"),
    });
    expect(created).toEqual([]);
  });
  it("allows read-only package checks during application recovery", async () => {
    supportedHost();
    const result = await jobsFor({
      helperSays: '{"outcome":"started"}',
      running: [],
      applicationRecoveryPending: () => true,
      unit: { verb: "check", log: CHECK_LOG, status: "success exited 0" },
    }).run(job());
    expect(result.succeeded).toBe(true);
    expect(created).toHaveLength(1);
  });
  it("refuses changes if recovery starts while host support is being inspected", async () => {
    supportedHost();
    let calls = 0;
    const result = await jobsFor({ helperSays: null, running: [], applicationRecoveryPending: () => ++calls > 1 }).run(
      job({ action: "reboot" }),
    );
    expect(result.succeeded).toBe(false);
    expect(calls).toBe(2);
    expect(created).toEqual([]);
  });
  it("refuses host changes while persistent data recovery is pending", async () => {
    supportedHost();
    guard.recoveries = async () => [
      {
        version: 1,
        id: JOB,
        owner: "app",
        phase: "prepared",
        at: null,
        members: [{ name: "app", id: "original", replacementId: "replacement", running: true, restore: true }],
      },
    ];
    expect((await jobsFor({ helperSays: null, running: [] }).run(job({ action: "reboot" }))).outcome).toContain(
      "data recovery for app is incomplete",
    );
    expect(created).toEqual([]);
  });

  it("after a restart, follows the recent runs it finds on the host, and leaves old ones alone", async () => {
    supportedHost();
    leaveRun("upgrade", "Setting up openssl ...\n", "success exited 0");
    utimesSync(join(hostRoot, `var/log/autoheal/${JOB}-upgrade.log`), new Date(NOW), new Date(NOW));
    const old = "11111111-2222-4333-8444-555555555555";
    writeFileSync(join(hostRoot, `var/log/autoheal/${old}-check.log`), "");
    utimesSync(
      join(hostRoot, `var/log/autoheal/${old}-check.log`),
      new Date(NOW - 3 * 3600_000),
      new Date(NOW - 3 * 3600_000),
    );
    writeFileSync(join(hostRoot, "var/log/autoheal/notes.txt"), "");
    const jobs = jobsFor({ helperSays: null, running: [] });

    const runs = await jobs.followable();

    expect(runs.map(({ jobId }) => jobId)).toEqual([JOB]);
    expect(await runs[0]?.result).toMatchObject({
      succeeded: true,
      outcome: "The upgrade finished. The runner restarted while it ran.",
    });
  });
});
