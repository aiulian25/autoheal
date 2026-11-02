import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type HostView,
  type MadeSshKeyView,
  type PendingSshHostView,
  type SettingsView,
  type SshKeyView,
} from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import { ConnectHostTile } from "./connect-host.js";

const text = TEXT.connectHost;
const PRIVATE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAKYWVzMjU2LWN0cg-the-secret\n-----END OPENSSH PRIVATE KEY-----\n";
const PENDING_ID = "5b6a3f58-6a43-4f7c-9a3f-6a4e1d2c3b4a";
const settings = { runnerAddress: "https://autoheal.example:9443" } as SettingsView;

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
const pending: PendingSshHostView = {
  pendingId: PENDING_ID,
  label: "mini",
  hostKeyFingerprint: "SHA256:hostkeyfingerprint",
  expiresAt: Date.now() + 600_000,
  docker: { socket: true, usable: true },
};
const newHost = (overrides: Partial<HostView> = {}) =>
  ({ id: "h3", label: "DS923", state: "never_seen", ...overrides }) as HostView;

// jsdom has <dialog> but neither opens nor closes one.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});

/** Answers by "METHOD path"; anything not listed gets an empty list. */
function show(answers: Record<string, unknown>, hosts: readonly HostView[] = []) {
  const fetch = vi.fn(
    async (path: string, options?: RequestInit) =>
      new Response(JSON.stringify(answers[`${options?.method ?? "GET"} ${path}`] ?? []), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ConnectHostTile hosts={hosts} />
    </QueryClientProvider>,
  );
  const rerender = (next: readonly HostView[]) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <ConnectHostTile hosts={next} />
      </QueryClientProvider>,
    );
  return { fetch, rerender };
}
const sent = (fetch: ReturnType<typeof show>["fetch"], method: string, path: string) =>
  fetch.mock.calls
    .filter(([url, init]) => url === path && init?.method === method)
    .map(([, init]) => (init?.body === undefined ? null : JSON.parse(String(init.body))));

// Open once its fields are there: they wait for the dashboard's own address.
async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: text.tile }));
  const dialog = within(await screen.findByRole("dialog", { name: text.title }));
  await dialog.findByRole("textbox", { name: /^Name/ });
  return dialog;
}
const type = (dialog: ReturnType<typeof within>, name: string | RegExp, value: string) =>
  fireEvent.change(dialog.getByRole("textbox", { name }), { target: { value } });

describe("connecting a new host from the tile at the end of the host grid", () => {
  it("over SSH with the user's own key and its passphrase: stored, signed in with, trusted, and added", async () => {
    const { fetch } = show({
      [`GET ${API_ROUTES.settings}`]: settings,
      [`POST ${API_ROUTES.sshKeys}`]: key({ id: "k9", name: "mini" }),
      [`POST ${API_ROUTES.sshHosts}`]: pending,
      [`POST ${apiPath(API_ROUTES.sshHostConfirm, { pendingId: PENDING_ID })}`]: newHost({ id: "h4", label: "mini" }),
    });
    const dialog = await openDialog();
    type(dialog, /^Name/, "mini");
    type(dialog, text.address, "192.168.10.123");
    type(dialog, text.user, "alex");
    fireEvent.change(await dialog.findByRole("combobox", { name: text.key }), { target: { value: "paste" } });
    type(dialog, text.privateKey, PRIVATE_KEY);
    fireEvent.change(dialog.getByLabelText(new RegExp(`^${text.passphrase}`)), {
      target: { value: "my own passphrase" },
    });
    expect(dialog.getByRole<HTMLButtonElement>("button", { name: text.add }).disabled).toBe(true);
    fireEvent.click(dialog.getByRole("button", { name: text.test }));

    expect(await dialog.findByText(pending.hostKeyFingerprint)).toBeTruthy();
    expect(sent(fetch, "POST", API_ROUTES.sshKeys)).toEqual([
      { name: "mini", privateKey: PRIVATE_KEY, passphrase: "my own passphrase" },
    ]);
    expect(sent(fetch, "POST", API_ROUTES.sshHosts)).toEqual([
      { label: "mini", address: "192.168.10.123", port: 22, user: "alex", keyId: "k9" },
    ]);
    expect(dialog.getByText(TEXT.ssh.add.withDocker)).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: text.trust }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(fetch, "POST", apiPath(API_ROUTES.sshHostConfirm, { pendingId: PENDING_ID }))).toHaveLength(1);
    // Added: the key it stored stays, as the host signs in with it.
    expect(sent(fetch, "DELETE", apiPath(API_ROUTES.sshKey, { keyId: "k9" }))).toEqual([]);
  });

  it("makes a key with a passphrase, shows what lets it in with its download, and signs in with a stored key", async () => {
    const made: MadeSshKeyView = {
      key: key({ id: "k5", name: "mini", madeByAutoheal: true, publicLine: "ssh-ed25519 AAAAmade autoheal@mini" }),
      privateKey: PRIVATE_KEY,
    };
    const { fetch } = show({
      [`GET ${API_ROUTES.settings}`]: settings,
      [`GET ${API_ROUTES.sshKeys}`]: [key(), made.key],
      [`POST ${API_ROUTES.sshKeysMake}`]: made,
    });
    const dialog = await openDialog();
    type(dialog, /^Name/, "mini");
    type(dialog, text.user, "alex");
    fireEvent.change(await dialog.findByRole("combobox", { name: text.key }), { target: { value: "make" } });
    fireEvent.change(dialog.getByLabelText(new RegExp(`^${text.passphrase}`)), { target: { value: "made's own" } });
    fireEvent.click(dialog.getByRole("button", { name: text.make }));

    const commands = await dialog.findByText(text.newKeyCommands);
    expect(sent(fetch, "POST", API_ROUTES.sshKeysMake)).toEqual([{ name: "mini", passphrase: "made's own" }]);
    const details = commands.closest("details")!;
    expect(details.open).toBe(true);
    // The made key's own line, to put in place on the host as is, or held to this dashboard's address.
    expect(within(details).getAllByText(/ssh-ed25519 AAAAmade autoheal@mini/, { selector: "pre" })).toHaveLength(2);
    expect(within(details).getByRole("button", { name: TEXT.ssh.add.download })).toBeTruthy();
    // Chosen once made: Test connection is open to it.
    expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: text.key }).value).toBe("k5");
  });

  it("takes back the keys an attempt stored when it is cancelled, by its button or by Escape", async () => {
    const { fetch } = show({
      [`GET ${API_ROUTES.settings}`]: settings,
      [`POST ${API_ROUTES.sshKeys}`]: key({ id: "k9", name: "mini" }),
      [`POST ${API_ROUTES.sshHosts}`]: pending,
    });
    const dialog = await openDialog();
    type(dialog, /^Name/, "mini");
    type(dialog, text.address, "192.168.10.123");
    type(dialog, text.user, "alex");
    fireEvent.change(await dialog.findByRole("combobox", { name: text.key }), { target: { value: "paste" } });
    type(dialog, text.privateKey, PRIVATE_KEY);
    fireEvent.click(dialog.getByRole("button", { name: text.test }));
    await dialog.findByText(pending.hostKeyFingerprint);

    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(fetch, "DELETE", apiPath(API_ROUTES.sshKey, { keyId: "k9" }))).toEqual([null]);
  });

  it("with a runner: makes its install command, waits for it, and is done once it joined", async () => {
    const enrolled: EnrolledHostView = {
      host: newHost(),
      joinCode: "join-code",
      imageCopyCommand: null,
      installCommand: "mkdir -p autoheal && cd autoheal && docker compose up -d",
    };
    const { fetch, rerender } = show({
      [`GET ${API_ROUTES.settings}`]: settings,
      [`POST ${API_ROUTES.hosts}`]: enrolled,
    });
    const dialog = await openDialog();
    type(dialog, /^Name/, "DS923");
    fireEvent.change(dialog.getByRole("combobox", { name: new RegExp(`^${text.connection}`) }), {
      target: { value: "runner" },
    });
    expect(((await dialog.findByRole("textbox", { name: text.runnerAddress })) as HTMLInputElement).value).toBe(
      settings.runnerAddress,
    );
    fireEvent.click(dialog.getByRole("checkbox", { name: new RegExp(TEXT.hosts.add.nas) }));
    fireEvent.click(dialog.getByRole("button", { name: text.makeCommand }));

    expect(await dialog.findByText(enrolled.installCommand)).toBeTruthy();
    expect(sent(fetch, "POST", API_ROUTES.hosts)).toEqual([
      { label: "DS923", address: settings.runnerAddress, nasFolder: "/volume1/docker/autoheal" },
    ]);
    expect(dialog.getByText(TEXT.hosts.add.waiting("DS923"))).toBeTruthy();
    // This image can be downloaded, so there is no copying to do.
    expect(dialog.queryByText(TEXT.hosts.add.nasCopyTitle)).toBeNull();
    expect(dialog.getByText(TEXT.hosts.add.nasPaste)).toBeTruthy();
    // Its way in stays as it was made.
    expect(dialog.getByRole<HTMLSelectElement>("combobox", { name: new RegExp(`^${text.connection}`) }).disabled).toBe(
      true,
    );

    rerender([newHost({ state: "online" })]);
    expect(await dialog.findByText(TEXT.hosts.add.connected("DS923"))).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: text.done }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(fetch, "POST", apiPath(API_ROUTES.hostRevoke, { hostId: "h3" }))).toEqual([]);
  });

  it("revokes a runner host that never joined when it is cancelled: its join code opens nothing", async () => {
    const enrolled: EnrolledHostView = {
      host: newHost(),
      joinCode: "join-code",
      imageCopyCommand: null,
      installCommand: "docker compose up -d",
    };
    const { fetch } = show({
      [`GET ${API_ROUTES.settings}`]: settings,
      [`POST ${API_ROUTES.hosts}`]: enrolled,
    });
    const dialog = await openDialog();
    fireEvent.change(dialog.getByRole("combobox", { name: new RegExp(`^${text.connection}`) }), {
      target: { value: "runner" },
    });
    fireEvent.click(await dialog.findByRole("button", { name: text.makeCommand }));
    await dialog.findByText(enrolled.installCommand);
    // No name given: the host's own hostname is used.
    expect(sent(fetch, "POST", API_ROUTES.hosts)).toEqual([{ address: settings.runnerAddress }]);

    fireEvent.click(dialog.getByRole("button", { name: text.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(fetch, "POST", apiPath(API_ROUTES.hostRevoke, { hostId: "h3" }))).toEqual([null]);
  });
});
