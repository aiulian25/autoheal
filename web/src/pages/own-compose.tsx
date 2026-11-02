import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { API_ROUTES, apiPath, type HostView, type JobView } from "../../../src/shared/api.js";
import {
  firstServiceOf,
  hasBlockingIssue,
  lintOwnFiles,
  projectNameOf,
  withFix,
} from "../../../src/shared/compose-lint.js";
import { JOB_STATUS } from "../../../src/shared/constants.js";
import type { InstallAnswer } from "../../../src/shared/install.js";
import {
  OWN_FILE,
  OWN_ISSUE_LEVEL,
  type OwnCheck,
  type OwnCheckBody,
  type OwnIssue,
} from "../../../src/shared/own-compose.js";
import { api } from "../api-client.js";
import { CopyButton, ErrorNotice, PlainText } from "../components/common.js";
import { masked } from "../components/compose-panel.js";
import { isWaiting } from "../components/container-actions.js";
import { Progress } from "../components/install-progress.js";
import { useInstallJob } from "../components/take-away.js";
import { TEXT } from "../constants.js";

const text = TEXT.ownCompose;
const CHECK_DELAY_MILLISECONDS = 700;
const SECRET_BYTES = 24;
const STANDIN_NAME = "my-app";
const WARNING_ORDER = { [OWN_ISSUE_LEVEL.error]: 0, [OWN_ISSUE_LEVEL.warning]: 1 };
type FileKind = (typeof OWN_FILE)[keyof typeof OWN_FILE];

export interface OwnStart {
  compose: string;
  env: string;
  leftOut: readonly string[];
  converted: boolean;
}

// Only ever goes where a person pasting their own would: into their .env.
function makeSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const issueRank = (issue: OwnIssue) => WARNING_ORDER[issue.level] * 1_000_000 + (issue.line ?? 0);

/** A text box with its lines drawn behind it: numbered, marked where something is wrong, and saying what beside it. */
function CodeBox({
  label,
  value,
  placeholder,
  issues,
  onChange,
  box,
}: {
  label: string;
  value: string;
  placeholder: string;
  issues: readonly OwnIssue[];
  onChange: (next: string) => void;
  box: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const behind = useRef<HTMLDivElement>(null);
  const follow = (event: UIEvent<HTMLTextAreaElement>) => {
    if (behind.current === null) return;
    behind.current.scrollTop = event.currentTarget.scrollTop;
    behind.current.scrollLeft = event.currentTarget.scrollLeft;
  };
  const firstOn = (line: number) =>
    issues.filter((issue) => issue.line === line).toSorted((one, other) => issueRank(one) - issueRank(other))[0];
  return (
    <div className="own-code">
      <div className="own-behind" ref={behind} aria-hidden="true">
        {value.split("\n").map((line, index) => {
          const issue = firstOn(index + 1);
          return (
            <div key={index} className={issue === undefined ? "own-line" : `own-line ${issue.level}`}>
              <span className="own-number">{index + 1}</span>
              <span className="own-shadow">{line}</span>
              {issue !== undefined && <span className="own-said">{issue.message}</span>}
            </div>
          );
        })}
      </div>
      <textarea
        ref={box}
        className="own-text"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        wrap="off"
        spellCheck={false}
        autoFocus
        autoComplete="off"
        onScroll={follow}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function IssueRow({ issue, onGo, onFix }: { issue: OwnIssue; onGo: () => void; onFix: () => void }) {
  const place = issue.file === OWN_FILE.env ? text.envLine : text.line;
  return (
    <div className={`own-issue ${issue.level}`}>
      <div className="own-issue-head">
        {issue.line !== null && (
          <button type="button" className="link" title={text.goTo(issue.line)} onClick={onGo}>
            {place(issue.line)}
          </button>
        )}
        {issue.fix !== null && (
          <button type="button" className="add-container" onClick={onFix}>
            {issue.fix.label}
          </button>
        )}
      </div>
      <p>{issue.message}</p>
    </div>
  );
}

function Plan({ check, folder, hasEnv }: { check: OwnCheck; folder: string; hasEnv: boolean }) {
  const { plan } = check;
  if (plan === null) return null;
  return (
    <div className="own-plan">
      <strong>{text.willCreate}</strong>
      <span className="mono">{`${folder}/docker-compose.yml`}</span>
      {hasEnv && <span className="mono">{`${folder}/.env`}</span>}
      {plan.containers.map((name) => (
        <span key={name}>{text.container(name)}</span>
      ))}
      {plan.networks.map((name) => (
        <span key={name}>{text.network(name)}</span>
      ))}
      {plan.volumes.map((name) => (
        <span key={name}>{text.volume(name)}</span>
      ))}
    </div>
  );
}

function Finished({
  host,
  job,
  name,
  folder,
  port,
  onBack,
  onRetry,
  onClose,
}: {
  host: HostView;
  job: JobView;
  name: string;
  folder: string;
  port: number | null;
  onBack: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const succeeded = job.status === JOB_STATUS.succeeded;
  const address = host.health?.address ?? null;
  const command = text.command(folder);
  return (
    <>
      <h2>{text.doneTitle(name, host.label)}</h2>
      <div className="connect-host-body install-body">
        <p className={succeeded ? "install-done" : "install-failed"} role="status">
          {succeeded ? text.running(name) : text.failed(name)}
        </p>
        {!succeeded && job.outcome !== null && <p className="small">{job.outcome}</p>}
        {!succeeded && job.output !== null && <PlainText text={job.output} />}
        {!succeeded && <p className="small muted">{text.failedNote}</p>}
        {succeeded && (
          <>
            <div className="own-file">
              <span className="mono">{`${folder}/docker-compose.yml`}</span>
              <span className="muted small">{text.asWritten}</span>
            </div>
            <div className="own-file">
              <span className="mono">{`${folder}/.env`}</span>
              <span className="muted small">{text.envOwner}</span>
            </div>
            <div className="own-yours">
              <strong>{text.yours}</strong>
              <ul>
                <li>
                  {text.fromTerminal} <span className="mono">{command}</span> <CopyButton text={command} />
                </li>
                <li>{text.otherManagers}</li>
                <li>{text.editAnywhere}</li>
                <li>{text.leaveAutoheal}</li>
              </ul>
            </div>
          </>
        )}
      </div>
      <div className="connect-host-foot">
        {!succeeded && (
          <>
            <button type="button" className="primary" onClick={onBack}>
              {text.backToFiles}
            </button>
            <button type="button" onClick={onRetry}>
              {text.tryAgain}
            </button>
          </>
        )}
        <button type="button" onClick={onClose}>
          {text.close}
        </button>
        {succeeded && address !== null && port !== null && (
          <a className="button primary" href={`http://${address}:${port}`} target="_blank" rel="noopener noreferrer">
            {text.open(name)}
          </a>
        )}
      </div>
    </>
  );
}

function Running({
  host,
  started,
  name,
  onEnded,
  onClose,
}: {
  host: HostView;
  started: JobView;
  name: string;
  onEnded: (job: JobView) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useInstallJob(host.id, started)!;
  const waiting = isWaiting(job);
  useEffect(() => {
    if (waiting) return;
    void queryClient.invalidateQueries();
    onEnded(job);
  }, [waiting]);
  return (
    <>
      <h2>{text.installingTitle(name, host.label)}</h2>
      <div className="connect-host-body install-body">
        <Progress job={job} />
        <p className="small muted">{text.canClose}</p>
      </div>
      <div className="connect-host-foot">
        <button type="button" onClick={onClose}>
          {text.close}
        </button>
      </div>
    </>
  );
}

/**
 * A person's own Compose file and .env: read by the host's real Compose as they type, every problem at its line, and
 * written exactly as shown to an ordinary folder. Nothing of them is kept here, so any other tool can take over.
 */
export function OwnComposeEditor({
  host,
  start,
  onGuided,
  guidedBusy,
  guidedRefusal,
  onClose,
}: {
  host: HostView;
  start: OwnStart;
  onGuided: (compose: string) => void;
  guidedBusy: boolean;
  guidedRefusal: string | null;
  onClose: () => void;
}) {
  const [compose, setCompose] = useState(start.compose);
  const [env, setEnv] = useState(start.env);
  const [tab, setTab] = useState<FileKind>(OWN_FILE.compose);
  const [envShown, setEnvShown] = useState(start.env === "");
  const [parent, setParent] = useState<string | null>(null);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [check, setCheck] = useState<OwnCheck | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The install that failed, for a second try at it in the same folder.
  const [failed, setFailed] = useState<{ jobId: string; folder: string | null } | null>(null);
  const [started, setStarted] = useState<JobView | null>(null);
  const [ended, setEnded] = useState<JobView | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const asked = useRef(0);
  const name = typedName ?? projectNameOf(`/${firstServiceOf(compose) ?? STANDIN_NAME}`);
  const folder = parent === null ? null : `${parent}/${name}`;
  const retryOf = failed !== null && failed.folder === folder ? failed.jobId : null;
  const key = JSON.stringify([compose, env, folder, retryOf]);
  const body: OwnCheckBody = { own: true, folder, compose, env, retryOf };

  const ask = useMutation({
    mutationFn: (files: OwnCheckBody) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallOwnCheck, { hostId: host.id }), files),
  });
  useEffect(() => {
    if (compose.trim() === "") {
      setCheck(null);
      setCheckedKey(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      asked.current += 1;
      const mine = asked.current;
      ask.mutate(body, {
        onSuccess: (answer) => {
          if (mine !== asked.current) return;
          setProblem(answer.error);
          if (answer.own == null) return;
          setCheck(answer.own);
          setCheckedKey(key);
          setParent((known) => known ?? answer.own!.parent);
        },
      });
    }, CHECK_DELAY_MILLISECONDS);
    return () => window.clearTimeout(timer);
  }, [key]);

  const install = useMutation({
    mutationFn: () =>
      api<JobView>("POST", apiPath(API_ROUTES.hostInstallOwn, { hostId: host.id }), { ...body, folder }),
    onSuccess: (job) => {
      setEnded(null);
      setStarted(job);
    },
  });

  const finish = (job: JobView) => {
    setEnded(job);
    if (job.status === JOB_STATUS.failed) setFailed({ jobId: job.id, folder });
  };

  const lint = useMemo(() => lintOwnFiles(compose, env), [compose, env]);
  const unreadable = check !== null && !check.readable;
  const issues = (unreadable ? (check?.issues ?? []) : [...(check?.issues ?? []), ...lint]).toSorted(
    (one, other) => issueRank(one) - issueRank(other),
  );
  const errors = issues.filter(({ level }) => level === OWN_ISSUE_LEVEL.error).length;
  const warnings = issues.length - errors;
  const current = checkedKey === key && check !== null;
  const canInstall =
    current && check.readable && !hasBlockingIssue(issues) && folder !== null && name !== "" && !install.isPending;

  const goTo = (issue: OwnIssue) => {
    setTab(issue.file);
    if (issue.file === OWN_FILE.env) setEnvShown(true);
    if (issue.line === null) return;
    const line = issue.line;
    // Once the right file is showing.
    window.setTimeout(() => {
      const area = box.current;
      if (area === null) return;
      const lines = area.value.split("\n");
      const from = lines.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
      area.focus();
      area.setSelectionRange(from, from + (lines[line - 1]?.length ?? 0));
      const height = Number.parseFloat(getComputedStyle(area).lineHeight);
      if (!Number.isNaN(height)) area.scrollTop = Math.max(0, (line - 3) * height);
    });
  };
  const applyFix = (issue: OwnIssue) => {
    if (issue.fix === null) return;
    const fixed = withFix({ compose, env }, issue.fix, makeSecret);
    setCompose(fixed.compose);
    setEnv(fixed.env);
  };
  const generate = () => {
    const area = box.current;
    const value = makeSecret();
    if (area === null) {
      setEnv(`${env}${value}`);
      return;
    }
    setEnv(`${env.slice(0, area.selectionStart)}${value}${env.slice(area.selectionEnd)}`);
  };

  if (started !== null && ended === null) {
    return <Running host={host} started={started} name={name} onEnded={finish} onClose={onClose} />;
  }
  if (ended !== null && folder !== null) {
    return (
      <Finished
        host={host}
        job={ended}
        name={name}
        folder={folder}
        port={check?.plan?.port ?? null}
        onBack={() => {
          setStarted(null);
          setEnded(null);
        }}
        onRetry={() => install.mutate()}
        onClose={onClose}
      />
    );
  }
  const status = () => {
    if (errors > 0) return { kind: "error", words: text.statusFix(errors) };
    if (!current) return { kind: "", words: text.statusWaiting };
    if (folder === null) return { kind: "warning", words: text.statusFolder };
    if (warnings > 0) return { kind: "warning", words: text.statusKnow(warnings) };
    return { kind: "clear", words: text.statusReady };
  };
  const said = status();
  let headClass = "clear";
  if (errors > 0) headClass = "error";
  else if (warnings > 0) headClass = "warning";
  return (
    <>
      <h2>{text.title(host.label)}</h2>
      <div className="own-fields">
        <label>
          {text.name}
          <input
            className="mono"
            value={name}
            spellCheck={false}
            onChange={(event) => setTypedName(projectNameOf(`/${event.target.value}`))}
          />
        </label>
        <label>
          {text.folder}
          <input
            className="mono own-folder"
            value={parent ?? ""}
            placeholder={text.folderPlaceholder}
            spellCheck={false}
            onChange={(event) => setParent(event.target.value.replace(/\/+$/, ""))}
          />
          <span className="mono muted">{`/${name}`}</span>
        </label>
        {check?.parentProjects != null && <span className="small muted">{text.likeApps(check.parentProjects)}</span>}
      </div>
      {(start.converted || start.leftOut.length > 0) && (
        <p className="own-notes small muted">
          {start.converted && text.convertedNote} {start.leftOut.length > 0 && text.leftOut(start.leftOut.join(", "))}
        </p>
      )}
      <div className="own-grid">
        <div className="own-pane">
          <div className="own-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === OWN_FILE.compose}
              onClick={() => setTab(OWN_FILE.compose)}
            >
              {text.composeFile}
            </button>
            <button type="button" role="tab" aria-selected={tab === OWN_FILE.env} onClick={() => setTab(OWN_FILE.env)}>
              {text.envFile}
            </button>
          </div>
          {tab === OWN_FILE.compose && (
            <CodeBox
              label={text.composeFile}
              value={compose}
              placeholder={text.placeholder}
              issues={issues.filter(({ file }) => file === OWN_FILE.compose)}
              onChange={setCompose}
              box={box}
            />
          )}
          {tab === OWN_FILE.env && envShown && (
            <CodeBox
              label={text.envFile}
              value={env}
              placeholder={text.envPlaceholder}
              issues={issues.filter(({ file }) => file === OWN_FILE.env)}
              onChange={setEnv}
              box={box}
            />
          )}
          {tab === OWN_FILE.env && !envShown && (
            <pre className="mono own-masked" aria-label={text.envFile}>
              {masked(env)}
            </pre>
          )}
          {tab === OWN_FILE.env && (
            <div className="own-env-bar">
              <button type="button" className="link small" onClick={() => setEnvShown(!envShown)}>
                {envShown ? text.hide : text.show}
              </button>
              {envShown && (
                <button type="button" className="add-container" onClick={generate}>
                  {text.generate}
                </button>
              )}
              <span className="small muted">{text.envNote}</span>
            </div>
          )}
        </div>
        <aside className="own-side" aria-live="polite">
          {issues.length > 0 && <h3 className={headClass}>{text.toFix(errors, warnings)}</h3>}
          {issues.length === 0 && current && <h3 className="clear">{text.allClear}</h3>}
          {issues.map((issue, index) => (
            <IssueRow
              key={`${issue.file}-${issue.line}-${index}`}
              issue={issue}
              onGo={() => goTo(issue)}
              onFix={() => applyFix(issue)}
            />
          ))}
          {unreadable && <p className="small muted">{text.unreadable}</p>}
          {!current && compose.trim() !== "" && <p className="small muted">{text.checking}</p>}
          {problem !== null && (
            <p className="notice warning small" role="alert">
              {problem}
            </p>
          )}
          {guidedRefusal !== null && (
            <p className="notice warning small" role="alert">
              {guidedRefusal}
            </p>
          )}
          <ErrorNotice error={ask.error ?? install.error} />
          {current && check.readable && errors === 0 && folder !== null && (
            <>
              <span className="small">✓ {text.readsOk}</span>
              <Plan check={check} folder={folder} hasEnv={env !== ""} />
            </>
          )}
          <p className="small muted">{text.by(host.label)}</p>
        </aside>
      </div>
      <div className="own-foot">
        <span className={`own-status small ${said.kind}`} role="status">
          {said.words}
        </span>
        <button
          type="button"
          className="quiet"
          disabled={guidedBusy || compose.trim() === ""}
          onClick={() => onGuided(compose)}
        >
          {text.guided}
        </button>
        <button type="button" className="primary" disabled={!canInstall} onClick={() => install.mutate()}>
          {text.install}
        </button>
      </div>
    </>
  );
}
