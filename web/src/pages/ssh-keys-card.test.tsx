import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type MadeSshKeyView, type SshKeyView } from "../../../src/shared/api.js";
import { SSH_SETUP, TEXT } from "../constants.js";
import { SshKeysCard } from "./ssh-keys-card.js";

const text = TEXT.ssh.keys;
const laptop: SshKeyView = {
  id: "k1",
  name: "laptop",
  publicLine: "ssh-ed25519 AAAAlaptop alex@laptop",
  fingerprint: "SHA256:laptop",
  madeByAutoheal: false,
  createdBy: "admin",
  createdAt: 1,
  hosts: ["mini", "delta3640"],
};
const made: MadeSshKeyView = {
  key: { ...laptop, id: "k2", name: "spare", madeByAutoheal: true, publicLine: "ssh-ed25519 AAAAspare", hosts: [] },
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nthe-secret-body\n-----END OPENSSH PRIVATE KEY-----\n",
};

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("lists the keys and the hosts using each, makes one without showing its private half, and removes one", async () => {
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const answers: Record<string, unknown> = {
      [`GET ${API_ROUTES.sshKeys}`]: [laptop],
      [`POST ${API_ROUTES.sshKeysMake}`]: made,
    };
    const answer = answers[`${method} ${path}`];
    return answer === undefined
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SshKeysCard dashboardAddress="192.168.10.83" />
    </QueryClientProvider>,
  );

  expect(await screen.findByText(text.usedBy(["mini", "delta3640"]))).toBeTruthy();
  expect(screen.getByText("SHA256:laptop")).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: text.makeName }), { target: { value: "spare" } });
  fireEvent.click(screen.getByRole("button", { name: TEXT.ssh.add.make }));
  expect(await screen.findByText(SSH_SETUP.authorize(made.key.publicLine))).toBeTruthy();
  expect(screen.getByText(SSH_SETUP.authorizeFrom("192.168.10.83", made.key.publicLine))).toBeTruthy();
  expect(screen.getByRole("button", { name: TEXT.ssh.add.download })).toBeTruthy();
  expect(document.body.textContent).not.toContain("the-secret-body");

  fireEvent.click(screen.getByRole("button", { name: text.remove }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([url, options]) => url === apiPath(API_ROUTES.sshKey, { keyId: "k1" }) && options?.method === "DELETE",
      ),
    ).toBe(true),
  );
});
