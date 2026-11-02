import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { API_ROUTES, apiPath, type JobView } from "../../../src/shared/api.js";
import { JOB_STATUS, sizeText } from "../../../src/shared/constants.js";
import {
  BACKUP_ASK,
  BACKUP_LEFT_OUT,
  BACKUP_METHOD,
  BACKUP_WHY,
  type BackupAnswer,
  type BackupEntry,
  type BackupPreview,
  type BackupTarget,
} from "../../../src/shared/container-backups.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { TEXT } from "../constants.js";

const text = TEXT.containerBackup;
const JOB_REFRESH_MILLISECONDS = 1_500;
const PERCENT = 100;
export const BACKUP_DIALOG = { backUp: "back_up", restore: "restore" } as const;
export type BackupDialogMode = (typeof BACKUP_DIALOG)[keyof typeof BACKUP_DIALOG];

const isOpen = (job: JobView) => job.status === JOB_STATUS.pending || job.status === JOB_STATUS.delivered;
const nameOf = ({ container, stack }: BackupTarget) => stack ?? container ?? "";
const dateOf = (at: number) => new Date(at).toLocaleString();

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function howItRuns(preview: BackupPreview, name: string) {
  const dumps = preview.dumps.map(({ engine }) => engine);
  const stops = preview.stops;
  if (stops.length === 0) return text.keepsRunning([...new Set(dumps)].join(", "));
  const others = stops.filter((one) => one !== name);
  const stopping = others.length === 0 ? text.stopsItself : text.stopsThese(stops.join(", "));
  return dumps.length === 0 ? stopping : `${stopping} ${text.andDumps([...new Set(dumps)].join(", "))}`;
}

function BackUpFacts({
  preview,
  name,
  ticked,
  onTick,
}: {
  preview: BackupPreview;
  name: string;
  ticked: ReadonlySet<string>;
  onTick: (source: string) => void;
}) {
  const saved = preview.mounts.filter(({ leftOut }) => leftOut === null);
  const leftOut = preview.mounts.filter(({ leftOut: why }) => why !== null);
  const bytes = saved.reduce((sum, { bytes: size }) => sum + (size ?? 0), 0);
  const parts = [
    ...(saved.length === 0 ? [] : [text.folders(saved.length, sizeText(bytes))]),
    ...preview.dumps.map(({ engine }) => text.databaseSaved(engine)),
  ];
  return (
    <>
      <dl className="backup-facts">
        <Fact label={text.saves}>{parts.join(TEXT.separator) || text.nothingChosen}</Fact>
        {saved.length > 0 && (
          <Fact label={text.folderList}>
            {saved.map(({ source }) => (
              <code key={source}>{source}</code>
            ))}
          </Fact>
        )}
        <Fact label={text.alsoSaves}>{preview.savesSettings ? text.composeAndImage : text.settingsAndImage}</Fact>
        <Fact label={text.how}>{howItRuns(preview, name)}</Fact>
        <Fact label={text.where}>
          <code>{`${preview.directory}/${name}`}</code>
          {preview.freeBytes !== null && ` ${TEXT.separator}${text.free(sizeText(preview.freeBytes))}`}
        </Fact>
      </dl>
      {leftOut.map(({ source, bytes: size, leftOut: why }) => (
        <label key={source} className="backup-left-out">
          <input
            type="checkbox"
            checked={ticked.has(source)}
            disabled={why === BACKUP_LEFT_OUT.noRoom}
            onChange={() => onTick(source)}
          />
          <span>
            {text.alsoSave} <code>{source}</code>{" "}
            <span className="text-warning">{text.leftOutWhy[why!](size === null ? null : sizeText(size))}</span>
          </span>
        </label>
      ))}
    </>
  );
}

function BackupRow({ backup, chosen, onChoose }: { backup: BackupEntry; chosen: boolean; onChoose: () => void }) {
  const moved = backup.members.some(({ sameImage }) => !sameImage);
  return (
    <label className={chosen ? "backup-row chosen" : "backup-row"}>
      <input type="radio" name="backup" checked={chosen} disabled={backup.unsealed} onChange={onChoose} />
      <strong>{dateOf(backup.createdAt)}</strong>
      <span>{sizeText(backup.bytes)}</span>
      <span className={moved ? "text-warning" : "muted"}>{backup.members.map(({ image }) => image).join(", ")}</span>
      <span className="muted">
        {backup.why === BACKUP_WHY.safety ? text.beforeRestore : text.byYou}
        {backup.fromStack && ` ${TEXT.separator}${text.fromStack}`}
      </span>
      {backup.unsealed ? (
        <span className="text-warning">{text.notSealed}</span>
      ) : (
        <span className="text-good">{text.checked}</span>
      )}
    </label>
  );
}

function RestoreNotes({ backup, name }: { backup: BackupEntry; name: string }) {
  const moved = backup.members.filter(({ sameImage, method }) => !sameImage && method === BACKUP_METHOD.files);
  return (
    <>
      {moved.length > 0 && (
        <p className="notice warning small">
          {backup.hasSettings ? text.olderImageCompose(moved[0]!.image) : text.olderImageAlone(moved[0]!.image)}
        </p>
      )}
      {backup.fromStack && <p className="notice warning small">{text.oneOfStack(name)}</p>}
      {backup.leftOut.length > 0 && <p className="small muted">{text.leftOutThen(backup.leftOut.join(", "))}</p>}
      <p className="small muted">{text.whatIsLost(name)}</p>
    </>
  );
}

function Progress({ job }: { job: JobView }) {
  const { progress } = job;
  const percent =
    progress?.total != null && progress.total > 0
      ? Math.min(PERCENT, (progress.downloaded / progress.total) * PERCENT)
      : null;
  return (
    <div className="backup-progress" role="status">
      <strong>{progress === null ? text.waiting : TEXT.updateStream.phases[progress.phase]}</strong>
      {percent !== null && (
        <span className="network-bar">
          <i style={{ width: `${percent}%` }} />
        </span>
      )}
      <span className="small muted">{text.canClose}</span>
    </div>
  );
}

/** Back up, or choose a backup to restore: it says what will happen first, and shows how it went. */
export function BackupDialog({
  hostId,
  target,
  mode,
  onClose,
}: {
  hostId: string;
  target: BackupTarget;
  mode: BackupDialogMode;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const name = nameOf(target);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const asking = mode === BACKUP_DIALOG.backUp ? BACKUP_ASK.preview : BACKUP_ASK.list;
  const askKey = ["container-backup", hostId, asking, name];
  const asked = useQuery({
    queryKey: askKey,
    queryFn: () => api<BackupAnswer>("POST", apiPath(API_ROUTES.hostBackupAsk, { hostId }), { kind: asking, target }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const job = useQuery({
    queryKey: ["container-backup-job", jobId],
    queryFn: () => api<JobView>("GET", apiPath(API_ROUTES.job, { jobId: jobId! })),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data !== undefined && !isOpen(query.state.data) ? false : JOB_REFRESH_MILLISECONDS,
  });
  const start = useMutation({
    mutationFn: () =>
      api<JobView>("POST", apiPath(API_ROUTES.hostBackupStart, { hostId }), { target, include: [...ticked] }),
    onSuccess: ({ id }) => setJobId(id),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api<JobView>("POST", apiPath(API_ROUTES.hostBackupRestore, { hostId }), { target, id }),
    onSuccess: ({ id }) => {
      setJobId(id);
      setChosen(null);
    },
  });
  const finished = job.data !== undefined && !isOpen(job.data);
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries();
  }, [finished, queryClient]);
  const answer = asked.data;
  const backups = answer?.backups ?? [];
  const unreadable = answer?.unreadable ?? [];
  const unreadableCount = answer?.unreadableCount ?? 0;
  const restorable = backups.find(({ unsealed }) => !unsealed);
  const selected = backups.find(({ id }) => id === (chosen ?? restorable?.id));
  // This restore's own copy, by its name, and only while it is still there; never just the newest one listed.
  const undoTo = backups.find(({ id, why }) => id === job.data?.recoveryBackupId && why === BACKUP_WHY.safety);
  const canUndo = mode === BACKUP_DIALOG.restore && finished && undoTo !== undefined;
  const toggle = (source: string) => {
    const next = new Set(ticked);
    if (!next.delete(source)) next.add(source);
    setTicked(next);
  };
  const working = jobId !== null;
  const nothingToSave =
    answer?.preview != null &&
    answer.preview.dumps.length === 0 &&
    answer.preview.mounts.every(({ source, leftOut }) => leftOut !== null && !ticked.has(source));
  return (
    <dialog ref={dialog} className="connect-host add-container-dialog backup-dialog" onClose={onClose}>
      <h2>{mode === BACKUP_DIALOG.backUp ? text.backUpTitle(name) : text.restoreTitle(name)}</h2>
      <div className="connect-host-body install-body">
        {asked.isPending && !working && <Loading />}
        <ErrorNotice error={asked.error ?? start.error ?? restore.error ?? job.error} />
        {answer?.refusal != null && !working && <p className="notice warning small">{answer.refusal}</p>}
        {!working && answer?.preview != null && (
          <BackUpFacts preview={answer.preview} name={name} ticked={ticked} onTick={toggle} />
        )}
        {!working &&
          mode === BACKUP_DIALOG.restore &&
          answer?.refusal === null &&
          backups.length === 0 &&
          unreadableCount === 0 && <p className="muted">{text.noBackups}</p>}
        {!working && mode === BACKUP_DIALOG.restore && unreadableCount > 0 && (
          <div className="notice warning small">
            <p>{text.unreadable(unreadableCount)}</p>
            <ul>
              {unreadable.map(({ folder, id, reason }) => (
                <li key={`${folder}/${id}`}>
                  {folder}/{id}: {text.unreadableWhy[reason]}
                </li>
              ))}
              {unreadableCount > unreadable.length && (
                <li>{text.unreadableMore(unreadableCount - unreadable.length)}</li>
              )}
            </ul>
          </div>
        )}
        {!working && backups.length > 0 && (
          <div className="backup-rows">
            {backups.map((backup) => (
              <BackupRow
                key={backup.id}
                backup={backup}
                chosen={selected?.id === backup.id}
                onChoose={() => setChosen(backup.id)}
              />
            ))}
          </div>
        )}
        {!working && selected !== undefined && <RestoreNotes backup={selected} name={name} />}
        {working && !finished && job.data !== undefined && <Progress job={job.data} />}
        {finished && (
          <p className={job.data.status === JOB_STATUS.succeeded ? "text-good" : "notice warning"} role="status">
            {job.data.outcome}
          </p>
        )}
        {canUndo && <p className="small muted">{text.undoTo(dateOf(undoTo.createdAt))}</p>}
      </div>
      <div className="connect-host-foot">
        {!working && answer?.preview != null && <span className="small muted">{text.encrypted}</span>}
        <button type="button" onClick={() => dialog.current?.close()}>
          {finished || working ? text.close : text.cancel}
        </button>
        {!working && answer?.preview != null && (
          <button
            type="button"
            className="primary"
            disabled={start.isPending || nothingToSave}
            onClick={() => start.mutate()}
          >
            {text.backUpNow}
          </button>
        )}
        {!working && selected !== undefined && (
          <button
            type="button"
            className="primary"
            disabled={restore.isPending}
            onClick={() => restore.mutate(selected.id)}
          >
            {text.restoreThis}
          </button>
        )}
        {canUndo && (
          <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(undoTo.id)}>
            {text.undo}
          </button>
        )}
      </div>
    </dialog>
  );
}
