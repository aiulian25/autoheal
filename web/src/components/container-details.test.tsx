import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContainerView } from "../../../src/shared/api.js";
import type { ContainerDetailsView, SettingsAnswer } from "../../../src/shared/protocol.js";
import { ContainerDetailTabs, type DetailTab } from "./container-details.js";

const SETTINGS = "/api/inventory/hosts/h1/containers/app/settings";
const details: ContainerDetailsView = {
  imageId: "sha256:9f47dcf5ec3c0000000000",
  createdAt: "2026-10-26T09:14:00Z",
  startedAt: "2026-10-31T00:40:00Z",
  command: ["node", "server.js"],
  workingFolder: "/app",
  user: "",
  hostname: "app",
  networks: [{ name: "newt", address: "172.20.0.7", gateway: "172.20.0.1", aliases: ["app"] }],
  availableNetworks: ["newt", "npm"],
  mounts: [{ kind: "bind", source: "/srv/app/data", target: "/data", readOnly: true }],
  security: {
    privileged: true,
    capabilitiesAdded: [],
    capabilitiesDropped: ["ALL"],
    readOnlyRoot: false,
    noNewPrivileges: true,
    appArmor: "",
    seccomp: "",
    dockerSocket: false,
  },
  resources: { cpuCores: null, memoryBytes: null, processes: null, oomKilled: false },
  health: null,
  processes: { titles: ["PID", "CMD"], rows: [["7", "node server.js"]] },
  layers: [{ sizeBytes: 1024, createdAt: 1, step: "COPY dist /app" }],
};
const container = {
  hostId: "h1",
  name: "app",
  image: "ghcr.io/example/app:latest",
  composeProject: null,
  version: null,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  ports: [],
  usage: null,
} as unknown as ContainerView;

let answers: Record<string, SettingsAnswer>;
const asked: string[] = [];
const posted: object[] = [];

beforeEach(() => {
  asked.length = 0;
  posted.length = 0;
  answers = {
    [`${SETTINGS}?details=true`]: { error: null, settings: null, details },
    [SETTINGS]: {
      error: null,
      settings: {
        environment: [
          { name: "TZ", value: "Europe/Lisbon" },
          { name: "API_TOKEN", value: "a-secret" },
        ],
        labels: [{ name: "stack", value: "one" }],
        ports: [],
        mounts: [],
        restart: { policy: "no", retries: 0 },
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push(url);
      if (init?.method === "POST") posted.push(JSON.parse(String(init.body)) as object);
      return new Response(JSON.stringify(answers[url] ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Tabs() {
  const [tab, setTab] = useState<DetailTab>("overview");
  return <ContainerDetailTabs container={container} tab={tab} onTab={setTab} trend={<p>the trend</p>} />;
}
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Tabs />
    </QueryClientProvider>,
  );
const open = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

it("opens on Overview, reading no settings until a tab needs them", async () => {
  show();
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByText("node server.js")).toBeTruthy();
  expect(asked).not.toContain(SETTINGS);
  expect(screen.getAllByRole("tab")).toHaveLength(12);
});

it("shows each topic in its own tab, with its count", async () => {
  show();
  await screen.findByText("node server.js");
  open(/^Layers/);
  expect(await screen.findByText("COPY dist /app")).toBeTruthy();
  open(/^Processes/);
  expect(await screen.findByText("7")).toBeTruthy();
  open(/^Network/);
  expect(await screen.findByText("172.20.0.7")).toBeTruthy();
  open(/^Mounts/);
  expect(await screen.findByText("/srv/app/data")).toBeTruthy();
  expect(screen.getByText("read only")).toBeTruthy();
  open(/^Security/);
  expect(await screen.findByText("root")).toBeTruthy();
  open(/^Resources/);
  expect(await screen.findByText("the trend")).toBeTruthy();
  open(/^Health/);
  expect(await screen.findByText("It has no health check.")).toBeTruthy();
});

it("keeps what looks like a secret hidden until asked, and reads the environment only there", async () => {
  show();
  await screen.findByText("node server.js");
  open(/^Environment/);
  expect(await screen.findByText("Europe/Lisbon")).toBeTruthy();
  expect(asked).toContain(SETTINGS);
  expect(screen.queryByText("a-secret")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "show" }));
  expect(screen.getByText("a-secret")).toBeTruthy();
});

it("says so when its runner is too old to tell, or why it could not", async () => {
  answers[`${SETTINGS}?details=true`] = { error: null, settings: null, details: null };
  show();
  open(/^Layers/);
  expect(await screen.findByText(/older than this/)).toBeTruthy();
  cleanup();

  answers[`${SETTINGS}?details=true`] = { error: "This host's .env keeps people out", settings: null, details: null };
  show();
  open(/^Layers/);
  expect(await screen.findByText(/keeps people out/)).toBeTruthy();
});

const NETWORKS = "/api/inventory/hosts/h1/containers/app/networks";

it("joins a network with a click, and shows what it is on as the runner answers", async () => {
  answers[NETWORKS] = {
    error: null,
    settings: null,
    details: { ...details, networks: [...details.networks, { name: "npm", address: "1", gateway: "1", aliases: [] }] },
  };
  show();
  await screen.findByText("node server.js");
  open(/^Network/);
  const npm = await screen.findByRole("button", { name: "npm" });
  expect(npm.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "newt" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(npm);
  expect((await screen.findByRole("button", { name: "npm", pressed: true })).getAttribute("aria-pressed")).toBe("true");
  expect(posted).toEqual([{ name: "npm", joined: true }]);
});

it("takes it off a network with another click, and says why when it cannot", async () => {
  answers[NETWORKS] = { error: "This is its only network.", settings: null, details: null };
  show();
  await screen.findByText("node server.js");
  open(/^Network/);
  fireEvent.click(await screen.findByRole("button", { name: "newt" }));
  expect(await screen.findByText("This is its only network.")).toBeTruthy();
  expect(posted).toEqual([{ name: "newt", joined: false }]);
  expect(screen.getByRole("button", { name: "newt" }).getAttribute("aria-pressed")).toBe("true");
});

it("says so where it cannot join anything, or its runner is too old to offer", async () => {
  answers[`${SETTINGS}?details=true`] = {
    error: null,
    settings: null,
    details: { ...details, availableNetworks: [], networkMode: "host" },
  };
  show();
  await screen.findByText("node server.js");
  open(/^Network/);
  expect(await screen.findByText(/network mode host/)).toBeTruthy();
  cleanup();

  const { availableNetworks: _left, ...older } = details;
  answers[`${SETTINGS}?details=true`] = { error: null, settings: null, details: older };
  show();
  await screen.findByText("node server.js");
  open(/^Network/);
  expect(await screen.findByText(/older than this/)).toBeTruthy();
});

it("offers to take away only what Autoheal installed, asking about its data", async () => {
  show();
  await screen.findByText("node server.js");
  expect(screen.queryByRole("button", { name: "Take it away" })).toBeNull();
  cleanup();

  answers[`${SETTINGS}?details=true`] = {
    error: null,
    settings: null,
    details: { ...details, installedIn: "/home/me/docker/app" },
  };
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Take it away" }));
  expect(screen.getByText(/Its data is in \/home\/me\/docker\/app/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep its data" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove its data too" }));
  await waitFor(() => expect(posted).toEqual([{ name: "app", removeData: true }]));
});
