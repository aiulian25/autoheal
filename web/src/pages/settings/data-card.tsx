import { useQuery } from "@tanstack/react-query";
import { API_ROUTES, type DataView } from "../../../../src/shared/api.js";
import { MILLISECONDS_PER_DAY } from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { ErrorNotice, Loading } from "../../components/common.js";
import { REFRESH_MILLISECONDS, TEXT } from "../../constants.js";
import { bytes, timeAgo, wholeNumber } from "../../format.js";
import { SettingsFold } from "./settings-fold.js";

const text = TEXT.settingsPage;

// --- Data --------------------------------------------------------------------------------------------

const keptOf = (kept: number | null) =>
  kept === null ? text.data.keptWhole : text.data.window(Math.round(kept / MILLISECONDS_PER_DAY));

// The database's size, then the last clean-up and how much it removed: the line its card folds to.
function dataLine(view: DataView): string {
  const words = text.data;
  const size = bytes(view.bytes);
  if (view.lastSweep === null) {
    return [size, words.notCleaned].join(TEXT.separator);
  }
  return [
    size,
    `${words.cleaned} ${timeAgo(view.lastSweep.at)}`,
    words.removed(wholeNumber(view.lastSweep.removed)),
  ].join(TEXT.separator);
}

// What the database holds, and how long it keeps each kind of record: its growth followed without SQL.
export function DataCard() {
  const data = useQuery({
    queryKey: ["data-housekeeping"],
    queryFn: () => api<DataView>("GET", API_ROUTES.dataHousekeeping),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  const words = text.data;
  const view = data.data;
  return (
    <SettingsFold title={words.title} state={view === undefined ? null : dataLine(view)}>
      <p className="settings-card-text small">{words.explanation}</p>
      {view === undefined && <Loading />}
      <ErrorNotice error={data.error} />
      {view !== undefined && (
        <dl className="card system-grid" aria-label={words.title}>
          {view.kinds.map((kind) => (
            <div key={kind.kind}>
              <dt>{`${words.kinds[kind.kind]}${TEXT.separator}${keptOf(kind.keptMilliseconds)}`}</dt>
              <dd>{wholeNumber(kind.rows)}</dd>
            </div>
          ))}
        </dl>
      )}
    </SettingsFold>
  );
}
