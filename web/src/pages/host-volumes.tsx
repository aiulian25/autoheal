import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ROUTES, apiPath, type HostView, type HostVolumesView, type JobView } from "../../../src/shared/api.js";
import { BYTES_PER_KILOBYTE, JOB_ACTION, JOB_STATUS } from "../../../src/shared/constants.js";
import {
  VOLUME_STATE,
  isCleanableVolume,
  isRemovableVolume,
  volumeState,
  type VolumeLookAnswer,
  type VolumeLookEntry,
  type VolumeReport,
  type VolumeState,
} from "../../../src/shared/volumes.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { isWaiting } from "../components/container-actions.js";
import { Icon } from "../components/icons.js";
import { INVENTORY_REFRESH_MILLISECONDS, JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { bytes } from "../format.js";
import { chipClassOf, toggled } from "./host-networks.js";
import { NewVolumeDialog } from "./new-volume.js";

const text = TEXT.hostVolumes;
const SHOWN_MEMBERS = 3;
const SECTION_ID = "host-volumes";
const COLUMNS = 6;
const SHORT_NAME = 12;
const PATH_SEPARATOR = "/";

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

// As Docker counts them, so the figures here match its own.
const sizeText = (sizeBytes: number) => bytes(sizeBytes, BYTES_PER_KILOBYTE);
const sizeOf = (volume: VolumeReport) => (volume.sizeBytes === null ? text.notCounted : sizeText(volume.sizeBytes));
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

function madeByOf(volume: VolumeReport): string {
  if (volume.own) return text.madeBy.autoheal;
  if (volume.ownedBy !== null) return volume.ownedBy;
  if (volume.project !== null) return text.madeBy.compose(volume.project);
  return volume.nameless ? text.madeBy.docker : text.madeBy.hand;
}

function stateLine(volume: VolumeReport): string {
  const state = volumeState(volume);
  if (state === VOLUME_STATE.otherTool) return text.states.other_tool(volume.ownedBy ?? "");
  if (state === VOLUME_STATE.projectStillHere) return text.states.project_still_here(volume.project ?? "");
  if (state !== VOLUME_STATE.leftBehind) return text.states[state];
  if (!volume.nameless) return text.states.left_behind_project;
  return volume.sizeBytes === 0 ? text.states.left_behind_empty : text.states.left_behind_nameless;
}

const STATE_CLASS: Partial<Record<VolumeState, string>> = {
  [VOLUME_STATE.leftBehind]: "text-warning",
  [VOLUME_STATE.inUse]: "text-good",
};

function VolumeName({ volume }: { volume: VolumeReport }) {
  if (!volume.nameless) return <span className="mono">{volume.name}</span>;
  return (
    <span title={volume.name}>
      <span className="muted">{text.noName}</span>{" "}
      <span className="mono faint">{volume.name.slice(0, SHORT_NAME)}</span>
    </span>
  );
}

function Members({ volume }: { volume: VolumeReport }) {
  if (volume.members.length === 0) return <span className="faint">{text.nobody}</span>;
  const rest = volume.members.length - SHOWN_MEMBERS;
  return (
    <span className="network-members">
      {volume.members.slice(0, SHOWN_MEMBERS).map((member) => (
        <span key={member.name} className={member.running ? "network-member" : "network-member text-warning"}>
          {member.name}
          {member.running ? <span className="faint"> {member.destination}</span> : <span>{` · ${text.stopped}`}</span>}
        </span>
      ))}
      {rest > 0 && <span className="faint">{text.more(rest)}</span>}
    </span>
  );
}

// One folder's worth of what was read: its files, and its folders with all they hold added up.
function folderContents(entries: readonly VolumeLookEntry[], folder: string) {
  const start = folder === "" ? "" : `${folder}${PATH_SEPARATOR}`;
  const shown = new Map<string, { name: string; folder: boolean; sizeBytes: number; modifiedAt: number }>();
  for (const entry of entries) {
    if (!entry.path.startsWith(start)) continue;
    const [name, ...deeper] = entry.path.slice(start.length).split(PATH_SEPARATOR);
    if (!name) continue;
    const before = shown.get(name);
    shown.set(name, {
      name,
      folder: entry.folder || deeper.length > 0 || before?.folder === true,
      sizeBytes: (before?.sizeBytes ?? 0) + entry.sizeBytes,
      modifiedAt: Math.max(before?.modifiedAt ?? 0, entry.modifiedAt),
    });
  }
  return [...shown.values()].toSorted(
    (first, second) => Number(second.folder) - Number(first.folder) || first.name.localeCompare(second.name),
  );
}

/** What a volume holds, read when asked: looked at here, never changed. */
function VolumeFiles({ hostId, name }: { hostId: string; name: string }) {
  const [folder, setFolder] = useState("");
  const look = useQuery({
    queryKey: ["host-volume-look", hostId, name],
    queryFn: () => api<VolumeLookAnswer>("POST", apiPath(API_ROUTES.hostVolumeLook, { hostId }), { name }),
    staleTime: 0,
    gcTime: 0,
  });
  if (look.data === undefined) {
    return look.error ? (
      <ErrorNotice error={look.error} />
    ) : (
      <p className="small muted" role="status">
        {text.looking}
      </p>
    );
  }
  const { error, entries, partial } = look.data;
  if (error !== null) return <p className="small text-danger">{error}</p>;
  if (entries.length === 0) return <p className="small muted">{text.lookEmpty}</p>;
  const parent = folder.includes(PATH_SEPARATOR) ? folder.slice(0, folder.lastIndexOf(PATH_SEPARATOR)) : "";
  return (
    <div className="volume-files" role="group" aria-label={text.lookLabel}>
      <div className="volume-files-head mono muted">
        {folder !== "" && (
          <button type="button" className="link" onClick={() => setFolder(parent)}>
            {text.up}
          </button>
        )}{" "}
        {PATH_SEPARATOR} {folder}
      </div>
      {folderContents(entries, folder).map((item) => (
        <div key={item.name} className="volume-file-row">
          {item.folder ? (
            <button
              type="button"
              className="link mono"
              aria-label={text.openFolder(item.name)}
              onClick={() => setFolder(folder === "" ? item.name : `${folder}${PATH_SEPARATOR}${item.name}`)}
            >
              {item.name}
              {PATH_SEPARATOR}
            </button>
          ) : (
            <span className="mono">{item.name}</span>
          )}
          <span className="muted">{sizeText(item.sizeBytes)}</span>
          <span className="muted">{new Date(item.modifiedAt).toLocaleString()}</span>
        </div>
      ))}
      {partial && <p className="small text-warning">{text.lookPartial}</p>}
      <p className="small faint network-hint">{text.lookHint}</p>
    </div>
  );
}

function VolumePanel({
  hostId,
  volume,
  looking,
  onLook,
}: {
  hostId: string;
  volume: VolumeReport;
  looking: boolean;
  onLook: () => void;
}) {
  const created = volume.createdAt === "" ? null : new Date(volume.createdAt).toLocaleDateString();
  const facts = [
    { label: text.facts.driver, value: volume.driver },
    { label: text.facts.holds, value: sizeOf(volume) },
    { label: text.facts.madeBy, value: madeByOf(volume) },
    ...(created === null ? [] : [{ label: text.facts.created, value: created }]),
  ];
  return (
    <div className="network-panel">
      <dl className="network-facts">
        {facts.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {volume.members.map((member) => (
        <div key={member.name} className="network-panel-row">
          <span className="mono">{member.name}</span>
          <span className="mono muted">{member.destination}</span>
          <span className={member.running ? "text-good" : "text-warning"}>
            {member.running ? text.running : text.stopped}
          </span>
        </div>
      ))}
      {volume.members.length > 0 && <p className="small faint network-hint">{text.settingsHint}</p>}
      {!volume.own &&
        (looking ? (
          <VolumeFiles hostId={hostId} name={volume.name} />
        ) : (
          <p>
            <button type="button" onClick={onLook}>
              {text.lookInside}
            </button>
          </p>
        ))}
    </div>
  );
}

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
