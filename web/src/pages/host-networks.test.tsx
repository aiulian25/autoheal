import { TEXT } from "../constants.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type ContainerView,
  type HostNetworksView,
  type HostView,
  type JobView,
  type SessionView,
} from "../../../src/shared/api.js";
import type { NetworkReport } from "../../../src/shared/networks.js";
import { SESSION_QUERY_KEY } from "../constants.js";
import { HostNetworks, LeftBehindOffer, NetworksChip, NetworksHeading } from "./host-networks.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const NETWORKS_URL = apiPath(API_ROUTES.hostNetworks, { hostId: "h1" });
const ACTIONS_URL = apiPath(API_ROUTES.hostActions, { hostId: "h1" });

const network = (overrides: Partial<NetworkReport>): NetworkReport => ({
  name: "wyrmrss_default",
  driver: "bridge",
  subnet: "192.168.96.0/20",
  gateway: "192.168.96.1",
  internal: false,
  project: "wyrmrss",
  projectHere: false,
  own: false,
  members: [],
  ...overrides,
});
const running = (name: string) => ({ name, running: true, address: "192.168.16.7" });
const NETWORKS = [
  network({ name: "npm", project: null, subnet: "192.168.16.0/20", members: [running("radicale")] }),
  network({}),
  network({ name: "by-hand", project: null }),
  network({ name: "linkwarden_default", project: "linkwarden", projectHere: true }),
  network({ name: "autoheal-runner_default", members: [{ name: "autoheal", running: false, address: "" }] }),
  network({ name: "autoheal_default", own: true, members: [running("autoheal-self")] }),
  network({ name: "bridge", project: null }),
];
const host = {
  id: "h1",
  label: "DeltaAv1",
  dryRun: false,
  containerAccess: true,
} as HostView;
const job = (overrides: Partial<JobView>) =>
  ({ id: "j1", status: "pending", outcome: null, output: null, ...overrides }) as JobView;

let view: HostNetworksView;
let posts: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  view = { networks: NETWORKS, lastJob: null };
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return answer(job({}));
      }
      if (url === NETWORKS_URL) return answer(view);
      const containers = [
        { name: "radarr", handsOff: null },
        { name: "radicale", handsOff: null },
      ] as ContainerView[];
      return answer(url.startsWith(API_ROUTES.containers) ? containers : []);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const headed = (
  <>
    <NetworksHeading host={host} />
    <HostNetworks host={host} admin />
  </>
);

function show(element = headed) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
const row = (name: string) => screen.getByText(name).closest("tr")!;
const removal = (names: string[], evenIfStoppedNeedIt = false) => ({
  url: ACTIONS_URL,
  body: { action: "remove_networks", removal: { names, evenIfStoppedNeedIt } },
});

describe("a host's networks", () => {
  it("lists what needs a person first, and says what each is", async () => {
    show();
    await screen.findByRole("region", { name: /Networks/ });

    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((each) => each.querySelector("td.mono")?.textContent);
    expect(names).toEqual([
      "wyrmrss_default",
      "by-hand",
      "linkwarden_default",
      "autoheal-runner_default",
      "npm",
      "autoheal_default",
      "bridge",
    ]);
    expect(within(row("wyrmrss_default")).getByText("Left behind · its containers are gone")).toBeTruthy();
    expect(within(row("by-hand")).getByText("Empty · nothing asks for it")).toBeTruthy();
    expect(within(row("linkwarden_default")).getByText("Empty · linkwarden is still here")).toBeTruthy();
    expect(within(row("autoheal-runner_default")).getByText("Kept for a stopped container")).toBeTruthy();
    expect(within(row("autoheal-runner_default")).getByText("autoheal · stopped")).toBeTruthy();
    expect(within(row("npm")).getByText("In use · 1")).toBeTruthy();
    expect(within(row("bridge")).getByText("Docker's own")).toBeTruthy();
    expect(within(row("autoheal_default")).getByText("Autoheal's own")).toBeTruthy();
  });

  it("filters, each chip counting what it shows", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Not used 3" }));
    expect(screen.queryByText("npm")).toBeNull();
    expect(screen.getByText("wyrmrss_default")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Docker's own 1" }));
    expect(screen.queryByText("wyrmrss_default")).toBeNull();
    expect(screen.getByText("bridge")).toBeTruthy();
    expect(screen.getByRole("button", { name: "In use 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All 7" })).toBeTruthy();
  });

  it("cleans up in one click, leaving what an app still here made and what a stopped container needs", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Clean up 2 left behind" }));
    await waitFor(() => expect(posts).toEqual([removal(["wyrmrss_default", "by-hand"])]));
  });

  it("brings the bar with a tick, and only what can go has a tick", async () => {
    show();
    await screen.findByRole("region", { name: /Networks/ });
    expect(screen.queryByRole("group", { name: "Act on the ticked networks" })).toBeNull();
    expect(within(row("npm")).queryByRole("checkbox")).toBeNull();
    expect(within(row("bridge")).queryByRole("checkbox")).toBeNull();
    expect(within(row("autoheal-runner_default")).queryByRole("checkbox")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tick wyrmrss_default" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick linkwarden_default" }));
    const bar = screen.getByRole("group", { name: "Act on the ticked networks" });
    expect(bar.classList.contains("action-bar")).toBe(true);
    fireEvent.click(within(bar).getByRole("button", { name: "Remove 2" }));

    await waitFor(() => expect(posts).toEqual([removal(["wyrmrss_default", "linkwarden_default"])]));
  });

  it("asks first about one a stopped container needs, and offers no bin where something runs or is locked", async () => {
    show();
    await screen.findByRole("region", { name: /Networks/ });
    const bin = (name: string) =>
      within(row(name)).queryByRole("button", { name: `Remove ${name}` }) as HTMLButtonElement | null;
    expect(bin("npm")?.disabled).toBe(true);
    expect(bin("bridge")).toBeNull();
    expect(bin("autoheal_default")).toBeNull();

    fireEvent.click(bin("autoheal-runner_default")!);
    expect(screen.getByRole("alert").textContent).toContain("autoheal would not start again without it");
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(bin("autoheal-runner_default")!);
    fireEvent.click(screen.getByRole("button", { name: "Remove anyway" }));
    await waitFor(() => expect(posts).toEqual([removal(["autoheal-runner_default"], true)]));
  });

  it("removes an empty one from its row at once", async () => {
    show();
    await screen.findByRole("region", { name: /Networks/ });
    fireEvent.click(within(row("by-hand")).getByRole("button", { name: "Remove by-hand" }));
    await waitFor(() => expect(posts).toEqual([removal(["by-hand"])]));
  });

  it("opens one in place, moving containers on and off it live", async () => {
    show();
    await screen.findByRole("region", { name: /Networks/ });
    fireEvent.click(within(row("npm")).getByRole("button", { name: "Open npm" }));

    expect(screen.getByText("only on this one")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "radarr" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
    const joined = { name: "npm", joined: true };
    await waitFor(() => expect(posts.map(({ body }) => body)).toEqual([joined]));
    expect(posts[0]!.url).toBe(apiPath(API_ROUTES.containerNetwork, { hostId: "h1", containerName: "radarr" }));

    fireEvent.click(screen.getByRole("button", { name: "Take off" }));
    await waitFor(() => expect(posts.at(-1)?.body).toEqual({ name: "npm", joined: false }));
  });

  it("changes nothing for one who may not, or on a host that only watches", async () => {
    show(
      <>
        <NetworksHeading host={host} />
        <HostNetworks host={{ ...host, dryRun: true }} admin />
      </>,
    );
    await screen.findByText("This host only watches, so its networks can be seen but not changed.");
    expect(screen.queryByRole("button", { name: "New network" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Clean up/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("says when its runner does not report them yet", async () => {
    view = { networks: null, lastJob: null };
    show();
    expect(await screen.findByText(/does not report its networks yet/)).toBeTruthy();
  });

  it("makes a new one, with only its name to type", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New network" }));
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "npm" } });
    expect(screen.getByText("A network with that name is already here")).toBeTruthy();
    expect(create.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "media" } });
    expect(screen.getByText("Name is free")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "radarr" }));
    fireEvent.click(create);

    await waitFor(() =>
      expect(posts).toEqual([
        {
          url: ACTIONS_URL,
          body: {
            action: "create_network",
            network: {
              name: "media",
              driver: "bridge",
              internal: false,
              subnet: null,
              parent: null,
              containers: ["radarr"],
            },
          },
        },
      ]),
    );
  });

  it("checks addresses a person writes against what is there", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New network" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "media" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Addresses" })).getByRole("button", { name: "Other…" }));
    const range = screen.getByRole("textbox", { name: "Range" });
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;

    fireEvent.change(range, { target: { value: "nonsense" } });
    expect(screen.getByText("Write addresses like 172.40.0.0/16")).toBeTruthy();
    fireEvent.change(range, { target: { value: "192.168.16.0/24" } });
    expect(screen.getByText("Those addresses clash with npm")).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.change(range, { target: { value: "172.40.0.0/16" } });
    expect(screen.getByText("Addresses do not clash with its other networks")).toBeTruthy();
    expect(create.disabled).toBe(false);
  });

  it("shows Docker's words when a removal fails, with the way to the network", async () => {
    view = {
      networks: NETWORKS,
      lastJob: job({ status: "failed", outcome: "Could not remove npm. active endpoints" }),
    };
    show();
    await screen.findByRole("region", { name: /Networks/ });
    fireEvent.click(within(row("by-hand")).getByRole("button", { name: "Remove by-hand" }));
    expect(await screen.findByText(/Could not remove npm/)).toBeTruthy();
  });
});

describe("the button beside the containers' filters", () => {
  const chip = (onOpen = vi.fn()) => <NetworksChip hostId="h1" active={false} onOpen={onOpen} />;

  it("says what was left behind, and opens on it", async () => {
    const onOpen = vi.fn();
    show(chip(onOpen));
    fireEvent.click(await screen.findByRole("button", { name: "Networks 2 left behind" }));
    expect(onOpen).toHaveBeenCalledWith(true);
  });

  it("counts them when nothing was left behind", async () => {
    view = { networks: [network({ project: "x", projectHere: true })], lastJob: null };
    const onOpen = vi.fn();
    show(chip(onOpen));
    fireEvent.click(await screen.findByRole("button", { name: "Networks 1" }));
    expect(onOpen).toHaveBeenCalledWith(false);
  });
});

describe("opened from the button", () => {
  it("goes straight to what was left behind when asked", async () => {
    show(<HostNetworks host={host} admin leftAsked={1} />);
    const chosen = await screen.findByRole("button", { name: /^Not used/ });
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows only what Find holds, and says when that is nothing", async () => {
    show(<HostNetworks host={host} admin find="no such network" />);
    expect(await screen.findByText(TEXT.hostNetworks.nothingFound)).toBeTruthy();
  });
});

describe("the offer after removing an app's containers", () => {
  it("names only what those containers' projects left, and removes it in one more click", async () => {
    view = { networks: [network({}), network({ name: "other_default", project: "other" })], lastJob: null };
    show(<LeftBehindOffer hostId="h1" projects={["wyrmrss"]} />);
    expect(await screen.findByText("They left a network behind: wyrmrss_default.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove it too" }));
    await waitFor(() => expect(posts).toEqual([removal(["wyrmrss_default"])]));
    expect(screen.queryByText(/They left/)).toBeNull();
  });

  it("goes away when kept", async () => {
    show(<LeftBehindOffer hostId="h1" projects={["wyrmrss"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep it" }));
    expect(screen.queryByText(/They left/)).toBeNull();
    expect(posts).toEqual([]);
  });
});
