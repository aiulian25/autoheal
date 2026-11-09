import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { BYTES_PER_KILOBYTE } from "../../../src/shared/constants.js";
import {
  VOLUME_STATE,
  volumeState,
  type VolumeLookAnswer,
  type VolumeLookEntry,
  type VolumeReport,
  type VolumeState,
} from "../../../src/shared/volumes.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { TEXT } from "../constants.js";
import { bytes } from "../format.js";

const text = TEXT.hostVolumes;

const SHOWN_MEMBERS = 3;

const SHORT_NAME = 12;

const PATH_SEPARATOR = "/";

// As Docker counts them, so the figures here match its own.
export const sizeText = (sizeBytes: number) => bytes(sizeBytes, BYTES_PER_KILOBYTE);

export const sizeOf = (volume: VolumeReport) =>
  volume.sizeBytes === null ? text.notCounted : sizeText(volume.sizeBytes);

export function madeByOf(volume: VolumeReport): string {
  if (volume.own) return text.madeBy.autoheal;
  if (volume.ownedBy !== null) return volume.ownedBy;
  if (volume.project !== null) return text.madeBy.compose(volume.project);
  return volume.nameless ? text.madeBy.docker : text.madeBy.hand;
}

export function stateLine(volume: VolumeReport): string {
  const state = volumeState(volume);
  if (state === VOLUME_STATE.otherTool) return text.states.other_tool(volume.ownedBy ?? "");
  if (state === VOLUME_STATE.projectStillHere) return text.states.project_still_here(volume.project ?? "");
  if (state !== VOLUME_STATE.leftBehind) return text.states[state];
  if (!volume.nameless) return text.states.left_behind_project;
  return volume.sizeBytes === 0 ? text.states.left_behind_empty : text.states.left_behind_nameless;
}

export const STATE_CLASS: Partial<Record<VolumeState, string>> = {
  [VOLUME_STATE.leftBehind]: "text-warning",
  [VOLUME_STATE.inUse]: "text-good",
};

export function VolumeName({ volume }: { volume: VolumeReport }) {
  if (!volume.nameless) return <span className="mono">{volume.name}</span>;
  return (
    <span title={volume.name}>
      <span className="muted">{text.noName}</span>{" "}
      <span className="mono faint">{volume.name.slice(0, SHORT_NAME)}</span>
    </span>
  );
}

export function Members({ volume }: { volume: VolumeReport }) {
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

export function VolumePanel({
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
