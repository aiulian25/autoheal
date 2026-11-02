import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../src/shared/api.js";
import { HOME_SCAN_INCOMPLETE, type HomeReviewView } from "../../../src/shared/home-review.js";
import { TEXT } from "../constants.js";
import { HomeReviewSection } from "./home-review.js";

const text = TEXT.homeReview;
const VIEW: HomeReviewView = {
  mounted: true,
  connected: true,
  scannedAt: 1,
  log: [],
  deadReferences: [],
  rooms: [],
  leftovers: [],
  comments: [],
  skippedFiles: [],
  scanIncomplete: null,
};

const shown = (view: HomeReviewView) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === API_ROUTES.homeReview
        ? new Response(JSON.stringify(view), { headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ extras: [], defaultName: "ollama", reviewServerId: null }), {
            headers: { "content-type": "application/json" },
          }),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HomeReviewSection />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a look at the configuration that stopped short", () => {
  it.each(Object.values(HOME_SCAN_INCOMPLETE))("says it covers only part, when it ran out of %s", async (why) => {
    shown({ ...VIEW, scanIncomplete: why });
    expect(await screen.findByText(text.scanIncomplete[why])).toBeTruthy();
  });

  it("says nothing of the kind when it saw everything", async () => {
    shown(VIEW);
    await screen.findByText(text.checkAgain);
    for (const said of Object.values(text.scanIncomplete)) expect(screen.queryByText(said)).toBeNull();
  });
});
