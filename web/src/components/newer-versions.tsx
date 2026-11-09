import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  API_ROUTES,
  apiPath,
  hasNewerVersion,
  ignoresNewerVersion,
  type ContainerView,
  type HostView,
  type IgnoredVersionChange,
  type JobView,
} from "../../../src/shared/api.js";
import { IGNORE_EVERY_VERSION, JOB_ACTION, JOB_STATUS } from "../../../src/shared/constants.js";
import { imageTag } from "../../../src/shared/image-reference.js";
import { handedCount, isDatabaseMajor, tagHandable, tagItem, useHandOver } from "../agent-dispatch.js";
import { api } from "../api-client.js";
import { NEWER_VERSIONS_SHOWN, TEXT } from "../constants.js";
import { hostJobsQuery } from "../queries.js";
import { ErrorNotice } from "./common.js";
import { isWaiting } from "./container-actions.js";
import { Icon } from "./icons.js";
import { ReleaseNotesLink } from "./release-notes-link.js";

const text = TEXT.containerImages;

/** What a person ignores of the host's newer versions; once saved, the lists follow. */
export function useIgnoreVersions(hostId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: IgnoredVersionChange[]) =>
      api<void>("PUT", apiPath(API_ROUTES.hostIgnoredVersions, { hostId }), { changes }),
    onSettled: () =>
      Promise.all(["containers", "board", "tasks"].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });
}

/** Ignore, with its two choices: the version out now, until a later one comes out, or every new version. */
function IgnoreChoices({
  button,
  label,
  thisVersion,
  everyVersion,
  disabled,
  onChoose,
}: {
  button: string;
  label: string;
  thisVersion: string;
  everyVersion: string;
  disabled: boolean;
  onChoose: (every: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (every: boolean) => {
    setOpen(false);
    onChoose(every);
  };
  return (
    <span className="ignore-menu">
      <button type="button" aria-expanded={open} aria-label={label} disabled={disabled} onClick={() => setOpen(!open)}>
        {button}
        <Icon name={open ? "chevronUp" : "chevronDown"} />
      </button>
      {open && (
        <span className="ignore-choices" role="menu">
          <button type="button" role="menuitem" onClick={() => choose(false)}>
            {thisVersion}
            <span className="small muted">{text.ignoreThisHint}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose(true)}>
            {everyVersion}
            <span className="small muted">{text.ignoreEveryHint}</span>
          </button>
        </span>
      )}
    </span>
  );
}

/** A version one container ignores now: that one, until a later one comes out, or every new version of it. */
export function IgnoreMenu({
  container,
  disabled,
  onIgnore,
}: {
  container: ContainerView;
  disabled: boolean;
  onIgnore: (version: string) => void;
}) {
  const tag = container.update.newerTag ?? "";
  return (
    <IgnoreChoices
      button={text.ignore}
      label={text.ignoreOf(container.name)}
      thisVersion={text.ignoreThis(tag)}
      everyVersion={text.ignoreEvery(container.name)}
      disabled={disabled}
      onChoose={(every) => onIgnore(every ? IGNORE_EVERY_VERSION : tag)}
    />
  );
}

// Why a newer version cannot go to the agent, where the row can say: null where it can, or where only the host's
// rules stand in the way, which its page says already.
function whyNotHandable(container: ContainerView): string | null {
  if (isDatabaseMajor(container)) return text.databaseMajor;
  return container.composeProject === null ? text.notFromCompose : null;
}

// Each newer version handed from here, with its container's tag changes as they were then: only one asked since ends it.
type Handed = ReadonlyMap<string, ReadonlySet<string>>;

const tagChangesOf = (jobs: readonly JobView[], container: ContainerView) =>
  jobs.filter((job) => job.action === JOB_ACTION.changeTag && job.containerName === container.name);

/**
 * Whether a newer version is with Ollama now: its tag change on its way, or handed from here and not given back since.
 * One whose change went well leaves the list with the next report; one Ollama gave back is offered again.
 */
function withOllama(container: ContainerView, jobs: readonly JobView[], handed: Handed): boolean {
  const changes = tagChangesOf(jobs, container);
  if (changes.some(isWaiting)) return true;
  const before = handed.get(tagItem(container));
  if (before === undefined) return false;
  return !changes.some((job) => !before.has(job.id) && job.status !== JOB_STATUS.succeeded);
}

// One container ignores a version that is out now, or every new one.
const ignoresNow = (container: ContainerView) =>
  container.update.ignored === IGNORE_EVERY_VERSION || ignoresNewerVersion(container);

/**
 * Newer versions of the tags the host's containers are pinned to: the first few, the rest a click away. Each can go to
 * the Ollama agent, which changes its tag where the container's files write it, or be ignored; ticked ones go together.
 */
export function NewerVersions({
  host,
  admin,
  containers,
}: {
  host: HostView;
  admin: boolean;
  containers: readonly ContainerView[];
}) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [handed, setHanded] = useState<Handed>(new Map());
  const jobs = useQuery(hostJobsQuery(host.id)).data ?? [];
  const handOver = useHandOver();
  const ignore = useIgnoreVersions(host.id);
  const newer = containers.filter(hasNewerVersion);
  const ignored = containers.filter(ignoresNow);
  if (newer.length === 0 && ignored.length === 0) return null;
  const busy = handOver.isPending || ignore.isPending;
  const shown = open ? newer : newer.slice(0, NEWER_VERSIONS_SHOWN);
  const hidden = newer.length - NEWER_VERSIONS_SHOWN;
  const isWithOllama = (container: ContainerView) => withOllama(container, jobs, handed);
  const handable = (container: ContainerView) => admin && tagHandable(host, container) && !isWithOllama(container);
  const tickedRows = newer.filter((container) => ticked.has(container.name));
  const tickedHandable = tickedRows.filter(handable);
  const clear = () => setTicked(new Set());
  const toggle = (name: string) =>
    setTicked((current) =>
      current.has(name) ? new Set([...current].filter((each) => each !== name)) : new Set([...current, name]),
    );
  const noteHanded = (rows: readonly ContainerView[]) =>
    setHanded((current) => {
      const next = new Map(current);
      rows.forEach((row) => next.set(tagItem(row), new Set(tagChangesOf(jobs, row).map((job) => job.id))));
      return next;
    });
  const hand = (rows: readonly ContainerView[]) =>
    handOver.mutate(rows.map(tagItem), {
      onSuccess: () => {
        clear();
        noteHanded(rows);
      },
    });
  const ignoreRows = (rows: readonly ContainerView[], version: (container: ContainerView) => string | null) =>
    ignore.mutate(
      rows.map((container) => ({ container: container.name, version: version(container) })),
      { onSuccess: clear },
    );
  return (
    <>
      {newer.length > 0 && <h4>{text.newerTitle}</h4>}
      {admin && tickedRows.length > 0 && (
        <div className="bulk-bar action-bar newer-bar" role="group" aria-label={text.newerTitle}>
          <span>{TEXT.hostContainers.bulk.ticked(tickedRows.length)}</span>
          <button type="button" className="quiet" onClick={clear}>
            {TEXT.hostContainers.bulk.clear}
          </button>
          <button
            type="button"
            className="primary"
            disabled={tickedHandable.length === 0 || busy}
            onClick={() => hand(tickedHandable)}
          >
            {text.handTicked(tickedHandable.length)}
          </button>
          <IgnoreChoices
            button={text.ignoreTicked(tickedRows.length)}
            label={text.ignoreTicked(tickedRows.length)}
            thisVersion={text.ignoreTickedThis(tickedRows.length)}
            everyVersion={text.ignoreTickedEvery(tickedRows.length)}
            disabled={busy}
            onChoose={(every) =>
              ignoreRows(tickedRows, (container) =>
                every ? IGNORE_EVERY_VERSION : (container.update.newerTag ?? null),
              )
            }
          />
        </div>
      )}
      {newer.length > 0 && (
        <ul className="update-rows">
          {shown.map((container) => {
            const why = whyNotHandable(container);
            const handedOver = isWithOllama(container);
            return (
              <li key={container.name} className="update-row newer-row">
                {admin ? (
                  <input
                    type="checkbox"
                    checked={ticked.has(container.name)}
                    disabled={busy}
                    onChange={() => toggle(container.name)}
                    aria-label={text.tickOne(container.name)}
                  />
                ) : (
                  <span className="tick-space" />
                )}
                <span className="update-what">
                  <span className="mono">{container.name}</span>
                  <span className="small">
                    {TEXT.updates.versions(imageTag(container.image), container.update.newerTag!)}
                    <ReleaseNotesLink container={container} version={container.update.newerTag!} />
                    {why !== null && <span className="faint"> · {why}</span>}
                  </span>
                </span>
                {admin && (
                  <button
                    type="button"
                    aria-label={handedOver ? text.withOllamaOf(container.name) : text.handOne(container.name)}
                    disabled={!handable(container) || busy}
                    onClick={() => hand([container])}
                  >
                    {handedOver ? text.withOllama : text.handTo}
                  </button>
                )}
                {admin && (
                  <IgnoreMenu
                    container={container}
                    disabled={busy}
                    onIgnore={(version) => ignoreRows([container], () => version)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? text.newerShowFewer : text.newerShowAll(newer.length)}
        </button>
      )}
      {handOver.data !== undefined && (
        <p className="small" role="status">
          {text.handed(handedCount(handOver.data))}
        </p>
      )}
      <ErrorNotice error={handOver.error ?? ignore.error} />
      {newer.length > 0 && <p className="small muted">{text.newerHint}</p>}
      {ignored.length > 0 && (
        <>
          <h4>{text.ignoredTitle}</h4>
          <ul className="update-rows">
            {ignored.map((container) => (
              <li key={container.name} className="update-row">
                <span className="tick-space" />
                <span className="update-what">
                  <span className="mono">{container.name}</span>
                  <span className="small faint">
                    {container.update.ignored === IGNORE_EVERY_VERSION ? text.ignoredEvery : container.update.ignored}
                  </span>
                </span>
                {admin && (
                  <button
                    type="button"
                    aria-label={text.stopIgnoringOf(container.name)}
                    disabled={busy}
                    onClick={() => ignoreRows([container], () => null)}
                  >
                    {text.stopIgnoring}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
