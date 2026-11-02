import { describe, expect, it } from "vitest";
import { parseCheck, problemIn } from "./package-check.js";

// A check on the test host (test/fixtures/host-packages), as its log came out.
const CHECK_LOG = `== dpkg-audit
== exit 0
== refresh
Get:4 file:/srv/repositories/debian ./ Release [876 B]
Get:8 file:/srv/repositories/debian ./ Packages [2025 B]
Reading package lists...
== exit 0
== upgrade
Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages have been kept back:
  autoheal-kept-back
The following packages will be upgraded:
  autoheal-config autoheal-routine autoheal-security autoheal-vendor
  containerd.io
5 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.
Inst autoheal-config [1.0] (1.1 Debian:stable [all])
Inst autoheal-routine [1.0] (1.1 Debian:stable [all])
Inst autoheal-security [1.0] (1.1 Debian-Security:stable-security [all])
Inst autoheal-vendor [1.0] (1.1 Vendor:stable [all])
Inst containerd.io [1.0] (1.1 Vendor:stable [all])
Conf autoheal-config (1.1 Debian:stable [all])
Conf autoheal-routine (1.1 Debian:stable [all])
== exit 0
== dist-upgrade
Calculating upgrade...
6 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.
Inst autoheal-config [1.0] (1.1 Debian:stable [all])
Inst autoheal-new-dependency (1.0 Debian:stable [all])
Inst autoheal-kept-back [1.0] (2.0 Debian:stable [all])
Inst autoheal-routine [1.0] (1.1 Debian:stable [all])
Inst autoheal-security [1.0] (1.1 Debian-Security:stable-security [all])
Inst autoheal-vendor [1.0] (1.1 Vendor:stable [all])
Inst containerd.io [1.0] (1.1 Vendor:stable [all])
== exit 0
== autoremove
Reading package lists...
The following packages will be REMOVED:
  autoheal-orphan
0 upgraded, 0 newly installed, 1 to remove and 6 not upgraded.
Remv autoheal-orphan [1.0]
== exit 0
`;

describe("a package check's log", () => {
  it("gives what an upgrade would change, with where each candidate comes from, and what it keeps back", () => {
    const check = parseCheck("apt", CHECK_LOG);

    expect(check).toMatchObject({ refreshed: true, refreshProblem: null, needsRepair: false });
    expect(check.upgradable.map(({ name }) => name)).toEqual([
      "autoheal-config",
      "autoheal-routine",
      "autoheal-security",
      "autoheal-vendor",
      "containerd.io",
    ]);
    expect(check.upgradable[2]).toEqual({
      name: "autoheal-security",
      installed: "1.0",
      candidate: "1.1",
      origins: ["Debian-Security:stable-security"],
    });
    // The new dependency is not an upgrade of anything installed.
    expect(check.keptBack).toEqual([
      { name: "autoheal-kept-back", installed: "1.0", candidate: "2.0", origins: ["Debian:stable"] },
    ]);
    expect(check.removable).toEqual([{ name: "autoheal-orphan", installed: "1.0" }]);
    expect(check.rebootRequired).toBeNull();
  });

  it("keeps every origin apt names, so a fix in both -updates and -security shows as security", () => {
    const log = `== upgrade
Inst curl [8.5.0-2ubuntu10.4] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
== exit 0
`;
    expect(parseCheck("apt", log).upgradable[0]?.origins).toEqual([
      "Ubuntu:24.04/noble-updates",
      "Ubuntu:24.04/noble-security",
    ]);
  });

  it("says what each package is, by the installed one's own summary", () => {
    const log = `== upgrade
Inst curl [8.5.0-2ubuntu10.4] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates [amd64])
Inst libc6:i386 [2.39-0ubuntu8.3] (2.39-0ubuntu8.4 Ubuntu:24.04/noble-updates [i386])
Inst unknown [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])
== exit 0
== dist-upgrade
Inst curl [8.5.0-2ubuntu10.4] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates [amd64])
Inst libc6:i386 [2.39-0ubuntu8.3] (2.39-0ubuntu8.4 Ubuntu:24.04/noble-updates [i386])
Inst linux-generic [6.8.0-85.85] (6.8.0-90.90 Ubuntu:24.04/noble-updates [amd64])
== exit 0
== summaries
curl command line tool for transferring data with URL syntax
libc6 GNU C Library: Shared libraries
linux-generic Complete Generic Linux kernel and headers
dpkg-query: no packages found matching linux-image-6.8.0-90-generic
== exit 123
`;
    const check = parseCheck("apt", log);

    expect(check.upgradable.map(({ summary }) => summary)).toEqual([
      "command line tool for transferring data with URL syntax",
      "GNU C Library: Shared libraries",
      undefined,
    ]);
    expect(check.keptBack[0]?.summary).toBe("Complete Generic Linux kernel and headers");
  });

  it("says when dpkg was left half-done", () => {
    const log = `== dpkg-audit
The following packages have been unpacked but not yet configured.
 autoheal-half-done   Autoheal test package
== exit 0
`;
    expect(parseCheck("apt", log).needsRepair).toBe(true);
  });

  it("says why the lists could not be refreshed, in apt's own words", () => {
    const log = `== refresh
Err:1 http://deb.debian.org/debian trixie InRelease
  Temporary failure resolving 'deb.debian.org'
Reading package lists...
E: Could not get lock /var/lib/apt/lists/lock. It is held by process 4242 (apt-get)
== exit 100
== upgrade
Inst curl [8.14.1-2] (8.14.1-2+deb13u1 Debian-Security:13/stable-security [amd64])
== exit 0
`;
    const check = parseCheck("apt", log);

    expect(check.refreshed).toBe(false);
    expect(check.refreshProblem).toBe(
      "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 4242 (apt-get)",
    );
    expect(check.upgradable).toHaveLength(1);
  });

  it("drops what isn't a package line, and names that could be anything else", () => {
    const log = `== upgrade
Inst $(reboot) [1.0] (1.1 Debian:stable [all])
Inst ok [1.0] (1.1 Debian:stable [all])
Inst also-ok [1.0;rm] (1.1 Debian:stable [all])
nonsense
== exit 0
`;
    expect(parseCheck("apt", log).upgradable.map(({ name }) => name)).toEqual(["ok"]);
  });

  it("knows nothing from an empty or cut-off log", () => {
    const nothing = {
      refreshed: false,
      refreshProblem: null,
      needsRepair: false,
      upgradable: [],
      keptBack: [],
      removable: [],
      rebootRequired: null,
    };
    expect(parseCheck("apt", "")).toEqual(nothing);
    expect(parseCheck("dnf", "")).toEqual(nothing);
  });
});

// A check on a Fedora host as dnf5 prints it; dnf4 adds a blank line after each repoquery line.
const DNF_CHECK_LOG = `== refresh
== exit 0
== installed
kernel-core 6.17.4-200.fc42 x86_64
kernel-core 6.17.5-200.fc42 x86_64
glibc 2.41-5.fc42 x86_64
glibc 2.41-5.fc42 i686
openssl-libs 1:3.2.4-3.fc42 x86_64
docker-ce 3:28.5.0-1.fc42 x86_64
autoheal-orphan 1.0-1 noarch
gpg-pubkey 5323552a-6112bcdc (none)
== exit 0
== upgrades
kernel-core 6.17.6-200.fc42 x86_64 updates

glibc 2.41-7.fc42 x86_64 updates
glibc 2.41-7.fc42 i686 updates
openssl-libs 1:3.2.4-4.fc42 x86_64 updates
openssl-libs 1:3.2.4-3.fc42 x86_64 fedora
docker-ce 3:28.5.1-1.fc42 x86_64 docker-ce-stable
not-installed 1.0-1 noarch updates
Updating and loading repositories:
== exit 0
== security
openssl-libs
== exit 0
== unneeded
autoheal-orphan 1.0-1
== exit 0
== summaries
kernel-core The Linux kernel

glibc The GNU libc libraries
glibc The GNU libc libraries
openssl-libs A general purpose cryptography library with TLS implementation
docker-ce The open-source application container engine
== exit 0
== reboot
Core libraries or services have been updated since boot-up:
  * kernel

Reboot is required to fully utilize these updates.
More information: https://access.redhat.com/solutions/27943
== exit 1
`;

describe("a dnf check's log", () => {
  it("gives each upgrade once, from its newest installed version, with its repository and advisories", () => {
    const check = parseCheck("dnf", DNF_CHECK_LOG);

    expect(check).toMatchObject({ refreshed: true, refreshProblem: null, needsRepair: false, keptBack: [] });
    expect(check.upgradable).toEqual([
      {
        name: "kernel-core",
        installed: "6.17.5-200.fc42",
        candidate: "6.17.6-200.fc42",
        origins: ["updates"],
        security: false,
        summary: "The Linux kernel",
      },
      {
        name: "glibc",
        installed: "2.41-5.fc42",
        candidate: "2.41-7.fc42",
        origins: ["updates"],
        security: false,
        summary: "The GNU libc libraries",
      },
      {
        name: "openssl-libs",
        installed: "1:3.2.4-3.fc42",
        candidate: "1:3.2.4-4.fc42",
        origins: ["updates"],
        security: true,
        summary: "A general purpose cryptography library with TLS implementation",
      },
      {
        name: "docker-ce",
        installed: "3:28.5.0-1.fc42",
        candidate: "3:28.5.1-1.fc42",
        origins: ["docker-ce-stable"],
        security: false,
        summary: "The open-source application container engine",
      },
    ]);
    expect(check.removable).toEqual([{ name: "autoheal-orphan", installed: "1.0-1" }]);
    expect(check.rebootRequired).toBe(true);
  });

  it("takes a reboot as needed only when dnf says so in words, not from its exit alone", () => {
    const check = (lines: string, exit: number) =>
      parseCheck("dnf", `== reboot\n${lines}\n== exit ${exit}\n`).rebootRequired;

    expect(check("No core libraries or services have been updated since boot-up.", 0)).toBe(false);
    expect(check("No such command: needs-restarting. Please use /usr/bin/dnf --help", 1)).toBeNull();
    expect(check('Unknown argument "needs-restarting" for command "dnf5".', 2)).toBeNull();
  });

  it("says why the metadata could not be refreshed, in dnf's own words", () => {
    const log = `== refresh
Errors during downloading metadata for repository 'updates':
  - Curl error (6): Could not resolve hostname
Error: Failed to download metadata for repo 'updates': Cannot download repomd.xml
== exit 1
`;
    expect(parseCheck("dnf", log).refreshProblem).toBe(
      "Error: Failed to download metadata for repo 'updates': Cannot download repomd.xml",
    );
  });
});

describe("what went wrong", () => {
  it("is the last error line, else the last line", () => {
    expect(problemIn("E: first\nE: second\nN: a note\n")).toBe("E: second");
    expect(problemIn("working\nNot rebooting: a Proxmox backup is running on this node.\n")).toBe(
      "Not rebooting: a Proxmox backup is running on this node.",
    );
    expect(problemIn("")).toBe("");
  });
});
