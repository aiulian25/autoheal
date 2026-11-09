import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ROUTES, apiPath, type HostView, type HostVolumesView, type JobView } from "../../../src/shared/api.js";
import { JOB_ACTION, JOB_STATUS } from "../../../src/shared/constants.js";
import {
  VOLUME_STATE,
  isCleanableVolume,
  isRemovableVolume,
  volumeState,
  type VolumeReport,
  type VolumeState,
} from "../../../src/shared/volumes.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { isWaiting } from "../components/container-actions.js";
import { Icon } from "../components/icons.js";
import { INVENTORY_REFRESH_MILLISECONDS, JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { chipClassOf, toggled } from "./resource-chips.js";
import { NewVolumeDialog } from "./new-volume.js";
import {
  sizeText,
  VolumeName,
  Members,
  sizeOf,
  madeByOf,
  STATE_CLASS,
  stateLine,
  VolumePanel,
} from "./volume-panel.js";

const text = TEXT.hostVolumes;

const SECTION_ID = "host-volumes";
const COLUMNS = 6;

const TITLE_ID = "host-volumes-title";
const VOLUME_COLUMNS = 7;
const volumesKey = (hostId: string) => ["host-volumes", hostId];
const volumesQuery = (hostId: string) => ({
  queryKey: volumesKey(hostId),
  queryFn: () => api<HostVolumesView>("GET", apiPath(API_ROUTES.hostVolumes, { hostId })),
  refetchInterval: (query: { state: { data: HostVolumesView | undefined } }) => {
    const job = query.state.data?.lastJob;
    return job && isWaiting(job) ? JOB_REFRESH_MILLISECONDS : INVENTORY_REFRESH_MILLISECONDS;
  },
});

function useVolumeRemoval(hostId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ names, evenWithData = false }: { names: readonly string[]; evenWithData?: boolean }) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId }), {
        action: JOB_ACTION.removeVolumes,
        volumeRemoval: { names, evenWithData },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: volumesKey(hostId) }),
  });
}

const totalOf = (volumes: readonly VolumeReport[]) =>
  volumes.reduce((total, { sizeBytes }) => total + (sizeBytes ?? 0), 0);

const ORDER: readonly VolumeState[] = [
  VOLUME_STATE.leftBehind,
  VOLUME_STATE.notUsed,
  VOLUME_STATE.projectStillHere,
  VOLUME_STATE.otherTool,
  VOLUME_STATE.keptForStopped,
  VOLUME_STATE.inUse,
  VOLUME_STATE.autohealOwn,
];
const inOrder = (volumes: readonly VolumeReport[]) =>
  volumes.toSorted(
    (first, second) =>
      ORDER.indexOf(volumeState(first)) - ORDER.indexOf(volumeState(second)) ||
      (second.sizeBytes ?? 0) - (first.sizeBytes ?? 0) ||
      first.name.localeCompare(second.name),
  );

const FILTERS = {
  all: () => true,
  notUsed: (volume: VolumeReport) => !volume.own && volume.members.length === 0,
  inUse: (volume: VolumeReport) => !volume.own && volume.members.length > 0,
  autohealOwn: (volume: VolumeReport) => volume.own,
};
type Filter = keyof typeof FILTERS;
const FILTER_NAMES = Object.keys(FILTERS) as Filter[];

function holdsLine({ sizeBytes }: VolumeReport): string {
  if (sizeBytes === null) return text.ask.holdsUnknown;
  return sizeBytes === 0 ? text.ask.holdsNothing : text.ask.holds(sizeText(sizeBytes));
}

// What the question says: how much goes, and whose it was, in place of a warning that says nothing.
function askLine(volumes: readonly VolumeReport[]): string {
  const [only] = volumes;
  if (only === undefined) return "";
  if (volumes.length > 1) return text.ask.many(volumes.length, text.ask.holdsMany(sizeText(totalOf(volumes))));
  const parts = [
    holdsLine(only),
    ...(only.ownedBy === null ? [] : [text.ask.other(only.ownedBy)]),
    ...(only.project === null ? [] : [text.ask.project(only.project)]),
  ];
  return text.ask.one(only.name, parts.join(" "));
}

/** Every Docker volume on a host: what it holds, who uses it, and only what cannot hurt cleared in one click. */
export function HostVolumes({
  host,
  admin,
  find = "",
  leftAsked = 0,
}: {
  host: HostView;
  admin: boolean;
  // What Find holds while this list is the one showing.
  find?: string;
  // Goes up each time a person clicks the button while it says something was left behind.
  leftAsked?: number;
}) {
  const queryClient = useQueryClient();
  const view = useQuery(volumesQuery(host.id));
  const removal = useVolumeRemoval(host.id);
  const [filter, setFilter] = useState<Filter>("all");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<{ name: string; looking: boolean } | null>(null);
  const [asking, setAsking] = useState<readonly VolumeReport[]>([]);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (leftAsked > 0) setFilter("notUsed");
  }, [leftAsked]);
  const data = view.data;
  if (data === undefined) {
    return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  }
  const volumes = data.volumes;
  const remove = (names: readonly string[], evenWithData = false) => {
    removal.mutate({ names, evenWithData });
    setTicked(new Set());
    setAsking([]);
  };
  // Nothing to lose goes at once; anything else is asked about first, with the facts.
  const removeOrAsk = (chosen: readonly VolumeReport[]) => {
    if (chosen.every(isCleanableVolume)) remove(chosen.map(({ name }) => name));
    else setAsking(chosen);
  };
  if (volumes === null) {
    return (
      <section id={SECTION_ID} className="section host-networks" aria-labelledby={TITLE_ID}>
        <p className="muted">{text.notReported}</p>
      </section>
    );
  }
  const canChange = admin && host.dryRun === false;
  const cleanable = volumes.filter(isCleanableVolume);
  const chosen = volumes.filter((volume) => ticked.has(volume.name));
  const words = find.trim().toLowerCase();
  const shown = inOrder(volumes.filter(FILTERS[filter]).filter(({ name }) => name.toLowerCase().includes(words)));
  const lastJob = data.lastJob;
  const answered = lastJob !== null && removal.data?.id === lastJob.id && !isWaiting(lastJob);
  const failed = answered && lastJob.status === JOB_STATUS.failed;
  return (
    <section id={SECTION_ID} className="section host-networks" aria-labelledby={TITLE_ID}>
      <div className="row spread panel-filters">
        <div className="show-chips" role="group" aria-label={text.filterLabel}>
          {FILTER_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className={name === filter ? "chip-button active" : "chip-button"}
              aria-pressed={name === filter}
              onClick={() => setFilter(name)}
            >
              {text.filters[name]} <span className="tab-count">{volumes.filter(FILTERS[name]).length}</span>
            </button>
          ))}
        </div>
        {canChange && (
          <span className="row">
            {cleanable.length > 0 && (
              <button
                type="button"
                className="primary"
                disabled={removal.isPending}
                onClick={() => remove(cleanable.map(({ name }) => name))}
              >
                {text.cleanUp(cleanable.length)}
              </button>
            )}
            <button type="button" className="add-container" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {text.newVolume}
            </button>
          </span>
        )}
      </div>
      {!canChange && admin && <p className="small muted">{text.watchOnly}</p>}
      {chosen.length > 0 && (
        <div className="bulk-bar action-bar" role="group" aria-label={text.barLabel}>
          <span>{text.ticked(chosen.length)}</span>
          <button type="button" className="quiet" onClick={() => setTicked(new Set())}>
            {text.clear}
          </button>
          <button type="button" className="danger" disabled={removal.isPending} onClick={() => removeOrAsk(chosen)}>
            {text.remove(chosen.length)}
          </button>
          {chosen.every(isCleanableVolume) && <span className="muted">{text.noQuestion}</span>}
        </div>
      )}
      {asking.length > 0 && (
        <div className="notice warning row spread" role="alert">
          <span>{askLine(asking)}</span>
          <span className="row">
            <button type="button" onClick={() => setAsking([])}>
              {text.ask.keep}
            </button>
            {asking.length === 1 && (
              <button type="button" onClick={() => setOpened({ name: asking[0]!.name, looking: true })}>
                {text.ask.lookInside}
              </button>
            )}
            <button
              type="button"
              className="danger"
              onClick={() =>
                remove(
                  asking.map(({ name }) => name),
                  true,
                )
              }
            >
              {text.ask.remove}
            </button>
          </span>
        </div>
      )}
      {answered && (
        <p className={failed ? "text-danger small" : "small"} role="status">
          {lastJob.outcome}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {canChange && <th className="tick-column" />}
              <th>{text.columns.name}</th>
              <th>{text.columns.who}</th>
              <th>{text.columns.holds}</th>
              <th>{text.columns.madeBy}</th>
              <th>{text.columns.state}</th>
              <th>{text.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={VOLUME_COLUMNS} className="muted">
                  {text.nothingFound}
                </td>
              </tr>
            )}
            {shown.flatMap((volume) => {
              const open = opened?.name === volume.name;
              const removable = isRemovableVolume(volume);
              const tickable = removable && volume.ownedBy === null;
              const row = (
                <tr key={volume.name} className={ticked.has(volume.name) ? "selected" : undefined}>
                  {canChange && (
                    <td className="tick-column">
                      {tickable && (
                        <input
                          type="checkbox"
                          checked={ticked.has(volume.name)}
                          aria-label={text.tick(volume.name)}
                          onChange={() => setTicked(toggled(ticked, volume.name))}
                        />
                      )}
                    </td>
                  )}
                  <td>
                    <VolumeName volume={volume} />
                  </td>
                  <td>
                    <Members volume={volume} />
                  </td>
                  <td className="muted">{sizeOf(volume)}</td>
                  <td className="muted">{madeByOf(volume)}</td>
                  <td className={STATE_CLASS[volumeState(volume)] ?? "muted"}>{stateLine(volume)}</td>
                  <td>
                    <span className="network-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title={text.open(volume.name)}
                        aria-label={text.open(volume.name)}
                        aria-expanded={open}
                        onClick={() => setOpened(open ? null : { name: volume.name, looking: false })}
                      >
                        <Icon name="eye" />
                      </button>
                      {volume.own ? (
                        <span className="locked" title={text.lockedNote}>
                          <Icon name="lock" />
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="icon-button"
                            title={text.look(volume.name)}
                            aria-label={text.look(volume.name)}
                            onClick={() => setOpened({ name: volume.name, looking: true })}
                          >
                            <Icon name="folder" />
                          </button>
                          {canChange && (
                            <button
                              type="button"
                              className="icon-button icon-danger"
                              title={removable ? text.removeOne(volume.name) : text.busy}
                              aria-label={text.removeOne(volume.name)}
                              disabled={!removable || removal.isPending}
                              onClick={() => removeOrAsk([volume])}
                            >
                              <Icon name="trash" />
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              );
              if (!open) return [row];
              return [
                row,
                <tr key={`${volume.name}-panel`}>
                  <td colSpan={canChange ? COLUMNS + 1 : COLUMNS}>
                    <VolumePanel
                      hostId={host.id}
                      volume={volume}
                      looking={opened.looking}
                      onLook={() => setOpened({ name: volume.name, looking: true })}
                    />
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      <ErrorNotice error={removal.error} />
      {creating && (
        <NewVolumeDialog
          host={host}
          volumes={volumes}
          lastJob={lastJob}
          onChanged={() => queryClient.invalidateQueries({ queryKey: volumesKey(host.id) })}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}

/** The heading while this list is the one showing. */
export function VolumesHeading({ host }: { host: HostView }) {
  const volumes = useQuery(volumesQuery(host.id)).data?.volumes;
  return (
    <h2 id={TITLE_ID}>
      {text.title}
      {volumes != null && (
        <span className="muted">
          {TEXT.separator}
          {text.summary(volumes.length, host.label, sizeText(totalOf(volumes)))}
        </span>
      )}
    </h2>
  );
}

/** Beside the containers' filters: opens the volumes, and says when something truly empty was left behind. */
export function VolumesChip({
  hostId,
  active,
  onOpen,
}: {
  hostId: string;
  active: boolean;
  onOpen: (leftBehind: boolean) => void;
}) {
  const view = useQuery(volumesQuery(hostId));
  const volumes = view.data?.volumes ?? [];
  const empty = volumes.filter(isCleanableVolume).length;
  const hasEmpty = empty > 0;
  return (
    <button
      type="button"
      className={chipClassOf(active, hasEmpty)}
      aria-pressed={active}
      onClick={() => onOpen(hasEmpty)}
    >
      {text.chip} <span className="tab-count">{hasEmpty ? text.chipEmpty(empty) : volumes.length}</span>
    </button>
  );
}

/** On the line that says containers were removed: the volumes they leave. Only what is empty goes in one click. */
export function VolumesLeftOffer({
  hostId,
  projects,
  names,
  onLook,
}: {
  hostId: string;
  projects: readonly string[];
  names: readonly string[];
  onLook: () => void;
}) {
  const view = useQuery(volumesQuery(hostId));
  const removal = useVolumeRemoval(hostId);
  const [dismissed, setDismissed] = useState(false);
  const left = (view.data?.volumes ?? []).filter(
    (volume) =>
      isRemovableVolume(volume) &&
      (names.includes(volume.name) || (volume.project !== null && projects.includes(volume.project))),
  );
  if (left.length === 0 || dismissed) return null;
  const empty = left.filter(isCleanableVolume);
  const others = left.filter((volume) => !isCleanableVolume(volume));
  const described = others.map((volume) =>
    volume.sizeBytes === null ? volume.name : `${volume.name}, ${sizeText(volume.sizeBytes)}`,
  );
  return (
    <span className="left-behind-offer">
      <span className="text-warning">{text.offer(empty.length, described)}</span>
      {empty.length > 0 && (
        <button
          type="button"
          className="danger"
          disabled={removal.isPending}
          onClick={() => removal.mutate({ names: empty.map(({ name }) => name) })}
        >
          {text.removeEmpty(empty.length)}
        </button>
      )}
      {others.length > 0 && (
        <button type="button" onClick={onLook}>
          {text.lookOthers(others.length)}
        </button>
      )}
      <button type="button" className="quiet" onClick={() => setDismissed(true)}>
        {text.keep(left.length)}
      </button>
    </span>
  );
}
