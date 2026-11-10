import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostPowerView, type HostView } from "../../../src/shared/api.js";
import { POWER_PHASE } from "../../../src/shared/constants.js";
import { POWER_TEXT } from "../constants.js";
import { StateBadge } from "./fleet-page.js";
import { PowerButtons, PowerStrip } from "./host-power.js";
import { HostDials } from "./host-stats.js";

const NOW = Date.now();
const host: HostView = {
  id: "h1",
  label: "OrionBx3",
  state: "online",
  tokenHint: "hint",
  enrolledAt: 1,
  lastHeartbeatAt: NOW,
  runnerVersion: "2.0.0",
  dryRun: false,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: null,
  health: {
    cpuCount: 14,
    loadAverage: [0.2, 0.2, 0.2],
    memoryTotalBytes: 16e9,
    memoryAvailableBytes: 12e9,
    uptimeSeconds: 345_600,
    disks: [],
    rebootRequired: false,
    pendingUpdates: null,
    operatingSystem: "Ubuntu 24.04.5 LTS",
    kernel: "7.0.0-42-generic",
    // Its packages are only checked: reboot and shutdown do not depend on that.
    packages: {
      setting: "check",
      unsupported: null,
      unattendedUpgrades: false,
      rebootPackages: [],
      kernelWaiting: null,
      timeZone: "UTC",
      recentChanges: [],
    },
  },
  metrics: null,
  containerCount: 33,
  runningCount: 33,
  problemCount: 0,
};
const power = (overrides: Partial<HostPowerView>): HostPowerView => ({
  action: "reboot",
  jobId: "j1",
  phase: POWER_PHASE.offline,
  requestedAt: NOW - 30_000,
  requestedBy: "admin",
  lastSeenAt: NOW - 20_000,
  finishedAt: null,
  outcome: null,
  ...overrides,
});

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});

function show(content: React.ReactNode, localHostId: string | null = "elsewhere") {
  const fetch = vi.fn(
    async (url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify(url === API_ROUTES.localHost ? { hostId: localHostId, revoked: false } : { id: "j1" }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
  return fetch;
}
const posted = (fetch: ReturnType<typeof show>) =>
  fetch.mock.calls
    .filter(([url, init]) => url === apiPath(API_ROUTES.hostActions, { hostId: "h1" }) && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init!.body)));

describe("reboot and shut down, on a host's page", () => {
  it("asks once, in place, then reboots; a shutdown says it stays off; a cancel asks nothing", async () => {
    const fetch = show(<PowerButtons host={host} />);
    fireEvent.click(screen.getByRole("button", { name: POWER_TEXT.reboot }));
    expect(screen.getByText(POWER_TEXT.confirm.reboot("OrionBx3", 33))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: POWER_TEXT.cancel }));
    expect(posted(fetch)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: POWER_TEXT.shutdown }));
    expect(screen.getByText(POWER_TEXT.confirm.shutdown("OrionBx3"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: POWER_TEXT.confirm.go.shutdown }));
    await waitFor(() => expect(posted(fetch)).toEqual([{ action: "shutdown" }]));
  });

  it("warns that the dashboard goes down too on the machine it runs on, and offers nothing where systemd can't be asked", async () => {
    show(<PowerButtons host={{ ...host, kind: "local" }} />, "h1");
    fireEvent.click(screen.getByRole("button", { name: POWER_TEXT.reboot }));
    expect(screen.getByText(new RegExp(POWER_TEXT.confirm.dashboardToo))).toBeTruthy();
    cleanup();
    show(<PowerButtons host={{ ...host, health: { ...host.health!, packages: null } }} />);
    expect(screen.queryByRole("button", { name: POWER_TEXT.reboot })).toBeNull();
  });

  it("keeps both buttons still while a reboot is under way", () => {
    show(<PowerButtons host={{ ...host, power: power({}) }} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: POWER_TEXT.reboot }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: POWER_TEXT.shutdown }).disabled).toBe(true);
  });
});

describe("the strip that follows a reboot or a shutdown", () => {
  const stepsOf = (strip: HTMLElement) =>
    within(strip)
      .getAllByRole("listitem")
      .map((step) => `${step.textContent}:${step.className || "-"}`);

  it("follows a reboot: offline after going down, with how long it has been quiet", () => {
    show(<PowerStrip host={{ ...host, power: power({}) }} />);
    const strip = screen.getByRole("status", { name: POWER_TEXT.title.reboot("OrionBx3") });
    expect(stepsOf(strip)).toEqual(["Asked:done", "Going down:done", "Offline:active", "Starting:-", "Ready:-"]);
    // About 20 s, as long as the test took to get here.
    expect(within(strip).getByText(/^Offline\. No answer for 2\d s: Autoheal keeps asking\.$/)).toBeTruthy();
    expect(strip.className).toContain("power-neutral");
  });

  it("says when it is back, how long it took and what runs again", () => {
    show(
      <PowerStrip host={{ ...host, power: power({ phase: POWER_PHASE.ready, finishedAt: NOW - 30_000 + 72_000 }) }} />,
    );
    const strip = screen.getByRole("status", { name: POWER_TEXT.title.ready("OrionBx3") });
    expect(stepsOf(strip).every((step) => step.endsWith(":done"))).toBe(true);
    expect(within(strip).getByText(/^Back in 1 minute\. 33 of 33 containers running\.$/)).toBeTruthy();
  });

  it("says a shutdown is off, when and by whom, and why it raises no alarm; and what refused one", () => {
    show(
      <PowerStrip
        host={{ ...host, power: power({ action: "shutdown", phase: POWER_PHASE.off, finishedAt: NOW - 10_000 }) }}
      />,
    );
    const strip = screen.getByRole("status", { name: POWER_TEXT.title.off("OrionBx3") });
    expect(within(strip).getByText(/by admin\. No alarm while it stays off/)).toBeTruthy();
    cleanup();
    const refusal = "Not rebooting: a Proxmox backup is running on this node.";
    show(<PowerStrip host={{ ...host, power: power({ phase: POWER_PHASE.failed, outcome: refusal }) }} />);
    expect(screen.getByRole("status", { name: POWER_TEXT.title.failed("OrionBx3") }).textContent).toContain(refusal);
  });

  it("shows on the badge and over the dials while the host is away", () => {
    show(
      <>
        <StateBadge host={{ ...host, power: power({}) }} />
        <HostDials host={{ ...host, power: power({}) }} />
      </>,
    );
    expect(screen.getByText(POWER_TEXT.badge.offline).closest(".badge")!.className).toContain("badge-moving");
    expect(screen.getByText(POWER_TEXT.away.offline("OrionBx3"))).toBeTruthy();
  });
});
