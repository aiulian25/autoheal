import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type SessionView } from "../../../src/shared/api.js";
import type { ProbeView } from "../../../src/shared/probes.js";
import { SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { ServiceProbes } from "./service-probes.js";

const text = TEXT.probes;
const ROUTE = apiPath(API_ROUTES.hostProbes, { hostId: "h1" });
const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const availability = { percent: 99.5, down: 1, maintenance: 0, unknownPercent: 0 };
const probe = (change: Partial<ProbeView> = {}): ProbeView => ({
  id: "p1",
  hostId: "h1",
  name: "Wiki",
  scope: "local-network",
  vantage: null,
  intervalSeconds: 60,
  timeoutSeconds: 5,
  failuresBeforeDown: 3,
  objectivePercent: 99,
  target: { kind: "http", url: "http://192.168.10.2/", expectedStatus: 200, ignoreCertificate: false },
  state: "up",
  stateSince: 1,
  inMaintenance: false,
  lastCheckedAt: 2,
  lastLatencyMilliseconds: 12,
  lastProblem: null,
  certificate: null,
  certificateStatus: null,
  day: availability,
  month: { ...availability, percent: 90, unknownPercent: 12 },
  samples: [
    { at: 1, outcome: "up", latencyMilliseconds: 10 },
    { at: 2, outcome: "up", latencyMilliseconds: 12 },
  ],
  ...change,
});

let listed: ProbeView[];
let sent: { method: string; url: string; body: Record<string, unknown> | null }[];
let refusal: string | null;

beforeEach(() => {
  listed = [];
  sent = [];
  refusal = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify(listed), { status: 200 });
      sent.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (refusal !== null) return new Response(JSON.stringify({ error: refusal }), { status: 400 });
      return new Response(JSON.stringify({ id: "p2" }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  const { container } = render(
    <QueryClientProvider client={client}>
      <ServiceProbes hostId="h1" />
    </QueryClientProvider>,
  );
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
const typeInto = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("service checks on a host's page", () => {
  it("asks for nothing until opened", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ServiceProbes hostId="h1" />
      </QueryClientProvider>,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so when there are none", async () => {
    await open();
    expect(await screen.findByText(text.none)).toBeTruthy();
  });

  it("shows state, availability against its target, and time not looked at", async () => {
    listed = [probe()];
    await open();
    expect(await screen.findByText("Wiki")).toBeTruthy();
    expect(screen.getByText(/Last day: 99\.50%/)).toBeTruthy();
    expect(screen.getByText(/Last day: 99\.50%/).textContent).toContain("meets its 99.00% target");
    expect(screen.getByText(/Last 30 days: 90\.00%/).textContent).toContain("below its 99.00% target");
    expect(screen.getByText(/not checked for 12\.00% of the time/)).toBeTruthy();
  });

  it("shows why it is down, and when maintenance is holding it", async () => {
    listed = [probe({ state: "down", lastProblem: "It answered 500, not 200.", inMaintenance: true })];
    await open();
    expect(await screen.findByText("It answered 500, not 200.")).toBeTruthy();
    expect(screen.getByText(text.maintenance)).toBeTruthy();
  });

  it("says nothing was seen yet rather than giving a figure", async () => {
    listed = [probe({ day: { ...availability, percent: null } })];
    await open();
    expect(await screen.findByText(new RegExp(`Last day: ${text.noFigure}`))).toBeTruthy();
  });

  it("adds a web check as filled in", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: text.add }));
    typeInto(text.name, "Wiki");
    typeInto(text.url, "http://192.168.10.2/health");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: ROUTE,
      body: {
        name: "Wiki",
        scope: "local-network",
        intervalSeconds: 60,
        timeoutSeconds: 5,
        failuresBeforeDown: 3,
        objectivePercent: null,
        target: { kind: "http", url: "http://192.168.10.2/health", expectedStatus: 200, ignoreCertificate: false },
      },
    });
  });

  it("adds a port check and a name lookup with their own fields", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: text.add }));
    typeInto(text.name, "Database");
    typeInto(text.kind, "tcp");
    typeInto(text.host, "192.168.10.3");
    typeInto(text.port, "5432");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body!.target).toEqual({ kind: "tcp", host: "192.168.10.3", port: 5432 });

    fireEvent.click(await screen.findByRole("button", { name: text.add }));
    typeInto(text.name, "Names");
    typeInto(text.kind, "dns");
    typeInto(text.lookupName, "wiki.home.test");
    typeInto(text.server, "192.168.10.1");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body!.target).toEqual({
      kind: "dns",
      name: "wiki.home.test",
      server: "192.168.10.1",
      port: 53,
      expectedAnswer: null,
    });
  });

  it("says why a destination was refused, keeping what was typed", async () => {
    refusal = "probe_destination_refused";
    await open();
    fireEvent.click(await screen.findByRole("button", { name: text.add }));
    typeInto(text.name, "Metadata");
    typeInto(text.url, "http://169.254.169.254/");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText(text.url) as HTMLInputElement).value).toBe("http://169.254.169.254/");
  });

  it("adds a certificate check, naming what it trusts", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: text.add }));
    typeInto(text.name, "Wiki");
    typeInto(text.kind, "tls");
    typeInto(text.host, "192.168.10.2");
    typeInto(text.port, "443");
    typeInto(text.serverName, "wiki.home.test");
    typeInto(text.caPem, "-----BEGIN CERTIFICATE-----");
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body!.target).toEqual({
      kind: "tls",
      host: "192.168.10.2",
      port: 443,
      serverName: "wiki.home.test",
      warnDays: 30,
      caPem: "-----BEGIN CERTIFICATE-----",
    });
  });

  it("shows what a certificate check last saw, dated, and why it is not trusted", async () => {
    listed = [
      probe({
        target: { kind: "tls", host: "h", port: 443, serverName: null, warnDays: 30, caPem: null },
        certificateStatus: "untrusted",
        certificate: {
          fingerprint: "AA:BB",
          subject: "CN=wiki",
          issuer: "CN=Home",
          validFrom: 1,
          validTo: Date.UTC(2027, 0, 12),
          name: "wiki.home.test",
          nameMatches: true,
          chainError: "SELF_SIGNED_CERT_IN_CHAIN",
          observedAt: Date.now(),
          firstSeenAt: Date.now(),
        },
      }),
    ];
    await open();
    expect(await screen.findByText(/Certificate not trusted/i)).toBeTruthy();
    expect(screen.getByText(/For wiki\.home\.test, issued by CN=Home/)).toBeTruthy();
    expect(screen.getByText(/2027-01-12/)).toBeTruthy();
    expect(screen.getByText("SELF_SIGNED_CERT_IN_CHAIN")).toBeTruthy();
  });

  it("removes only once confirmed", async () => {
    listed = [probe()];
    await open();
    fireEvent.click(await screen.findByRole("button", { name: text.remove }));
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: text.removeYes }));
    await waitFor(() =>
      expect(sent).toMatchObject([
        { method: "DELETE", url: apiPath(API_ROUTES.hostProbe, { hostId: "h1", probeId: "p1" }) },
      ]),
    );
  });
});
