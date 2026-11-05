import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostView } from "../../../src/shared/api.js";
import { HOST_KIND } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";
import { VantageChoice, VantageLine } from "./probe-vantages.js";

const text = TEXT.probes.vantage;
const host = (id: string, label: string, change: Partial<HostView> = {}) =>
  ({ id, label, kind: HOST_KIND.runner, serviceProbes: true, ...change }) as HostView;
const HOSTS = [
  host("h1", "Alder"),
  host("h2", "Birch"),
  // A runner from before this cannot make a check, so it is not offered.
  host("h3", "Cedar", { serviceProbes: false }),
];

let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(HOSTS), { headers: { "content-type": "application/json" } })),
  );
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});

function show(element: React.ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

it("offers Autoheal and every host that can make a check itself, this one first", async () => {
  show(<VantageChoice hostId="h2" value={null} onChange={() => undefined} />);

  await screen.findByRole("option", { name: text.fromHost("Alder") });
  const choice = screen.getByLabelText(text.label) as HTMLSelectElement;
  expect([...choice.options].map((option) => option.textContent)).toEqual([
    text.controlPlane,
    text.fromHost("Birch"),
    text.fromHost("Alder"),
  ]);
});

it("gives back the host chosen, and null for Autoheal itself", async () => {
  const chosen: (string | null)[] = [];
  show(<VantageChoice hostId="h1" value={null} onChange={(vantage) => chosen.push(vantage)} />);
  await screen.findByRole("option", { name: text.fromHost("Birch") });
  const choice = screen.getByLabelText(text.label);

  fireEvent.change(choice, { target: { value: "h2" } });
  fireEvent.change(choice, { target: { value: "" } });

  expect(chosen).toEqual(["h2", null]);
});

it("says on each check where it is made from, and when that host has gone", () => {
  const { rerender } = render(<VantageLine vantage={null} hosts={HOSTS} />);
  expect(screen.getByText(text.madeHere)).toBeTruthy();

  rerender(<VantageLine vantage="h2" hosts={HOSTS} />);
  expect(screen.getByText(text.madeFrom("Birch"))).toBeTruthy();

  rerender(<VantageLine vantage="gone" hosts={HOSTS} />);
  expect(screen.getByText(text.hostGone)).toBeTruthy();
});
