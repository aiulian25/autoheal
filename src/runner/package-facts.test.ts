import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPackageFacts } from "./package-facts.js";

const NOW = Date.UTC(2026, 9, 22, 8, 0, 0);
const RUNNING = "6.8.0-45-generic";

describe("what a host's own files say about its packages", () => {
  let hostRoot: string;

  const write = (path: string, content = "") => {
    mkdirSync(dirname(join(hostRoot, path)), { recursive: true });
    writeFileSync(join(hostRoot, path), content);
  };
  const directory = (path: string) => mkdirSync(join(hostRoot, path), { recursive: true });
  const facts = (runningKernel = RUNNING) => readPackageFacts({ hostRoot, setting: "apply", runningKernel }, NOW);
  // A Debian or Ubuntu host booted by systemd, with its D-Bus.
  const supportedHost = () => {
    write("usr/bin/apt-get");
    directory("run/systemd/system");
    write("run/dbus/system_bus_socket");
  };

  beforeEach(() => {
    hostRoot = mkdtempSync(join(tmpdir(), "autoheal-packages-"));
  });

  afterEach(() => {
    rmSync(hostRoot, { recursive: true, force: true });
  });

  it("finds a supported host, and passes on what its .env allows", async () => {
    supportedHost();
    expect(await facts()).toMatchObject({ setting: "apply", unsupported: null, manager: "apt" });
  });

  it("finds dnf on Fedora and the RHEL family, even through a link that points at an absolute path", async () => {
    directory("run/systemd/system");
    write("run/dbus/system_bus_socket");
    directory("usr/bin");
    symlinkSync("/usr/bin/dnf5", join(hostRoot, "usr/bin/dnf"));
    write("etc/os-release", 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=42\n');

    expect(await facts()).toMatchObject({
      unsupported: null,
      manager: "dnf",
      release: { id: "fedora", versionId: "42" },
      proxmox: false,
    });
  });

  it("knows a Proxmox VE node, whose os-release says Debian", async () => {
    supportedHost();
    write("etc/os-release", 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n');
    write("usr/bin/pveversion");

    expect(await facts()).toMatchObject({ release: { id: "debian", versionId: "12" }, proxmox: true });
  });

  it("knows dnf-automatic installs by itself from its timer, or its plain timer with apply_updates", async () => {
    write("usr/bin/dnf");
    const timers = "etc/systemd/system/timers.target.wants";
    directory(timers);
    symlinkSync("/usr/lib/systemd/system/dnf-automatic.timer", join(hostRoot, timers, "dnf-automatic.timer"));
    write("etc/dnf/automatic.conf", "[commands]\napply_updates = no\n");
    expect((await facts()).unattendedUpgrades).toBe(false);

    write("etc/dnf/automatic.conf", "[commands]\nupgrade_type = security\napply_updates = yes\n");
    expect((await facts()).unattendedUpgrades).toBe(true);

    write("etc/dnf/automatic.conf", "");
    symlinkSync(
      "/usr/lib/systemd/system/dnf-automatic-install.timer",
      join(hostRoot, timers, "dnf-automatic-install.timer"),
    );
    expect((await facts()).unattendedUpgrades).toBe(true);
  });

  it.each([
    ["apt or dnf", () => undefined, "no_package_manager"],
    ["systemd", () => write("usr/bin/apt-get"), "no_systemd"],
    [
      "the D-Bus socket",
      () => {
        write("usr/bin/apt-get");
        directory("run/systemd/system");
      },
      "no_dbus",
    ],
  ])("says why not on a host without %s", async (_missing, prepare, reason) => {
    prepare();
    expect((await facts()).unsupported).toBe(reason);
  });

  it("knows unattended-upgrades is on only when installed and apt says so, the last file winning", async () => {
    write(
      "etc/apt/apt.conf.d/20auto-upgrades",
      'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
    );
    expect((await facts()).unattendedUpgrades).toBe(false);

    write("usr/bin/unattended-upgrade");
    expect((await facts()).unattendedUpgrades).toBe(true);

    write("etc/apt/apt.conf.d/99-owner", 'APT::Periodic::Unattended-Upgrade "0";\n');
    expect((await facts()).unattendedUpgrades).toBe(false);
  });

  it("lists the packages a reboot waits for, without junk or repeats", async () => {
    write("run/reboot-required.pkgs", "linux-base\nlibc6\nlinux-base\n$(reboot)\n\n");
    expect((await facts()).rebootPackages).toEqual(["linux-base", "libc6"]);
  });

  it("sees a newer kernel of the same flavour waiting for the next boot", async () => {
    for (const kernel of [RUNNING, "6.8.0-40-generic", "6.8.0-47-generic", "6.8.0-50-lowlatency"]) {
      directory(`usr/lib/modules/${kernel}`);
    }
    expect((await facts()).kernelWaiting).toBe("6.8.0-47-generic");
  });

  it("sees Debian's and the Raspberry Pi's kernel names too, and nothing when the newest runs", async () => {
    directory("lib/modules/6.12.48+deb13-amd64");
    directory("lib/modules/6.12.57+deb13-amd64");
    expect((await facts("6.12.48+deb13-amd64")).kernelWaiting).toBe("6.12.57+deb13-amd64");
    expect((await facts("6.12.57+deb13-amd64")).kernelWaiting).toBeNull();

    directory("usr/lib/modules/6.12.25+rpt-rpi-v8");
    expect((await facts("6.6.51+rpt-rpi-v8")).kernelWaiting).toBe("6.12.25+rpt-rpi-v8");
  });

  it("sees RPM's kernel names, whose release changes with each build", async () => {
    directory("usr/lib/modules/5.14.0-570.12.1.el9_6.x86_64");
    directory("usr/lib/modules/5.14.0-570.17.1.el9_6.x86_64");
    directory("usr/lib/modules/5.14.0-570.17.1.el9_6.x86_64+debug");
    expect((await facts("5.14.0-570.12.1.el9_6.x86_64")).kernelWaiting).toBe("5.14.0-570.17.1.el9_6.x86_64");
  });

  it("takes the host's time zone from /etc/timezone, else from where /etc/localtime points", async () => {
    mkdirSync(join(hostRoot, "etc"));
    symlinkSync("/usr/share/zoneinfo/Europe/Berlin", join(hostRoot, "etc/localtime"));
    expect((await facts()).timeZone).toBe("Europe/Berlin");

    write("etc/timezone", "Europe/Lisbon\n");
    expect((await facts()).timeZone).toBe("Europe/Lisbon");

    write("etc/timezone", "Not/AZone\n");
    expect((await facts()).timeZone).toBe("Europe/Berlin");
  });

  it("reads what apt changed, in the host's time zone", async () => {
    write("etc/timezone", "Europe/Lisbon\n");
    write(
      "var/log/apt/history.log",
      "\nStart-Date: 2026-10-21  06:25:31\nCommandline: /usr/bin/unattended-upgrade\n" +
        "Upgrade: openssl:amd64 (3.0.13-0ubuntu3.4, 3.0.13-0ubuntu3.5)\nEnd-Date: 2026-10-21  06:25:40\n",
    );
    expect((await facts()).recentChanges).toEqual([
      {
        endedAt: Date.UTC(2026, 9, 21, 5, 25, 40),
        byUnattendedUpgrades: true,
        upgraded: [{ name: "openssl", version: "3.0.13-0ubuntu3.5" }],
        upgradedCount: 1,
        installed: [],
        removed: [],
      },
    ]);
  });

  it("says nothing it cannot know on a bare host", async () => {
    expect(await facts()).toEqual({
      setting: "apply",
      unsupported: "no_package_manager",
      manager: null,
      release: null,
      proxmox: false,
      unattendedUpgrades: false,
      rebootPackages: [],
      kernelWaiting: null,
      timeZone: null,
      recentChanges: [],
    });
  });
});
