import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter, createMemoryRouter, Link, Route, RouterProvider, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type HostPackagesView,
  type HostView,
  type JobView,
  type SessionView,
  type SshHostDetailsView,
} from "../../../src/shared/api.js";
import { HOST_SECTIONS } from "../../../src/shared/constants.js";
import { PATHS, RUNNER_UPDATE_COMMAND, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { hostPackagesQuery, localHostQuery } from "../queries.js";
import { HostPage } from "./host-page.js";

const session: SessionView = {
  user: { id: "u", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const host: HostView = {
  id: "h1",
  label: "Alder",
  state: "online",
  tokenHint: "hint",
  enrolledAt: 1,
  lastHeartbeatAt: 1,
  runnerVersion: "2.0.0",
  dryRun: false,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: null,
  health: null,
  metrics: null,
  containerCount: 0,
  runningCount: 0,
  problemCount: 0,
};
// What a runner without the host's own files reports: no packages, no disks.
const hostHealthWithout = {
  cpuCount: 4,
  loadAverage: [0.1, 0.1, 0.1],
  memoryTotalBytes: 8_000_000_000,
  memoryAvailableBytes: 4_000_000_000,
  uptimeSeconds: 3600,
  disks: [],
  rebootRequired: null,
  pendingUpdates: null,
  operatingSystem: null,
  kernel: "4.4.302+",
  packages: null,
} satisfies HostView["health"];
const packageView: HostPackagesView = {
  hostId: host.id,
  facts: null,
  lifecycle: null,
  rebootRequired: false,
  checkedAt: null,
  refreshed: false,
  refreshProblem: null,
  needsRepair: false,
  packages: [],
  keptBack: [],
  removable: [],
  automatic: [],
  unattended: [],
  forPerson: [],
  running: null,
  recent: [],
  window: { securityInWindow: false, windowStart: "03:00", windowEnd: "05:00" },
};
const job = (
  id: string,
  action: JobView["action"] = "check_updates",
  status: JobView["status"] = "pending",
): JobView => ({
  id,
  action,
  status,
  hostId: host.id,
  hostLabel: host.label,
  containerName: "",
  requestedBy: "admin",
  taskId: null,
  createdAt: 1,
  completedAt: status === "pending" || status === "delivered" ? null : 2,
  outcome: null,
  output: null,
  recoveryBackupId: null,
  packages: [],
  progress: null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let client: QueryClient;
// An SSH host's details, as its Over SSH card reads them.
const sshDetails: SshHostDetailsView = {
  address: "192.168.10.21",
  port: 22,
  user: "alex",
  keyId: "k1",
  keyName: "laptop",
  hostKeyFingerprint: "SHA256:hostkey",
  offeredHostKeyFingerprint: null,
  settings: {
    dryRun: false,
    protectedContainers: [],
    containerAccess: true,
    hostPackages: "apply",
    checkpointLimitGigabytes: 2,
  },
  rootMethod: "sudo",
};
// The version the dashboard runs, as its settings give it.
const AUTOHEAL_VERSION = "2.0.0";
// The host Autoheal itself runs on.
let localHostId: string | null = "h0";
// What the host's open tasks are, and the changes asked of them.
let openTasks: Record<string, unknown>[] = [];
let taskChanges: [string, string][] = [];
function show(packages = packageView, browserHash?: string, shownHost = host) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  const records = new Map<string, JobView>();
  const posts: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === apiPath(API_ROUTES.hostActions, { hostId: host.id }) && init?.method === "POST") {
      const { action } = JSON.parse(String(init.body)) as { action: JobView["action"] };
      posts.push(action);
      const accepted = job(`j${posts.length}`, action);
      records.set(accepted.id, accepted);
      return json(accepted);
    }
    if (url.startsWith("/api/jobs/")) return json(records.get(url.split("/").at(-1)!));
    if (init?.method === "PATCH" && url.startsWith(`${API_ROUTES.tasks}/`)) {
      taskChanges.push([url.split("/").at(-1)!, String(init.body)]);
      return json({});
    }
    if (url.startsWith(`${API_ROUTES.tasks}?`)) return json(openTasks);
    if (url === API_ROUTES.hosts) return json([shownHost]);
    if (url === apiPath(API_ROUTES.hostPackages, { hostId: host.id })) return json(packages);
    if (url === apiPath(API_ROUTES.hostControl, { hostId: host.id }))
      return json({
        hostId: host.id,
        restartDefault: "ask",
        updateDefault: "ask",
        imageCleanup: "off",
        clearBuildCache: false,
        nextCleanupAt: null,
        lastCleanup: null,
        timeZone: null,
      });
    if (url === apiPath(API_ROUTES.hostNetworks, { hostId: host.id })) return json({ networks: [], lastJob: null });
    if (url === apiPath(API_ROUTES.hostVolumes, { hostId: host.id })) return json({ volumes: [], lastJob: null });
    if (url === apiPath(API_ROUTES.hostImages, { hostId: host.id })) return json({ images: [], lastRemoval: null });
    if (url === apiPath(API_ROUTES.containerUpdates, { hostId: host.id })) return json(null);
    if (url === API_ROUTES.session) return json(session);
    if (url === API_ROUTES.settings)
      return json({ runnerAddress: "https://192.168.10.83:9443", version: AUTOHEAL_VERSION });
    if (url === API_ROUTES.localHost) return json({ hostId: localHostId, revoked: false });
    if (url === apiPath(API_ROUTES.sshHost, { hostId: host.id })) return json(sshDetails);
    return json([]);
  });
  vi.stubGlobal("fetch", fetch);
  const router = createMemoryRouter([{ path: PATHS.host, element: <HostPage /> }], {
    initialEntries: [apiPath(PATHS.host, { hostId: host.id })],
  });
  if (browserHash !== undefined)
    window.history.replaceState(null, "", apiPath(PATHS.host, { hostId: host.id }) + browserHash);
  render(
    <QueryClientProvider client={client}>
      {browserHash === undefined ? (
        <RouterProvider router={router} />
      ) : (
        <BrowserRouter>
          <Routes>
            <Route path={PATHS.host} element={<HostPage />} />
          </Routes>
          <Link to="#control">Other link to host control</Link>
        </BrowserRouter>
      )}
    </QueryClientProvider>,
  );
  const refresh = () => client.invalidateQueries({ queryKey: ["job"] });
  return { records, posts, fetch, refresh, router };
}
afterEach(() => {
  localHostId = "h0";
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("re-enables Check updates after its accepted job finishes and submits another check without unmounting", async () => {
  const { records, posts, refresh } = show();
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_updates"]));
  await waitFor(() => expect(button.disabled).toBe(true));
  records.set("j1", job("j1", "check_updates", "succeeded"));
  await refresh();
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_updates", "check_updates"]));
});

const checkable: HostPackagesView = {
  ...packageView,
  facts: {
    setting: "check",
    unsupported: null,
    unattendedUpgrades: false,
    rebootPackages: [],
    kernelWaiting: null,
    timeZone: "UTC",
    recentChanges: [],
  },
};

it("disables the host-wide check button while another package operation runs", async () => {
  const running = job("upgrade", "upgrade_packages", "delivered");
  const { posts } = show({ ...checkable, running, recent: [running] });
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  await waitFor(() => expect(button.disabled).toBe(true));
  fireEvent.click(button);
  expect(posts).toEqual([]);
});

it.each(["succeeded", "failed", "expired"] as const)(
  "waits for both exact jobs and releases the button when the last job is %s",
  async (status) => {
    const { records, posts, refresh } = show(checkable);
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
    await waitFor(() => expect(client.getQueryData(["host-packages", host.id])).toEqual(checkable));
    fireEvent.click(button);
    await waitFor(() => expect(posts).toEqual(["check_updates", "check_packages"]));
    expect(await screen.findByText("Image check: Queued")).toBeTruthy();
    expect(await screen.findByText("Package check: Queued")).toBeTruthy();
    records.set("j1", job("j1", "check_updates", "succeeded"));
    records.set("j2", job("j2", "check_packages", "delivered"));
    await refresh();
    expect(await screen.findByText("Image check: Completed")).toBeTruthy();
    expect(await screen.findByText("Package check: Under way")).toBeTruthy();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(posts).toHaveLength(2);
    records.set("j2", job("j2", "check_packages", status));
    await refresh();
    await waitFor(() => expect(button.disabled).toBe(false));
  },
);

it("retains the accepted image job on package submission failure and retries only the package check", async () => {
  const { records, posts, fetch, refresh } = show(checkable);
  const base = fetch.getMockImplementation()!;
  let rejectPackage = true;
  fetch.mockImplementation(async (url, init) => {
    if (init?.method === "POST" && JSON.parse(String(init.body)).action === "check_packages" && rejectPackage) {
      posts.push("check_packages");
      return json({ error: "internal_error" }, 503);
    }
    return base(url, init);
  });
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  await waitFor(() => expect(client.getQueryData(["host-packages", host.id])).toEqual(checkable));
  fireEvent.click(button);
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry package check" });
  expect(screen.getByText(/The image check was accepted/)).toBeTruthy();
  expect(retry.disabled).toBe(true);
  records.set("j1", job("j1", "check_updates", "succeeded"));
  await refresh();
  await waitFor(() => expect(retry.disabled).toBe(false));
  rejectPackage = false;
  fireEvent.click(retry);
  await waitFor(() => expect(posts).toEqual(["check_updates", "check_packages", "check_packages"]));
  expect(await screen.findByText("Package check: Queued")).toBeTruthy();
  records.set("j3", job("j3", "check_packages", "succeeded"));
  await refresh();
  const again = screen.getByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  await waitFor(() => expect(again.disabled).toBe(false));
  fireEvent.click(again);
  await waitFor(() =>
    expect(posts).toEqual(["check_updates", "check_packages", "check_packages", "check_updates", "check_packages"]),
  );
});

it("keeps a status-read failure separate from action retry and recovers by refreshing the same job", async () => {
  const { records, posts, fetch } = show();
  const base = fetch.getMockImplementation()!;
  let unavailable = true;
  fetch.mockImplementation((url, init) =>
    String(url).startsWith("/api/jobs/") && unavailable
      ? Promise.resolve(json({ error: "internal_error" }, 503))
      : base(url, init),
  );
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  fireEvent.click(button);
  expect(
    await screen.findByText("Check status is unavailable. Refresh status before requesting another check."),
  ).toBeTruthy();
  expect(button.disabled).toBe(true);
  unavailable = false;
  records.set("j1", job("j1", "check_updates", "succeeded"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh check status" }));
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(posts).toEqual(["check_updates"]);
});

it("allows submission retry when the first request was refused without a confirmed accepted job", async () => {
  const { posts, fetch } = show(checkable);
  const base = fetch.getMockImplementation()!;
  let refused = true;
  fetch.mockImplementation((url, init) =>
    init?.method === "POST" && refused ? Promise.resolve(json({ error: "internal_error" }, 503)) : base(url, init),
  );
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  await waitFor(() => expect(client.getQueryData(["host-packages", host.id])).toEqual(checkable));
  fireEvent.click(button);
  await screen.findByRole("alert");
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(posts).toEqual([]);
  refused = false;
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_updates", "check_packages"]));
});

it("observes completion through fallback polling without an SSE event", async () => {
  const { records, posts } = show();
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  fireEvent.click(button);
  await screen.findByText("Image check: Queued");
  records.set("j1", job("j1", "check_updates", "succeeded"));
  await waitFor(() => expect(button.disabled).toBe(false), { timeout: 4000 });
  expect(posts).toEqual(["check_updates"]);
});

it.each([
  { ...checkable, facts: { ...checkable.facts!, setting: "off" as const } },
  { ...checkable, facts: { ...checkable.facts!, unsupported: "no_systemd" as const } },
])("omits package submission when the host does not permit checking its packages", async (view) => {
  const { posts } = show(view);
  const button = await screen.findByRole("button", { name: "Check for updates" });
  await waitFor(() => expect(client.getQueryData(["host-packages", host.id])).toEqual(view));
  fireEvent.click(button);
  await screen.findByText("Image check: Queued");
  expect(posts).toEqual(["check_updates"]);
});

it("derives the host's active tab from a same-page router navigation", async () => {
  const { router } = show();
  const nav = await screen.findByRole("navigation", { name: TEXT.hosts.tabs.label });
  await act(() => router.navigate("#updates"));
  expect(
    within(nav)
      .getByRole("link", { name: /^Updates/ })
      .getAttribute("aria-current"),
  ).toBe("true");
});

it("underlines the section scrolled to, until a tab jumps somewhere else", async () => {
  const { router } = show();
  const nav = await screen.findByRole("navigation", { name: TEXT.hosts.tabs.label });
  const current = () => nav.querySelector('[aria-current="true"]')?.textContent;
  const placed = (["updates", "dependencies", "control"] as const).map((section, index) =>
    vi
      .spyOn(document.getElementById(section)!, "getBoundingClientRect")
      .mockReturnValue({ top: index * window.innerHeight } as DOMRect),
  );

  fireEvent.scroll(window);
  expect(current()).toMatch(/^Updates/);

  await act(() => router.navigate("#dependencies"));
  await waitFor(() => expect(current()).toMatch(/^Dependencies/));
  placed.forEach((spy) => spy.mockRestore());
});

it("keeps host tab highlighting on the browser URL through native clicks, Back/Forward and another same-page link", async () => {
  show(packageView, "#containers");
  const nav = await screen.findByRole("navigation", { name: TEXT.hosts.tabs.label });
  const selected = (name: string) => {
    expect(
      within(nav)
        .getByRole("link", { name: new RegExp(`^${name}`) })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(nav.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  };
  selected(TEXT.hosts.tabs.containers);
  const updates = within(nav).getByRole("link", { name: TEXT.hosts.tabs.updates });
  expect(updates.getAttribute("href")).toBe("#updates");
  fireEvent.click(updates);
  await waitFor(() => {
    expect(window.location.hash).toBe("#updates");
    selected(TEXT.hosts.tabs.updates);
  });
  await act(async () => window.history.back());
  await waitFor(() => {
    expect(window.location.hash).toBe("#containers");
    selected(TEXT.hosts.tabs.containers);
  });
  await act(async () => window.history.forward());
  await waitFor(() => {
    expect(window.location.hash).toBe("#updates");
    selected(TEXT.hosts.tabs.updates);
  });
  fireEvent.click(screen.getByRole("link", { name: "Other link to host control" }));
  await waitFor(() => selected(TEXT.hosts.tabs.control));
  await act(async () => {
    window.location.hash = "not-a-section";
  });
  await waitFor(() => selected(TEXT.hosts.tabs.overview));
  await act(async () => {
    window.location.hash = "";
  });
  await waitFor(() => selected(TEXT.hosts.tabs.overview));
});

it("says in its title that the host's runner holds its automatic recovery, and why", async () => {
  show(packageView, undefined, { ...host, recoveryHold: { reason: "state_full", until: null } });
  const title = await screen.findByRole("heading", { level: 1, name: host.label });
  const held = within(title.parentElement!).getByText(TEXT.hosts.recoveryHeld);
  expect(held.className).toBe("badge danger");
  expect(held.title).toBe(TEXT.hosts.recoveryHeldWhy.state_full);
});

it("offers to switch a runner host to SSH, but not the machine Autoheal runs on", async () => {
  show();
  fireEvent.click(await screen.findByText(TEXT.ssh.add.switchTitle));
  expect(await screen.findByText(TEXT.ssh.add.switchExplanation)).toBeTruthy();
  cleanup();

  localHostId = host.id;
  show();
  await waitFor(() => expect(client.getQueryState(localHostQuery.queryKey)?.status).toBe("success"));
  expect(screen.queryByText(TEXT.ssh.add.switchTitle)).toBeNull();
});

it("leaves out operating system updates on a host whose runner reads only its containers", async () => {
  show(checkable, undefined, { ...host, health: hostHealthWithout });
  // Its containers' images still are; its packages, read for the rest of the page, are not shown.
  await screen.findByRole("heading", { name: TEXT.containerImages.heading });
  await waitFor(() => expect(client.getQueryState(hostPackagesQuery(host.id).queryKey)?.status).toBe("success"));
  expect(document.getElementById("host-packages-title")).toBeNull();
});

it("says how the machine Autoheal runs on is looked after, why it waits, and offers no switch to SSH", async () => {
  localHostId = "h0";
  const waiting = "its Autoheal runner container still runs here: remove it";
  show(packageView, undefined, { ...host, kind: "local", inPlace: { problem: waiting } });
  expect(await screen.findByText(waiting, { selector: "p.notice" })).toBeTruthy();
  // Not even asked which machine Autoheal runs on: a host looked after in place is never a runner host.
  expect(screen.queryByText(TEXT.ssh.add.switchTitle)).toBeNull();
});

it("tells how to bring a runner on another version level with Autoheal", async () => {
  show(packageView, undefined, { ...host, runnerVersion: "1.9.0" });
  expect(await screen.findByText(TEXT.ssh.runnerBehind("1.9.0", AUTOHEAL_VERSION))).toBeTruthy();
  expect(screen.getByText(RUNNER_UPDATE_COMMAND)).toBeTruthy();
});

it("checks only the packages of a host without Docker: it has no images to check", async () => {
  const { posts } = show(checkable, undefined, { ...host, kind: "ssh", docker: false });
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Check for updates" });
  // Nothing to ask for until its packages are known to be checkable.
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_packages"]));
  expect(await screen.findByText("Package check: Queued")).toBeTruthy();
  expect(screen.queryByText(/^Image check/)).toBeNull();
  // Its updates are its packages': no container images, and no image rollout across hosts.
  expect(screen.queryByRole("heading", { name: TEXT.containerImages.title })).toBeNull();
  expect(screen.queryByText("Staged cross-host rollout")).toBeNull();
  expect(screen.getByRole("heading", { name: TEXT.hostPackages.title })).toBeTruthy();
});

it("shows a host without Docker its system and packages alone, and all of its containers' sections once it has Docker", async () => {
  const tabNames = () =>
    within(screen.getByRole("navigation", { name: TEXT.hosts.tabs.label }))
      .getAllByRole("link")
      .map((link) => link.textContent);
  show(checkable, undefined, { ...host, kind: "ssh", docker: false });
  await screen.findByRole("heading", { name: TEXT.hostPackages.title });
  expect(tabNames()).toEqual([TEXT.hosts.tabs.overview, TEXT.hosts.tabs.updates]);
  for (const section of ["containers", "dependencies", "control"]) {
    expect(document.getElementById(section)).toBeNull();
  }
  cleanup();

  // Docker installed since: the host reports it, and they are all back.
  show(checkable, undefined, { ...host, kind: "ssh", docker: true });
  await screen.findByRole("heading", { name: TEXT.hostPackages.title });
  expect(tabNames()).toEqual([
    TEXT.hosts.tabs.overview,
    expect.stringMatching(new RegExp(`^${TEXT.hosts.tabs.containers}`)),
    TEXT.hosts.tabs.updates,
    TEXT.hosts.tabs.dependencies,
    TEXT.hosts.tabs.control,
  ]);
  expect(document.getElementById("containers")).not.toBeNull();
});

it("offers a terminal where the host's runner can open one, and says why it cannot elsewhere", async () => {
  const terminalButton = async () => screen.findByRole<HTMLButtonElement>("button", { name: TEXT.hostTerminal.button });
  show(packageView, undefined, { ...host, hostTerminal: true });
  expect((await terminalButton()).disabled).toBe(false);
  cleanup();
  const reasons = [
    [{ hostTerminal: false }, TEXT.hostTerminal.unavailable.off(host.label)],
    [{}, TEXT.hostTerminal.unavailable.runner(host.label)],
    [{ hostTerminal: true, state: "silent" as const }, TEXT.hostTerminal.unavailable.silent(host.label)],
  ] as const;
  for (const [shown, why] of reasons) {
    show(packageView, undefined, { ...host, ...shown });
    const button = await terminalButton();
    expect([button.disabled, button.title]).toEqual([true, why]);
    cleanup();
  }
});

it("puts the stats history right under the dials, folded away until opened", async () => {
  show();
  const fold = (await screen.findByText(TEXT.metrics.statsHistory)).closest("details")!;
  expect(fold.open).toBe(false);
  expect(fold.closest(`#${HOST_SECTIONS.overview}`)).not.toBeNull();
  // The dials come first; nothing stands between them and the fold.
  expect(fold.previousElementSibling?.className).toContain("section stack");
  expect(screen.queryByText(TEXT.metrics.history)).toBeNull();
});

it("leads back to the container list from the page's Containers tab", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: `${TEXT.hostNetworks.chip} 0` }));
  expect(screen.getByRole("heading", { name: new RegExp(`^${TEXT.hostNetworks.title}`) })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: new RegExp(`^${TEXT.hosts.tabs.containers}`) }));
  expect(await screen.findByRole("heading", { name: new RegExp(`^${TEXT.hostContainers.title}`) })).toBeTruthy();
});

it("puts a host's old images in its containers' section, right after the container list", async () => {
  show();
  const images = await screen.findByRole("region", { name: TEXT.hostImages.title });
  const containers = images.closest(`#${HOST_SECTIONS.containers}`)!;
  expect(containers).not.toBeNull();
  expect(images.previousElementSibling).toBe(containers.querySelector(".host-containers"));
});

it("scrolls to the section a link from another page names, once the host is drawn", async () => {
  const scrolled: string[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push(this.id);
  });
  show(undefined, "#updates");
  await waitFor(() => expect(scrolled).toContain("updates"));
});

describe("the almost-full disks banner", () => {
  const BYTES = 1_000_000_000;
  const diskAt = (path: string, used: number) => ({
    path,
    totalBytes: 100 * BYTES,
    usedBytes: used * BYTES,
    availableBytes: (100 - used) * BYTES,
  });
  const fullHost = {
    ...host,
    health: { ...hostHealthWithout, disks: [diskAt("/mnt/storage", 99), diskAt("/mnt/fast", 96)] },
  };
  const taskOn = (path: string, snoozedUntil: number | null = null) => ({
    id: `task-${path.split("/").at(-1)}`,
    title: `${path} is full`,
    priority: "high",
    labels: ["disk"],
    updatedAt: 1,
    snoozedUntil,
    resource: { kind: "disk", id: path, label: path },
  });
  beforeEach(() => {
    taskChanges = [];
  });
  afterEach(() => {
    openTasks = [];
  });

  it("snoozes every disk it names at one press", async () => {
    openTasks = [taskOn("/mnt/storage"), taskOn("/mnt/fast")];
    show(undefined, undefined, fullHost);

    fireEvent.click(await screen.findByRole("button", { name: "Snooze 3 months" }));

    await waitFor(() => expect(taskChanges).toHaveLength(2));
    expect(taskChanges).toEqual(
      expect.arrayContaining([
        ["task-storage", '{"snoozed":"3_months"}'],
        ["task-fast", '{"snoozed":"3_months"}'],
      ]),
    );
  });

  it("leaves out a snoozed disk, and goes once all are", async () => {
    const later = Date.now() + 1_000_000;
    openTasks = [taskOn("/mnt/storage", later), taskOn("/mnt/fast")];
    show(undefined, undefined, fullHost);
    const banner = (await screen.findByRole("button", { name: "Snooze 1 month" })).closest(".banner")!;
    expect(banner.textContent).toContain("/mnt/fast");
    expect(banner.textContent).not.toContain("/mnt/storage");
    cleanup();

    openTasks = [taskOn("/mnt/storage", later), taskOn("/mnt/fast", later)];
    show(undefined, undefined, fullHost);
    await waitFor(() => expect(client.getQueryData(["tasks", "host", host.id])).toHaveLength(2));
    await waitFor(() => expect(document.querySelector(".banner.danger")).toBeNull());
  });

  it("offers no snooze before its disks have tasks, and still warns", async () => {
    show(undefined, undefined, fullHost);
    await waitFor(() => expect(client.getQueryData(["tasks", "host", host.id])).toEqual([]));
    expect(document.querySelector(".banner.danger")?.textContent).toContain("/mnt/storage");
    expect(screen.queryByRole("button", { name: "Snooze 1 month" })).toBeNull();
  });
});
