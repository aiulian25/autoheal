import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type ContainerView, type HostView } from "../../../src/shared/api.js";
import { MEMBER_EVIDENCE, type AvailabilityGroupView } from "../../../src/shared/availability-groups.js";
import { TEXT } from "../constants.js";
import { AvailabilityGroups } from "./availability-groups.js";

const text = TEXT.availability;
const HOSTS = [
  { id: "h1", label: "Alder" },
  { id: "h2", label: "Birch" },
] as HostView[];
const CONTAINERS = [
  { hostId: "h1", hostLabel: "Alder", name: "wiki" },
  { hostId: "h2", hostLabel: "Birch", name: "wiki" },
] as ContainerView[];
const member = (hostId: string, failureDomain: string | null = null) => ({
  hostId,
  containerName: "wiki",
  failureDomain,
  probeId: null,
});
const GROUP: AvailabilityGroupView = {
  id: "g1",
  name: "Wiki",
  minimumAvailable: 1,
  evidenceFreshSeconds: 300,
  members: [member("h1"), member("h2")],
  createdBy: "admin",
  createdAt: 1,
  updatedAt: 1,
  revision: "abc",
  availableDomains: 2,
  remainingDomains: 1,
  standings: [
    { ...member("h1"), evidence: MEMBER_EVIDENCE.available, problem: null, goingDown: false },
    {
      ...member("h2"),
      evidence: MEMBER_EVIDENCE.unknown,
      problem: "birch has not reported recently enough.",
      goingDown: true,
    },
  ],
};

let client: QueryClient;
let groups: AvailabilityGroupView[];
let sent: { url: string; method: string; body: Record<string, unknown> | null }[];

beforeEach(() => {
  groups = [GROUP];
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      const answer = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (method === "GET") {
        if (url === API_ROUTES.availabilityGroups) return answer(groups);
        if (url === API_ROUTES.containers) return answer(CONTAINERS);
        return answer(HOSTS);
      }
      sent.push({ url, method, body: options?.body === undefined ? null : JSON.parse(String(options.body)) });
      return method === "POST" ? answer({ id: "g2" }) : new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function show(admin = true) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AvailabilityGroups admin={admin} />
    </QueryClientProvider>,
  );
}

it("shows each replica, what the fleet sees of it, and what would be left", async () => {
  show();

  expect(await screen.findByText("Wiki")).toBeTruthy();
  expect(screen.getByText(new RegExp(text.summary(2, 1)))).toBeTruthy();
  expect(screen.getByText(new RegExp(text.afterWhatIsUnderWay(1)))).toBeTruthy();
  expect(screen.getByText(new RegExp(`^${text.evidence.available}$`))).toBeTruthy();
  expect(screen.getByText(/has not reported recently enough/)).toBeTruthy();
  expect(screen.getByText(new RegExp(text.goingDown))).toBeTruthy();
});

it("makes a group from the containers that were ticked, with what each shares its fate with", async () => {
  show();
  fireEvent.change(await screen.findByLabelText(text.name), { target: { value: "Wiki" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: /wiki on Alder/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /wiki on Birch/ }));
  fireEvent.change(screen.getByLabelText(text.domainFor("wiki", "Alder")), { target: { value: "rack-a" } });
  fireEvent.submit(screen.getByLabelText(text.add));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({
    url: API_ROUTES.availabilityGroups,
    method: "POST",
    body: { name: "Wiki", minimumAvailable: 1, evidenceFreshSeconds: 300 },
  });
  const members = (sent[0]!.body as { members: { hostId: string; failureDomain: string | null }[] }).members;
  expect(members.map(({ hostId }) => hostId)).toEqual(["h1", "h2"]);
  expect(members[0]!.failureDomain).toBe("rack-a");
});

it("offers nothing to submit until a replica is ticked", async () => {
  show();
  await screen.findByLabelText(text.name);

  expect((screen.getByRole("button", { name: text.add }) as HTMLButtonElement).disabled).toBe(true);
});

it("asks before removing a group", async () => {
  show();

  fireEvent.click(await screen.findByRole("button", { name: text.removeFor("Wiki") }));
  expect(sent).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ url: apiPath(API_ROUTES.availabilityGroup, { groupId: "g1" }), method: "DELETE" });
});

it("lets a viewer read the groups and change nothing", async () => {
  show(false);

  expect(await screen.findByText("Wiki")).toBeTruthy();
  expect(screen.queryByLabelText(text.add)).toBeNull();
  expect(screen.queryByRole("button", { name: text.removeFor("Wiki") })).toBeNull();
});

it("says plainly when none is set up", async () => {
  groups = [];
  show();

  expect(await screen.findByText(text.none)).toBeTruthy();
});
