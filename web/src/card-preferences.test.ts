import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_ARRANGEMENT,
  arrangedCards,
  hiddenAway,
  keepArrangement,
  pinnedFirst,
  shownAgain,
  storedArrangement,
  unpinned,
} from "./card-preferences.js";
import { CARD_PAGES, CARD_STORAGE_KEY_PREFIX } from "./constants.js";

const KEY = `${CARD_STORAGE_KEY_PREFIX}${CARD_PAGES.host}`;
const cards = [{ id: "dials" }, { id: "history" }, { id: "system" }, { id: "ollama", fixed: true }, { id: "probes" }];
const idsOf = (arranged: readonly { id: string }[]) => arranged.map((card) => card.id);

describe("a page's cards as a person arranged them", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps the page's own order until something is pinned, and puts the latest pinned first", () => {
    expect(idsOf(arrangedCards(cards, NO_ARRANGEMENT))).toEqual(["dials", "history", "system", "ollama", "probes"]);
    const systemPinned = pinnedFirst(NO_ARRANGEMENT, "system");
    expect(idsOf(arrangedCards(cards, systemPinned))).toEqual(["system", "dials", "history", "ollama", "probes"]);
    // One always in its place keeps it; the rest move round it.
    const probesToo = pinnedFirst(systemPinned, "probes");
    expect(idsOf(arrangedCards(cards, probesToo))).toEqual(["probes", "system", "dials", "ollama", "history"]);
    expect(idsOf(arrangedCards(cards, unpinned(probesToo, "probes")))).toEqual(
      idsOf(arrangedCards(cards, systemPinned)),
    );
  });

  it("leaves a hidden card out, but not one that needs a person now, nor one always in its place", () => {
    const arrangement = hiddenAway(hiddenAway(hiddenAway(NO_ARRANGEMENT, "history"), "system"), "ollama");
    expect(idsOf(arrangedCards(cards, arrangement))).toEqual(["dials", "ollama", "probes"]);
    const clockOff = cards.map((card) => (card.id === "system" ? { ...card, pressing: true } : card));
    expect(idsOf(arrangedCards(clockOff, arrangement))).toEqual(["dials", "system", "ollama", "probes"]);
    expect(idsOf(arrangedCards(cards, shownAgain(arrangement, "history")))).toEqual([
      "dials",
      "history",
      "ollama",
      "probes",
    ]);
  });

  it("keeps the arrangement for the next visit, and nothing once nothing is pinned or hidden", () => {
    const arrangement = hiddenAway(pinnedFirst(NO_ARRANGEMENT, "system"), "history");
    keepArrangement(CARD_PAGES.host, arrangement);
    expect(storedArrangement(CARD_PAGES.host)).toEqual({ pinned: ["system"], hidden: ["history"] });
    // Each page keeps its own.
    expect(storedArrangement(CARD_PAGES.attention)).toEqual(NO_ARRANGEMENT);
    keepArrangement(CARD_PAGES.host, shownAgain(unpinned(arrangement, "system"), "history"));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("reads anything else kept under its key as nothing arranged, and what it can of a list", () => {
    for (const stored of ["not json", "null", "7", '"system"', "[]"]) {
      window.localStorage.setItem(KEY, stored);
      expect(storedArrangement(CARD_PAGES.host), stored).toEqual(NO_ARRANGEMENT);
    }
    window.localStorage.setItem(KEY, JSON.stringify({ pinned: ["system", 3, null], hidden: "history" }));
    expect(storedArrangement(CARD_PAGES.host)).toEqual({ pinned: ["system"], hidden: [] });
  });

  it("holds without storage, as in a private window", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(storedArrangement(CARD_PAGES.host)).toEqual(NO_ARRANGEMENT);
    expect(() => keepArrangement(CARD_PAGES.host, pinnedFirst(NO_ARRANGEMENT, "system"))).not.toThrow();
  });
});
