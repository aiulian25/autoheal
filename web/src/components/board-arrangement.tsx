import { useMutation, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES } from "../../../src/shared/api.js";
import {
  BOARD_COLUMN_KEYS,
  type BoardArrangement,
  type BoardColumnKey,
  type ViewPreferences,
} from "../../../src/shared/view-preferences.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { viewPreferencesQuery } from "../queries.js";
import { ErrorNotice } from "./common.js";

const text = TEXT.boardArrangement;
const STEP_EARLIER = -1;
const STEP_LATER = 1;

function moved(order: readonly BoardColumnKey[], key: BoardColumnKey, step: number) {
  const next = [...order];
  const from = next.indexOf(key);
  next.splice(from, 1);
  next.splice(from + step, 0, key);
  return next;
}

/** A person's own order and choice of the board's columns, saved as they change it. */
export function BoardArrangementPanel({ board }: { board: BoardArrangement | null }) {
  const queryClient = useQueryClient();
  const stored = (next: ViewPreferences) => queryClient.setQueryData(viewPreferencesQuery.queryKey, next);
  const arrange = useMutation({
    mutationFn: (next: BoardArrangement) => api<ViewPreferences>("PUT", API_ROUTES.accountBoardArrangement, next),
    onSuccess: stored,
  });
  const reset = useMutation({
    mutationFn: () => api<ViewPreferences>("DELETE", API_ROUTES.accountBoardArrangement),
    onSuccess: stored,
  });
  const order = board?.order ?? [...BOARD_COLUMN_KEYS];
  const hidden = board?.hidden ?? [];
  const toggled = (key: BoardColumnKey) =>
    hidden.includes(key) ? hidden.filter((each) => each !== key) : [...hidden, key];
  const busy = arrange.isPending || reset.isPending;
  return (
    <div className="card stack small">
      <ol>
        {order.map((key, index) => {
          const title = TEXT.board.columns[key].title;
          const isOnlyOneShown = !hidden.includes(key) && hidden.length === order.length - 1;
          return (
            <li key={key}>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={!hidden.includes(key)}
                  disabled={busy || isOnlyOneShown}
                  aria-label={text.show(title)}
                  onChange={() => arrange.mutate({ order, hidden: toggled(key) })}
                />
                {title}
              </label>{" "}
              <button
                type="button"
                className="quiet"
                aria-label={text.up(title)}
                disabled={busy || index === 0}
                onClick={() => arrange.mutate({ order: moved(order, key, STEP_EARLIER), hidden })}
              >
                ↑
              </button>
              <button
                type="button"
                className="quiet"
                aria-label={text.down(title)}
                disabled={busy || index === order.length - 1}
                onClick={() => arrange.mutate({ order: moved(order, key, STEP_LATER), hidden })}
              >
                ↓
              </button>
            </li>
          );
        })}
      </ol>
      <ErrorNotice error={arrange.error ?? reset.error} />
      <div className="card-actions">
        <button type="button" className="quiet" disabled={busy || board === null} onClick={() => reset.mutate()}>
          {text.reset}
        </button>
      </div>
    </div>
  );
}
