import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TEXT } from "../constants.js";
import { NewVersionNotice } from "./new-version-notice.js";

const RUNNING = "/assets/index-old.js";
const page = (script: string) => `<!doctype html><script type="module" src="${script}"></script>`;

function show(served: string, running: string | null = RUNNING) {
  document.head.innerHTML = running === null ? "" : page(running);
  const fetch = vi.fn(async () => new Response(served));
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NewVersionNotice />
    </QueryClientProvider>,
  );
  return fetch;
}

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

it("offers a reload once the page served names another script", async () => {
  show(page("/assets/index-new.js"));
  expect(await screen.findByRole("button", { name: TEXT.newVersion.reload })).toBeTruthy();
});

it("says nothing while the page served is this one", async () => {
  const fetch = show(page(RUNNING));
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve));
  expect(screen.queryByRole("status")).toBeNull();
});

it("says nothing when the answer is not a page, as from a proxy's error", async () => {
  const fetch = show("Bad gateway");
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve));
  expect(screen.queryByRole("status")).toBeNull();
});
