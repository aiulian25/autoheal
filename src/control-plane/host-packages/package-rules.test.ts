import { describe, expect, it } from "vitest";
import type { PackageCheck, PackageFacts } from "../../shared/protocol.js";
import { insideWindow } from "./host-packages-service.js";
import { assess, isSecurityFix, kindOf, planFor } from "./package-rules.js";

const update = (name: string, ...origins: string[]) => ({ name, installed: "1.0", candidate: "1.1", origins });
const dnfUpdate = (name: string, repository: string, security: boolean) => ({
  ...update(name, repository),
  security,
});
const nothingKeepsData = () => false;
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

describe("what kind of package an update is", () => {
  it.each([
    ["docker-ce", ["Docker CE:noble/stable"], "container_runtime"],
    ["containerd.io", ["Ubuntu:24.04/noble-updates"], "container_runtime"],
    ["libc6:i386", ["Ubuntu:24.04/noble-security"], "core_system"],
    ["openssh-server", ["Debian-Security:13/stable-security"], "core_system"],
    ["grafana", ["grafana:stable/main"], "third_party"],
    ["postgresql-17", ["Debian:13.1/stable"], "keeps_data"],
    ["mosquitto", ["Debian:13.1/stable"], "keeps_data"],
    ["linux-image-6.12.57+deb13-amd64", ["Debian-Security:13/stable-security"], "kernel"],
    ["raspi-firmware", ["Raspberry Pi Foundation:trixie/main"], "kernel"],
    ["curl", ["Ubuntu:24.04/noble-updates"], "routine"],
    ["curl", ["updates"], "routine"],
    ["glibc", ["baseos"], "core_system"],
    ["openssl-libs", ["appstream"], "routine"],
    ["kernel-core", ["rhel-9-for-x86_64-baseos-rpms"], "kernel"],
    ["docker-ce", ["docker-ce-stable"], "container_runtime"],
    ["htop", ["epel"], "third_party"],
  ])("%s from %s is %s", (name, origins, kind) => {
    expect(kindOf(update(name, ...origins), nothingKeepsData)).toBe(kind);
  });

  it("takes Ollama's word for a package the lists don't know", () => {
    expect(kindOf(update("bind9", "Debian:13.1/stable"), (name) => name === "bind9")).toBe("keeps_data");
  });

  it("calls a fix security when any of its origins is a security archive", () => {
    expect(isSecurityFix(["Ubuntu:24.04/noble-updates", "Ubuntu:24.04/noble-security"])).toBe(true);
    expect(isSecurityFix(["Debian-Security:13/stable-security"])).toBe(true);
    expect(isSecurityFix(["Debian:13.1/stable"])).toBe(false);
    expect(isSecurityFix(["Vendor:stable"])).toBe(false);
  });
});

describe("where an update comes from", () => {
  it.each([
    [["Ubuntu:24.04/noble-updates"], "noble-updates"],
    [["Ubuntu:24.04/noble-updates", "Ubuntu:24.04/noble-security"], "noble-security"],
    [["Debian-Security:13/stable-security"], "stable-security"],
    [["Raspberry Pi Foundation:trixie/main"], "main"],
    [["Docker CE:noble"], "Docker CE"],
    [["docker-ce-stable"], "docker-ce-stable"],
    [[], null],
  ])("%j is %s", (origins, source) => {
    expect(assess(update("curl", ...origins), nothingKeepsData).source).toBe(source);
  });

  it("keeps what the runner said the package is, and nothing from an older runner", () => {
    const described = { ...update("curl", "Debian:13.1/stable"), summary: "command line tool for transferring data" };
    expect(assess(described, nothingKeepsData).summary).toBe("command line tool for transferring data");
    expect(assess(update("curl", "Debian:13.1/stable"), nothingKeepsData).summary).toBeNull();
  });
});

describe("who takes care of a host's pending packages", () => {
  const check: PackageCheck = {
    refreshed: true,
    refreshProblem: null,
    needsRepair: false,
    upgradable: [
      update("openssl", "Debian-Security:13/stable-security"),
      update("libc6", "Debian-Security:13/stable-security"),
      update("curl", "Debian:13.1/stable"),
      update("acme-vpn", "Acme Security:stable"),
    ],
    keptBack: [],
    removable: [{ name: "linux-image-6.12.48+deb13-amd64", installed: "6.12.48-1" }],
    rebootRequired: null,
  };

  it("gives Autoheal the security fixes nothing holds, and a person the rest", () => {
    const plan = planFor(check, facts(), true, nothingKeepsData);
    expect(plan).toMatchObject({ automatic: ["openssl"], unattended: [], forPerson: ["libc6", "curl", "acme-vpn"] });
  });

  it("gives every distribution security fix to unattended-upgrades where it is on, held or not", () => {
    const plan = planFor(check, facts({ unattendedUpgrades: true }), true, nothingKeepsData);
    expect(plan).toMatchObject({ automatic: [], unattended: ["openssl", "libc6"], forPerson: ["curl", "acme-vpn"] });
  });

  it("passes on what nothing needs any more, and dnf's word on a reboot", () => {
    expect(planFor(check, facts(), true, nothingKeepsData)).toMatchObject({
      removable: [{ name: "linux-image-6.12.48+deb13-amd64", installed: "6.12.48-1" }],
      rebootRequired: false,
    });
    expect(planFor({ ...check, rebootRequired: true }, facts(), true, nothingKeepsData).rebootRequired).toBe(true);
  });

  it("knows dnf's security fixes by their advisories, and leaves them to dnf-automatic where it installs", () => {
    const dnfCheck: PackageCheck = {
      ...check,
      upgradable: [
        dnfUpdate("curl", "updates", true),
        dnfUpdate("vim-enhanced", "updates", false),
        dnfUpdate("docker-ce", "docker-ce-stable", true),
      ],
    };

    expect(planFor(dnfCheck, facts({ manager: "dnf" }), true, nothingKeepsData)).toMatchObject({
      automatic: ["curl"],
      forPerson: ["vim-enhanced", "docker-ce"],
    });
    expect(
      planFor(dnfCheck, facts({ manager: "dnf", unattendedUpgrades: true }), true, nothingKeepsData),
    ).toMatchObject({
      automatic: [],
      unattended: ["curl"],
      forPerson: ["vim-enhanced", "docker-ce"],
    });
  });

  it.each([
    ["the host only allows checks", facts({ setting: "check" }), true],
    ["the owner turned the window off", facts(), false],
    ["the host has not said what it allows", null, true],
  ])("gives Autoheal nothing when %s", (_case, hostFacts, securityInWindow) => {
    expect(planFor(check, hostFacts, securityInWindow, nothingKeepsData).automatic).toEqual([]);
  });
});

describe("a host's nightly window, in its own time zone", () => {
  const window = { securityInWindow: true, windowStart: "03:00", windowEnd: "05:00" };

  it("opens at its start and closes at its end, on the host's clock", () => {
    // 03:30 in London is 02:30 UTC in summer time and 03:30 UTC in winter.
    expect(insideWindow(window, "Europe/Lisbon", Date.UTC(2026, 9, 21, 2, 30))).toBe(true);
    expect(insideWindow(window, "Europe/Lisbon", Date.UTC(2026, 11, 21, 3, 30))).toBe(true);
    expect(insideWindow(window, "Europe/Lisbon", Date.UTC(2026, 9, 21, 4, 0))).toBe(false);
    expect(insideWindow(window, "UTC", Date.UTC(2026, 9, 21, 2, 59))).toBe(false);
    expect(insideWindow(window, "UTC", Date.UTC(2026, 9, 21, 3, 0))).toBe(true);
  });

  it("runs past midnight when it ends before it starts, and never when both are the same", () => {
    const overnight = { ...window, windowStart: "23:00", windowEnd: "01:00" };
    expect(insideWindow(overnight, "UTC", Date.UTC(2026, 9, 21, 23, 30))).toBe(true);
    expect(insideWindow(overnight, "UTC", Date.UTC(2026, 9, 22, 0, 30))).toBe(true);
    expect(insideWindow(overnight, "UTC", Date.UTC(2026, 9, 22, 1, 30))).toBe(false);
    expect(insideWindow({ ...window, windowEnd: "03:00" }, "UTC", Date.UTC(2026, 9, 21, 3, 0))).toBe(false);
  });
});
