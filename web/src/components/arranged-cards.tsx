import { Fragment, useState, type ReactNode } from "react";
import {
  arrangedCards,
  hiddenAway,
  isHidden,
  keepArrangement,
  pinnedFirst,
  shownAgain,
  storedArrangement,
  unpinned,
  type CardArrangement,
  type PlacedCard,
} from "../card-preferences.js";
import { TEXT, type CardPage } from "../constants.js";
import { Icon } from "./icons.js";

/** A card a page lets a person pin or hide: what its controls call it, and what it draws. */
export interface MovableCard extends PlacedCard {
  fixed?: false;
  title: string;
  node: ReactNode;
}

/** One that keeps its place among them. */
export interface FixedCard extends PlacedCard {
  fixed: true;
  node: ReactNode;
}

export type ArrangedCard = MovableCard | FixedCard;

const isMovable = (card: ArrangedCard): card is MovableCard => card.fixed !== true;

export const fixedCard = (id: string, node: ReactNode): FixedCard => ({ id, fixed: true, node });

/** A page's arrangement in this browser, and whether every card's controls show just now. */
export interface PageArrangement {
  arrangement: CardArrangement;
  change: (next: CardArrangement) => void;
  arranging: boolean;
  setArranging: (arranging: boolean) => void;
}

export function usePageArrangement(page: CardPage): PageArrangement {
  const [arrangement, setArrangement] = useState(() => storedArrangement(page));
  const [arranging, setArranging] = useState(false);
  const change = (next: CardArrangement) => {
    setArrangement(next);
    keepArrangement(page, next);
  };
  return { arrangement, change, arranging, setArranging };
}

const text = TEXT.arrange;

// Above a card while its page is arranged: its name, then pin, where there is something for it to come before, and hide.
function ArrangeBar({ card, canPin, page }: { card: MovableCard; canPin: boolean; page: PageArrangement }) {
  const { arrangement, change } = page;
  const pinned = arrangement.pinned.includes(card.id);
  // Hidden, yet shown while it needs a person.
  const hiddenHere = isHidden(arrangement, card);
  const pin = () => change(pinned ? unpinned(arrangement, card.id) : pinnedFirst(arrangement, card.id));
  const hide = () => change(hiddenHere ? shownAgain(arrangement, card.id) : hiddenAway(arrangement, card.id));
  return (
    <div className="arrange-bar" role="group" aria-label={text.controls(card.title)}>
      <span className="arrange-title">
        {card.title}
        {hiddenHere && (
          <span className="muted">
            {TEXT.separator}
            {text.pressing}
          </span>
        )}
      </span>
      <span className="arrange-buttons">
        {canPin && (
          <button
            type="button"
            className="link"
            aria-label={pinned ? text.unpinCard(card.title) : text.pinCard(card.title)}
            onClick={pin}
          >
            <Icon name="pin" />
            {pinned ? text.unpin : text.pin}
          </button>
        )}
        <button
          type="button"
          className="link"
          aria-label={hiddenHere ? text.show(card.title) : text.hideCard(card.title)}
          onClick={hide}
        >
          <Icon name={hiddenHere ? "eye" : "eyeSlashed"} />
          {hiddenHere ? text.unhide : text.hide}
        </button>
      </span>
    </div>
  );
}

/**
 * One part of a page's cards as this browser arranged them. While the page is arranged, each card that may move has its
 * controls just above it; a card keeps its place in the tree either way, so nothing in it starts over.
 */
export function CardGroup({ cards, page }: { cards: readonly ArrangedCard[]; page: PageArrangement }) {
  const canPin = cards.filter(isMovable).length > 1;
  return (
    <>
      {arrangedCards(cards, page.arrangement).flatMap((card) => {
        const drawn = <Fragment key={card.id}>{card.node}</Fragment>;
        if (!page.arranging || !isMovable(card)) {
          return [drawn];
        }
        return [<ArrangeBar key={`${card.id}-arrange`} card={card} canPin={canPin} page={page} />, drawn];
      })}
    </>
  );
}

/** At a page's foot: its hidden cards, each one to show again, and the switch that shows every card's controls. */
export function ArrangeLine({ cards, page }: { cards: readonly ArrangedCard[]; page: PageArrangement }) {
  const { arrangement, change, arranging, setArranging } = page;
  const hiddenCards = cards.filter(isMovable).filter((card) => card.pressing !== true && isHidden(arrangement, card));
  return (
    <div className={arranging ? "arrange-line arranging" : "arrange-line"}>
      {arranging && <span className="arrange-hint">{text.hint}</span>}
      {hiddenCards.length > 0 && (
        <span className="arrange-hidden">
          {text.hidden}
          {hiddenCards.map((card) => (
            <button
              key={card.id}
              type="button"
              className="link"
              aria-label={text.show(card.title)}
              onClick={() => change(shownAgain(arrangement, card.id))}
            >
              <Icon name="eye" />
              {card.title}
            </button>
          ))}
        </span>
      )}
      <button type="button" className={arranging ? "primary" : "link"} onClick={() => setArranging(!arranging)}>
        {arranging ? text.done : text.start}
      </button>
    </div>
  );
}
