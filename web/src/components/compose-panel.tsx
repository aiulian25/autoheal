import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ROUTES, apiPath, type JobView } from "../../../src/shared/api.js";
import { JOB_ACTION, JOB_STATUS, type JobAction } from "../../../src/shared/constants.js";
import { SECRET_NAME } from "../../../src/shared/install.js";
import {
  STACK_ASK,
  STACK_FILE_KIND,
  type EditedStackFile,
  type StackAnswer,
  type StackAsk,
  type StackCheck,
  type StackFile,
} from "../../../src/shared/stacks.js";
import { api } from "../api-client.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { ErrorNotice } from "./common.js";
import { isWaiting } from "./container-actions.js";

const text = TEXT.stacks.compose;
const CHECK_DELAY_MILLISECONDS = 500;
const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export const askStack = (hostId: string, project: string, ask: StackAsk) =>
  api<StackAnswer>("POST", apiPath(API_ROUTES.hostStackAsk, { hostId, project }), ask);

export const askStackJob = (
  hostId: string,
  action: JobAction,
  project: string,
  removeData = false,
  reconcile?: { revision: string },
) =>
  api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId }), {
    action,
    stack: { project, removeData, ...(reconcile === undefined ? {} : { reconcile }) },
  });

export const stackDriftKey = (hostId: string) => ["stack-drift", hostId];

/** A stack job followed until it ends, and the host's containers read again then. */
export function useStackJob(hostId: string) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ["job", jobId],
    enabled: jobId !== null,
    queryFn: () => api<JobView>("GET", apiPath(API_ROUTES.job, { jobId: jobId ?? "" })),
    refetchInterval: (query) =>
      query.state.data === undefined || isWaiting(query.state.data) ? JOB_REFRESH_MILLISECONDS : false,
  });
  const ended = job.data !== undefined && !isWaiting(job.data);
  useEffect(() => {
    if (!ended) return;
    void queryClient.invalidateQueries({ queryKey: ["containers"] });
    void queryClient.invalidateQueries({ queryKey: stackDriftKey(hostId) });
  }, [ended, queryClient]);
  const start = useMutation({
    mutationFn: ({
      action,
      project,
      removeData,
      reconcile,
    }: {
      action: JobAction;
      project: string;
      removeData?: boolean;
      reconcile?: { revision: string };
    }) => askStackJob(hostId, action, project, removeData, reconcile),
    onSuccess: (started) => setJobId(started.id),
  });
  return {
    start,
    job: job.data ?? null,
    running: start.isPending || (jobId !== null && !ended),
    forget: () => setJobId(null),
  };
}

// Settings are shown with what looks like a password blanked out, until a person asks to see or edit them.
export const masked = (envText: string) =>
  envText
    .split("\n")
    .map((line) => {
      const match = ENV_LINE.exec(line);
      if (match === null || !SECRET_NAME.test(match[2]!) || match[3] === "") return line;
      return `${match[1]}${match[2]}=${text.hidden}`;
    })
    .join("\n");

function EnvFile({
  file,
  value,
  onChange,
  disabled,
}: {
  file: StackFile;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  const [shown, setShown] = useState(false);
  if (file.text === null && value === "" && !shown) {
    return (
      <p className="small muted compose-absent">
        {text.absent}{" "}
        {!disabled && (
          <button type="button" className="link" onClick={() => setShown(true)}>
            {text.addFile}
          </button>
        )}
      </p>
    );
  }
  const name = file.path.split("/").at(-1) ?? file.path;
  return (
    <div className="compose-env">
      {shown ? (
        <textarea
          className="mono compose-text"
          aria-label={name}
          value={value}
          readOnly={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <pre className="mono compose-text" aria-label={name}>
          {masked(value)}
        </pre>
      )}
      <button type="button" className="link small" onClick={() => setShown(!shown)}>
        {shown ? text.hide : `${text.show} / ${text.editable}`}
      </button>
    </div>
  );
}

function CheckLine({ check, checking }: { check: StackCheck | null; checking: boolean }) {
  if (checking && check === null) return <p className="small muted">{text.checking}</p>;
  if (check === null) return null;
  if (check.problem !== null) {
    return (
      <div role="alert">
        <p className="small text-danger">{text.notSaved}</p>
        <pre className="mono compose-problem">{check.problem}</pre>
      </div>
    );
  }
  const actions = [
    ...(check.recreate.length > 0 ? [text.willRecreate(check.recreate)] : []),
    ...(check.added.length > 0 ? [text.willAdd(check.added)] : []),
    ...(check.removed.length > 0 ? [text.willRemove(check.removed)] : []),
  ];
  return (
    <>
      <p className="small muted">
        <span className="install-tick">✓</span> {text.reads}
      </p>
      {check.warnings.map((warning) => (
        <p key={warning} className="small text-warning">
          {warning}
        </p>
      ))}
      <p className="compose-changes small" role="status">
        {actions.length === 0 ? (
          text.nothingToDo
        ) : (
          <>
            <strong>{text.applying}</strong> {actions.join(", ")}
            {check.unchanged.length > 0 && `. ${text.leftAlone(check.unchanged)}`}.
          </>
        )}
      </p>
    </>
  );
}

/**
 * A Compose app's real files, in place: edit, have the host's own Compose say what that would change, then save, or
 * save and recreate. Saving alone touches no container. A failed recreate shows why, and the last file is one click.
 */
export function ComposePanel({
  hostId,
  project,
  readOnly,
  onClose,
}: {
  hostId: string;
  project: string;
  readOnly: boolean;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const key = ["stack-files", hostId, project];
  const read = useQuery({
    queryKey: key,
    queryFn: () => askStack(hostId, project, { kind: STACK_ASK.read }),
    staleTime: 0,
    gcTime: 0,
  });
  const files = read.data?.files ?? null;
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const [check, setCheck] = useState<StackCheck | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stackJob = useStackJob(hostId);
  const textOf = (file: StackFile) => edits.get(file.path) ?? file.text ?? "";
  const edited: EditedStackFile[] = (files?.files ?? []).flatMap((file) =>
    edits.has(file.path) && edits.get(file.path) !== (file.text ?? "")
      ? [{ path: file.path, text: edits.get(file.path)!, hash: file.hash }]
      : [],
  );
  const changed = edited.length > 0;
  const asked = useMutation({
    mutationFn: (candidates: EditedStackFile[]) =>
      askStack(hostId, project, { kind: STACK_ASK.check, files: candidates }),
    onSuccess: (answer) => setCheck(answer.check ?? null),
  });
  const editedKey = JSON.stringify(edited);
  // What the files would do, as they stand: on opening too, as a file can already differ from what runs.
  useEffect(() => {
    if (files === null) return undefined;
    const timer = setTimeout(() => asked.mutate(edited), CHECK_DELAY_MILLISECONDS);
    return () => clearTimeout(timer);
  }, [editedKey, files === null]);
  const reload = () => queryClient.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: () => askStack(hostId, project, { kind: STACK_ASK.save, files: edited }),
  });
  const restore = useMutation({
    mutationFn: () => askStack(hostId, project, { kind: STACK_ASK.restore }),
    onSuccess: async (answer) => {
      if (answer.error !== null) return;
      setNote(text.putBackDone);
      stackJob.forget();
      setEdits(new Map());
      await reload();
    },
  });
  const saved = async () => {
    const answer = await save.mutateAsync();
    if (answer.error !== null) return false;
    setEdits(new Map());
    await reload();
    return true;
  };
  const saveOnly = async () => {
    if (await saved()) setNote(text.saved);
  };
  const saveAndRecreate = async () => {
    setNote(null);
    if (changed && !(await saved())) return;
    stackJob.start.mutate({ action: JOB_ACTION.stackUp, project });
  };
  if (read.isPending) return <p className="small muted compose-panel">{text.loading}</p>;
  if (read.error) return <ErrorNotice error={read.error} />;
  if (files === null) return <p className="small text-danger compose-panel">{read.data?.error}</p>;
  const canSave = !readOnly && check?.problem === null && !asked.isPending && !save.isPending;
  const job = stackJob.job;
  const failed = job !== null && job.status === JOB_STATUS.failed;
  const hasPrevious = files.files.some((file) => file.hasPrevious);
  return (
    <div className="compose-panel">
      <p className="small">
        <span className="mono">{text.title(files.folder)}</span> <span className="muted">· {text.real}</span>
      </p>
      <div className="compose-panes">
        {files.files.map((file) => {
          const name = file.path.startsWith(`${files.folder}/`) ? file.path.slice(files.folder.length + 1) : file.path;
          const isEdited = edited.some(({ path }) => path === file.path);
          const change = (next: string) => {
            setNote(null);
            setEdits(new Map(edits).set(file.path, next));
          };
          return (
            <div
              key={file.path}
              className={file.kind === STACK_FILE_KIND.compose ? "compose-pane wide" : "compose-pane"}
            >
              <div className="compose-pane-head mono small">
                {name}
                {isEdited && <span className="text-warning">{text.edited}</span>}
              </div>
              {file.kind === STACK_FILE_KIND.compose ? (
                <textarea
                  className="mono compose-text"
                  aria-label={name}
                  value={textOf(file)}
                  readOnly={readOnly}
                  spellCheck={false}
                  onChange={(event) => change(event.target.value)}
                />
              ) : (
                <EnvFile file={file} value={textOf(file)} onChange={change} disabled={readOnly} />
              )}
            </div>
          );
        })}
      </div>
      <div className="compose-actions">
        <CheckLine check={check} checking={asked.isPending} />
        {readOnly && <p className="small muted">{TEXT.stacks.readOnly}</p>}
        {note !== null && (
          <p className="small" role="status">
            {note}
          </p>
        )}
        {save.data?.error != null && <p className="small text-danger">{save.data.error}</p>}
        {restore.data?.error != null && <p className="small text-danger">{restore.data.error}</p>}
        {stackJob.running && <p className="small muted">{text.recreating}</p>}
        {job !== null && !isWaiting(job) && (
          <div role="status">
            <p className={failed ? "small text-danger" : "small"}>{job.outcome}</p>
            {failed && job.output !== null && <pre className="mono compose-problem">{job.output}</pre>}
          </div>
        )}
        <ErrorNotice error={asked.error ?? save.error ?? restore.error ?? stackJob.start.error} />
        {!readOnly && (
          <div className="compose-foot">
            {!changed && onClose !== undefined && (
              <button type="button" onClick={onClose}>
                {TEXT.stacks.update.cancel}
              </button>
            )}
            <span className="compose-grow" />
            {changed && (
              <button type="button" className="danger" onClick={() => setEdits(new Map())}>
                {text.discard}
              </button>
            )}
            {hasPrevious && (failed || !changed) && (
              <button type="button" disabled={restore.isPending || stackJob.running} onClick={() => restore.mutate()}>
                {text.putBack}
              </button>
            )}
            {files.builds && (
              <button
                type="button"
                disabled={stackJob.running || changed}
                onClick={() => stackJob.start.mutate({ action: JOB_ACTION.stackRebuild, project })}
              >
                {text.rebuild}
              </button>
            )}
            <button type="button" disabled={!changed || !canSave || stackJob.running} onClick={() => void saveOnly()}>
              {text.save}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canSave || stackJob.running}
              onClick={() => void saveAndRecreate()}
            >
              {changed ? text.saveAndRecreate : text.recreate}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
