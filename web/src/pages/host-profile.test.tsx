import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostProfile, HostProfileAnswer } from "../../../src/shared/protocol.js";
import { HostProfileFold } from "./host-profile.js";

const profile: HostProfile = {
  containers: 36,
  user: { value: "1000:1000", uses: 9, of: 10 },
  timeZone: { value: "Europe/Lisbon", uses: 10, of: 10 },
  restartPolicy: { value: "unless-stopped", uses: 31, of: 36 },
  composeFolder: { path: "/home/alex/docker", projects: 24, of: 25 },
  mountsBesideCompose: 30,
  places: [{ path: "/mnt/fast", mounts: 13, availableBytes: 3_000_000_000_000 }],
  networks: [{ name: "npm", containers: 17 }],
  proxies: [{ kind: "Nginx Proxy Manager", container: "npm", network: "npm" }],
  databases: { common: "postgres:16", ownToAnApp: 2, standingAlone: 0 },
};

let answer: HostProfileAnswer;
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  answer = { error: null, profile };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HostProfileFold hostId="h1" />
    </QueryClientProvider>,
  );
};
const open = () => {
  const fold = screen.getByText("How this host is set up").closest("details")!;
  fold.open = true;
  fireEvent(fold, new Event("toggle"));
};

it("asks its runner nothing until it is opened, then shows what most containers do", async () => {
  show();
  expect(asked).toEqual([]);
  open();
  expect(await screen.findByText("1000:1000")).toBeTruthy();
  expect(asked).toEqual(["/api/inventory/hosts/h1/profile"]);
  expect(screen.getByText("9 of 10")).toBeTruthy();
  expect(screen.getByText("/home/alex/docker")).toBeTruthy();
  expect(screen.getByText("24 of 25 Compose projects")).toBeTruthy();
  expect(screen.getByText(/13 mounts, .* free/)).toBeTruthy();
  expect(screen.getByText("Nginx Proxy Manager")).toBeTruthy();
  expect(screen.getByText("2 with their own app, 0 standing alone")).toBeTruthy();
});

it("says what is missing on a host that shows nothing, a plain NAS say", async () => {
  answer = {
    error: null,
    profile: {
      ...profile,
      user: null,
      composeFolder: null,
      places: [],
      networks: [],
      proxies: [],
      mountsBesideCompose: 0,
      databases: { common: null, ownToAnApp: 0, standingAlone: 0 },
    },
  };
  show();
  open();
  expect((await screen.findAllByText("Nothing shows yet")).length).toBeGreaterThan(1);
});

it("says why its host would not tell", async () => {
  answer = { error: "This host's .env keeps people out.", profile: null };
  show();
  open();
  expect(await screen.findByText("This host's .env keeps people out.")).toBeTruthy();
});
