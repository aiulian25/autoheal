import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSshServer, type FakeExecAnswer } from "../../../test/fakes/fake-ssh-server.js";
import { NvidiaGpus } from "../../runner/gpu-metrics.js";
import { readHostHealth } from "../../runner/host-health.js";
import { HostMetricsSampler } from "../../runner/host-metrics.js";
import { SSH_STATE } from "../../shared/constants.js";
import { SshHostFiles, parseDiskFree, sshHostCommand } from "./ssh-host-files.js";
import { SshSession } from "./ssh-session.js";

const USER = "alex";
const FAST = { reconnectFirstMilliseconds: 50, reconnectMostMilliseconds: 200 };
const SETTLE_MILLISECONDS = 5_000;
// A whole second, as SFTP gives a file's time.
const SMART_READ_AT_SECONDS = 1_793_000_000;
const diskLine = (name: string, sectorsRead: number, sectorsWritten: number) =>
  `   8 0 ${name} 10 0 ${sectorsRead} 0 20 0 ${sectorsWritten} 0 0 0 0`;
const DISK_FREE: Record<string, string> = {
  "'/'": "/dev/sda1 1000000000 400000000 550000000 43% /",
  "'/mnt/data'": "/dev/sdb1 4000000000 1000000000 2800000000 27% /mnt/data",
};

async function until(session: SshSession) {
  const started = Date.now();
  while (session.state().state !== SSH_STATE.connected) {
    if (Date.now() - started > SETTLE_MILLISECONDS) throw new Error(`still ${session.state().state}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("an SSH host's files, read over its session", () => {
  let root: string;
  let server: FakeSshServer;
  let session: SshSession;
  let files: SshHostFiles;
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const directory = (path: string) => mkdirSync(join(root, path), { recursive: true });
  const answer = (command: string): FakeExecAnswer => {
    const diskFree = /^df -P -B1 -- (.+)$/.exec(command);
    if (diskFree !== null) {
      const line = DISK_FREE[diskFree[1]!];
      return line === undefined
        ? { stderr: "df: no such file", exitCode: 1 }
        : { stdout: `Filesystem 1-blocks Used Available Capacity Mounted on\n${line}\n` };
    }
    return { stderr: `${command}: not found`, exitCode: 127 };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "autoheal-ssh-host-"));
    // The host as its user sees it over SSH: /proc, /sys and its own files under one /.
    write("proc/loadavg", "0.52 0.41 0.30 2/1234 56789\n");
    write("proc/meminfo", "MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\nCached:  100000 kB\n");
    write("proc/uptime", "86400.25 345600.10\n");
    write("proc/sys/kernel/random/boot_id", "8c2f3c1e-5b7a-4d36-9e0f-1a2b3c4d5e6f\n");
    write("proc/sys/kernel/osrelease", "6.8.0-87-generic\n");
    write("proc/sys/kernel/arch", "x86_64\n");
    write("proc/cpuinfo", "processor\t: 0\nmodel name\t: Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz\n");
    write(
      "proc/stat",
      "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\ncpu1 50 0 25 400 25 0 0 0 0 0\n",
    );
    write("proc/diskstats", [diskLine("loop0", 0, 0), diskLine("sda", 500, 500)].join("\n"));
    write(
      "proc/1/mounts",
      "/dev/sda1 / ext4 rw 0 0\n/dev/loop0 /snap/core ext4 ro 0 0\n/dev/sdb1 /mnt/data ext4 rw 0 0\n",
    );
    write(
      "proc/1/net/route",
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n" +
        "eno1\t00000000\t010AA8C0\t0003\t0\t0\t0\t00000000\n" +
        "eno1\t000AA8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\n",
    );
    write("proc/1/net/fib_trie", "Local:\n  |-- 192.168.10.178\n     /32 host LOCAL\n");
    directory("proc/1");
    directory("proc/42");
    directory("sys/block/loop0");
    directory("sys/block/sda/device");
    write("sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "4000000");
    write("sys/class/hwmon/hwmon1/name", "coretemp\n");
    write("sys/class/hwmon/hwmon1/temp1_input", "47000");
    write("sys/class/hwmon/hwmon1/temp2_label", "Core 0\n");
    write("sys/class/hwmon/hwmon1/temp2_input", "44000");
    directory("sys/class/net/eno1/device");
    write("sys/class/net/eno1/speed", "1000");
    write("sys/class/net/eno1/statistics/rx_bytes", "5000000");
    write("sys/class/net/eno1/statistics/tx_bytes", "1000000");
    write("sys/class/net/eno1/statistics/rx_dropped", "4");
    write("sys/class/net/eno1/statistics/tx_dropped", "0");
    write("etc/os-release", 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nVERSION_ID="24.04"\n');
    write("etc/hostname", "mini\n");
    write("etc/timezone", "Europe/Lisbon\n");
    write("usr/bin/apt-get", "");
    directory("run/systemd/system");
    write("run/reboot-required", "*** System restart required ***\n");
    write("run/reboot-required.pkgs", "linux-image-6.8.0-88-generic\n");
    directory("usr/lib/modules/6.8.0-87-generic");
    directory("usr/lib/modules/6.8.0-88-generic");
    const state =
      "ata-smart-attribute.12.id = 193\nata-smart-attribute.12.raw = 5768\n" +
      "ata-smart-attribute.13.id = 194\nata-smart-attribute.13.raw = 41\n";
    write("var/lib/smartmontools/smartd.WDC_WD180EMFZ_11AFXA0-3WHE12GJ.ata.state", state);
    const statePath = join(root, "var/lib/smartmontools/smartd.WDC_WD180EMFZ_11AFXA0-3WHE12GJ.ata.state");
    utimesSync(statePath, SMART_READ_AT_SECONDS, SMART_READ_AT_SECONDS);
    directory("dev/disk/by-id");
    symlinkSync("../../sda", join(root, "dev/disk/by-id/ata-WDC_WD180EMFZ-11AFXA0_3WHE12GJ"));
    // A file only root reads: it reads as missing, never as an error.
    write("var/lib/update-notifier/updates-available", "\n12 updates can be applied immediately.\n");
    chmodSync(join(root, "var/lib/update-notifier/updates-available"), 0o000);

    const key = FakeSshServer.newHostKey();
    server = await FakeSshServer.start(USER, [key]);
    server.filesRoot = root;
    server.exec = answer;
    session = new SshSession(
      () => ({
        address: "127.0.0.1",
        port: server.port,
        user: USER,
        privateKey: key,
        passphrase: null,
        pinnedHostKey: server.hostKeyBlob(),
      }),
      Date.now,
      FAST,
    );
    session.start();
    await until(session);
    files = new SshHostFiles(session);
  });

  afterEach(async () => {
    session.close();
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("gives the host's health as a runner reading the same files through its mount does", async () => {
    const local = await readHostHealth({
      hostRoot: root,
      procRoot: join(root, "proc"),
      sysRoot: join(root, "sys"),
      filesystems: [],
      packages: "check",
    });
    const overSsh = await readHostHealth({ hostRoot: "/", filesystems: [], packages: "check", files });

    // Only what a runner asks of its own machine, or of statfs, differs.
    const { cpuCount, kernel, architecture, disks, packages, ...rest } = overSsh;
    const {
      cpuCount: _localCpus,
      kernel: _localKernel,
      architecture: _localArchitecture,
      disks: _localDisks,
      packages: localPackages,
      ...localRest
    } = local;
    expect(rest).toEqual(localRest);
    // Its kernel is the host's: the kernel waiting is newer than the host's own, not this machine's.
    expect(packages).toEqual({ ...localPackages, kernelWaiting: "6.8.0-88-generic" });
    expect({ cpuCount, kernel, architecture }).toEqual({
      cpuCount: 2,
      kernel: "6.8.0-87-generic",
      architecture: "x86_64",
    });
    expect(disks).toEqual([
      { path: "/", totalBytes: 1_000_000_000, usedBytes: 400_000_000, availableBytes: 550_000_000 },
      { path: "/mnt/data", totalBytes: 4_000_000_000, usedBytes: 1_000_000_000, availableBytes: 2_800_000_000 },
    ]);
    expect(overSsh).toMatchObject({
      loadAverage: [0.52, 0.41, 0.3],
      hostname: "mini",
      operatingSystem: "Ubuntu 24.04.3 LTS",
      rebootRequired: true,
      pendingUpdates: null,
      address: "192.168.10.178",
      processes: 2,
      cpuModel: "Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz",
      cpuTemperatures: [{ label: "Core 1", celsius: 44 }],
      driveTemperatures: [{ device: "sda", celsius: 41 }],
      drives: [{ device: "sda", readAt: SMART_READ_AT_SECONDS * 1000 }],
      packages: { manager: "apt", timeZone: "Europe/Lisbon", rebootPackages: ["linux-image-6.8.0-88-generic"] },
    });
  });

  it("samples usage as a runner does, in a handful of SFTP requests per tick and no command", async () => {
    let now = Date.UTC(2026, 9, 29, 12);
    const local = new HostMetricsSampler(
      { hostRoot: root, procRoot: join(root, "proc"), sysRoot: join(root, "sys"), readGpus: async () => [] },
      () => now,
    );
    const overSsh = new HostMetricsSampler({ hostRoot: "/", readGpus: async () => [], files }, () => now);
    expect([await local.sample(), await overSsh.sample()]).toEqual([null, null]);

    now += 5_000;
    write("proc/stat", "cpu  200 0 100 900 60 0 0 0 0 0\ncpu0 100 0 50 450 30 0 0 0 0 0\n");
    write("proc/diskstats", [diskLine("loop0", 0, 0), diskLine("sda", 10_500, 20_500)].join("\n"));
    write("sys/class/net/eno1/statistics/rx_bytes", "10000000");
    const requestsBefore = server.sftpRequests;
    const commandsBefore = server.commands.length;
    const sampled = await overSsh.sample();
    const requests = server.sftpRequests - requestsBefore;

    expect(sampled).toEqual(await local.sample());
    expect(sampled).toMatchObject({
      cpu: { frequencyMegahertz: 4000, temperatureCelsius: 47 },
      disk: { devices: ["sda"], readBytesPerSecond: 1_024_000, writeBytesPerSecond: 2_048_000 },
      network: { receiveBytesPerSecond: 1_000_000 },
    });
    expect(server.commands.length).toBe(commandsBefore);
    // Measured: each file is opened, sized, read to its end and closed, in parallel on one channel.
    expect(requests).toBeLessThan(120);
  });

  it("reads nothing while the session is down, and again on a new channel once it is back", async () => {
    expect(await files.readText("/proc/loadavg")).toContain("0.52");
    await server.stop();
    expect(await files.readText("/proc/loadavg")).toBeNull();
    expect(await files.list("/proc")).toEqual([]);
    await server.restart();
    await until(session);
    expect(await files.readText("/proc/loadavg")).toContain("0.52");
  });

  it("runs nvidia-smi on the host, its arguments quoted, and stops asking a host without it", async () => {
    let installed = true;
    server.exec = () =>
      installed
        ? { stdout: "37, 1024, 6144, 41.5, 61, NVIDIA GeForce RTX 3060\n" }
        : { stderr: "nvidia-smi: not found", exitCode: 127 };
    const gpus = new NvidiaGpus("nvidia-smi", sshHostCommand(session));
    expect(await gpus.read()).toMatchObject([{ name: "NVIDIA GeForce RTX 3060", utilizationPercent: 37 }]);
    expect(server.commands.at(-1)).toBe(
      "nvidia-smi '--query-gpu=utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu,name' " +
        "'--format=csv,noheader,nounits'",
    );

    installed = false;
    const none = new NvidiaGpus("nvidia-smi", sshHostCommand(session));
    expect(await none.read()).toEqual([]);
    const asked = server.commands.length;
    expect(await none.read()).toEqual([]);
    expect(server.commands.length).toBe(asked);
  });

  it("quotes a path for df whatever it holds, and reads only a well-formed answer", async () => {
    server.exec = () => ({
      stdout: "Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sdc1 10 4 5 45% /x\n",
    });
    expect(await files.filesystem("/mnt/it's; rm -rf /")).toMatchObject({ device: "/dev/sdc1", totalBytes: 10 });
    expect(server.commands.at(-1)).toBe(`df -P -B1 -- '/mnt/it'\\''s; rm -rf /'`);
    expect(parseDiskFree("df: /gone: No such file or directory\n")).toBeNull();
    expect(parseDiskFree("Filesystem 1-blocks Used\n/dev/sda1 ten 4 5\n")).toBeNull();
  });
});
