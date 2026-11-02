import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostView, JobView } from "../../../src/shared/api.js";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { draftOf, type InstallAnswer } from "../../../src/shared/install.js";
import type { HostProfile } from "../../../src/shared/protocol.js";
import { AddContainer } from "./add-container.js";

const profile: HostProfile = {
  containers: 36,
  user: { value: "1000:1000", uses: 9, of: 9 },
  timeZone: { value: "Europe/Lisbon", uses: 10, of: 10 },
  restartPolicy: { value: "unless-stopped", uses: 31, of: 36 },
  composeFolder: { path: "/home/me/docker", projects: 25, of: 25 },
  mountsBesideCompose: 41,
  places: [],
  networks: [{ name: "npm", containers: 17 }],
  proxies: [{ kind: "Nginx Proxy Manager", container: "npm", network: "npm" }],
  databases: { common: "postgres:16", ownToAnApp: 2, standingAlone: 0 },
};
const host = { id: "h1", label: "DeltaAv1", health: { address: "192.168.10.178" } } as HostView;
const DRAFT = apiPath(API_ROUTES.hostInstallDraft, { hostId: "h1" });
const CHECK = apiPath(API_ROUTES.hostInstallCheck, { hostId: "h1" });
const INSTALL = apiPath(API_ROUTES.hostInstall, { hostId: "h1" });
const okChecks = [
  { key: "image", ok: true, detail: "Image found for this machine" },
  { key: "name", ok: true, detail: "Name is free" },
] as const;
const draft = draftOf(
  "ghcr.io/dev/new:1",
  {
    ports: [3000],
    volumes: ["/data"],
    environment: [
      { name: "PUID", value: "" },
      { name: "API_TOKEN", value: "" },
    ],
    user: "",
  },
  profile,
);
const job = (overrides: Partial<JobView> = {}) =>
  ({
    id: "j1",
    action: "install",
    containerName: "new",
    status: "pending",
    outcome: null,
    output: null,
    progress: null,
    createdAt: 1,
    completedAt: null,
    requestedBy: "admin",
    ...overrides,
  }) as JobView;

let answers: Record<string, unknown>;
let sent: { url: string; body: unknown }[];
let jobs: JobView[];

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
  sent = [];
  jobs = [job()];
  answers = {
    [DRAFT]: { error: null, draft, checks: [...okChecks] } satisfies InstallAnswer,
    [CHECK]: { error: null, draft: null, checks: [...okChecks] } satisfies InstallAnswer,
    [INSTALL]: job(),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") sent.push({ url, body: JSON.parse(String(init.body)) });
      const body = url.startsWith("/api/jobs") ? jobs : (answers[url] ?? []);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AddContainer host={host} />
    </QueryClientProvider>,
  );
const open = () => fireEvent.click(screen.getByRole("button", { name: "Add a container" }));
const type = (text: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "An app or an image" }), { target: { value: text } });
const toReady = async () => {
  show();
  open();
  type("ghcr.io/dev/new:1");
  fireEvent.click(screen.getByRole("button", { name: /ghcr\.io\/dev\/new:1/ }));
  await screen.findByRole("button", { name: "Install" });
};

it("warns before installing with a runner behind Autoheal, and only then", async () => {
  answers[API_ROUTES.settings] = { version: "2.0.0+new" };
  const showFor = (runner: Partial<HostView>) => {
    cleanup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AddContainer host={{ ...host, ...runner }} />
      </QueryClientProvider>,
    );
    open();
  };
  const warning = "Update this host's runner first";
  showFor({ runnerVersion: "2.0.0+old" });
  expect(await screen.findByText(new RegExp(warning))).toBeTruthy();
  showFor({ runnerVersion: "2.0.0+new" });
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(screen.queryByText(new RegExp(warning))).toBeNull();
  showFor({ runnerVersion: "2.0.0", kind: "ssh" });
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(screen.queryByText(new RegExp(warning))).toBeNull();
});

it("opens on one box, with nothing to browse", () => {
  show();
  open();
  expect(screen.getByRole("textbox", { name: "An app or an image" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Mealie/ })).toBeNull();
});

it("closes from its corner, leaving the next opening empty", () => {
  show();
  open();
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: "https://github.com/some/project" } });

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("textbox")).toBeNull();

  open();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

it("finds an app by name, and asks for a recipe by its id", async () => {
  show();
  open();
  type("meal");
  fireEvent.click(screen.getByRole("button", { name: /Mealie/ }));
  await waitFor(() => expect(sent[0]).toEqual({ url: DRAFT, body: { recipe: "mealie" } }));
});

it("takes a project's address as one, reading its page, and shows what it left out", async () => {
  answers[DRAFT] = {
    error: null,
    draft: {
      ...draft,
      spec: { ...draft.spec, environment: [...draft.spec.environment, { name: "DB_NAME", value: "/app/data/x.db" }] },
      project: {
        address: "https://github.com/0xfurai/peekaping",
        settings: ["DB_NAME"],
        leftOut: ["privileged mode"],
      },
    },
    checks: [...okChecks],
  } satisfies InstallAnswer;
  show();
  open();
  type("https://github.com/0xfurai/peekaping");
  fireEvent.click(screen.getByRole("button", { name: /Read this project's page/ }));
  await waitFor(() =>
    expect(sent[0]).toEqual({ url: DRAFT, body: { project: "https://github.com/0xfurai/peekaping" } }),
  );
  expect(await screen.findByText("DB_NAME=/app/data/x.db")).toBeTruthy();
  expect(screen.getByText("from its README")).toBeTruthy();
  expect(screen.getByText(/asks for privileged mode\. Left out/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "https://github.com/0xfurai/peekaping" })).toBeTruthy();
});

it("says what to do when nothing matches, and what stopped an image", async () => {
  show();
  open();
  type("nothing like this");
  expect(screen.getByText(/Paste its image name/)).toBeTruthy();
  answers[DRAFT] = { error: "no version for arm64", draft: null, checks: [] };
  type("a/b:1");
  fireEvent.click(screen.getByRole("button", { name: /a\/b:1/ }));
  expect(await screen.findByText("no version for arm64")).toBeTruthy();
});

it("shows everything filled in, saying why, with nothing asked", async () => {
  await toReady();
  expect(screen.getByRole("button", { name: /^\/home\/me\/docker\/new/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("25 apps here")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^1000:1000/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("like your other 9")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^npm, Nginx Proxy Manager/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("new:3000")).toBeTruthy();
  expect(screen.getByText("your proxy: Nginx Proxy Manager")).toBeTruthy();
  expect(screen.getByText("1 generated, kept in .env")).toBeTruthy();
  expect(screen.getByText(/Image found/)).toBeTruthy();
});

it("shows every option, selects one with a click, and takes several networks", async () => {
  answers[DRAFT] = {
    error: null,
    draft: {
      ...draft,
      networks: ["npm", "cloudflare"],
      networkCounts: { npm: 11, cloudflare: 2 },
      proxies: [
        { kind: "Nginx Proxy Manager", network: "npm" },
        { kind: "Cloudflare Tunnel", network: "cloudflare" },
      ],
    },
    checks: [...okChecks],
  } satisfies InstallAnswer;
  await toReady();
  const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
  expect(pressed(/^npm, Nginx Proxy Manager/)).toBe("true");
  expect(pressed(/^cloudflare, Cloudflare Tunnel/)).toBe("false");
  expect(screen.getByText("your proxy: Nginx Proxy Manager")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /^cloudflare, Cloudflare Tunnel/ }));
  expect(pressed(/^npm, Nginx Proxy Manager/)).toBe("true");
  expect(pressed(/^cloudflare, Cloudflare Tunnel/)).toBe("true");
  await waitFor(() =>
    expect((sent.at(-1)?.body as { spec: { networks: string[] } }).spec.networks).toEqual(["npm", "cloudflare"]),
  );

  fireEvent.click(screen.getByRole("button", { name: /^npm, Nginx Proxy Manager/ }));
  expect(pressed(/^npm, Nginx Proxy Manager/)).toBe("false");
  expect(await screen.findByText("your proxy: Cloudflare Tunnel")).toBeTruthy();

  expect(pressed(/^On the LAN, 192\.168\.10\.178:3000/)).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: /^On the LAN, 192\.168\.10\.178:3000/ }));
  expect(screen.getByText("new:3000 · 192.168.10.178:3000")).toBeTruthy();
  expect((screen.getByRole("spinbutton", { name: "Port on this host" }) as HTMLInputElement).value).toBe("3000");

  // Only one restart policy at a time.
  fireEvent.click(screen.getByRole("button", { name: /^Always/ }));
  expect(pressed(/^Always/)).toBe("true");
  expect(pressed(/^Unless stopped/)).toBe("false");
});

it("gives a real address to open once it is on the LAN, and none when it is not", async () => {
  jobs = [job({ status: "succeeded", outcome: "new is running." })];
  await toReady();
  fireEvent.click(screen.getByRole("button", { name: /^On the LAN/ }));
  await waitFor(() =>
    expect((sent.at(-1)?.body as { spec: { port: { published: number } } }).spec.port.published).toBe(3000),
  );
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  const open = await screen.findByRole("link", { name: "Open new" });
  expect(open.getAttribute("href")).toBe("http://192.168.10.178:3000");
  cleanup();
  await toReady();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await screen.findByText("✓ new is running");
  expect(screen.queryByRole("link", { name: /^Open/ })).toBeNull();
});

it("offers the host's disks for a folder and its data, and Other for what is not there", async () => {
  answers[DRAFT] = {
    error: null,
    draft: { ...draft, places: [{ path: "/mnt/fast", availableBytes: 3_000_000_000_000 }] },
    checks: [...okChecks],
  } satisfies InstallAnswer;
  await toReady();
  fireEvent.click(screen.getByRole("button", { name: /^\/mnt\/fast\/new\/data/ }));
  await waitFor(() =>
    expect((sent.at(-1)?.body as { spec: { mounts: object[] } }).spec.mounts).toEqual([
      { source: "/mnt/fast/new/data", target: "/data" },
    ]),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Other…" })[0]!);
  fireEvent.change(screen.getByRole("textbox", { name: "Folder" }), { target: { value: "/srv/x" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect((sent.at(-1)?.body as { spec: { folder: string } }).spec.folder).toBe("/srv/x"));
  expect(screen.getByRole("button", { name: "/srv/x" }).getAttribute("aria-pressed")).toBe("true");
});

it("shows the files, with IDs in the .env and no secret value at all", async () => {
  await toReady();
  fireEvent.click(screen.getByRole("button", { name: "Show the files" }));
  const shown = document.body.textContent ?? "";
  expect(shown).toContain("PUID=1000");
  expect(shown).toContain("API_TOKEN=(made on the host");
  expect(shown).toContain("env_file: .env");
});

it("checks again after a change, in place, and holds Install back while something is wrong", async () => {
  await toReady();
  answers[CHECK] = {
    error: null,
    draft: null,
    checks: [{ key: "folder", ok: false, detail: "/srv/x already holds a Compose file: choose another folder." }],
  } satisfies InstallAnswer;
  fireEvent.click(screen.getAllByRole("button", { name: "Other…" })[0]!);
  fireEvent.change(screen.getByRole("textbox", { name: "Folder" }), { target: { value: "/srv/x" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "/srv/x" })).toBeTruthy();
  expect((sent.at(-1)?.body as { spec: { folder: string } }).spec.folder).toBe("/srv/x");
  expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(true);
});

it("sends no secret values when it installs, then follows the job to done", async () => {
  await toReady();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await screen.findByText(/You can close this/);
  const { spec } = sent.find(({ url }) => url === INSTALL)!.body as { spec: { secrets: object[] } };
  expect(spec.secrets).toEqual([{ name: "API_TOKEN", characters: 32 }]);
  cleanup();
  jobs = [job({ status: "succeeded", outcome: "new is running." })];
  await toReady();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(await screen.findByText("✓ new is running")).toBeTruthy();
  expect(screen.getByText(/^In Nginx Proxy Manager/)).toBeTruthy();
});

it("says what went wrong in its own words, then offers Undo, which asks about the data", async () => {
  await toReady();
  jobs = [job({ status: "failed", outcome: "new started, but it stopped.", output: "ERROR no database" })];
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(await screen.findByText("✕ new did not start properly")).toBeTruthy();
  expect(screen.getByText(/ERROR no database/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByText(/Its data is in \/home\/me\/docker\/new/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep its data" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove its data too" })).toBeTruthy();
});
