import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type SshHostDetailsView,
  type SshKeyView,
} from "../../../src/shared/api.js";
import { DEFAULT_SSH_HOST_SETTINGS } from "../../../src/shared/ssh-hosts.js";
import { ERROR_TEXT, SSH_SETUP, TEXT } from "../constants.js";
import { SshHostCard } from "./host-ssh.js";

const HOST_ID = "8d0c3a52-0f8e-4b8f-9a55-3f6c1b2a4d5e";
const text = TEXT.ssh.host;
const picker = TEXT.sshKeyPicker;
const host = {
  id: HOST_ID,
  label: "mini",
  kind: "ssh",
  ssh: { state: "hostKeyChanged", since: Date.now(), reason: null },
} as HostView;
const details = (overrides: Partial<SshHostDetailsView> = {}): SshHostDetailsView => ({
  address: "192.168.10.50",
  port: 22,
  user: "alex",
  keyId: "k1",
  keyFingerprint: "SHA256:laptop",
  keySharedWith: [],
  hostKeyFingerprint: "SHA256:trusted",
  offeredHostKeyFingerprint: null,
  settings: DEFAULT_SSH_HOST_SETTINGS,
  rootMethod: null,
  ...overrides,
});
const key = (id: string, name: string) =>
  ({
    id,
    name,
    fingerprint: `SHA256:${name}`,
    publicLine: `ssh-ed25519 AAAA ${name}`,
    hosts: [],
  }) as unknown as SshKeyView;

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function show(view: SshHostDetailsView, shown: HostView = host, more: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const answers: Record<string, unknown> = {
      ...more,
      [`GET ${apiPath(API_ROUTES.sshHost, { hostId: HOST_ID })}`]: view,
      [`GET ${API_ROUTES.sshKeys}`]: [key("k1", "laptop"), key("k2", "made-for-mini")],
      [`PUT ${apiPath(API_ROUTES.sshHostSettings, { hostId: HOST_ID })}`]: JSON.parse(String(options?.body ?? "{}")),
    };
    const answer = answers[`${method} ${path}`];
    // A function answers each call afresh: a reply of its own, or the next of several.
    const reply = typeof answer === "function" ? (answer as () => unknown)() : answer;
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify(reply ?? host), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SshHostCard host={shown} />
    </QueryClientProvider>,
  );
  return fetch;
}
const sent = (fetch: ReturnType<typeof show>, method: string, path: string) =>
  fetch.mock.calls
    .filter(([url, options]) => url === path && options?.method === method)
    .map(([, options]) => JSON.parse(String(options!.body)));

describe("an SSH host's own card", () => {
  it("checks and saves a root password, says how it is used, never shows it, and removes it", async () => {
    const fetch = show(details({ rootMethod: "su" }));
    expect(await screen.findByText(text.rootSaved("su"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(text.rootPassword), { target: { value: "root's password" } });
    fireEvent.click(screen.getByRole("button", { name: text.rootSave }));
    await waitFor(() =>
      expect(sent(fetch, "PUT", apiPath(API_ROUTES.sshHostRoot, { hostId: HOST_ID }))).toEqual([
        { password: "root's password" },
      ]),
    );
    expect((screen.getByLabelText(text.rootPassword) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: text.rootRemove }));
    fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) =>
            url === apiPath(API_ROUTES.sshHostRoot, { hostId: HOST_ID }) && options?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  describe("what an interrupted package run left", () => {
    const interrupted = apiPath(API_ROUTES.sshHostInterrupted, { hostId: HOST_ID });
    const upgrade = { operation: "host:job-5", target: "", step: 1, at: Date.UTC(2026, 10, 15, 8, 0) };
    const refusal = "1 unfinished operation needs clearing before this runner can start: host:job-5";
    const connected = (reason: string | null, records: (typeof upgrade)[]) =>
      ({ ...host, ssh: { state: "connected", since: Date.now(), reason, interrupted: records } }) as HostView;
    const asked = (fetch: ReturnType<typeof show>, method: string) =>
      fetch.mock.calls.some(([url, options]) => url === interrupted && (options?.method ?? "GET") === method);

    it("is listed where its runner will not start, with what to look at, and cleared once a person says they looked", async () => {
      const fetch = show(details(), connected(refusal, [upgrade]), { [`DELETE ${interrupted}`]: [] });
      expect(await screen.findByText("host:job-5 (step 1, 2026-11-15 08:00)")).toBeTruthy();
      expect(screen.getByText(TEXT.heldBack.advice.packages)).toBeTruthy();
      // Said once, in the list: the connection line only says that its runner is held back.
      expect(screen.queryByText(new RegExp(refusal))).toBeNull();
      expect(screen.getByText(new RegExp(TEXT.ssh.heldBack))).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: TEXT.heldBack.clear }));
      expect(asked(fetch, "DELETE")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
      await waitFor(() => expect(asked(fetch, "DELETE")).toBe(true));
    });

    it("is not shown while its runner runs", async () => {
      show(details(), connected(null, []));
      await screen.findByText(text.title);
      expect(screen.queryByRole("button", { name: TEXT.heldBack.clear })).toBeNull();
    });
  });

  it("says a host without Docker is watched for its system alone", async () => {
    show(details(), { ...host, docker: false });
    expect(await screen.findByText(text.systemOnly)).toBeTruthy();
  });

  it("shows how it is reached, and on a changed host key both fingerprints and trusts the offered one", async () => {
    const fetch = show(details({ offeredHostKeyFingerprint: "SHA256:offered" }));
    expect(await screen.findByText(text.signsInAs("alex", "192.168.10.50", 22))).toBeTruthy();
    expect(screen.getByText(text.changed("SHA256:trusted", "SHA256:offered"))).toBeTruthy();
    expect(screen.getByText(SSH_SETUP.compareHostKey)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: text.trustNew }));
    await waitFor(() =>
      expect(sent(fetch, "POST", apiPath(API_ROUTES.sshHostTrustHostKey, { hostId: HOST_ID }))).toEqual([
        { fingerprint: "SHA256:offered" },
      ]),
    );
  });

  it("shows how it is reached and with which key, with nothing on the page to switch it by mistake", async () => {
    show(details({ keySharedWith: ["Cedar"] }));
    expect(await screen.findByText(text.signsInAs("alex", "192.168.10.50", 22))).toBeTruthy();
    expect(screen.getByText("SHA256:laptop")).toBeTruthy();
    expect(screen.getByText(text.sharedWith(["Cedar"]))).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: picker.key })).toBeNull();
    expect(screen.getByRole("button", { name: text.edit })).toBeTruthy();
  });

  it("changes how it is reached in one form, tried first, and keeps another host key only once a person trusts it", async () => {
    const connection = apiPath(API_ROUTES.sshHostConnection, { hostId: HOST_ID });
    const replies: unknown[] = [{ offeredHostKeyFingerprint: "SHA256:other" }, { host }];
    const fetch = show(details(), host, { [`PUT ${connection}`]: () => replies.shift() });
    fireEvent.click(await screen.findByRole("button", { name: text.edit }));
    const form = within(screen.getByRole("form", { name: text.edit }));
    // It opens on what the host has now: its own key picked, nothing else.
    const select = await form.findByRole<HTMLSelectElement>("combobox", { name: picker.key });
    await waitFor(() => expect(select.value).toBe("k1"));
    expect(form.getByRole("option", { name: picker.now("SHA256:laptop") })).toBeTruthy();
    fireEvent.change(form.getByRole("spinbutton", { name: TEXT.ssh.add.port }), { target: { value: "2222" } });
    fireEvent.click(form.getByRole("button", { name: text.testAndSave }));

    expect(await form.findByText(text.otherHostKey("192.168.10.50", "SHA256:other"))).toBeTruthy();
    expect(form.getByText(SSH_SETUP.compareHostKey)).toBeTruthy();
    fireEvent.click(form.getByRole("button", { name: text.trustAndSave }));
    expect(await screen.findByText(text.connectionSaved)).toBeTruthy();
    expect(sent(fetch, "PUT", connection)).toEqual([
      { address: "192.168.10.50", port: 2222, user: "alex", keyId: "k1", hostKeyFingerprint: null },
      { address: "192.168.10.50", port: 2222, user: "alex", keyId: "k1", hostKeyFingerprint: "SHA256:other" },
    ]);
    expect(screen.queryByRole("form", { name: text.edit })).toBeNull();
  });

  it("takes a pasted key in place, says what a refusal means, and lets the key go again when cancelled", async () => {
    const connection = apiPath(API_ROUTES.sshHostConnection, { hostId: HOST_ID });
    const pasted = "-----BEGIN OPENSSH PRIVATE KEY-----\nmini";
    const refused = () =>
      new Response(JSON.stringify({ error: "ssh_host_refused_key" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    const fetch = show(details(), host, {
      [`POST ${API_ROUTES.sshKeys}`]: key("k9", "mini"),
      [`PUT ${connection}`]: refused,
    });
    fireEvent.click(await screen.findByRole("button", { name: text.edit }));
    const form = within(screen.getByRole("form", { name: text.edit }));
    fireEvent.change(await form.findByRole("combobox", { name: picker.key }), { target: { value: "paste" } });
    fireEvent.change(form.getByRole("textbox", { name: picker.privateKey }), { target: { value: pasted } });
    fireEvent.click(form.getByRole("button", { name: text.testAndSave }));

    expect(await form.findByText(ERROR_TEXT.ssh_host_refused_key)).toBeTruthy();
    expect(sent(fetch, "POST", API_ROUTES.sshKeys)).toEqual([{ name: "mini", privateKey: pasted, passphrase: "" }]);
    expect(sent(fetch, "PUT", connection)).toEqual([
      { address: "192.168.10.50", port: 22, user: "alex", keyId: "k9", hostKeyFingerprint: null },
    ]);
    fireEvent.click(form.getByRole("button", { name: TEXT.ssh.add.cancel }));
    const removed = apiPath(API_ROUTES.sshKey, { keyId: "k9" });
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url, options]) => url === removed && options?.method === "DELETE")).toBe(true),
    );
    expect(screen.queryByRole("form", { name: text.edit })).toBeNull();
  });

  it("folds away its root password and its settings, each saying how it stands, and saves the settings", async () => {
    const fetch = show(details());
    expect(await screen.findByText(text.rootState.none)).toBeTruthy();
    const settings = text.settingsState;
    const state = [
      DEFAULT_SSH_HOST_SETTINGS.dryRun ? settings.dryRun : settings.acting,
      DEFAULT_SSH_HOST_SETTINGS.containerAccess ? settings.access : settings.noAccess,
      settings.nothingProtected,
    ].join(TEXT.separator);
    expect(screen.getByText(state)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: text.dryRun }));
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(text.protectedContainers) }), {
      target: { value: "postgres, npm  redis" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: text.hostTerminal }));
    fireEvent.click(screen.getByRole("checkbox", { name: text.hostDeploy }));
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(text.hostFilesystems) }), {
      target: { value: "/ /mnt/data" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: text.hostPackages }), { target: { value: "check" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: text.checkpointLimit }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() =>
      expect(sent(fetch, "PUT", apiPath(API_ROUTES.sshHostSettings, { hostId: HOST_ID }))).toEqual([
        {
          dryRun: !DEFAULT_SSH_HOST_SETTINGS.dryRun,
          protectedContainers: ["postgres", "npm", "redis"],
          containerAccess: DEFAULT_SSH_HOST_SETTINGS.containerAccess,
          hostTerminal: !DEFAULT_SSH_HOST_SETTINGS.hostTerminal,
          hostDeploy: !DEFAULT_SSH_HOST_SETTINGS.hostDeploy,
          hostFilesystems: ["/", "/mnt/data"],
          hostPackages: "check",
          checkpointLimitGigabytes: 5,
        },
      ]),
    );
  });
});
