import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { machine, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageStoreOf, readHostHealth } from "./host-health.js";

const KIBIBYTE = 1024;
const BOOT_ID = "8c2f3c1e-5b7a-4d36-9e0f-1a2b3c4d5e6f";

describe("readHostHealth", () => {
  let procRoot: string;
  let hostRoot: string;

  const write = (root: string, path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  beforeEach(() => {
    procRoot = mkdtempSync(join(tmpdir(), "autoheal-proc-"));
    hostRoot = mkdtempSync(join(tmpdir(), "autoheal-host-"));
    write(procRoot, "loadavg", "0.52 0.41 0.30 2/1234 56789\n");
    write(
      procRoot,
      "meminfo",
      "MemTotal:       16384000 kB\nMemFree:         1024000 kB\nMemAvailable:    8192000 kB\n",
    );
    write(procRoot, "uptime", "86400.25 345600.10\n");
    write(procRoot, "sys/kernel/random/boot_id", `${BOOT_ID}\n`);
    write(hostRoot, "etc/os-release", 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\n');
  });

  afterEach(() => {
    rmSync(procRoot, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  });

  it("reads load, memory and uptime from /proc, and the rest from the mounted host", async () => {
    write(hostRoot, "run/reboot-required", "*** System restart required ***\n");
    write(hostRoot, "var/lib/update-notifier/updates-available", "\n12 updates can be applied immediately.\n");
    const health = await readHostHealth({ hostRoot, filesystems: ["/"], procRoot, packages: "check" });
    expect(health).toMatchObject({
      loadAverage: [0.52, 0.41, 0.3],
      memoryTotalBytes: 16384000 * KIBIBYTE,
      memoryAvailableBytes: 8192000 * KIBIBYTE,
      uptimeSeconds: 86400.25,
      rebootRequired: true,
      pendingUpdates: 12,
      operatingSystem: "Ubuntu 24.04.3 LTS",
      bootId: BOOT_ID,
      packages: { setting: "check", unsupported: "no_package_manager" },
    });
    expect(health.cpuCount).toBeGreaterThan(0);
    expect(health.kernel.length).toBeGreaterThan(0);
    const [disk] = health.disks;
    expect(disk).toMatchObject({ path: "/" });
    expect(disk!.totalBytes).toBeGreaterThan(0);
    expect(disk!.usedBytes + disk!.availableBytes).toBeLessThanOrEqual(disk!.totalBytes);
  });

  it("says nothing it cannot know: no reboot flag file, no update-notifier, a filesystem that is not there", async () => {
    const health = await readHostHealth({
      hostRoot,
      filesystems: ["/", "/mnt/missing-disk"],
      procRoot,
      packages: "off",
    });
    expect(health).toMatchObject({ rebootRequired: false, pendingUpdates: null });
    expect(health.disks.map((disk) => disk.path)).toEqual(["/"]);
  });

  it("names the host, its processor and how many processes it runs", async () => {
    write(hostRoot, "etc/hostname", "alex-Alder\n");
    write(procRoot, "cpuinfo", "processor\t: 0\nmodel name\t: Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz\n");
    for (const process of ["1", "42", "self"]) {
      mkdirSync(join(hostRoot, "proc", process), { recursive: true });
    }
    const sysRoot = join(procRoot, "sys");
    const health = await readHostHealth({ hostRoot, filesystems: ["/"], procRoot, sysRoot, packages: "off" });

    expect(health).toMatchObject({
      hostname: "alex-Alder",
      architecture: machine(),
      cpuModel: "Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz",
      processes: 2,
      driveTemperatures: [],
      address: null,
      cpuTemperatures: [],
    });
  });

  it("gives its address, each core's temperature and its SATA drives' as smartd last read them", async () => {
    write(
      hostRoot,
      "proc/1/net/route",
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n" +
        "eno1\t00000000\t010AA8C0\t0003\t0\t0\t0\t00000000\n" +
        "eno1\t000AA8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\n",
    );
    write(hostRoot, "proc/1/net/fib_trie", "Local:\n  |-- 192.168.10.178\n     /32 host LOCAL\n");
    const sysRoot = join(procRoot, "sys");
    const coretemp = "class/hwmon/hwmon3";
    write(sysRoot, `${coretemp}/name`, "coretemp\n");
    const readings = [
      ["1", "Package id 0", "47000"],
      ["2", "Core 0", "44000"],
      ["6", "Core 4", "43000"],
      ["10", "Core 8", "45000"],
    ];
    for (const [index, label, millidegrees] of readings) {
      write(sysRoot, `${coretemp}/temp${index}_label`, `${label}\n`);
      write(sysRoot, `${coretemp}/temp${index}_input`, `${millidegrees}\n`);
    }
    const state = (raw: string) =>
      `# smartd state file\nata-smart-attribute.12.id = 193\nata-smart-attribute.12.raw = 5768\n` +
      `ata-smart-attribute.13.id = 194\nata-smart-attribute.13.val = 31\nata-smart-attribute.13.raw = ${raw}\n`;
    write(hostRoot, "var/lib/smartmontools/smartd.WDC_WD180EMFZ_11AFXA0-3WHE12GJ.ata.state", state("292058628141"));
    write(hostRoot, "var/lib/smartmontools/smartd.WDC_WD180EMFZ_11AFXA0-3WHE12GJ.ata.state~", state("1"));
    // A drive smartd knows that is no longer plugged in.
    write(hostRoot, "var/lib/smartmontools/smartd.WDC_WD40NMZW_11GX6S1-WD_WXD1EC84DPT6.ata.state", state("37"));
    mkdirSync(join(hostRoot, "dev/disk/by-id"), { recursive: true });
    symlinkSync("../../sda", join(hostRoot, "dev/disk/by-id/ata-WDC_WD180EMFZ-11AFXA0_3WHE12GJ"));
    symlinkSync("../../sda1", join(hostRoot, "dev/disk/by-id/ata-WDC_WD180EMFZ-11AFXA0_3WHE12GJ-part1"));

    const health = await readHostHealth({ hostRoot, filesystems: ["/"], procRoot, sysRoot, packages: "off" });

    expect(health.address).toBe("192.168.10.178");
    expect(health.cpuTemperatures).toEqual([
      { label: "Core 1", celsius: 44 },
      { label: "Core 2", celsius: 43 },
      { label: "Core 3", celsius: 45 },
    ]);
    expect(health.driveTemperatures).toEqual([{ device: "sda", celsius: 45 }]);
  });

  it("says whether a time service keeps the host's clock from the units systemd runs, and nothing without that list", async () => {
    const ntpActive = async () =>
      (await readHostHealth({ hostRoot, filesystems: ["/"], procRoot, packages: "off" })).ntpActive;
    // No systemd, or one too old to list what it runs.
    expect(await ntpActive()).toBeNull();
    const units = join(hostRoot, "run/systemd/units");
    write(hostRoot, "run/systemd/units/log-extra-fields:cron.service", "");
    expect(await ntpActive()).toBeNull();
    // Running, as systemd lists them: each points at its invocation's id. timedated answers timedatectl, and keeps no time.
    for (const unit of ["cron", "systemd-timedated"]) {
      symlinkSync("0b4f7a1c5e6d4f3a8b9c0d1e2f3a4b5c", join(units, `invocation:${unit}.service`));
    }
    expect(await ntpActive()).toBe(false);
    for (const unit of ["systemd-timesyncd", "chrony", "chronyd", "ntp", "ntpd", "ntpsec", "openntpd"]) {
      const entry = join(units, `invocation:${unit}.service`);
      symlinkSync("8c2f3c1e5b7a4d369e0f1a2b3c4d5e6f", entry);
      expect(await ntpActive(), unit).toBe(true);
      rmSync(entry);
    }
    // Stopped, it is gone from the list.
    expect(await ntpActive()).toBe(false);
  });

  it("finds every local disk when none is listed, but one mounted after the runner started", async () => {
    write(hostRoot, "proc/1/mounts", "/dev/sda2 / ext4 rw 0 0\n/dev/sdb1 /mnt/later ext4 rw 0 0\n");
    mkdirSync(join(hostRoot, "mnt/later"), { recursive: true });
    const health = await readHostHealth({ hostRoot, filesystems: [], procRoot, packages: "off" });

    expect(health.disks.map((disk) => disk.path)).toEqual(["/"]);
  });

  it("leaves out a boot ID it cannot read", async () => {
    write(procRoot, "sys/kernel/random/boot_id", "not a boot id\n");
    const health = await readHostHealth({ hostRoot, filesystems: ["/"], procRoot, packages: "off" });
    expect(health.bootId).toBeNull();
  });

  it("reports only what /proc gives when the host's filesystem is not mounted", async () => {
    const health = await readHostHealth({
      hostRoot: join(hostRoot, "not-mounted"),
      filesystems: ["/"],
      procRoot,
      packages: "apply",
    });
    expect(health).toMatchObject({
      disks: [],
      rebootRequired: null,
      pendingUpdates: null,
      operatingSystem: null,
      packages: null,
    });
    expect(health.memoryTotalBytes).toBe(16384000 * KIBIBYTE);
  });
});

describe("imageStoreOf", () => {
  it("finds Docker's images under its root, or the host's containerd's when Docker stores them there", () => {
    expect(imageStoreOf({ DockerRootDir: "/var/lib/docker", DriverStatus: [["Backing Filesystem", "extfs"]] })).toBe(
      "/var/lib/docker",
    );
    // This workstation's Docker 29: its root says /var/lib/docker, but its images are the host's containerd's.
    const snapshotter: [string, string][] = [["driver-type", "io.containerd.snapshotter.v1"]];
    const docker29 = { DockerRootDir: "/var/lib/docker", DriverStatus: snapshotter };
    expect(imageStoreOf({ ...docker29, Containerd: { Address: "/run/containerd/containerd.sock" } })).toBe(
      "/var/lib/containerd",
    );
    // A Docker from before 27 does not say which containerd.
    expect(imageStoreOf(docker29)).toBe("/var/lib/containerd");
    // Docker-in-Docker's: no containerd of the host's, so Docker started its own, which keeps them under its root.
    expect(imageStoreOf({ ...docker29, Containerd: { Address: "/var/run/docker/containerd/containerd.sock" } })).toBe(
      "/var/lib/docker",
    );
    expect(imageStoreOf({ DriverStatus: null })).toBeNull();
  });
});
