import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type ContainerView, type HostView, type SessionView } from "../../../src/shared/api.js";
import { SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { NewerVersions } from "./newer-versions.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const IGNORED = apiPath(API_ROUTES.hostIgnoredVersions, { hostId: "h1" });

// A host that acts, whose runner changes tags.
const alder = (overrides: Partial<HostView> = {}): HostView =>
  ({
    id: "h1",
    label: "Alder",
    state: "online",
    dryRun: false,
    containerAccess: true,
    hostDeploy: true,
    tagChanges: true,
    ...overrides,
  }) as HostView;

const pinned = (name: string, image: string, newerTag: string, overrides: Partial<ContainerView> = {}) =>
  ({
    hostId: "h1",
    hostLabel: "Alder",
    name,
    image,
    composeProject: name,
    handsOff: null,
    update: { status: "current", checkedAt: 1, policy: "ask", remote: null, reason: null, newerTag, ignored: null },
    byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: null },
    ...overrides,
  }) as ContainerView;

const APP = pinned("immich-server", "ghcr.io/immich-app/immich-server:v3.3.6", "v3.4.0");
const DATABASE = pinned("mealie-db", "postgres:16", "18", {
  byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: "database" },
});
const LOOSE = pinned("tool", "example/tool:1.0", "1.1", { composeProject: null });

function serve() {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.method === "PUT" ? null : { updates: 0, packages: 0, incidents: 0, tags: 1 };
    return body === null
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show(containers: ContainerView[], host = alder(), admin = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  render(
    <QueryClientProvider client={queryClient}>
      <NewerVersions host={host} admin={admin} containers={containers} />
    </QueryClientProvider>,
  );
}

const sent = (fetch: ReturnType<typeof serve>, url: string, body: object) =>
  waitFor(() => expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ body: JSON.stringify(body) })));

describe("newer versions on a host's page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hands one to the Ollama agent, or the ticked ones together", async () => {
    const fetch = serve();
    show([APP, LOOSE]);

    fireEvent.click(screen.getByRole("button", { name: "Hand the new version of immich-server to Ollama" }));
    const one = { hostId: "h1", container: "immich-server", tag: "v3.4.0" };
    await sent(fetch, API_ROUTES.agentDispatch, { updates: [], packages: [], incidents: [], tags: [one] });
    expect(await screen.findByText("Handed 1 to Ollama.")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tick the new version of immich-server" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick the new version of tool" }));
    const bar = screen.getByRole("group", { name: "Newer TAG versions" });
    // Only what the agent can move goes: tool runs from no Compose file.
    fireEvent.click(within(bar).getByRole("button", { name: "Hand 1 to Ollama" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === API_ROUTES.agentDispatch)).toHaveLength(2));
  });

  it("never offers a database's new major version, nor one its files do not hold, and says why", () => {
    serve();
    show([DATABASE, LOOSE]);
    const offered = (name: string) =>
      (screen.getByRole("button", { name: `Hand the new version of ${name} to Ollama` }) as HTMLButtonElement).disabled;
    expect(offered("mealie-db")).toBe(true);
    expect(offered("tool")).toBe(true);
    expect(screen.getByText(/needs a dump and a restore/)).toBeTruthy();
    expect(screen.getByText(/not started from a Compose file/)).toBeTruthy();
  });

  it("offers nothing to hand over where the host's runner cannot change a tag", () => {
    serve();
    show([APP], alder({ tagChanges: false }));
    const button = screen.getByRole("button", { name: "Hand the new version of immich-server to Ollama" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("ignores one version or every one, and lists what is ignored with a way back", async () => {
    const fetch = serve();
    const ignoredEvery = pinned("cache", "redis:7", "8", {
      update: {
        status: "current",
        checkedAt: 1,
        policy: "ask",
        remote: null,
        reason: null,
        newerTag: "8",
        ignored: "*",
      },
    });
    show([DATABASE, ignoredEvery]);

    fireEvent.click(screen.getByRole("button", { name: "Ignore new versions of mealie-db" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Ignore every new version of mealie-db/ }));
    await sent(fetch, IGNORED, { changes: [{ container: "mealie-db", version: "*" }] });

    fireEvent.click(screen.getByRole("button", { name: "Ignore new versions of mealie-db" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Ignore 18/ }));
    await sent(fetch, IGNORED, { changes: [{ container: "mealie-db", version: "18" }] });

    expect(screen.getByRole("heading", { name: "Ignored" })).toBeTruthy();
    expect(screen.getByText("every new version")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop ignoring new versions of cache" }));
    await sent(fetch, IGNORED, { changes: [{ container: "cache", version: null }] });
  });

  it("offers the ticked ones the same two choices as one row's menu, every new version included", async () => {
    const fetch = serve();
    show([APP, DATABASE]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick the new version of immich-server" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick the new version of mealie-db" }));
    fireEvent.click(screen.getByRole("button", { name: "Ignore 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Ignore every new version of the 2 ticked/ }));
    await sent(fetch, IGNORED, {
      changes: [
        { container: "immich-server", version: "*" },
        { container: "mealie-db", version: "*" },
      ],
    });
  });

  it("links each newer version to its release notes where its image names a known source, and others to nothing", () => {
    const sourced = pinned("immich-server", "ghcr.io/immich-app/immich-server:v3.3.6", "v3.4.0", {
      source: "https://github.com/immich-app/immich",
    });
    show([sourced, LOOSE]);
    const link = screen.getByRole("link", { name: TEXT.updates.releaseNotesOf("immich-server", "v3.4.0") });
    expect(link.getAttribute("href")).toBe("https://github.com/immich-app/immich/releases?q=3.4.0");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // The tool's image names no source: its row has no link.
    expect(screen.getAllByRole("link")).toEqual([link]);
  });

  it("shows a viewer the versions, with nothing to tick, hand over or ignore", () => {
    serve();
    show([APP], alder(), false);
    expect(screen.getByText("immich-server")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Hand/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ignore/ })).toBeNull();
  });
});
