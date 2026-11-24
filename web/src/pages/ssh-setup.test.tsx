import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type MadeSshKeyView,
  type PendingSshHostView,
  type SshKeyView,
} from "../../../src/shared/api.js";
import { ERROR_TEXT, SSH_SETUP, TEXT } from "../constants.js";
import { MemoryRouter } from "react-router";
import { SwitchToSshSteps } from "./ssh-setup.js";

const text = TEXT.ssh.add;
const picker = TEXT.sshKeyPicker;
const PRIVATE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA-the-secret-body\n-----END OPENSSH PRIVATE KEY-----\n";
const PENDING_ID = "5b6a3f58-6a43-4f7c-9a3f-6a4e1d2c3b4a";

const key = (overrides: Partial<SshKeyView> = {}): SshKeyView => ({
  id: "k1",
  name: "laptop",
  publicLine: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN0 alex@laptop",
  fingerprint: "SHA256:laptopfingerprint",
  madeByAutoheal: false,
  createdBy: "admin",
  createdAt: 1,
  hosts: [],
  ...overrides,
});
const pending = (docker: PendingSshHostView["docker"]): PendingSshHostView => ({
  pendingId: PENDING_ID,
  label: "mini",
  hostKeyFingerprint: "SHA256:hostkeyfingerprint",
  expiresAt: Date.now() + 600_000,
  docker,
});
const READY = { socket: true, usable: true };

let client: QueryClient;
const cancelled = vi.fn();
afterEach(() => {
  cleanup();
  cancelled.mockClear();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Answers by "METHOD path"; a list of answers is given one per call, the last one again. */
function show(answers: Record<string, unknown | { status: number; body: unknown }[]>) {
  const calls = new Map<string, number>();
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const route = `${options?.method ?? "GET"} ${path}`;
    const count = calls.get(route) ?? 0;
    calls.set(route, count + 1);
    const answer = answers[route];
    const replies =
      Array.isArray(answer) && answer.every((reply) => reply !== null && "status" in reply) ? answer : null;
    const reply =
      replies === null ? { status: 200, body: answer ?? [] } : replies[Math.min(count, replies.length - 1)]!;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SwitchToSshSteps
          dashboardAddress="192.168.10.83"
          onCancelled={cancelled}
          switching={{ hostId: "h3", label: "orion2480" }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetch;
}
const sent = (fetch: ReturnType<typeof show>, method: string, path: string) =>
  fetch.mock.calls
    .filter(([url, options]) => url === path && options?.method === method)
    .map(([, options]) => JSON.parse(String(options!.body ?? "null")));

// Cedar signs in with the laptop's key: it is offered by that host's name.
const cedarsKey = () => key({ hosts: ["Cedar"] });
// Once the list holds it: a key is offered only once the keys Autoheal keeps have come.
async function choose(value: string) {
  const select = await screen.findByRole<HTMLSelectElement>("combobox", { name: picker.key });
  await waitFor(() => expect([...select.options].map((option) => option.value)).toContain(value));
  fireEvent.change(select, { target: { value } });
}
const useKey = () => fireEvent.click(screen.getByRole("button", { name: text.useKey }));
function fillWhere() {
  fireEvent.change(screen.getByRole("textbox", { name: text.address }), { target: { value: "192.168.10.50" } });
  fireEvent.change(screen.getByRole("textbox", { name: text.user }), { target: { value: "alex" } });
  fireEvent.click(screen.getByRole("button", { name: text.next }));
}

describe("switching a runner host to SSH, step by step", () => {
  it("switches a runner host to SSH under its own name, then says how to remove its runner", async () => {
    const fetch = show({
      [`GET ${API_ROUTES.sshKeys}`]: [cedarsKey()],
      [`POST ${apiPath(API_ROUTES.sshHostSwitch, { hostId: "h3" })}`]: { ...pending(READY), label: "orion2480" },
      [`POST ${apiPath(API_ROUTES.sshHostConfirm, { pendingId: PENDING_ID })}`]: { id: "h3", label: "orion2480" },
    });
    expect(screen.getByText(text.switchExplanation)).toBeTruthy();
    // It keeps its name: none is asked.
    expect(screen.queryByRole("textbox", { name: /^Name/ })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: text.address }), { target: { value: "192.168.10.60" } });
    fireEvent.change(screen.getByRole("textbox", { name: text.user }), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: text.next }));
    expect(
      await screen.findByRole("option", { name: picker.usedBy(["Cedar"], "SHA256:laptopfingerprint") }),
    ).toBeTruthy();
    await choose("k1");
    useKey();
    fireEvent.click(await screen.findByRole("button", { name: text.connect }));
    expect(screen.getAllByText(text.chosen("SHA256:laptopfingerprint")).length).toBeGreaterThan(0);
    expect(await screen.findByText("SHA256:hostkeyfingerprint")).toBeTruthy();
    expect(screen.getByText(SSH_SETUP.compareHostKey)).toBeTruthy();
    expect(screen.getByText(text.withDocker)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: text.switchTrust }));
    expect(await screen.findByText(text.switched("orion2480"))).toBeTruthy();
    expect(sent(fetch, "POST", apiPath(API_ROUTES.sshHostSwitch, { hostId: "h3" }))).toEqual([
      { address: "192.168.10.60", port: 22, user: "alex", keyId: "k1" },
    ]);
    expect(sent(fetch, "POST", API_ROUTES.sshHosts)).toEqual([]);
    expect(screen.getByText(text.removeRunner)).toBeTruthy();
    expect(screen.getByText(SSH_SETUP.removeRunner)).toBeTruthy();
    expect(screen.getByRole("button", { name: text.close })).toBeTruthy();
    // Its root password is offered, on its page.
    expect(screen.getByRole("link", { name: text.rootOfferLink }).getAttribute("href")).toBe("/hosts/h3#ssh");
  });

  it("takes the user's own key with its passphrase, and adds a host without Docker, its system watched alone", async () => {
    const fetch = show({
      [`GET ${API_ROUTES.sshKeys}`]: [],
      [`POST ${API_ROUTES.sshKeys}`]: key(),
      [`POST ${apiPath(API_ROUTES.sshHostSwitch, { hostId: "h3" })}`]: pending({ socket: false, usable: false }),
      [`POST ${apiPath(API_ROUTES.sshHostConfirm, { pendingId: PENDING_ID })}`]: { id: "h3", label: "orion2480" },
    });
    fillWhere();
    await choose("paste");
    fireEvent.change(screen.getByRole("textbox", { name: picker.privateKey }), { target: { value: PRIVATE_KEY } });
    fireEvent.change(screen.getByLabelText(new RegExp(`^${picker.passphrase}`)), {
      target: { value: "its passphrase" },
    });
    useKey();
    await waitFor(() =>
      expect(sent(fetch, "POST", API_ROUTES.sshKeys)).toEqual([
        { name: "orion2480", privateKey: PRIVATE_KEY, passphrase: "its passphrase" },
      ]),
    );

    fireEvent.click(await screen.findByRole("button", { name: text.connect }));
    expect(await screen.findByText(text.noDocker)).toBeTruthy();
    // Nothing to install: it is added all the same.
    expect(document.body.textContent).not.toContain("get.docker.com");
    fireEvent.click(screen.getByRole("button", { name: text.switchTrust }));
    expect(await screen.findByText(text.switched("orion2480"))).toBeTruthy();
  });

  it("says, without asking, how the user would reach Docker that is there but not theirs", async () => {
    show({
      [`GET ${API_ROUTES.sshKeys}`]: [cedarsKey()],
      [`POST ${apiPath(API_ROUTES.sshHostSwitch, { hostId: "h3" })}`]: pending({ socket: true, usable: false }),
    });
    fillWhere();
    await choose("k1");
    useKey();
    fireEvent.click(await screen.findByRole("button", { name: text.connect }));
    expect(await screen.findByText(text.notUsable("alex"))).toBeTruthy();
    expect(screen.getByText(SSH_SETUP.joinDocker("alex"))).toBeTruthy();
    expect(screen.getByRole("button", { name: text.switchTrust })).toBeTruthy();
  });

  it("lets a step be changed, and cancelling removes the keys this attempt stored, not one chosen", async () => {
    const made: MadeSshKeyView = {
      key: key({ id: "k2", name: "mini", madeByAutoheal: true }),
      privateKey: PRIVATE_KEY,
    };
    const fetch = show({
      [`GET ${API_ROUTES.sshKeys}`]: [cedarsKey()],
      [`POST ${API_ROUTES.sshKeysMake}`]: made,
      [`POST ${API_ROUTES.sshKeys}`]: key({ id: "k3", name: "pasted" }),
    });
    fillWhere();
    // The address was wrong: changed, the rest kept.
    fireEvent.click(await screen.findByRole("button", { name: text.change }));
    expect((screen.getByRole("textbox", { name: text.user }) as HTMLInputElement).value).toBe("alex");
    fireEvent.change(screen.getByRole("textbox", { name: text.address }), { target: { value: "192.168.10.21" } });
    fireEvent.click(screen.getByRole("button", { name: text.next }));
    expect(await screen.findByText(TEXT.ssh.host.signsInAs("alex", "192.168.10.21", 22))).toBeTruthy();

    await choose("make");
    fireEvent.click(screen.getByRole("button", { name: picker.make }));
    await screen.findByText(SSH_SETUP.folder);
    useKey();
    await screen.findByRole("button", { name: text.connect });
    // Another key after all: pasted in instead.
    fireEvent.click(screen.getAllByRole("button", { name: text.change }).at(-1)!);
    await choose("paste");
    fireEvent.change(screen.getByRole("textbox", { name: picker.privateKey }), { target: { value: PRIVATE_KEY } });
    useKey();
    await screen.findByRole("button", { name: text.connect });

    fireEvent.click(screen.getByRole("button", { name: text.cancel }));
    await waitFor(() => expect(cancelled).toHaveBeenCalled());
    const removed = fetch.mock.calls.filter(([, options]) => options?.method === "DELETE").map(([url]) => url);
    expect(removed).toEqual([apiPath(API_ROUTES.sshKey, { keyId: "k2" }), apiPath(API_ROUTES.sshKey, { keyId: "k3" })]);
  });

  it("makes a key for a user without one: the setup to copy, and its private half only as a download", async () => {
    const made: MadeSshKeyView = {
      key: key({ id: "k2", name: "mini", madeByAutoheal: true, publicLine: "ssh-ed25519 AAAAmade autoheal@mini" }),
      privateKey: PRIVATE_KEY,
    };
    const fetch = show({ [`GET ${API_ROUTES.sshKeys}`]: [], [`POST ${API_ROUTES.sshKeysMake}`]: made });
    const createObjectURL = vi.fn(() => "blob:made-key");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    fillWhere();
    await choose("make");
    // Its private half comes encrypted with the passphrase given, as ssh-keygen's would.
    fireEvent.change(screen.getByLabelText(new RegExp(`^${picker.passphrase}`)), { target: { value: "made's own" } });
    fireEvent.click(screen.getByRole("button", { name: picker.make }));

    for (const command of [
      SSH_SETUP.folder,
      SSH_SETUP.authorize(made.key.publicLine),
      SSH_SETUP.authorizeFrom("192.168.10.83", made.key.publicLine),
      SSH_SETUP.joinDocker("alex"),
      SSH_SETUP.checkDocker,
    ]) {
      expect(await screen.findByText(command)).toBeTruthy();
    }
    expect(sent(fetch, "POST", API_ROUTES.sshKeysMake)).toEqual([{ name: "orion2480", passphrase: "made's own" }]);
    expect(document.body.textContent).not.toContain("the-secret-body");

    fireEvent.click(screen.getByRole("button", { name: text.download }));
    const [blob] = createObjectURL.mock.calls[0] as unknown as [Blob];
    expect(await blob.text()).toBe(PRIVATE_KEY);
    expect(document.body.textContent).not.toContain("the-secret-body");
    // Picked once made: using it makes connecting the next step, its setup still on the page.
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: picker.key }).value).toBe("k2");
    useKey();
    expect(await screen.findByRole("button", { name: text.connect })).toBeTruthy();
    expect(screen.getByText(SSH_SETUP.folder)).toBeTruthy();
  });

  it("says what a refused key means, and what to do", async () => {
    show({
      [`GET ${API_ROUTES.sshKeys}`]: [cedarsKey()],
      [`POST ${apiPath(API_ROUTES.sshHostSwitch, { hostId: "h3" })}`]: [
        { status: 422, body: { error: "ssh_host_refused_key" } },
      ],
    });
    fillWhere();
    await choose("k1");
    useKey();
    fireEvent.click(await screen.findByRole("button", { name: text.connect }));
    expect(await screen.findByText(ERROR_TEXT.ssh_host_refused_key)).toBeTruthy();
  });
});
