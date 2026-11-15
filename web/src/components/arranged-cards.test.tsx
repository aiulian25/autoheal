import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NO_ARRANGEMENT, hiddenAway, keepArrangement } from "../card-preferences.js";
import { CARD_PAGES } from "../constants.js";
import { usePageArrangement } from "./arranged-cards.js";

afterEach(() => window.localStorage.clear());

// The host page stays drawn from one host to the next, so each host's arrangement is read as its page opens.
it("gives each host's page that host's own arrangement, and keeps a change to the host it was made on", () => {
  keepArrangement(CARD_PAGES.host, hiddenAway(NO_ARRANGEMENT, "history"), "h1");
  const page = renderHook(({ hostId }) => usePageArrangement(CARD_PAGES.host, hostId), {
    initialProps: { hostId: "h1" },
  });
  expect(page.result.current.arrangement.hidden).toEqual(["history"]);

  page.rerender({ hostId: "h2" });
  expect(page.result.current.arrangement).toEqual(NO_ARRANGEMENT);
  act(() => page.result.current.change(hiddenAway(NO_ARRANGEMENT, "system")));
  expect(page.result.current.arrangement.hidden).toEqual(["system"]);

  page.rerender({ hostId: "h1" });
  expect(page.result.current.arrangement.hidden).toEqual(["history"]);
  page.rerender({ hostId: "h2" });
  expect(page.result.current.arrangement.hidden).toEqual(["system"]);
});
