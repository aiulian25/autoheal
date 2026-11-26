import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import { apiPath, type BoardView, type ContainerView, type TaskSummaryView } from "../../../../src/shared/api.js";
import { MILLISECONDS_PER_MINUTE, TASK_STATUS } from "../../../../src/shared/constants.js";
import { doneByItself, nextImageCheckIn, type LookAtPlace } from "../../attention-places.js";
import { ErrorNotice } from "../../components/common.js";
import { Icon } from "../../components/icons.js";
import { SnoozeMenu } from "../../components/snooze-menu.js";
import { LOOK_AT_SHOWN, PATHS, TEXT } from "../../constants.js";
import { calendarDate, shortTimeAgo } from "../../format.js";
import { hostUpdatesQuery } from "../../queries.js";
import { placeLink, placeName, SectionLabel, useTaskChange } from "./attention-parts.js";

const taskLink = (task: TaskSummaryView) => apiPath(PATHS.task, { taskId: task.id });

// What a task is about in a word or two, for the line that names the ones not shown.
const shortName = (task: TaskSummaryView) => task.resource?.label ?? task.title;

/** One thing to look at: what it is, since when, and Done or Snooze right there. */
function LookAtRow({ task, admin }: { task: TaskSummaryView; admin: boolean }) {
  const change = useTaskChange(task.id);
  return (
    <li className="look-row">
      <span className="look-dot" aria-hidden />
      <Link className="look-title" to={taskLink(task)}>
        {task.title}
      </Link>
      <span className="small faint">{shortTimeAgo(task.createdAt)}</span>
      {admin && (
        <span className="look-actions">
          <button
            type="button"
            className="quiet"
            disabled={change.isPending}
            onClick={() => change.mutate({ status: TASK_STATUS.done })}
          >
            {TEXT.attention.done}
          </button>
          <SnoozeMenu disabled={change.isPending} onChoose={(snoozed) => change.mutate({ snoozed })} />
        </span>
      )}
      <ErrorNotice error={change.error} />
    </li>
  );
}

function LookAtCard({ place, admin }: { place: LookAtPlace; admin: boolean }) {
  const titleId = useId();
  const [everything, setEverything] = useState(false);
  const name = placeName(place.kind, place.hostLabel);
  const link = placeLink(place.kind, place.hostId);
  const shown = everything ? place.tasks : place.tasks.slice(0, LOOK_AT_SHOWN);
  const rest = place.tasks.slice(shown.length);
  return (
    <article className="place-card light" aria-labelledby={titleId}>
      <header className="place-head">
        <h3 id={titleId}>{name}</h3>
        <span className="place-facts">{place.tasks.length}</span>
        {link !== null && (
          <Link className="push small" to={link}>
            {TEXT.attention.open(name)}
          </Link>
        )}
      </header>
      <ul className="look-rows">
        {shown.map((task) => (
          <LookAtRow key={task.id} task={task} admin={admin} />
        ))}
        {rest.length > 0 && (
          <li className="look-row">
            <button type="button" className="link" onClick={() => setEverything(true)}>
              {TEXT.attention.lookAt.more(rest.length, rest.map(shortName).join(", "))}
            </button>
          </li>
        )}
      </ul>
    </article>
  );
}

/** What waits for a look when a person has time, place by place, two cards to a row. */
export function LookAt({ places, admin }: { places: readonly LookAtPlace[]; admin: boolean }) {
  if (places.length === 0) return null;
  const count = places.reduce((sum, place) => sum + place.tasks.length, 0);
  return (
    <section className="attention-section">
      <SectionLabel tone="accent" text={TEXT.attention.lookAt} count={count} />
      <div className="look-at-grid">
        {places.map((place) => (
          <LookAtCard key={place.key} place={place} admin={admin} />
        ))}
      </div>
    </section>
  );
}

function SnoozedRow({ task, admin }: { task: TaskSummaryView; admin: boolean }) {
  const change = useTaskChange(task.id);
  return (
    <li className="look-row">
      <span className="look-dot quiet" aria-hidden />
      <Link className="look-title" to={taskLink(task)}>
        {task.title}
      </Link>
      <span className="small faint">{TEXT.attention.snoozedUntil(calendarDate(task.snoozedUntil ?? 0))}</span>
      {admin && (
        <button
          type="button"
          className="quiet push"
          disabled={change.isPending}
          onClick={() => change.mutate({ snoozed: false })}
        >
          {TEXT.tasks.wake}
        </button>
      )}
      <ErrorNotice error={change.error} />
    </li>
  );
}

/** What a person put off: one line that says how many and until when, opened in place to wake one. */
export function SnoozedFold({ tasks, admin }: { tasks: readonly TaskSummaryView[]; admin: boolean }) {
  if (tasks.length === 0) return null;
  const latest = Math.max(...tasks.map((task) => task.snoozedUntil ?? 0));
  const text = TEXT.attention;
  return (
    <details className="fold snoozed-fold">
      <summary>
        <span>{text.snoozed(tasks.length)}</span>
        <span className="small muted">
          {[text.snoozedUntil(calendarDate(latest)), tasks.map(shortName).join(", ")].join(TEXT.separator)}
        </span>
      </summary>
      <ul className="look-rows">
        {tasks.map((task) => (
          <SnoozedRow key={task.id} task={task} admin={admin} />
        ))}
      </ul>
    </details>
  );
}

/** Nothing for a person at all: one calm card, with what Autoheal did meanwhile and what comes next. */
export function AllClear({ board, containers }: { board: BoardView; containers: readonly ContainerView[] }) {
  const window = useQuery(hostUpdatesQuery).data;
  const { healed, updated } = doneByItself(board);
  const checkIn = nextImageCheckIn(containers, Date.now());
  const minutes = checkIn === null ? null : Math.ceil(checkIn / MILLISECONDS_PER_MINUTE);
  const text = TEXT.attention.allClear;
  const said = [text.nothing, text.lastDay(healed, updated), text.next(minutes, window?.windowStart ?? null)];
  return (
    <section className="card all-clear">
      <span className="all-clear-mark" aria-hidden>
        <Icon name="check" />
      </span>
      <div>
        <h2>{text.title}</h2>
        <p>{said.filter(Boolean).join(" ")}</p>
      </div>
    </section>
  );
}
