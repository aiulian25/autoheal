import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import type { RegistryCredentialView } from "../../../src/shared/registry-credentials.js";
import { TEXT } from "../constants.js";
import { RegistryCredentialsCard } from "./registry-credentials.js";

const text = TEXT.registries;
const PASSWORD = "ghp_a-token-nobody-else-may-see";
const HOSTS = [
  { id: "6f1c9a1e-0000-4000-8000-000000000001", label: "Alder" },
  { id: "6f1c9a1e-0000-4000-8000-000000000002", label: "Birch" },
] as HostView[];
const owner: RegistryCredentialView = {
  id: "c1",
  registry: "ghcr.io",
  repository: "owner/app",
  username: "owner",
  hostIds: [HOSTS[0]!.id],
  createdBy: "admin",
  createdAt: 1,
  updatedAt: 2,
};

let client: QueryClient;
let credentials: RegistryCredentialView[];
let sent: { url: string; method: string; body: Record<string, unknown> | null }[];

beforeEach(() => {
  credentials = [owner];
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      const answer = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (method === "GET") {
        if (url === API_ROUTES.registryCredentials) return answer(credentials);
        return answer(HOSTS);
      }
      sent.push({ url, method, body: options?.body === undefined ? null : JSON.parse(String(options.body)) });
      if (url.endsWith("/test"))
        return answer({ reached: false, problem: "ghcr.io refused the stored credential for owner" });
      if (method === "POST") return answer({ id: "c2" });
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RegistryCredentialsCard />
    </QueryClientProvider>,
  );
}

it("shows each credential's scope, its user and the hosts allowed to use it, and never a password", async () => {
  show();

  expect(await screen.findByText("ghcr.io/owner/app")).toBeTruthy();
  expect(screen.getByText(new RegExp(text.asUser("owner")))).toBeTruthy();
  expect(screen.getAllByText(/Alder/).length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain(PASSWORD);
  expect(screen.getAllByLabelText(text.newPassword)[0]!).toHaveProperty("type", "password");
});

it("adds one for the hosts that were ticked, and leaves the repository out for a whole registry", async () => {
  show();
  const form = (await screen.findByLabelText(text.add)) as HTMLFormElement;

  fireEvent.change(screen.getByLabelText(text.registry), { target: { value: "registry.example.com" } });
  fireEvent.change(screen.getByLabelText(text.username), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText(text.password), { target: { value: PASSWORD } });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Birch" }));
  fireEvent.submit(form);

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    url: API_ROUTES.registryCredentials,
    method: "POST",
    body: {
      registry: "registry.example.com",
      repository: null,
      username: "owner",
      password: PASSWORD,
      hostIds: [HOSTS[1]!.id],
    },
  });
});

it("replaces a password without changing the scope, and asks before removing one", async () => {
  show();

  fireEvent.change(await screen.findByLabelText(text.newPassword), { target: { value: "rotated-secret" } });
  fireEvent.click(screen.getByRole("button", { name: text.rotate }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({
    url: apiPath(API_ROUTES.registryCredential, { credentialId: "c1" }),
    method: "PUT",
    body: { registry: "ghcr.io", repository: "owner/app", password: "rotated-secret", hostIds: [HOSTS[0]!.id] },
  });

  fireEvent.click(screen.getByRole("button", { name: text.remove }));
  expect(sent).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({ method: "DELETE" });
});

it("says what an asked-for try found, in the words the control plane sent", async () => {
  show();

  fireEvent.click(await screen.findByRole("button", { name: text.test }));

  expect(await screen.findByText(/refused the stored credential for owner/)).toBeTruthy();
  expect(sent[0]).toMatchObject({ url: apiPath(API_ROUTES.registryCredentialTest, { credentialId: "c1" }) });
});

it("says plainly when none is set up, so public images are not thought to need one", async () => {
  credentials = [];
  show();

  expect(await screen.findByText(text.none)).toBeTruthy();
});
