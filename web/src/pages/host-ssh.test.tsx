import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type SshHostDetailsView,
  type SshKeyView,
} from "../../../src/shared/api.js";
import { DEFAULT_SSH_HOST_SETTINGS } from "../../../src/shared/ssh-hosts.js";
import { SSH_SETUP, TEXT } from "../constants.js";
import { SshHostCard } from "./host-ssh.js";

const HOST_ID = "8d0c3a52-0f8e-4b8f-9a55-3f6c1b2a4d5e";
const text = TEXT.ssh.host;
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
  keyName: "laptop",
  hostKeyFingerprint: "SHA256:trusted",
  offeredHostKeyFingerprint: null,
  settings: DEFAULT_SSH_HOST_SETTINGS,
  rootMethod: null,
  ...overrides,
});
const key = (id: string, name: string) => ({ id, name, fingerprint: `SHA256:${name}` }) as SshKeyView;

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
    return new Response(JSON.stringify(answers[`${method} ${path}`] ?? host), {
      headers: { "content-type": "application/json" },
    });
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

  it("signs in with another stored key, and saves its settings as a runner's .env would hold them", async () => {
    const fetch = show(details());
    expect(screen.queryByRole("button", { name: text.trustNew })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: text.replace }));
    await waitFor(() =>
      expect(sent(fetch, "PUT", apiPath(API_ROUTES.sshHostKey, { hostId: HOST_ID }))).toEqual([{ keyId: "k2" }]),
    );

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
