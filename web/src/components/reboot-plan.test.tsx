import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiPath, type HostView, type SessionView } from "../../../src/shared/api.js";
import { HOST_KIND } from "../../../src/shared/constants.js";
import {
  REBOOT_PLAN_ROUTES,
  REBOOT_PLAN_TEXT,
  type RebootPlanPreview,
  type RebootPlanView,
} from "../../../src/shared/reboot-plans.js";
import { SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { RebootPlanPanel } from "./reboot-plan.js";

const text = TEXT.rebootPlans;
const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const host = (id: string, label: string, kind: HostView["kind"] = HOST_KIND.runner) =>
  ({ id, label, kind }) as HostView;
const HOSTS = [host("h1", "One"), host("h2", "Two"), host("h3", "Home", HOST_KIND.local)];
const step = (hostLabel: string, status: RebootPlanView["steps"][number]["status"]) => ({
  hostId: hostLabel,
  hostLabel,
  status,
  jobId: null,
  followingSince: null,
  backAt: null,
  doneAt: null,
});
const planWith = (change: Partial<RebootPlanView> = {}): RebootPlanView => ({
  id: "p1",
  body: {
    name: "Kernel updates",
    hostIds: ["h1", "h2"],
    minimumHealthy: 1,
    probeIds: [],
    returnMinutes: 15,
    notBefore: null,
    notAfter: null,
  },
  status: "running",
  createdBy: { userId: "u1", username: "admin" },
  createdAt: 1,
  updatedAt: 2,
  cancelAsked: false,
  reason: null,
  steps: [step("One", "asked"), step("Two", "waiting")],
  ...change,
});
const previewWith = (problem: string | null): RebootPlanPreview => ({
  hosts: [
    { hostId: "h2", label: "Two", problem: null, rebootRequired: true, openJobs: 0 },
    { hostId: "h1", label: "One", problem: "One has not reported recently.", rebootRequired: false, openJobs: 2 },
  ],
  checks: [],
  problem,
});

let plans: RebootPlanView[];
let preview: RebootPlanPreview;
// The checks each host reports, which a refetch may answer differently.
let probes: Record<string, { id: string; name: string }[]>;
let sent: { url: string; body: Record<string, unknown> | null }[];

beforeEach(() => {
  plans = [];
  preview = previewWith(null);
  probes = {};
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if ((init?.method ?? "GET") === "GET") {
        if (url === REBOOT_PLAN_ROUTES.plans) return answer(plans);
        const forHost = /\/hosts\/([^/]+)\/probes$/.exec(url)?.[1];
        return answer(forHost === undefined ? [] : (probes[forHost] ?? []));
      }
      sent.push({ url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      return answer(url === REBOOT_PLAN_ROUTES.preview ? preview : planWith());
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  render(
    <QueryClientProvider client={client}>
      <RebootPlanPanel hosts={HOSTS} />
    </QueryClientProvider>,
  );
  return client;
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

async function fillIn() {
  show();
  fireEvent.change(await screen.findByLabelText(text.name), { target: { value: "Kernel updates" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Two" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "One" }));
  fireEvent.click(button(text.review));
}

describe("planning reboots from the fleet page", () => {
  it("approves the checks that were reviewed, and refuses once one of them has gone", async () => {
    probes = { h1: [{ id: "probe-1", name: "Wiki answers" }], h2: [] };
    preview = { ...previewWith(null), checks: [{ probeId: "probe-1", name: "Wiki answers", problem: null }] };
    const client = show();
    fireEvent.change(await screen.findByLabelText(text.name), { target: { value: "Kernel updates" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "One" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Wiki answers" }));
    fireEvent.click(button(text.review));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body!.probeIds).toEqual(["probe-1"]);

    // The check is no longer set up by the time they press Approve.
    probes = { h1: [], h2: [] };
    await client.invalidateQueries({ queryKey: ["probes"] });

    expect(await screen.findByText(new RegExp(text.checksGone("Wiki answers")))).toBeTruthy();
    expect(button(text.approve).disabled).toBe(true);
    fireEvent.click(button(text.approve));
    expect(sent).toHaveLength(1);

    // Reviewing again starts from what is there now.
    fireEvent.click(button(text.edit));
    fireEvent.click(await screen.findByRole("button", { name: text.review }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body!.probeIds).toEqual([]);
  });

  it("approves the reviewed check even while the fleet is answering again", async () => {
    probes = { h1: [{ id: "probe-1", name: "Wiki answers" }], h2: [] };
    show();
    fireEvent.change(await screen.findByLabelText(text.name), { target: { value: "Kernel updates" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "One" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Wiki answers" }));
    fireEvent.click(button(text.review));
    await waitFor(() => expect(sent).toHaveLength(1));

    fireEvent.click(button(text.approve));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ url: REBOOT_PLAN_ROUTES.plans, body: { probeIds: ["probe-1"] } });
  });

  it("offers the fleet's hosts but not the machine Autoheal runs on", async () => {
    show();
    expect(await screen.findByRole("checkbox", { name: "One" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Home" })).toBeNull();
  });

  it("keeps the order hosts were ticked in, and reviews before anything starts", async () => {
    await fillIn();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      url: REBOOT_PLAN_ROUTES.preview,
      body: { name: "Kernel updates", hostIds: ["h2", "h1"], minimumHealthy: 1, returnMinutes: 15 },
    });
    expect(await screen.findByText(text.wouldStart)).toBeTruthy();
    expect(screen.getByText(/One has not reported recently/)).toBeTruthy();
    expect(screen.getByText(/2 jobs still open/)).toBeTruthy();
    expect(sent).toHaveLength(1);

    fireEvent.click(button(text.approve));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ url: REBOOT_PLAN_ROUTES.plans, body: { hostIds: ["h2", "h1"] } });
  });

  it("will not approve what would not start, and says why", async () => {
    preview = previewWith("Rebooting Two would leave 0 healthy, and this plan needs 1.");
    await fillIn();
    expect(await screen.findByText(/Rebooting Two would leave 0 healthy/)).toBeTruthy();
    expect(button(text.approve).disabled).toBe(true);
  });

  it("will not approve beside a saved plan that cannot be read, and says only that much", async () => {
    preview = previewWith(REBOOT_PLAN_TEXT.unreadable(1));

    await fillIn();

    expect(await screen.findByText(new RegExp(REBOOT_PLAN_TEXT.unreadable(1)))).toBeTruthy();
    expect(button(text.approve).disabled).toBe(true);
  });
});

describe("following a plan", () => {
  it("shows each host's step, and offers no new plan while one is open", async () => {
    plans = [planWith()];
    show();
    expect(await screen.findByText(/One: Reboot asked/)).toBeTruthy();
    expect(screen.getByText(/Two: Waiting/)).toBeTruthy();
    expect(screen.queryByLabelText(text.name)).toBeNull();
    expect(screen.queryByRole("button", { name: text.resume })).toBeNull();
  });

  it("says why it paused, and resumes on request", async () => {
    plans = [planWith({ status: "paused", reason: "One was not back and ready within 15 minutes." })];
    show();
    expect(await screen.findByText(/not back and ready/)).toBeTruthy();
    fireEvent.click(button(text.resume));
    await waitFor(() =>
      expect(sent).toEqual([{ url: apiPath(REBOOT_PLAN_ROUTES.resume, { planId: "p1" }), body: null }]),
    );
  });

  it("is plain that cancelling takes back nothing already asked, and cancels only once confirmed", async () => {
    plans = [planWith()];
    show();
    fireEvent.click(await screen.findByRole("button", { name: text.cancel }));
    expect(screen.getByText(text.cancelConfirm)).toBeTruthy();
    expect(sent).toEqual([]);
    fireEvent.click(button(text.cancelYes));
    await waitFor(() =>
      expect(sent).toEqual([{ url: apiPath(REBOOT_PLAN_ROUTES.cancel, { planId: "p1" }), body: null }]),
    );
  });

  it("says the rest is cancelled while still following what was asked", async () => {
    plans = [planWith({ cancelAsked: true, steps: [step("One", "asked"), step("Two", "cancelled")] })];
    show();
    expect(await screen.findByText(text.cancelling)).toBeTruthy();
    expect(screen.getByText(/One: Reboot asked/)).toBeTruthy();
    expect(screen.getByText(/Two: Will not be rebooted/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: text.cancel })).toBeNull();
  });

  it("offers a new plan once the last has ended, keeping its result in view", async () => {
    plans = [planWith({ status: "completed", steps: [step("One", "done"), step("Two", "done")] })];
    show();
    expect(await screen.findByText(/One: Done/)).toBeTruthy();
    expect(await screen.findByLabelText(text.name)).toBeTruthy();
  });
});
