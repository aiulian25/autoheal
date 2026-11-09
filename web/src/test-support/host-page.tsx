import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { BrowserRouter, createMemoryRouter, Link, Route, RouterProvider, Routes } from "react-router";
import { vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type ContainerView,
  type EnrolledHostView,
  type HostPackagesView,
  type HostView,
  type JobView,
  type SessionView,
  type SshHostDetailsView,
} from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY } from "../constants.js";
import { HostPage } from "../pages/host-page.js";

// The host page in tests: one host, what the dashboard answers about it, and showing the page.
export const session: SessionView = {
  user: { id: "u", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
export const host: HostView = {
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
export const hostHealthWithout = {
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
export const packageView: HostPackagesView = {
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
export const job = (
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
  stack: null,
});
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
export let client: QueryClient;
// An SSH host's details, as its Over SSH card reads them.
export const sshDetails: SshHostDetailsView = {
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
    hostTerminal: true,
    hostDeploy: true,
    hostFilesystems: [],
    hostPackages: "apply",
    checkpointLimitGigabytes: 2,
  },
  rootMethod: "sudo",
};
// The version the dashboard runs, as its settings give it.
export const AUTOHEAL_VERSION = "2.0.0";
// A new join code for the host, as the dashboard answers one.
export const MADE_JOIN_CODE: EnrolledHostView = {
  host,
  joinCode: "ahj_new",
  joinCodeExpiresAt: Date.UTC(2026, 10, 9, 15, 30),
  imageCopyCommand: null,
  installCommand: "docker compose up -d",
  rejoinCommand: "sed -i 's|^AUTOHEAL_JOIN=.*|AUTOHEAL_JOIN=ahj_new|' .env && docker compose up -d",
};
// What the page is answered with that a test may change before it shows the page: the host Autoheal runs on, the
// host's open tasks and the changes asked of them, and its containers as its runner last reported them.
export const answers = {
  localHostId: "h0" as string | null,
  openTasks: [] as Record<string, unknown>[],
  taskChanges: [] as [string, string][],
  hostContainers: [] as ContainerView[],
};

export function show(packages = packageView, browserHash?: string, shownHost = host) {
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
    if (url === apiPath(API_ROUTES.hostJoinCode, { hostId: host.id }) && init?.method === "POST")
      return json(MADE_JOIN_CODE);
    if (init?.method === "PATCH" && url.startsWith(`${API_ROUTES.tasks}/`)) {
      answers.taskChanges.push([url.split("/").at(-1)!, String(init.body)]);
      return json({});
    }
    if (url.startsWith(`${API_ROUTES.tasks}?`)) return json(answers.openTasks);
    if (url.startsWith(`${API_ROUTES.containers}?`)) return json(answers.hostContainers);
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
    if (url === API_ROUTES.localHost) return json({ hostId: answers.localHostId, revoked: false });
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

/** What each test leaves behind goes: the page, its cache, its stubs, and the answers it changed. */
export function resetHostPage() {
  answers.localHostId = "h0";
  answers.hostContainers = [];
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
}

export const IMAGES = "Check images";
export const PACKAGES = "Check packages";

export const checkable: HostPackagesView = {
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
