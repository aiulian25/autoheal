import { describe, expect, it } from "vitest";
import {
  HOST_PACKAGE_CHECK_SCRIPTS,
  HOST_PACKAGE_ENVIRONMENT,
  HOST_PACKAGE_REBOOT_SCRIPT,
  HOST_PACKAGE_STATUS_SCRIPT,
  HOST_PACKAGE_TIMEOUT_MICROSECONDS,
  HOST_PACKAGE_WRAPPER,
  SYSTEMD,
} from "../shared/constants.js";
import { packageUnit, verbFits } from "./package-units.js";

const JOB = "0b8c3c5e-6a52-4f7e-9d3c-2f6d7a1b9e10";
const LOG = `/var/log/autoheal/${JOB}-check.log`;
const STATUS = `/var/log/autoheal/${JOB}-check.status`;

const propertiesOf = (unit: ReturnType<typeof packageUnit>) =>
  Object.fromEntries(unit.map(({ name, value }) => [name, value.value]));
// What follows the log file in the wrapper's arguments: the command it runs.
function commandOf(unit: ReturnType<typeof packageUnit>) {
  const [[, argv]] = propertiesOf(unit)[SYSTEMD.properties.execStart] as [[string, string[], boolean]];
  return argv.slice(argv.findIndex((argument) => argument.startsWith("/var/log/autoheal/")) + 1);
}

// Every command line a unit hands systemd, for each package manager and each of its verbs.
const commandLinesOf = (unit: ReturnType<typeof packageUnit>) =>
  unit
    .map(({ value }) => value.value)
    .filter(Array.isArray)
    .flatMap((commands) => (commands as [string, string[], boolean][]).flatMap(([path, argv]) => [path, ...argv]));

describe("the transient unit for a package job", () => {
  it("hands systemd nothing it would fill in itself: ${…} reaches a unit's command as systemd's own variable", () => {
    const managers = ["apt", "dnf"] as const;
    const verbs = ["check", "upgrade", "repair", "autoremove", "reboot"] as const;
    const lines = managers.flatMap((manager) =>
      verbs
        .filter((verb) => verbFits(manager, verb))
        .flatMap((verb) => commandLinesOf(packageUnit(manager, verb, JOB, ["openssl"]))),
    );

    expect(lines).toContain(HOST_PACKAGE_CHECK_SCRIPTS.apt);
    expect(lines.filter((line) => line.includes("${"))).toEqual([]);
  });

  it("runs once, goes away when it ends, never asks a question, and stops after its time", () => {
    const properties = propertiesOf(packageUnit("apt", "check", JOB, []));

    expect(properties[SYSTEMD.properties.type]).toBe("oneshot");
    expect(properties[SYSTEMD.properties.collectMode]).toBe("inactive-or-failed");
    expect(properties[SYSTEMD.properties.environment]).toEqual([...HOST_PACKAGE_ENVIRONMENT]);
    expect(properties[SYSTEMD.properties.environment]).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(properties[SYSTEMD.properties.environment]).toContain("LC_ALL=C.UTF-8");
    expect(properties[SYSTEMD.properties.timeout]).toBe(HOST_PACKAGE_TIMEOUT_MICROSECONDS.check);
    expect(properties[SYSTEMD.properties.description]).toContain(JOB);
  });

  it("writes the job's output to its log, and its result to its status file", () => {
    const properties = propertiesOf(packageUnit("apt", "check", JOB, []));

    expect(properties[SYSTEMD.properties.execStart]).toEqual([
      [
        "/bin/sh",
        ["sh", "-c", HOST_PACKAGE_WRAPPER, "autoheal", LOG, "/bin/sh", "-c", HOST_PACKAGE_CHECK_SCRIPTS.apt],
        false,
      ],
    ]);
    expect(properties[SYSTEMD.properties.execStopPost]).toEqual([
      ["/bin/sh", ["sh", "-c", HOST_PACKAGE_STATUS_SCRIPT, "autoheal", STATUS], false],
    ]);
  });

  it("upgrades only the named packages, keeping config files their owner changed", () => {
    expect(commandOf(packageUnit("apt", "upgrade", JOB, ["openssl", "libc6:i386"]))).toEqual([
      "/usr/bin/apt-get",
      "-q",
      "-y",
      "-o",
      "DPkg::Lock::Timeout=60",
      "-o",
      "Dpkg::Options::=--force-confdef",
      "-o",
      "Dpkg::Options::=--force-confold",
      "install",
      "--only-upgrade",
      "openssl",
      "libc6:i386",
    ]);
  });

  it("finishes what an interrupted dpkg left half-done, keeping changed config files too", () => {
    const unit = packageUnit("apt", "repair", JOB, []);

    expect(commandOf(unit)).toEqual(["/usr/bin/dpkg", "--force-confdef", "--force-confold", "--configure", "-a"]);
    expect(propertiesOf(unit)[SYSTEMD.properties.timeout]).toBe(HOST_PACKAGE_TIMEOUT_MICROSECONDS.repair);
  });

  it("speaks dnf on a dnf host, where there is nothing to repair", () => {
    expect(commandOf(packageUnit("dnf", "upgrade", JOB, ["openssl-libs", "NetworkManager"]))).toEqual([
      "/usr/bin/dnf",
      "-y",
      "upgrade",
      "openssl-libs",
      "NetworkManager",
    ]);
    expect(commandOf(packageUnit("dnf", "check", JOB, []))).toEqual(["/bin/sh", "-c", HOST_PACKAGE_CHECK_SCRIPTS.dnf]);
    expect(verbFits("dnf", "repair")).toBe(false);
    expect(() => packageUnit("dnf", "repair", JOB, [])).toThrow(/dnf has no repair/);
  });

  it("removes what nothing needs any more, old kernels included", () => {
    expect(commandOf(packageUnit("apt", "autoremove", JOB, []))).toEqual([
      "/usr/bin/apt-get",
      "-q",
      "-y",
      "-o",
      "DPkg::Lock::Timeout=60",
      "autoremove",
    ]);
    expect(commandOf(packageUnit("dnf", "autoremove", JOB, []))).toEqual(["/usr/bin/dnf", "-y", "autoremove"]);
  });

  it("reboots through its own script, which asks Proxmox about backups first", () => {
    expect(commandOf(packageUnit("apt", "reboot", JOB, []))).toEqual(["/bin/sh", "-c", HOST_PACKAGE_REBOOT_SCRIPT]);
    expect(HOST_PACKAGE_REBOOT_SCRIPT).toMatch(/--typefilter vzdump[\s\S]*systemctl reboot$/);
  });

  it("keeps the command out of the wrapper script, so nothing a job names can become shell code", () => {
    expect(HOST_PACKAGE_WRAPPER).toContain('exec "$@"');
    expect(HOST_PACKAGE_WRAPPER).not.toMatch(/apt|dpkg/);
  });
});
