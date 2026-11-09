import { CARD_STORAGE_KEY_PREFIX, type CardPage } from "./constants.js";

/** What a person chose for a page's cards in this browser: the ones pinned first, the latest pinned first, and the hidden. */
export interface CardArrangement {
  pinned: readonly string[];
  hidden: readonly string[];
}

/** A card where a page draws it: one always in its place cannot move or hide, and one that needs a person now always shows. */
export interface PlacedCard {
  id: string;
  fixed?: boolean;
  pressing?: boolean;
}

export const NO_ARRANGEMENT: CardArrangement = { pinned: [], hidden: [] };

const keyOf = (page: CardPage) => `${CARD_STORAGE_KEY_PREFIX}${page}`;

const idsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** The page's arrangement as this browser keeps it; none when it keeps none, keeps something else, or storage is off. */
export function storedArrangement(page: CardPage): CardArrangement {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(keyOf(page)) ?? "null");
    if (typeof stored !== "object" || stored === null) {
      return NO_ARRANGEMENT;
    }
    const { pinned, hidden } = stored as Record<string, unknown>;
    return { pinned: idsIn(pinned), hidden: idsIn(hidden) };
  } catch {
    return NO_ARRANGEMENT;
  }
}

/** Keeps it for the next visit, and nothing at all once nothing is pinned or hidden. */
export function keepArrangement(page: CardPage, arrangement: CardArrangement) {
  const nothingChosen = arrangement.pinned.length === 0 && arrangement.hidden.length === 0;
  try {
    if (nothingChosen) {
      window.localStorage.removeItem(keyOf(page));
    } else {
      window.localStorage.setItem(keyOf(page), JSON.stringify(arrangement));
    }
  } catch {
    // Storage can be off (a private window): the arrangement then holds until the page reloads.
  }
}

const without = (ids: readonly string[], id: string) => ids.filter((other) => other !== id);

export const pinnedFirst = (arrangement: CardArrangement, id: string): CardArrangement => ({
  ...arrangement,
  pinned: [id, ...without(arrangement.pinned, id)],
});

export const unpinned = (arrangement: CardArrangement, id: string): CardArrangement => ({
  ...arrangement,
  pinned: without(arrangement.pinned, id),
});

export const hiddenAway = (arrangement: CardArrangement, id: string): CardArrangement => ({
  ...arrangement,
  hidden: [...without(arrangement.hidden, id), id],
});

export const shownAgain = (arrangement: CardArrangement, id: string): CardArrangement => ({
  ...arrangement,
  hidden: without(arrangement.hidden, id),
});

export const isHidden = (arrangement: CardArrangement, card: PlacedCard) =>
  card.fixed !== true && arrangement.hidden.includes(card.id);

/**
 * A group's cards as this browser arranged them. The ones that may move go pinned first, the latest pinned first, then
 * in the page's own order, each into the next place such a card had; one always in its place keeps it. A hidden card is
 * left out, unless it needs a person now.
 */
export function arrangedCards<Card extends PlacedCard>(cards: readonly Card[], arrangement: CardArrangement): Card[] {
  const movable = cards.filter((card) => card.fixed !== true);
  const rankOf = (card: Card) => {
    const pinnedAt = arrangement.pinned.indexOf(card.id);
    return pinnedAt === -1 ? arrangement.pinned.length + movable.indexOf(card) : pinnedAt;
  };
  const inOrder = [...movable].sort((first, second) => rankOf(first) - rankOf(second));
  const placed = cards.map((card) => (card.fixed === true ? card : inOrder.shift()!));
  return placed.filter((card) => card.pressing === true || !isHidden(arrangement, card));
}
