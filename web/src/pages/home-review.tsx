import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES } from "../../../src/shared/api.js";
import { sizeText } from "../../../src/shared/constants.js";
import {
  HOME_REVIEW_RUN,
  type HomeLogEntry,
  type HomeReviewRun,
  type HomeReviewView,
  type HomeRoom,
} from "../../../src/shared/home-review.js";
import { api } from "../api-client.js";
import { Badge, CopyButton, ErrorNotice, Loading, PlainText, TimeAgo } from "../components/common.js";
import { TEXT } from "../constants.js";
import { ollamaServersQuery } from "../queries.js";

const text = TEXT.homeReview;
const REFRESH_MILLISECONDS = 60_000;
const REFRESH_WHILE_ASKING_MILLISECONDS = 3_000;
const TABS = ["errors", "rooms", "cleanup"] as const;
type Tab = (typeof TABS)[number];
const QUERY_KEY = ["home-review"];

const isAsking = (view: HomeReviewView) =>
  [...(view.log ?? []), ...view.rooms].some(({ run }) => run.status === HOME_REVIEW_RUN.running);

function Answer({ run }: { run: HomeReviewRun }) {
  if (run.status === HOME_REVIEW_RUN.idle) return null;
  if (run.status === HOME_REVIEW_RUN.running) return <p className="small muted">{text.thinking}</p>;
  if (run.status === HOME_REVIEW_RUN.failed) return <p className="notice warning small">{text.failed(run.error)}</p>;
  if (run.suggestions.length === 0) return <p className="small muted">{text.nothing}</p>;
  return (
    <div className="stack">
      {run.suggestions.map((suggestion, index) => (
        <div key={index} className="home-suggestion">
          <p className="row">
            <Badge value={text.kinds[suggestion.kind]} />
            <strong>{suggestion.title}</strong>
          </p>
          <p className="small">{suggestion.why}</p>
          {suggestion.unknownEntities.length > 0 && (
            <p className="notice warning small">{text.unknown(suggestion.unknownEntities.join(", "))}</p>
          )}
          {suggestion.problems.map((problem) => (
            <p key={problem} className="notice warning small">
              {problem}
            </p>
          ))}
          {suggestion.yaml !== "" && (
            <>
              <PlainText text={suggestion.yaml} />
              <CopyButton text={suggestion.yaml} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function AskButton({ run, label, onAsk }: { run: HomeReviewRun; label: string; onAsk: () => void }) {
  const done = run.status === HOME_REVIEW_RUN.done || run.status === HOME_REVIEW_RUN.failed;
  return (
    <button type="button" disabled={run.status === HOME_REVIEW_RUN.running} onClick={onAsk}>
      {done ? text.askAgain : label}
    </button>
  );
}

function LogRow({ entry, onAsk }: { entry: HomeLogEntry; onAsk: () => void }) {
  return (
    <div className="home-review-row">
      <div className="row spread">
        <span className="row">
          <Badge value={entry.level} />
          <span className="mono small">{entry.name}</span>
          {entry.count > 1 && <span className="small muted">{text.times(entry.count)}</span>}
        </span>
        <AskButton run={entry.run} label={text.askFix} onAsk={onAsk} />
      </div>
      <PlainText text={entry.message} />
      <Answer run={entry.run} />
    </div>
  );
}

function ErrorsTab({ view, onFix }: { view: HomeReviewView; onFix: (id: string) => void }) {
  return (
    <div className="stack">
      {view.log === null && <p className="muted">{text.noLog}</p>}
      {view.log?.length === 0 && <p className="muted">{text.logNone}</p>}
      {view.log?.map((entry) => (
        <LogRow key={entry.id} entry={entry} onAsk={() => onFix(entry.id)} />
      ))}
      <h3>{text.deadTitle}</h3>
      {view.deadReferences.length === 0 && <p className="muted">{text.deadNone}</p>}
      {view.deadReferences.map((reference) => (
        <p key={`${reference.file}:${reference.line}:${reference.entity}`} className="small">
          <span className="mono">{reference.entity}</span>{" "}
          <span className="muted">{text.deadAt(reference.file, reference.line)}</span>
          {reference.nearest !== null && <span> · {text.meant(reference.nearest)}</span>}
        </p>
      ))}
    </div>
  );
}

function RoomRow({ room, onAsk }: { room: HomeRoom; onAsk: () => void }) {
  return (
    <div className="home-review-row">
      <div className="row spread">
        <span>
          <strong>{room.name}</strong>{" "}
          <span className="small muted">{text.roomFacts(room.entities, room.automations)}</span>
        </span>
        <AskButton run={room.run} label={text.askRoom} onAsk={onAsk} />
      </div>
      <Answer run={room.run} />
    </div>
  );
}

function CleanupTab({ view }: { view: HomeReviewView }) {
  const total = view.leftovers.reduce((sum, { bytes }) => sum + bytes, 0);
  return (
    <div className="stack">
      <p className="small muted">{text.cleanupNote}</p>
      {view.skippedFiles.length > 0 && (
        <div className="stack">
          <h3>{text.skippedTitle}</h3>
          <p className="small muted">{text.skippedNote}</p>
          {view.skippedFiles.map(({ path, why }) => (
            <p key={path} className="row spread small">
              <span className="mono">{path}</span>
              <span className="muted">{text.skippedWhy[why]}</span>
            </p>
          ))}
        </div>
      )}
      <h3>
        {text.leftoversTitle}
        {total > 0 && <span className="muted"> · {text.leftoversTotal(sizeText(total))}</span>}
      </h3>
      {view.leftovers.length === 0 && <p className="muted">{text.leftoversNone}</p>}
      {view.leftovers.map((leftover) => (
        <p key={leftover.path} className="row spread small">
          <span className="mono">{leftover.path}</span>
          <span className="muted">
            {sizeText(leftover.bytes)} · <TimeAgo timestamp={leftover.modifiedAt} />
          </span>
        </p>
      ))}
      <h3>{text.commentsTitle}</h3>
      {view.comments.length === 0 && <p className="muted">{text.commentsNone}</p>}
      {view.comments.map((block) => (
        <p key={`${block.file}:${block.fromLine}`} className="small">
          <span className="muted">{text.commentsAt(block.file, block.fromLine, block.toLine)}</span>{" "}
          <span className="mono">{block.preview}</span>
        </p>
      ))}
    </div>
  );
}

/** What Ollama and a plain reading make of Home Assistant's configuration, in place on the Home page. */
export function HomeReviewSection() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("errors");
  const review = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<HomeReviewView>("GET", API_ROUTES.homeReview),
    refetchInterval: (query) =>
      query.state.data !== undefined && isAsking(query.state.data)
        ? REFRESH_WHILE_ASKING_MILLISECONDS
        : REFRESH_MILLISECONDS,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const askFix = useMutation({
    mutationFn: (id: string) => api("POST", API_ROUTES.homeReviewFix, { id }),
    onSuccess: refresh,
  });
  const askRoom = useMutation({
    mutationFn: (areaId: string) => api("POST", API_ROUTES.homeReviewRoom, { areaId }),
    onSuccess: refresh,
  });
  const rescan = useMutation({
    mutationFn: () => api<HomeReviewView>("POST", API_ROUTES.homeReviewRescan),
    onSuccess: (view) => queryClient.setQueryData(QUERY_KEY, view),
  });
  const view = review.data;
  const servers = useQuery(ollamaServersQuery).data;
  const reader =
    (servers?.extras.length ?? 0) === 0
      ? null
      : (servers?.extras.find(({ id }) => id === servers.reviewServerId)?.name ??
        servers?.defaultName ??
        text.defaultServer);
  const counts: Record<Tab, number> = {
    errors: (view?.log?.length ?? 0) + (view?.deadReferences.length ?? 0),
    rooms: view?.rooms.length ?? 0,
    cleanup: (view?.leftovers.length ?? 0) + (view?.comments.length ?? 0),
  };
  return (
    <section className="section" aria-labelledby="home-review-title">
      <div className="row spread">
        <h2 id="home-review-title">{text.title}</h2>
        {view?.mounted === true && (
          <span className="row small muted">
            {view.scannedAt !== null && (
              <span>
                {text.checked} <TimeAgo timestamp={view.scannedAt} />
              </span>
            )}
            <button type="button" disabled={rescan.isPending} onClick={() => rescan.mutate()}>
              {text.checkAgain}
            </button>
          </span>
        )}
      </div>
      {view === undefined && (review.error ? null : <Loading />)}
      {view?.mounted === false && <p className="notice warning">{text.notMounted}</p>}
      {view?.mounted === true && view.scanIncomplete !== null && (
        <p className="notice warning small">{text.scanIncomplete[view.scanIncomplete]}</p>
      )}
      {view?.mounted === true && (
        <>
          <p className="small muted">{text.lede}</p>
          {reader !== null && <p className="small muted">{text.readBy(reader)}</p>}
          <div className="show-chips" role="group" aria-label={text.tabsLabel}>
            {TABS.map((name) => (
              <button
                key={name}
                type="button"
                className={name === tab ? "chip-button active" : "chip-button"}
                aria-pressed={name === tab}
                onClick={() => setTab(name)}
              >
                {text.tabs[name]} <span className="tab-count">{counts[name]}</span>
              </button>
            ))}
          </div>
          {tab === "errors" && <ErrorsTab view={view} onFix={(id) => askFix.mutate(id)} />}
          {tab === "rooms" && (
            <div className="stack">
              {view.rooms.length === 0 && <p className="muted">{text.noRooms}</p>}
              {view.rooms.map((room) => (
                <RoomRow key={room.id} room={room} onAsk={() => askRoom.mutate(room.id)} />
              ))}
            </div>
          )}
          {tab === "cleanup" && <CleanupTab view={view} />}
        </>
      )}
      <ErrorNotice error={review.error ?? askFix.error ?? askRoom.error ?? rescan.error} />
    </section>
  );
}
