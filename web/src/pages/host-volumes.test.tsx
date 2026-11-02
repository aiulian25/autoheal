import { TEXT } from "../constants.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type HostVolumesView,
  type JobView,
  type SessionView,
} from "../../../src/shared/api.js";
import type { VolumeLookAnswer, VolumeReport } from "../../../src/shared/volumes.js";
import { SESSION_QUERY_KEY } from "../constants.js";
import { HostVolumes, VolumesChip, VolumesHeading, VolumesLeftOffer } from "./host-volumes.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const VOLUMES_URL = apiPath(API_ROUTES.hostVolumes, { hostId: "h1" });
const ACTIONS_URL = apiPath(API_ROUTES.hostActions, { hostId: "h1" });
const LOOK_URL = apiPath(API_ROUTES.hostVolumeLook, { hostId: "h1" });

const volume = (overrides: Partial<VolumeReport>): VolumeReport => ({
  name: "936121521c033724",
  driver: "local",
  sizeBytes: 0,
  createdAt: "2026-10-04T10:00:00Z",
  nameless: true,
  project: null,
  projectHere: false,
  own: false,
  ownedBy: null,
  members: [],
  ...overrides,
});
const VOLUMES = [
  volume({}),
  volume({ name: "charon_data", nameless: false, project: "charon", sizeBytes: 1_200_000_000 }),
  volume({ name: "old-backups", nameless: false }),
  volume({ name: "other-tool-cache", nameless: false, ownedBy: "Other Tool" }),
  volume({ name: "uncounted", sizeBytes: null }),
  volume({
    name: "quantum-data",
    nameless: false,
    members: [{ name: "quantum", running: false, destination: "/data" }],
  }),
  volume({
    name: "922ba92fe26f",
    sizeBytes: 239_500_000,
    members: [{ name: "handbrake", running: true, destination: "/output" }],
  }),
  volume({ name: "autoheal-guard-370", nameless: false, own: true }),
];
const host = { id: "h1", label: "DeltaAv1", dryRun: false, containerAccess: true } as HostView;
const job = (overrides: Partial<JobView>) =>
  ({ id: "j1", status: "pending", outcome: null, output: null, ...overrides }) as JobView;

let view: HostVolumesView;
let look: VolumeLookAnswer;
let posts: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  view = { volumes: VOLUMES, lastJob: null };
  look = { error: null, entries: [], partial: false };
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url === LOOK_URL) return answer(look);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return answer(job({}));
      }
      return answer(url === VOLUMES_URL ? view : []);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const headed = (
  <>
    <VolumesHeading host={host} />
    <HostVolumes host={host} admin />
  </>
);

function show(element = headed) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
const ready = () => screen.findByRole("region", { name: /Volumes/ });
const row = (text: string) => screen.getByText(text).closest("tr")!;
const removal = (names: string[], evenWithData = false) => ({
  url: ACTIONS_URL,
  body: { action: "remove_volumes", volumeRemoval: { names, evenWithData } },
});

describe("a host's volumes", () => {
  it("says what each is, with a short name for a nameless one and the folder it serves", async () => {
    show();
    await ready();

    expect(within(row("936121521c03")).getByText("Left behind · empty, its container is gone")).toBeTruthy();
    expect(within(row("charon_data")).getByText("Left behind · its containers are gone")).toBeTruthy();
    expect(within(row("charon_data")).getByText("1.2 GB")).toBeTruthy();
    expect(within(row("old-backups")).getByText("Not used · has a name, so someone may want it")).toBeTruthy();
    expect(within(row("other-tool-cache")).getByText("Other Tool's · leave it to Other Tool")).toBeTruthy();
    expect(within(row("uncounted".slice(0, 12))).getByText("not counted yet")).toBeTruthy();
    expect(within(row("quantum-data")).getByText("Kept for a stopped container")).toBeTruthy();
    expect(within(row("922ba92fe26f")).getByText("/output")).toBeTruthy();
    expect(within(row("autoheal-guard-370")).getByText("Autoheal's own · its safety records")).toBeTruthy();
  });

  it("filters, each chip counting what it shows", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Autoheal's own 1" }));
    expect(screen.queryByText("charon_data")).toBeNull();
    expect(screen.getByText("autoheal-guard-370")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not used 5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "In use 2" })).toBeTruthy();
  });

  it("cleans up in one click only what is nameless and known to be empty, without a yes", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Clean up 1 empty" }));
    await waitFor(() => expect(posts).toEqual([removal(["936121521c033724"])]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks before removing data, saying how much, and only then says yes to the host", async () => {
    show();
    await ready();
    fireEvent.click(within(row("charon_data")).getByRole("button", { name: "Remove charon_data" }));

    const question = screen.getByRole("alert");
    expect(question.textContent).toContain("Remove charon_data? Its 1.2 GB goes for good.");
    expect(question.textContent).toContain("Made by the Compose file of charon.");
    expect(posts).toEqual([]);
    fireEvent.click(within(question).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(posts).toEqual([]);

    fireEvent.click(within(row("charon_data")).getByRole("button", { name: "Remove charon_data" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove, data and all" }));
    await waitFor(() => expect(posts).toEqual([removal(["charon_data"], true)]));
  });

  it("asks too about what was never counted, what has a name, and another tool's", async () => {
    show();
    await ready();
    const ask = (name: string, label: string) => {
      fireEvent.click(within(row(label)).getByRole("button", { name: `Remove ${name}` }));
      const line = screen.getByRole("alert").textContent;
      fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
      return line;
    };
    expect(ask("uncounted", "uncounted")).toContain("has not been counted");
    expect(ask("old-backups", "old-backups")).toContain("It is empty, but someone may want it.");
    expect(ask("other-tool-cache", "other-tool-cache")).toContain("Other Tool made it and may need it.");
    expect(posts).toEqual([]);
  });

  it("offers no bin where a container is attached, nor anything on Autoheal's own", async () => {
    show();
    await ready();
    const bin = (name: string, label = name) =>
      within(row(label)).queryByRole("button", { name: `Remove ${name}` }) as HTMLButtonElement | null;
    expect(bin("quantum-data")?.disabled).toBe(true);
    expect(bin("922ba92fe26f")?.disabled).toBe(true);
    expect(bin("autoheal-guard-370")).toBeNull();
    expect(within(row("autoheal-guard-370")).queryByRole("checkbox")).toBeNull();
    expect(within(row("autoheal-guard-370")).queryByRole("button", { name: /Look inside/ })).toBeNull();
    expect(within(row("other-tool-cache")).queryByRole("checkbox")).toBeNull();
    expect(within(row("quantum-data")).queryByRole("checkbox")).toBeNull();
  });

  it("brings the bar with a tick, asking only if something ticked is not known to be empty", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick 936121521c033724" }));
    const bar = screen.getByRole("group", { name: "Act on the ticked volumes" });
    expect(bar.classList.contains("action-bar")).toBe(true);
    expect(within(bar).getByText("all empty, no question")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tick charon_data" }));
    expect(within(bar).queryByText("all empty, no question")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Remove 2" }));
    expect(screen.getByRole("alert").textContent).toContain("Remove 2 volumes? Their 1.2 GB goes for good.");
    expect(posts).toEqual([]);
  });

  it("opens one in place, and looks inside only when asked, one folder at a time", async () => {
    look = {
      error: null,
      partial: true,
      entries: [
        { path: "sessions", folder: true, sizeBytes: 0, modifiedAt: 1 },
        { path: "sessions/one", folder: false, sizeBytes: 2048, modifiedAt: 2 },
        { path: "config.json", folder: false, sizeBytes: 1024, modifiedAt: 3 },
      ],
    };
    show();
    await ready();
    fireEvent.click(within(row("922ba92fe26f")).getByRole("button", { name: "Open 922ba92fe26f" }));
    expect(screen.getByText("running")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === LOOK_URL)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Look inside" }));
    const files = await screen.findByRole("group", { name: "What the volume holds" });
    expect(within(files).getByText("config.json")).toBeTruthy();
    expect(within(files).getByText(/only the first part was read/)).toBeTruthy();
    expect(within(files).queryByText("one")).toBeNull();

    fireEvent.click(within(files).getByRole("button", { name: "Open sessions" }));
    expect(within(files).getByText("one")).toBeTruthy();
    expect(within(files).queryByText("config.json")).toBeNull();
    fireEvent.click(within(files).getByRole("button", { name: "Up a folder" }));
    expect(within(files).getByText("config.json")).toBeTruthy();
  });

  it("says why it could not look inside", async () => {
    look = { error: "Reaching inside containers and volumes is off in this host's .env.", entries: [], partial: false };
    show();
    await ready();
    fireEvent.click(within(row("charon_data")).getByRole("button", { name: "Look inside charon_data" }));
    expect(await screen.findByText(/off in this host's .env/)).toBeTruthy();
  });

  it("changes nothing on a host that only watches", async () => {
    show(
      <>
        <VolumesHeading host={host} />
        <HostVolumes host={{ ...host, dryRun: true }} admin />
      </>,
    );
    await screen.findByText("This host only watches, so its volumes can be seen but not changed.");
    expect(screen.queryByRole("button", { name: "New volume" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Clean up/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("says when its runner does not report them yet", async () => {
    view = { volumes: null, lastJob: null };
    show();
    expect(await screen.findByText(/does not report its volumes yet/)).toBeTruthy();
  });

  it("makes a new one with only its name to type, or on a share", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New volume" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "charon_data" } });
    expect(screen.getByText("A volume with that name is already here")).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "nas" } });
    expect(screen.getByText("Name is free")).toBeTruthy();
    expect(create.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /NFS share/ }));
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Address" }), { target: { value: "nas,uid=0" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Path" }), { target: { value: "/export" } });
    expect(screen.getByText(/Write an address like/)).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Address" }), { target: { value: "192.168.10.5" } });
    fireEvent.click(create);

    await waitFor(() =>
      expect(posts).toEqual([
        {
          url: ACTIONS_URL,
          body: {
            action: "create_volume",
            volume: { name: "nas", share: { kind: "nfs", address: "192.168.10.5", path: "/export" } },
          },
        },
      ]),
    );
  });
});

describe("the button beside the containers' filters", () => {
  const chip = (onOpen = vi.fn()) => <VolumesChip hostId="h1" active={false} onOpen={onOpen} />;

  it("counts only what is truly empty, and opens on it", async () => {
    const onOpen = vi.fn();
    show(chip(onOpen));
    fireEvent.click(await screen.findByRole("button", { name: "Volumes 1 empty" }));
    expect(onOpen).toHaveBeenCalledWith(true);
  });

  it("counts them all when none is empty", async () => {
    view = { volumes: [volume({ sizeBytes: 5 })], lastJob: null };
    const onOpen = vi.fn();
    show(chip(onOpen));
    fireEvent.click(await screen.findByRole("button", { name: "Volumes 1" }));
    expect(onOpen).toHaveBeenCalledWith(false);
  });
});

describe("opened from the button", () => {
  it("goes straight to what is not used when asked", async () => {
    show(<HostVolumes host={host} admin leftAsked={1} />);
    const chosen = await screen.findByRole("button", { name: /^Not used/ });
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows only what Find holds, and says when that is nothing", async () => {
    show(<HostVolumes host={host} admin find="no such volume" />);
    expect(await screen.findByText(TEXT.hostVolumes.nothingFound)).toBeTruthy();
  });
});

describe("the offer after removing containers", () => {
  it("removes only what is empty in one click, and points to the rest with its size", async () => {
    show(<VolumesLeftOffer hostId="h1" projects={["charon"]} names={["936121521c033724"]} onLook={vi.fn()} />);

    expect(await screen.findByText("They left 2 volumes behind: 1 empty, and charon_data, 1.2 GB.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove the empty one" }));

    await waitFor(() => expect(posts).toEqual([removal(["936121521c033724"])]));
    expect(screen.getByRole("button", { name: "Look at the other" })).toBeTruthy();
  });

  it("says nothing of volumes those containers never used, and goes away when kept", async () => {
    show(<VolumesLeftOffer hostId="h1" projects={["other"]} names={[]} onLook={vi.fn()} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText(/They left/)).toBeNull();
    cleanup();
    show(<VolumesLeftOffer hostId="h1" projects={["charon"]} names={[]} onLook={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep it" }));
    expect(screen.queryByText(/They left/)).toBeNull();
    expect(posts).toEqual([]);
  });
});
