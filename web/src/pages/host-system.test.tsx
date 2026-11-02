import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssessedPackageView, HostHealthView, HostPackagesView, HostView } from "../../../src/shared/api.js";
import type { DriveHealth } from "../../../src/shared/protocol.js";
import { hostHealth, hostMetrics } from "../../../test/support/inventory.js";
import { RUNNER_GPU_COMMAND } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";
import { HostDials } from "./host-stats.js";
import { HostSystem } from "./host-system.js";

const GIBIBYTE = 1024 ** 3;
const TEBIBYTE = 1024 ** 4;

// The Alder as its runner reports it: / and one of its NAS drives, an NVMe sensor, seven package updates.
const health: HostHealthView = {
  ...hostHealth({
    cpuCount: 16,
    loadAverage: [0.45, 0.23, 0.09],
    uptimeSeconds: 60,
    pendingUpdates: 7,
    operatingSystem: "Ubuntu 24.04.5 LTS",
    kernel: "7.0.0-38-generic",
    disks: [
      { path: "/", totalBytes: 466 * GIBIBYTE, usedBytes: 36 * GIBIBYTE, availableBytes: 406 * GIBIBYTE },
      {
        path: "/mnt/storage/disk1",
        totalBytes: 16 * TEBIBYTE,
        usedBytes: 15.5 * TEBIBYTE,
        availableBytes: 0.5 * TEBIBYTE,
      },
    ],
    packages: {
      setting: "check",
      unsupported: null,
      unattendedUpgrades: true,
      rebootPackages: [],
      kernelWaiting: null,
      timeZone: "Europe/Lisbon",
      recentChanges: [],
    },
  }),
  hostname: "alex-Alder",
  architecture: "x86_64",
  cpuModel: "Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz",
  processes: 349,
  driveTemperatures: [
    { device: "nvme0n1", celsius: 34 },
    { device: "sda", celsius: 44 },
    { device: "sdd", celsius: 36 },
  ],
  dockerVersion: "29.9.2",
  address: "192.168.10.178",
  cpuTemperatures: [
    { label: "Core 1", celsius: 44 },
    { label: "Core 2", celsius: 43 },
  ],
};

const update = (name: string, security: boolean): AssessedPackageView => ({
  name,
  installed: "1.0",
  candidate: "1.1",
  security,
  kind: "routine",
  held: false,
  summary: null,
  source: security ? "noble-security" : "noble-updates",
});

// Its last check, as the OS updates further down have it.
function servePackages(checkedAt: number | null, packages: AssessedPackageView[]) {
  const answer = { checkedAt, packages } as Partial<HostPackagesView>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } })),
  );
}

function show(host: HostView, shownHealth: HostHealthView) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <HostSystem host={host} health={shownHealth} />
    </QueryClientProvider>,
  );
}

const alder = (overrides: Partial<HostView> = {}): HostView => ({
  id: "h1",
  label: "Alder",
  state: "online",
  tokenHint: "abcd",
  enrolledAt: Date.now(),
  lastHeartbeatAt: Date.now(),
  runnerVersion: "2.0.0",
  dryRun: false,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: null,
  health,
  metrics: { ...hostMetrics(), at: Date.now() },
  containerCount: 13,
  runningCount: 13,
  problemCount: 0,
  ...overrides,
});

const factOf = (label: string) => screen.getByText(label).closest("div")!.querySelector("dd")!.textContent;

describe("a host's system information", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lays out what the host is and how it runs, in two lists side by side", async () => {
    servePackages(Date.now(), [update("openvpn", false), update("libfprint-2-2", true), update("curl", false)]);
    show(alder(), health);

    expect(factOf("Hostname")).toBe("alex-Alder (192.168.10.178)");
    expect(factOf("Docker")).toBe("29.9.2");
    expect(factOf("Kernel")).toBe("Linux 7.0.0-38-generic · x86_64");
    expect(factOf("Processor")).toBe("Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz, 16 threads");
    expect(factOf("CPU temperatures")).toMatch(/^Core 1 · 44.*Core 2 · 43/);
    expect(factOf("Drive temperatures")).toMatch(/^nvme0n1 · 34.*sda · 44.*sdd · 36/);
    expect(factOf("Running processes")).toBe("349");
    expect(factOf("Load averages")).toBe("0.45 1 min · 0.23 5 min · 0.09 15 min");
    expect(factOf("Real memory")).toMatch(/ used · .* cached · .* total$/);
    expect(factOf("Local disk space")).toBe("15.5 TB used · 918 GB free · 16.5 TB total");
    expect(factOf("Time on system")).toMatch(/2\d{3}/);
    // What the machine is and holds on the left; how it runs on the right.
    const left = screen.getByText("Hostname").closest("dl")!;
    const right = screen.getByText("Operating system").closest("dl")!;
    expect(left).not.toBe(right);
    expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Last report").closest("dl")).toBe(left);
    expect(screen.getByText("Package updates").closest("dl")).toBe(right);
    const updates = await screen.findByRole("link", { name: /available/ });
    expect(updates.getAttribute("href")).toBe("#updates");
    expect(updates.textContent).toBe("3 available, 1 of them security");
  });

  it("says what a runner from before these facts did not report, and Ubuntu's own count before a check", async () => {
    servePackages(null, []);
    const older: HostHealthView = { ...health };
    for (const key of [
      "hostname",
      "architecture",
      "cpuModel",
      "processes",
      "driveTemperatures",
      "dockerVersion",
      "address",
      "cpuTemperatures",
    ]) {
      delete older[key as keyof HostHealthView];
    }
    show(alder({ health: older, metrics: null }), older);

    expect(factOf("Hostname")).toBe("Alder");
    expect(factOf("Kernel")).toBe("Linux 7.0.0-38-generic");
    expect(factOf("Processor")).toBe("16 threads");
    expect(factOf("Docker")).toBe("—");
    expect(factOf("Virtual memory")).toBe("—");
    expect(factOf("CPU temperatures")).toBe("—");
    expect((await screen.findByRole("link", { name: /available/ })).textContent).toBe("7 available");
  });

  it("lists each drive's health as smartd read it: healthy, worn, or failing, and how old the reading is", async () => {
    servePackages(Date.now(), []);
    const now = Date.now();
    const drive = (device: string, overrides: Partial<DriveHealth> = {}): DriveHealth => ({
      device,
      kind: "nvme",
      readAt: now - 5 * 60_000,
      reallocatedSectors: 0,
      pendingSectors: 0,
      uncorrectableSectors: 0,
      selfTestErrors: 0,
      errorLogEntries: 0,
      percentageUsed: 2,
      availableSpare: 100,
      warnings: [],
      ...overrides,
    });
    const warnings = [{ kind: "Health", count: 22, lastAt: now - 3_600_000 }];
    const drives = [
      drive("nvme0n1", { errorLogEntries: 5, warnings }),
      drive("nvme1n1", { percentageUsed: 85 }),
      drive("sda", { kind: "ata", percentageUsed: null, availableSpare: null }),
      // Its attribute log says its warnings were heat alone.
      drive("nvme2n1", { warnings, criticalWarnings: 0b10 }),
    ];
    show(alder(), { ...health, drives });
    const items = screen.getByText("Drive health").closest("div")!.querySelectorAll("li");
    expect([...items].map((item) => item.querySelector("span:nth-child(2)")?.className)).toEqual([
      "text-danger",
      "text-warning",
      "text-good",
      "text-good",
    ]);
    expect(items[0]?.textContent).toMatch(
      /^nvme0n1 smartd raised 22 warnings \(Health\), the last on .*; 5 entries in its error log · read by smartd 5 min/,
    );
    expect(items[1]?.textContent).toContain("85% of its rated life used");
    expect(items[2]?.textContent).toContain("No signs of wear or failure");
    expect(items[3]?.textContent).toMatch(
      /^nvme2n1 No signs of wear or failure; smartd warned 22 times that it ran too hot, the last on .* · read by smartd/,
    );
  });

  it("says when every installed package is up to date", async () => {
    servePackages(Date.now(), []);
    show(alder(), health);

    expect(await screen.findByText("All up to date")).toBeTruthy();
  });
});

describe("a host's dials", () => {
  afterEach(cleanup);

  it("give a card that reports only its clock a dial that says so, and no memory row", () => {
    const arc = {
      name: "Intel GPU e212",
      utilizationPercent: 25,
      clockShare: true,
      memoryUsedBytes: 0,
      memoryTotalBytes: 0,
      powerWatts: null,
      temperatureCelsius: 46,
    };
    render(<HostDials host={alder({ metrics: { ...hostMetrics(), gpus: [arc], at: Date.now() } })} />);
    expect(screen.getByText("Intel GPU e212")).toBeTruthy();
    expect(screen.getByText("of top clock")).toBeTruthy();
    expect(screen.queryByText(TEXT.metrics.videoMemory)).toBeNull();
    cleanup();

    const busy = { ...arc, clockShare: undefined, memoryTotalBytes: 1024, memoryUsedBytes: 512 };
    render(<HostDials host={alder({ metrics: { ...hostMetrics(), gpus: [busy], at: Date.now() } })} />);
    expect(screen.queryByText("of top clock")).toBeNull();
    expect(screen.getByText(TEXT.metrics.videoMemory)).toBeTruthy();
  });

  it("say, where an NVIDIA card was not given to the runner, how to give it, and say nothing otherwise", () => {
    render(<HostDials host={alder({ health: { ...health, gpuNotGiven: true } })} />);
    expect(screen.getByText("No GPU dial: this host's NVIDIA card was not given to its runner.")).toBeTruthy();
    expect(screen.getByText(/compose.override.yaml/, { selector: "pre" }).textContent).toBe(RUNNER_GPU_COMMAND);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    cleanup();

    render(<HostDials host={alder()} />);
    expect(screen.queryByText(/No GPU dial/)).toBeNull();
  });
});
