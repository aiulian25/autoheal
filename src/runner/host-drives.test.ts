import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SMART_ATTRIBUTE_LOG } from "../shared/constants.js";
import { localFilesystems, readDrives } from "./host-drives.js";

// As the Alder's /proc/1/mounts has them, with what is no local disk, and a device mounted twice.
const MOUNT_TABLE = [
  "/dev/mapper/ubuntu--vg-ubuntu--lv / ext4 rw,relatime 0 0",
  "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
  "tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime 0 0",
  "/dev/nvme0n1p2 /boot ext4 rw,relatime 0 0",
  "/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0",
  "/dev/loop3 /snap/core22/1380 squashfs ro,nodev,relatime 0 0",
  "/dev/sda1 /mnt/storage/disk1 fuseblk rw,relatime,user_id=0,group_id=0,allow_other 0 0",
  "/dev/sda1 /srv/again fuseblk rw,relatime 0 0",
  "/dev/sdb2 /mnt/My\\040Disk ext4 rw,relatime 0 0",
  "server:/export /mnt/nfs nfs4 rw,relatime 0 0",
  "overlay /var/lib/docker/rootfs/overlayfs/0123 overlay rw,relatime 0 0",
].join("\n");

// A Proxmox VE node on ZFS: its datasets share their pool's free space.
const PROXMOX = [
  "rpool/ROOT/pve-1 / zfs rw,relatime,xattr,noacl 0 0",
  "rpool /rpool zfs rw,relatime,xattr,noacl 0 0",
  "rpool/data /rpool/data zfs rw,relatime,xattr,noacl 0 0",
  "tank/media /tank/media zfs rw,relatime,xattr,noacl 0 0",
].join("\n");

describe("the host's drives", () => {
  let sysRoot: string | null = null;

  afterEach(() => {
    if (sysRoot !== null) {
      rmSync(sysRoot, { recursive: true, force: true });
    }
  });

  it("finds each local disk once, as df lists them", () => {
    expect(localFilesystems(MOUNT_TABLE)).toEqual(["/", "/boot", "/boot/efi", "/mnt/storage/disk1", "/mnt/My Disk"]);
    expect(localFilesystems(PROXMOX)).toEqual(["/", "/tank/media"]);
  });

  it("reads the temperature of each drive with a sensor, by the disk's own name", async () => {
    sysRoot = mkdtempSync(join(tmpdir(), "autoheal-sys-"));
    const sensor = (entry: string, name: string, millidegrees: string, deviceEntry: string) => {
      const directory = join(sysRoot!, "class/hwmon", entry);
      mkdirSync(join(directory, "device", deviceEntry), { recursive: true });
      writeFileSync(join(directory, "name"), `${name}\n`);
      writeFileSync(join(directory, "temp1_input"), `${millidegrees}\n`);
    };
    sensor("hwmon0", "coretemp", "54000", "");
    sensor("hwmon1", "nvme", "32850", "nvme0n1");
    sensor("hwmon2", "drivetemp", "36000", "block/sda");
    // smartd reads sda too: the kernel's own sensor is the one shown.
    const hostRoot = join(sysRoot, "host");
    mkdirSync(join(hostRoot, "var/lib/smartmontools"), { recursive: true });
    writeFileSync(
      join(hostRoot, "var/lib/smartmontools/smartd.ST4000VN008_2DR166-ZDH1ABCD.ata.state"),
      "ata-smart-attribute.9.id = 194\nata-smart-attribute.9.raw = 40\n",
    );
    mkdirSync(join(hostRoot, "dev/disk/by-id"), { recursive: true });
    symlinkSync("../../sda", join(hostRoot, "dev/disk/by-id/ata-ST4000VN008-2DR166_ZDH1ABCD"));

    expect((await readDrives(sysRoot, hostRoot)).temperatures).toEqual([
      { device: "nvme0n1", celsius: 32.85, maximumCelsius: null },
      { device: "sda", celsius: 36, maximumCelsius: null },
    ]);
    expect((await readDrives(join(sysRoot, "none"), hostRoot)).temperatures).toEqual([{ device: "sda", celsius: 40 }]);
  });

  it("reads the highest temperature a drive declares it may run at", async () => {
    sysRoot = mkdtempSync(join(tmpdir(), "autoheal-sys-"));
    const directory = join(sysRoot, "class/hwmon/hwmon1");
    mkdirSync(join(directory, "device/nvme0n1"), { recursive: true });
    writeFileSync(join(directory, "name"), "nvme\n");
    writeFileSync(join(directory, "temp1_input"), "45850\n");
    writeFileSync(join(directory, "temp1_max"), "82850\n");
    expect((await readDrives(sysRoot, null)).temperatures).toEqual([
      { device: "nvme0n1", celsius: 45.85, maximumCelsius: 82.85 },
    ]);
  });

  describe("as smartd last read them", () => {
    const READ_AT = Date.UTC(2026, 9, 24, 8, 30);
    const smartd = (files: Record<string, string>, links: Record<string, string>) => {
      sysRoot = mkdtempSync(join(tmpdir(), "autoheal-sys-"));
      const hostRoot = join(sysRoot, "host");
      const states = join(hostRoot, "var/lib/smartmontools");
      mkdirSync(states, { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(states, file), content);
        utimesSync(join(states, file), READ_AT / 1000, READ_AT / 1000);
      }
      mkdirSync(join(hostRoot, "dev/disk/by-id"), { recursive: true });
      for (const [link, device] of Object.entries(links)) {
        symlinkSync(`../../${device}`, join(hostRoot, "dev/disk/by-id", link));
      }
      return hostRoot;
    };

    it("reads an NVMe drive's wear, spare, error log and smartd's warnings", async () => {
      // This workstation's own, 24 October: smartd warned 22 times, and its mail went nowhere.
      const hostRoot = smartd(
        {
          "smartd.SM2P41C8_256GC6-2P0629ABA4RE.nvme.state": [
            "# smartd state file",
            "mail.1.count = 22",
            "mail.1.first-sent-time = 1789582585",
            "mail.1.last-sent-time = 1792829006",
            "nvme-err-log-entries = 5",
            "nvme-available-spare = 100",
            "nvme-percentage-used = 2",
          ].join("\n"),
        },
        { "nvme-SM2P41C8-256GC6_2P0629ABA4RE": "nvme0n1", "nvme-SM2P41C8-256GC6_2P0629ABA4RE-part1": "nvme0n1p1" },
      );
      expect((await readDrives(join(sysRoot!, "none"), hostRoot)).health).toEqual([
        {
          device: "nvme0n1",
          kind: "nvme",
          readAt: READ_AT,
          reallocatedSectors: 0,
          pendingSectors: 0,
          uncorrectableSectors: 0,
          selfTestErrors: 0,
          errorLogEntries: 5,
          percentageUsed: 2,
          availableSpare: 100,
          // smartd keeps no attribute log of it here.
          criticalWarnings: null,
          warnings: [{ kind: "Health", count: 22, lastAt: 1792829006 * 1000 }],
        },
      ]);
    });

    it("reads which critical warnings an NVMe drive raised at smartd's checks of the last week", async () => {
      const check = (warning: number, celsius: number) =>
        `2026-10-24 09:03:26;\tcritical-warning;${warning};\ttemperature;${celsius};\tavailable-spare;100;\t`;
      // A week of checks, the last of them hot; a failing bit before it is past what counts.
      const log = [
        check(0b100, 40),
        ...Array.from({ length: SMART_ATTRIBUTE_LOG.samples - 2 }, () => check(0, 35)),
        check(0b10, 98),
        check(0, 34),
      ];
      const hostRoot = smartd(
        {
          "smartd.SM2P41C8_256GC6-2P0629ABA4RE.nvme.state": "mail.1.count = 22\nmail.1.last-sent-time = 1792829006\n",
          "attrlog.SM2P41C8_256GC6-2P0629ABA4RE.nvme.csv": `${log.join("\n")}\n`,
        },
        { "nvme-SM2P41C8-256GC6_2P0629ABA4RE": "nvme0n1" },
      );
      const [drive] = (await readDrives(join(sysRoot!, "none"), hostRoot)).health;
      expect(drive).toMatchObject({ device: "nvme0n1", criticalWarnings: 0b10 });
    });

    it("counts a SATA drive's sectors from the low four bytes, an attribute smartd left without a raw line as 0", async () => {
      const hostRoot = smartd(
        {
          "smartd.WDC__WDS200T2B0B_00YS70-2022HZ453510.ata.state": [
            "ata-smart-attribute.0.id = 5",
            "ata-smart-attribute.0.val = 100",
            "ata-smart-attribute.7.id = 197",
            `ata-smart-attribute.7.raw = ${2 ** 32 + 2}`,
            "ata-smart-attribute.8.id = 198",
            "ata-smart-attribute.8.raw = 1",
            "ata-smart-attribute.9.id = 194",
            "ata-smart-attribute.9.raw = 38",
            "self-test-errors = 1",
            "ata-error-count = 3",
            "mail.0.count = 1",
            "mail.10.count = 2",
            "mail.10.last-sent-time = 1792829006",
          ].join("\n"),
        },
        { "ata-WDC_WDS200T2B0B-00YS70_2022HZ453510": "sda" },
      );
      const drives = await readDrives(join(sysRoot!, "none"), hostRoot);
      expect(drives.health).toEqual([
        {
          device: "sda",
          kind: "ata",
          readAt: READ_AT,
          reallocatedSectors: 0,
          pendingSectors: 2,
          uncorrectableSectors: 1,
          selfTestErrors: 1,
          errorLogEntries: 3,
          percentageUsed: null,
          availableSpare: null,
          criticalWarnings: null,
          // smartd's test message is left out.
          warnings: [{ kind: "CurrentPendingSector", count: 2, lastAt: 1792829006 * 1000 }],
        },
      ]);
      expect(drives.temperatures).toEqual([{ device: "sda", celsius: 38 }]);
    });
  });
});
