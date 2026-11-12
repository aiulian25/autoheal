import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageCommand } from "../../host-helper/package-units.js";
import {
  HOST_HELPER_OUTCOME,
  HOST_PACKAGE_ENVIRONMENT,
  HOST_PACKAGE_LOG_DIRECTORY,
  HOST_PACKAGE_LOG_FILE,
  HOST_PACKAGE_STATUS_FILE,
  HOST_PACKAGE_UNIT,
  HOST_PACKAGE_UNIT_DESCRIPTION,
  HOST_PACKAGE_WRAPPER,
  SSH_PACKAGE_RUNS,
  type HostPackageManager,
  type HostPackageVerb,
} from "../../shared/constants.js";
import { packageUnitCommand, sshPackageUnits } from "./ssh-package-units.js";

const JOB = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const MODE_BITS = 0o777;
const OWNER_ONLY = 0o600;

describe("a package job started as root over SSH", () => {
  let root: string;
  // The host's own folders, moved under a test directory: nothing here touches this machine's.
  const moved = (text: string) =>
    text
      .replaceAll(SSH_PACKAGE_RUNS.directory, `${root}${SSH_PACKAGE_RUNS.directory}`)
      .replaceAll(HOST_PACKAGE_LOG_DIRECTORY, `${root}${HOST_PACKAGE_LOG_DIRECTORY}`);
  // What sh hands a command: each argument whole, NUL-separated, quotes and all taken as the shell takes them.
  const argumentsOf = (script: string) =>
    spawnSync("sh", ["-c", script.replace(/^exec /, `printf '%s\\0' `)], { encoding: "utf8" })
      .stdout.split("\0")
      .slice(0, -1);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-ssh-units-"));
    mkdirSync(join(root, "bin"));
    // systemd-run as a recorder of what it was asked: the unit itself is not started here.
    writeFileSync(join(root, "bin", "systemd-run"), `#!/bin/sh\nprintf '%s\\0' "$@" > "${root}/systemd-run.args"\n`);
    chmodSync(join(root, "bin", "systemd-run"), 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const start = (manager: HostPackageManager, verb: HostPackageVerb, packages: readonly string[]) => {
    const ran = spawnSync("sh", ["-c", moved(packageUnitCommand(manager, verb, JOB, packages))], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
    });
    expect(ran.status, ran.stderr).toBe(0);
    return {
      systemdRun: readFileSync(join(root, "systemd-run.args"), "utf8").split("\0").slice(0, -1),
      runPath: moved(SSH_PACKAGE_RUNS.runScript(JOB)),
      statusPath: moved(SSH_PACKAGE_RUNS.statusScript(JOB)),
    };
  };

  it.each([
    ["apt", "upgrade", ["openssl", "libssl3"]],
    // dnf's check carries rpm's %{NAME} formats and its own $variables: neither may be touched on the way.
    ["dnf", "check", []],
    ["apt", "shutdown", []],
  ] as const)("starts %s %s as the helper's unit would run it, every argument whole", (manager, verb, packages) => {
    const { systemdRun, runPath, statusPath } = start(manager, verb, packages);
    expect(systemdRun).toEqual([
      // Back once queued: a check outlives the root command's time otherwise.
      "--no-block",
      `--unit=${HOST_PACKAGE_UNIT}`,
      `--description=${HOST_PACKAGE_UNIT_DESCRIPTION(verb, JOB)}`,
      "--property=Type=oneshot",
      "--property=CollectMode=inactive-or-failed",
      expect.stringMatching(/^--property=TimeoutStartSec=\d+us$/),
      ...HOST_PACKAGE_ENVIRONMENT.map((setting) => `--setenv=${setting}`),
      `--property=ExecStopPost=/bin/sh ${statusPath}`,
      "--",
      "/bin/sh",
      runPath,
    ]);
    // Only root reads the scripts.
    expect(statSync(runPath).mode & MODE_BITS).toBe(OWNER_ONLY);
    expect(argumentsOf(readFileSync(runPath, "utf8"))).toEqual([
      "/bin/sh",
      "-c",
      moved(HOST_PACKAGE_WRAPPER),
      "autoheal",
      moved(HOST_PACKAGE_LOG_FILE(JOB, verb)),
      ...packageCommand(manager, verb, packages),
    ]);
  });

  it("leaves the status line the runner follows when the unit stops, and its scripts go", () => {
    const { statusPath, runPath } = start("apt", "check", []);
    mkdirSync(`${root}${HOST_PACKAGE_LOG_DIRECTORY}`, { recursive: true });
    // As systemd runs ExecStopPost: with the unit's result in the environment.
    const stopped = spawnSync("/bin/sh", [statusPath], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" },
    });
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(readFileSync(moved(HOST_PACKAGE_STATUS_FILE(JOB, "check")), "utf8")).toBe("success exited 0\n");
    expect([existsSync(runPath), existsSync(statusPath)]).toEqual([false, false]);
  });

  describe("a start systemd refuses", () => {
    const REFUSED = ["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"];
    const BUSY = "Failed to start transient service unit: Unit autoheal-packages.service was already loaded";
    const attempt = (jobId: string) =>
      spawnSync("sh", ["-c", moved(packageUnitCommand("apt", "check", jobId, []))], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
      });
    const scriptsOf = (jobId: string) =>
      [SSH_PACKAGE_RUNS.runScript(jobId), SSH_PACKAGE_RUNS.statusScript(jobId)].map((path) => existsSync(moved(path)));

    it("leaves nothing of a job it refused, and the scripts of the one that runs, saying why as it said", () => {
      start("apt", "check", []);
      writeFileSync(join(root, "bin", "systemd-run"), `#!/bin/sh\necho '${BUSY}' >&2\nexit 1\n`);
      for (const jobId of REFUSED) {
        const refused = attempt(jobId);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("already loaded");
        expect(scriptsOf(jobId)).toEqual([false, false]);
      }
      expect(scriptsOf(JOB)).toEqual([true, true]);
    });

    it("leaves nothing of a job whose scripts could not all be written, starting nothing", () => {
      mkdirSync(moved(SSH_PACKAGE_RUNS.statusScript(REFUSED[0]!)), { recursive: true });
      expect(attempt(REFUSED[0]!).status).not.toBe(0);
      expect(existsSync(moved(SSH_PACKAGE_RUNS.runScript(REFUSED[0]!)))).toBe(false);
      expect(existsSync(join(root, "systemd-run.args"))).toBe(false);
    });
  });

  it("says started, busy while another run goes on, or failed with what the host said", async () => {
    const answering = (exitCode: number, stderr: string) =>
      sshPackageUnits(async () => ({ stdout: "", stderr, exitCode }));
    expect(await answering(0, "")("apt", "check", JOB, [])).toEqual({ outcome: HOST_HELPER_OUTCOME.started });
    expect(
      await answering(1, "Failed to start transient service unit: Unit autoheal-packages.service was already loaded")(
        "apt",
        "check",
        JOB,
        [],
      ),
    ).toEqual({ outcome: HOST_HELPER_OUTCOME.busy });
    expect(await answering(1, "sudo: a password is required")("apt", "check", JOB, [])).toEqual({
      outcome: HOST_HELPER_OUTCOME.failed,
      reason: "sudo: a password is required",
    });
    const unreachable = sshPackageUnits(async () => {
      throw new Error("the SSH session is unreachable, not connected");
    });
    expect(await unreachable("apt", "check", JOB, [])).toEqual({
      outcome: HOST_HELPER_OUTCOME.failed,
      reason: "the SSH session is unreachable, not connected",
    });
  });
});
