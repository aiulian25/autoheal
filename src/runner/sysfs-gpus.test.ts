import { describe, expect, it } from "vitest";
import type { HostFiles } from "./host-files.js";
import { marketName, nameInPciIds, SysfsGpus } from "./sysfs-gpus.js";

const PCI_IDS =
  "# list\n8086  Intel Corporation\n\t7d67  Arrow Lake-U [Intel Graphics]\n1002  Advanced Micro Devices\n\t73bf  Navi 21\n";
const uevent = (driver: string, id: string, slot: string) => `DRIVER=${driver}\nPCI_ID=${id}\nPCI_SLOT_NAME=${slot}\n`;

function filesOf(tree: Record<string, string>): HostFiles {
  const paths = Object.keys(tree);
  return {
    readText: async (path: string) => tree[path] ?? null,
    list: async (directory: string) => [
      ...new Set(
        paths
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => path.slice(directory.length + 1).split("/")[0]!),
      ),
    ],
  } as unknown as HostFiles;
}

const CARD = "/sys/class/drm/card0";
const arc = {
  [`${CARD}/device/uevent`]: uevent("xe", "8086:E212", "0000:03:00.0"),
  [`${CARD}/device/power/runtime_status`]: "active\n",
  [`${CARD}/device/tile0/gt0/freq0/act_freq`]: "650\n",
  [`${CARD}/device/tile0/gt0/freq0/max_freq`]: "2600\n",
  [`${CARD}/device/tile0/gt1/freq0/act_freq`]: "1300\n",
  [`${CARD}/device/tile0/gt1/freq0/max_freq`]: "2600\n",
  // These jump on the real card, and must never be used.
  [`${CARD}/device/tile0/gt0/gtidle/idle_residency_ms`]: "5497833\n",
  [`${CARD}/device/hwmon/hwmon5/energy1_input`]: "8126471746093\n",
  [`${CARD}/device/hwmon/hwmon5/temp10_input`]: "99000\n",
  [`${CARD}/device/hwmon/hwmon5/temp3_input`]: "60000\n",
  [`${CARD}/device/hwmon/hwmon5/temp3_label`]: "vram\n",
  [`${CARD}/device/hwmon/hwmon5/temp2_input`]: "46000\n",
  [`${CARD}/device/hwmon/hwmon5/temp2_label`]: "pkg\n",
};

describe("GPUs read from the kernel's files", () => {
  it("shows an xe card by its busiest clock, its package's heat, and no power or memory it cannot vouch for", async () => {
    expect(await new SysfsGpus("/", filesOf(arc)).read()).toEqual([
      {
        name: "Intel Arc Pro B50",
        utilizationPercent: 50,
        clockShare: true,
        memoryUsedBytes: 0,
        memoryTotalBytes: 0,
        powerWatts: null,
        temperatureCelsius: 46,
      },
    ]);
  });

  it("gets i915's busy share from its idle counter, its busiest unit counting, and none on the first look", async () => {
    let now = 0;
    const tree = {
      [`${CARD}/device/uevent`]: uevent("i915", "8086:7D67", "0000:00:02.0"),
      [`${CARD}/device/power/runtime_status`]: "active\n",
      [`${CARD}/gt/gt0/rc6_residency_ms`]: "1000",
      [`${CARD}/gt/gt1/rc6_residency_ms`]: "1000",
      "/usr/share/misc/pci.ids": PCI_IDS,
    };
    const gpus = new SysfsGpus("/", filesOf(tree), "/sys", () => now);
    const [first] = await gpus.read();
    expect(first).toMatchObject({ name: "Intel Arrow Lake-S", utilizationPercent: 0 });
    expect(first?.clockShare).toBeUndefined();

    now = 5000;
    tree[`${CARD}/gt/gt0/rc6_residency_ms`] = "6000";
    tree[`${CARD}/gt/gt1/rc6_residency_ms`] = "2000";
    expect((await gpus.read())[0]?.utilizationPercent).toBe(80);
  });

  it("reads an AMD card's own busy share, memory, power and heat", async () => {
    const tree = {
      [`${CARD}/device/uevent`]: uevent("amdgpu", "1002:73BF", "0000:0a:00.0"),
      [`${CARD}/device/gpu_busy_percent`]: "37\n",
      [`${CARD}/device/mem_info_vram_used`]: "1048576\n",
      [`${CARD}/device/mem_info_vram_total`]: "16777216\n",
      [`${CARD}/device/hwmon/hwmon2/power1_average`]: "21000000\n",
      [`${CARD}/device/hwmon/hwmon2/temp1_input`]: "51000\n",
      [`${CARD}/device/hwmon/hwmon2/temp1_label`]: "edge\n",
    };
    expect(await new SysfsGpus("/", filesOf(tree)).read()).toEqual([
      {
        name: "AMD Radeon RX 6800/6800 XT / 6900 XT",
        utilizationPercent: 37,
        memoryUsedBytes: 1048576,
        memoryTotalBytes: 16777216,
        powerWatts: 21,
        temperatureCelsius: 51,
      },
    ]);
  });

  it("does not read a sleeping card, and its stopped counter does not read as busy when it wakes", async () => {
    let now = 0;
    const tree = {
      [`${CARD}/device/uevent`]: uevent("i915", "8086:7D67", "0000:00:02.0"),
      [`${CARD}/device/power/runtime_status`]: "active",
      [`${CARD}/gt/gt0/rc6_residency_ms`]: "1000",
    };
    const reads: string[] = [];
    const base = filesOf(tree);
    const files = { ...base, readText: async (path: string) => (reads.push(path), base.readText(path)) } as HostFiles;
    const gpus = new SysfsGpus("/", files, "/sys", () => now);
    await gpus.read();

    tree[`${CARD}/device/power/runtime_status`] = "suspended";
    now = 60_000;
    reads.length = 0;
    expect((await gpus.read())[0]).toMatchObject({ utilizationPercent: 0, powerWatts: null, temperatureCelsius: null });
    expect(reads.some((path) => path.includes("rc6"))).toBe(false);

    tree[`${CARD}/device/power/runtime_status`] = "active";
    now = 120_000;
    expect((await gpus.read())[0]?.utilizationPercent).toBe(0);
  });

  it("leaves out NVIDIA's cards, display adapters and connectors, and lists the rest in slot order", async () => {
    const tree = {
      "/sys/class/drm/card0/device/uevent": uevent("nvidia", "10DE:2204", "0000:01:00.0"),
      "/sys/class/drm/card1/device/uevent": uevent("ast", "1A03:2000", "0000:02:00.0"),
      "/sys/class/drm/card1-HDMI-A-1/device/uevent": uevent("xe", "8086:E212", "0000:09:00.0"),
      "/sys/class/drm/card2/device/uevent": uevent("xe", "8086:E212", "0000:03:00.0"),
      "/sys/class/drm/card3/device/uevent": uevent("i915", "8086:7D67", "0000:00:02.0"),
      "/usr/share/misc/pci.ids": PCI_IDS,
    };
    const gpus = await new SysfsGpus("/", filesOf(tree)).read();
    expect(gpus.map((gpu) => gpu.name)).toEqual(["Intel Arrow Lake-S", "Intel Arc Pro B50"]);
  });

  it("has no GPUs where the kernel lists none", async () => {
    expect(await new SysfsGpus("/", filesOf({})).read()).toEqual([]);
  });

  it("names a card too new for its own list from the host's, and by its number when nobody knows it", async () => {
    const tree = { [`${CARD}/device/uevent`]: uevent("xe", "8086:FFF0", "0000:03:00.0") };
    expect((await new SysfsGpus("/", filesOf(tree)).read())[0]?.name).toBe("Intel GPU fff0");

    const named = { ...tree, "/usr/share/hwdata/pci.ids": "8086  Intel Corporation\n\tfff0  Next [Arc C9]\n" };
    expect((await new SysfsGpus("/", filesOf(named)).read())[0]?.name).toBe("Intel Arc C9");
  });

  it("prefers the name a card is sold under", () => {
    expect(marketName("Battlemage G21 [Arc Pro B50]")).toBe("Arc Pro B50");
    expect(marketName("CometLake-H GT2 [UHD Graphics]")).toBe("UHD Graphics");
    expect(marketName("Arrow Lake-U [Intel Graphics]")).toBe("Arrow Lake-U");
    expect(marketName("Some Chip")).toBe("Some Chip");
  });

  it("finds a card's name under its own vendor only", () => {
    expect(nameInPciIds(PCI_IDS, "8086", "7d67")).toBe("Arrow Lake-U [Intel Graphics]");
    expect(nameInPciIds(PCI_IDS, "8086", "73bf")).toBeNull();
    expect(nameInPciIds(null, "8086", "7d67")).toBeNull();
  });
});
