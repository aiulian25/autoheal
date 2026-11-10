import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostView } from "../../../src/shared/api.js";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import type { OwnCheck } from "../../../src/shared/own-compose.js";
import { TEXT } from "../constants.js";
import { AddContainer } from "./add-container.js";

const text = TEXT.ownCompose;
const CHECK = apiPath(API_ROUTES.hostInstallOwnCheck, { hostId: "h1" });
const INSTALL = apiPath(API_ROUTES.hostInstallOwn, { hostId: "h1" });
const host = {
  id: "h1",
  label: "OrionBx3",
  kind: "ssh",
  hostDeploy: true,
  health: { address: "10.0.0.9" },
} as unknown as HostView;
const CLEAR: OwnCheck = {
  readable: true,
  issues: [],
  parent: "/srv/docker",
  parentProjects: 25,
  plan: { project: "wiki", containers: ["Wiki"], networks: ["wiki_default"], volumes: [], port: 3000 },
};
const FILE = "services:\n  wiki:\n    image: a:1\n    environment:\n      TOKEN: ${API_TOKEN}\n";
let answer: OwnCheck;
let sent: { url: string; body: Record<string, unknown> }[];
let jobStatus = "succeeded";

beforeEach(() => {
  answer = CLEAR;
  sent = [];
  jobStatus = "succeeded";
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url === CHECK) return json({ error: null, draft: null, checks: [], own: answer });
      if (url === INSTALL) return json({ id: "j1", status: "pending", action: "install" });
      return json([{ id: "j1", status: jobStatus, action: "install", outcome: "wiki is running.", output: null }]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddContainer host={host} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: TEXT.addContainer.add }));
}
const box = () => screen.getByRole("textbox", { name: TEXT.addContainer.searchLabel });
const paste = (value: string) => fireEvent.change(box(), { target: { value } });
const editor = () => screen.findByRole("textbox", { name: text.composeFile }) as Promise<HTMLTextAreaElement>;
const installButton = () => screen.getByRole("button", { name: text.install }) as HTMLButtonElement;

describe("your own Compose file", () => {
  it("is offered under the empty box, and opens an empty editor", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.writeOwn) }));
    expect((await editor()).value).toBe("");
    expect(installButton().disabled).toBe(true);
  });

  it("is offered beside the guided way when a file is pasted", async () => {
    open();
    paste(FILE);
    expect(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.useCompose) })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.useAsIs) }));
    expect((await editor()).value).toBe(FILE);
  });

  it("marks what is wrong at its line, fixes it with a click, and only then lets it install", async () => {
    open();
    paste(FILE);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.useAsIs) }));
    const fix = await screen.findByRole("button", { name: "Add to .env" });
    expect(screen.getByRole("button", { name: text.line(5) })).toBeTruthy();
    expect(installButton().disabled).toBe(true);
    fireEvent.click(fix);
    fireEvent.click(screen.getByRole("tab", { name: text.envFile }));
    const env = (await screen.findByRole("textbox", { name: text.envFile })) as HTMLTextAreaElement;
    expect(env.value).toMatch(/^API_TOKEN=[0-9a-f]{48}\n$/);
    await waitFor(() => expect(installButton().disabled).toBe(false), { timeout: 3000 });
  });

  it("checks with the host a moment after typing, as the same files, and shows what it finds", async () => {
    answer = {
      ...CLEAR,
      issues: [
        {
          level: "error",
          file: "compose",
          line: 3,
          message: "a:1 could not be found.",
          fix: { label: "Use b", lines: [{ file: "compose", line: 3, text: "    image: b:1" }], env: [] },
        },
      ],
    };
    open();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.writeOwn) }));
    fireEvent.change(await editor(), { target: { value: "services:\n  wiki:\n    image: a:1\n" } });
    fireEvent.click(await screen.findByRole("button", { name: "Use b" }, { timeout: 3000 }));
    expect((await editor()).value).toContain("image: b:1");
    expect(sent.at(-1)?.url).toBe(CHECK);
    expect(sent.at(-1)?.body.compose).toContain("wiki:");
  });

  it("writes the files as they stand and says they are the person's own", async () => {
    open();
    paste("services:\n  wiki:\n    image: a:1\n");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.useAsIs) }));
    await waitFor(() => expect(installButton().disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(installButton());
    expect(await screen.findByText(text.running("wiki"), {}, { timeout: 3000 })).toBeTruthy();
    const install = sent.find(({ url }) => url === INSTALL)!;
    expect(install.body).toMatchObject({
      own: true,
      folder: "/srv/docker/wiki",
      compose: "services:\n  wiki:\n    image: a:1\n",
    });
    expect(screen.getByText(text.yours)).toBeTruthy();
    const link = screen.getByRole("link", { name: text.open("wiki") }) as HTMLAnchorElement;
    expect(link.href).toBe("http://10.0.0.9:3000/");
  });
});

describe("a second try at what failed", () => {
  const untilFailed = async () => {
    jobStatus = "failed";
    open();
    paste("services:\n  wiki:\n    image: a:1\n");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.useAsIs) }));
    await waitFor(() => expect(installButton().disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(installButton());
    await screen.findByText(text.failed("wiki"), {}, { timeout: 3000 });
  };
  const installs = () => sent.filter(({ url }) => url === INSTALL);

  it("is no retry the first time", async () => {
    await untilFailed();
    expect(installs()[0]!.body).toMatchObject({ retryOf: null });
  });

  it("names the install that failed, whether tried at once or after a change", async () => {
    await untilFailed();
    fireEvent.click(screen.getByRole("button", { name: text.tryAgain }));
    await waitFor(() => expect(installs()).toHaveLength(2));
    expect(installs()[1]!.body).toMatchObject({ retryOf: "j1", folder: "/srv/docker/wiki" });
  });

  it("is no retry once it is headed for another folder", async () => {
    await untilFailed();
    fireEvent.click(screen.getByRole("button", { name: text.backToFiles }));
    const name = await screen.findByRole("textbox", { name: text.name });
    fireEvent.change(name, { target: { value: "other" } });
    await waitFor(() => expect(installButton().disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(installButton());
    await waitFor(() => expect(installs()).toHaveLength(2));
    expect(installs()[1]!.body).toMatchObject({ retryOf: null, folder: "/srv/docker/other" });
  });
});

describe("a docker run command", () => {
  it("becomes a Compose file and .env in the same editor, saying what it left out", async () => {
    open();
    paste("docker run -d --name Wiki --oom-score-adj=5 -e DB_PASS=secret -p 3000:3000 img:1");
    expect(screen.queryByRole("button", { name: new RegExp(TEXT.addContainer.readImage) })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(TEXT.addContainer.convertRun) }));
    const compose = await editor();
    expect(compose.value).toContain("image: img:1");
    expect(compose.value).not.toContain("secret");
    expect(screen.getByText(/--oom-score-adj=5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: text.envFile }));
    const hidden = screen.getByLabelText(text.envFile);
    expect(within(hidden.parentElement!).queryByText(/secret/)).toBeNull();
  });

  it("says when it names no image", () => {
    open();
    paste("docker run -d");
    expect(screen.getByRole("alert").textContent).toContain("image");
  });
});
