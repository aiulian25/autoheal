import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type ContainerView, type JobView, type SessionView } from "../../../src/shared/api.js";
import type { StackAnswer, StackCheck, StackDriftView } from "../../../src/shared/stacks.js";
import { SESSION_QUERY_KEY } from "../constants.js";
import { ComposePanel } from "./compose-panel.js";
import { StackHead } from "./stack-head.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const FOLDER = "/home/alex/docker/wiki";
const ASK = apiPath(API_ROUTES.hostStackAsk, { hostId: "h1", project: "wiki" });
const ACTIONS = apiPath(API_ROUTES.hostActions, { hostId: "h1" });
const COMPOSE = "services:\n  wiki:\n    image: wiki:2\n";
const files = (hasPrevious = false): StackAnswer => ({
  error: null,
  files: {
    project: "wiki",
    folder: FOLDER,
    builds: false,
    files: [
      { path: `${FOLDER}/docker-compose.yml`, kind: "compose", text: COMPOSE, hash: "h1", hasPrevious },
      {
        path: `${FOLDER}/.env`,
        kind: "env",
        text: "TZ=Europe/Lisbon\nDB_PASS=hunter2\n",
        hash: "h2",
        hasPrevious: false,
      },
    ],
  },
});
const CALM: StackCheck = { problem: null, recreate: [], unchanged: ["Wiki"], added: [], removed: [], warnings: [] };

let check: StackCheck;
let saveAnswer: StackAnswer;
let read: StackAnswer;
let job: Partial<JobView>;
let asks: Record<string, unknown>[];
let jobs: Record<string, unknown>[];
let drifts: StackDriftView[];

beforeEach(() => {
  check = CALM;
  read = files();
  saveAnswer = files(true);
  job = { id: "j1", status: "succeeded", outcome: "wiki is up", output: null };
  asks = [];
  jobs = [];
  drifts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url === ASK) {
        asks.push(body);
        if (body.kind === "check") return answer({ error: null, check });
        if (body.kind === "save") {
          read = saveAnswer;
          return answer(saveAnswer);
        }
        if (body.kind === "restore") return answer(files(true));
        return answer(read);
      }
      if (url === ACTIONS) {
        jobs.push(body);
        return answer({ id: "j1", status: "pending" });
      }
      if (url === apiPath(API_ROUTES.job, { jobId: "j1" })) return answer(job);
      if (url === apiPath(API_ROUTES.stackDrift, { hostId: "h1" })) return answer(drifts);
      return answer([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(element = <ComposePanel hostId="h1" project="wiki" readOnly={false} />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
const editor = () => screen.findByRole("textbox", { name: "docker-compose.yml" });
const edit = async (next: string) => fireEvent.change(await editor(), { target: { value: next } });
const NEW_TAG = COMPOSE.replace("wiki:2", "wiki:3");
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("a stack's Compose file", () => {
  it("shows the real files, with passwords hidden until asked", async () => {
    show();
    expect(((await editor()) as HTMLTextAreaElement).value).toBe(COMPOSE);
    const env = screen.getByLabelText(".env");
    expect(env.textContent).toContain("TZ=Europe/Lisbon");
    expect(env.textContent).not.toContain("hunter2");

    fireEvent.click(screen.getByRole("button", { name: /^Show/ }));
    expect((screen.getByRole("textbox", { name: ".env" }) as HTMLTextAreaElement).value).toContain("hunter2");
  });

  it("says what an edit would change, and saves without recreating anything", async () => {
    check = { ...CALM, recreate: ["Wiki"], unchanged: ["Wiki-DB"] };
    show();
    await edit(NEW_TAG);

    expect(await screen.findByText(/recreate Wiki/)).toBeTruthy();
    expect(screen.getByText(/Wiki-DB is left alone/)).toBeTruthy();
    await waitFor(() => expect(button("Save").disabled).toBe(false));
    fireEvent.click(button("Save"));

    await screen.findByText(/Saved\. Containers are unchanged/);
    expect(asks.find(({ kind }) => kind === "save")).toEqual({
      kind: "save",
      files: [{ path: `${FOLDER}/docker-compose.yml`, text: NEW_TAG, hash: "h1" }],
    });
    expect(jobs).toEqual([]);
  });

  it("offers Discard once a file is edited, and puts the file back", async () => {
    show();
    await editor();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    await edit(NEW_TAG);

    fireEvent.click(button("Discard"));

    expect(((await editor()) as HTMLTextAreaElement).value).toBe(COMPOSE);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("saves and recreates with one click", async () => {
    show();
    await edit(NEW_TAG);
    await waitFor(() => expect(button("Save and recreate").disabled).toBe(false));
    fireEvent.click(button("Save and recreate"));

    await waitFor(() => expect(jobs).toEqual([{ action: "stack_up", stack: { project: "wiki", removeData: false } }]));
    expect(asks.some(({ kind }) => kind === "save")).toBe(true);
    expect(await screen.findByText("wiki is up")).toBeTruthy();
  });

  it("can recreate from the files as they are, with nothing edited", async () => {
    show();
    await editor();
    expect(button("Save").disabled).toBe(true);
    await waitFor(() => expect(button("Recreate").disabled).toBe(false));
    fireEvent.click(button("Recreate"));
    await waitFor(() => expect(jobs).toHaveLength(1));
    expect(asks.some(({ kind }) => kind === "save")).toBe(false);
  });

  it("will not save what Compose cannot read, and says why", async () => {
    check = { ...CALM, problem: "yaml: line 9: did not find expected" };
    show();
    await edit("nonsense");

    expect(await screen.findByText(/yaml: line 9/)).toBeTruthy();
    expect(button("Save").disabled).toBe(true);
    expect(button("Save and recreate").disabled).toBe(true);
  });

  it("shows why a save was refused, keeping the edit", async () => {
    saveAnswer = { error: "docker-compose.yml changed on the host since it was opened" };
    show();
    await edit(NEW_TAG);
    await waitFor(() => expect(button("Save").disabled).toBe(false));
    fireEvent.click(button("Save"));

    expect(await screen.findByText(/changed on the host/)).toBeTruthy();
    expect(((await editor()) as HTMLTextAreaElement).value).toBe(NEW_TAG);
  });

  it("shows what a failed recreate said, with the last file one click away", async () => {
    job = { id: "j1", status: "failed", outcome: "It did not come back", output: "Error: connect ECONNREFUSED" };
    show();
    await edit(NEW_TAG);
    await waitFor(() => expect(button("Save and recreate").disabled).toBe(false));
    fireEvent.click(button("Save and recreate"));

    expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Put the last file back" }));
    expect(await screen.findByText(/The last file is back/)).toBeTruthy();
    expect(asks.some(({ kind }) => kind === "restore")).toBe(true);
  });

  it("is only looked at when the host keeps it to itself", async () => {
    show(<ComposePanel hostId="h1" project="wiki" readOnly />);
    expect(((await editor()) as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recreate" })).toBeNull();
  });

  it("says what stops it being opened", async () => {
    read = { error: "Its Compose file is no longer on this host" };
    show();
    expect(await screen.findByText(/no longer on this host/)).toBeTruthy();
  });
});

describe("a stack's row", () => {
  const container = (overrides: Partial<ContainerView>) =>
    ({
      name: "Wiki",
      state: "running",
      health: "healthy",
      handsOff: null,
      image: "wiki:2",
      composeProject: "wiki",
      update: { available: false },
      byItself: { updateLock: null },
      ...overrides,
    }) as unknown as ContainerView;
  const head = (members: ContainerView[]) => <StackHead hostId="h1" stack="wiki" members={members} canRestart admin />;

  it("stops one that runs and starts one that does not", async () => {
    show(head([container({})]));
    fireEvent.click(await screen.findByRole("button", { name: "Stop stack wiki" }));
    await waitFor(() =>
      expect(jobs).toEqual([{ action: "stack_stop", stack: { project: "wiki", removeData: false } }]),
    );
    cleanup();
    jobs = [];
    show(head([container({ state: "exited" })]));
    fireEvent.click(await screen.findByRole("button", { name: "Start stack wiki" }));
    await waitFor(() =>
      expect(jobs).toEqual([{ action: "stack_start", stack: { project: "wiki", removeData: false } }]),
    );
  });

  it("opens its Compose file in place", async () => {
    show(head([container({})]));
    fireEvent.click(await screen.findByRole("button", { name: "Compose file of wiki" }));
    expect(await editor()).toBeTruthy();
  });

  it("offers only reading on one the host keeps to itself", async () => {
    show(head([container({ handsOff: "self" as ContainerView["handsOff"] })]));
    expect(await screen.findByRole("button", { name: "Compose file of wiki" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop stack wiki" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update stack wiki" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove stack wiki" })).toBeNull();
  });

  it("keeps data by default when removing, and says what goes", async () => {
    read = {
      error: null,
      removal: {
        containers: ["Wiki"],
        networks: ["wiki_default"],
        sharedNetworks: ["npm"],
        data: [{ path: `${FOLDER}/db`, sizeBytes: 1_200_000_000 }],
        kept: [],
        outside: ["/mnt/storage"],
      },
    };
    show(head([container({})]));
    fireEvent.click(await screen.findByRole("button", { name: "Remove stack wiki" }));
    expect(await screen.findByText(/1 container, and wiki_default/)).toBeTruthy();
    expect(screen.getByText(/1\.2 GB/)).toBeTruthy();
    expect(screen.getByText(/npm · \/mnt\/storage/)).toBeTruthy();

    fireEvent.click(button("Remove the stack, keep its data"));
    await waitFor(() =>
      expect(jobs).toEqual([{ action: "stack_remove", stack: { project: "wiki", removeData: false } }]),
    );
  });

  it("says what stays even with its data removed, and why", async () => {
    read = {
      error: null,
      removal: {
        containers: ["Wiki"],
        networks: [],
        sharedNetworks: [],
        data: [],
        kept: [
          { path: `${FOLDER}/media`, why: "shared", usedBy: ["jellyfin"] },
          { path: `${FOLDER}/odd`, why: "unresolved", usedBy: [] },
        ],
        outside: [],
      },
    };
    show(head([container({})]));
    fireEvent.click(await screen.findByRole("button", { name: "Remove stack wiki" }));
    expect(await screen.findByText(/media · also used by jellyfin/)).toBeTruthy();
    expect(screen.getByText(/odd · could not be confirmed as only its own/)).toBeTruthy();
  });

  it("removes data only when picked", async () => {
    read = {
      error: null,
      removal: { containers: ["Wiki"], networks: [], sharedNetworks: [], data: [], kept: [], outside: [] },
    };
    show(head([container({})]));
    fireEvent.click(await screen.findByRole("button", { name: "Remove stack wiki" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove its data too" }));
    fireEvent.click(button("Remove the stack and its data"));
    await waitFor(() =>
      expect(jobs).toEqual([{ action: "stack_remove", stack: { project: "wiki", removeData: true } }]),
    );
  });
});

describe("a stack that differs from its files", () => {
  const REVISION = "c".repeat(64);
  const BADGE = "See how wiki differs from its files";
  const RECREATE = "Recreate from its files";
  const drift = (over: Partial<StackDriftView> = {}): StackDriftView => ({
    project: "wiki",
    files: ["compose.yaml"],
    unreadable: false,
    revision: REVISION,
    services: [
      {
        service: "wiki",
        container: "Wiki",
        kind: "source",
        fields: [
          { field: "environment", names: ["DB_PASS"] },
          { field: "image", names: [] },
        ],
      },
      { service: "old", container: "old-1", kind: "extra", fields: [] },
    ],
    firstSeenAt: 1,
    lastObservedAt: 2,
    ...over,
  });
  const running = {
    name: "Wiki",
    state: "running",
    health: "healthy",
    handsOff: null,
    image: "wiki:2",
    composeProject: "wiki",
    update: { available: false },
    byItself: { updateLock: null },
  } as unknown as ContainerView;
  const head = (member = running, admin = true) => (
    <StackHead hostId="h1" stack="wiki" members={[member]} canRestart admin={admin} />
  );
  const open = async () => fireEvent.click(await screen.findByRole("button", { name: BADGE }));
  const drifted = () => {
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return calls.some(([url]) => url === apiPath(API_ROUTES.stackDrift, { hostId: "h1" }));
  };

  it("shows nothing on a stack with nothing to say, nor on another stack's report", async () => {
    drifts = [drift({ project: "blog" })];
    show(head());
    await waitFor(() => expect(drifted()).toBe(true));
    await screen.findByRole("button", { name: "Stop stack wiki" });
    expect(screen.queryByRole("button", { name: BADGE })).toBeNull();
  });

  it("does not even ask for someone who cannot run the host", async () => {
    drifts = [drift()];
    show(head(running, false));
    await screen.findByText("wiki");
    expect(drifted()).toBe(false);
    expect(screen.queryByRole("button", { name: BADGE })).toBeNull();
  });

  it("reads as names alone, and changes nothing until asked and confirmed", async () => {
    drifts = [drift()];
    show(head());
    await open();
    expect(await screen.findByText("How wiki differs from its files")).toBeTruthy();
    expect(screen.getByText("DB_PASS")).toBeTruthy();
    expect(screen.getByText("Its files changed since this container was made.")).toBeTruthy();
    expect(jobs).toEqual([]);

    fireEvent.click(button(RECREATE));
    expect(jobs).toEqual([]);
    expect(screen.getByText(/This recreates wiki from its files/)).toBeTruthy();
    fireEvent.click(button("Cancel"));
    expect(jobs).toEqual([]);

    fireEvent.click(button(RECREATE));
    fireEvent.click(button("Recreate them"));
    await waitFor(() =>
      expect(jobs).toEqual([
        { action: "stack_up", stack: { project: "wiki", removeData: false, reconcile: { revision: REVISION } } },
      ]),
    );
  });

  it("stays read only on a stack the host keeps, and where only a leftover differs", async () => {
    drifts = [drift()];
    show(head({ ...running, handsOff: { reason: "protected" } } as unknown as ContainerView));
    await open();
    await screen.findByText("How wiki differs from its files");
    expect(screen.queryByRole("button", { name: RECREATE })).toBeNull();
    cleanup();

    drifts = [drift({ services: [{ service: "old", container: "old-1", kind: "extra", fields: [] }] })];
    show(head());
    await open();
    await screen.findByText("How wiki differs from its files");
    expect(screen.queryByRole("button", { name: RECREATE })).toBeNull();
  });

  it("says why when the host refused it, as with a review gone stale", async () => {
    job = { id: "j1", status: "failed", outcome: "It has changed since it was read", output: null };
    drifts = [drift()];
    show(head());
    await open();
    fireEvent.click(await screen.findByRole("button", { name: RECREATE }));
    fireEvent.click(button("Recreate them"));
    expect(await screen.findByText("It has changed since it was read")).toBeTruthy();
  });
});
