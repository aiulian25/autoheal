import { PolicyRehearsal } from "../components/policy-rehearsal.js";
import { OperatorGrants } from "../components/operator-grants.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  API_ROUTES,
  AUDIT_QUERY,
  apiPath,
  type AccountView,
  type AuditEventView,
  type CreatedAccountView,
  type PromptSnapshotView,
  type OllamaSettingsView,
  type ReplayRunView,
  type RunbookSuggestionView,
  type RunbookView,
  type TemporaryPasswordView,
} from "../../../src/shared/api.js";
import {
  REPLAY_DEFAULT_INCIDENTS,
  REPLAY_FINISHED,
  REPLAY_MAXIMUM_INCIDENTS,
  REPLAY_RUNNING,
  ROLE_ADMIN,
  ROLE_VIEWER,
  ROLES,
  RUNBOOK_CHARACTER_LIMIT,
  RUNBOOK_SCOPE_GLOBAL,
  RUNBOOK_SCOPES,
  USER_STATUS_ACTIVE,
  USER_STATUS_DEACTIVATED,
  USERNAME_PATTERN,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import {
  Badge,
  ErrorNotice,
  Loading,
  PageHeader,
  PlainText,
  TimeAgo,
  prettyJson,
  rowClick,
} from "../components/common.js";
import { incidentLink } from "../components/incident-parts.js";
import { HistoryTabs, RulesTabs, SettingsSubpage } from "../components/section-tabs.js";
import { PATHS, REPLAY_REFRESH_MILLISECONDS, SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { actionText, dateTime } from "../format.js";
import { ollamaQuery, ollamaSettingsQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";

const runbookLink = (runbookId: string) => apiPath(PATHS.runbook, { runbookId });
const replayLink = (replayId: string) => apiPath(PATHS.replay, { replayId });
const scopeOf = (runbook: RunbookView) =>
  `${TEXT.runbooks.scopes[runbook.scope]}${runbook.pattern ? `: ${runbook.pattern}` : ""}`;

function RunbookBadge({ runbook }: { runbook: RunbookView }) {
  if (runbook.archived) {
    return <Badge value={TEXT.runbooks.archived} />;
  }
  const published = runbook.publishedVersion !== null;
  return <Badge value={TEXT.runbooks.published(runbook.publishedVersion)} tone={published ? "good" : "neutral"} />;
}

function CharacterCount({ text }: { text: string }) {
  const tooLong = text.length > RUNBOOK_CHARACTER_LIMIT;
  return (
    <span className={tooLong ? "small notice error" : "small muted"}>
      {TEXT.runbooks.characters(text.length, RUNBOOK_CHARACTER_LIMIT)}
    </span>
  );
}

// Where a suggestion stands: not drafted yet, drafted and tried, or being tried now.
function SuggestionState({
  suggestion,
  busy,
  onDraft,
}: {
  suggestion: RunbookSuggestionView;
  busy: boolean;
  onDraft: () => void;
}) {
  const text = TEXT.runbooks.suggested;
  if (suggestion.replay?.status === REPLAY_RUNNING) {
    return (
      <p className="small muted" role="status">
        {text.trying}
      </p>
    );
  }
  const tried =
    suggestion.replay === null ? text.notTried : text.matched(suggestion.replay.matched, suggestion.replay.incidents);
  return (
    <p className="small suggestion-state">
      {suggestion.runbookId !== null && <span>{tried}</span>}
      <button type="button" disabled={busy} onClick={onDraft}>
        {suggestion.runbookId === null ? text.makeDraft : text.tryAgain}
      </button>
      {suggestion.runbookId !== null && <Link to={runbookLink(suggestion.runbookId)}>{text.openDraft}</Link>}
    </p>
  );
}

// Recurring escalations a runbook could answer: each drafted and tried only when an admin asks.
function SuggestedRunbooks() {
  const queryClient = useQueryClient();
  const suggestions = useQuery({
    queryKey: ["runbook-suggestions"],
    queryFn: () => api<RunbookSuggestionView[]>("GET", API_ROUTES.runbookSuggestions),
    refetchInterval: (current) =>
      current.state.data?.some((suggestion) => suggestion.replay?.status === REPLAY_RUNNING)
        ? REPLAY_REFRESH_MILLISECONDS
        : false,
  });
  const draft = useMutation({
    mutationFn: (key: string) =>
      api<RunbookSuggestionView>("POST", apiPath(API_ROUTES.runbookSuggestionDraft, { key })),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["runbook-suggestions"] });
      void queryClient.invalidateQueries({ queryKey: ["runbooks"] });
    },
  });
  const text = TEXT.runbooks.suggested;
  if (suggestions.data === undefined || suggestions.data.length === 0) {
    return <ErrorNotice error={suggestions.error} />;
  }
  return (
    <section className="card" aria-labelledby="suggested-title">
      <h2 id="suggested-title">{text.title}</h2>
      <p className="muted small">{text.explanation}</p>
      <ul className="plain-list suggestions">
        {suggestions.data.map((suggestion) => (
          <li key={suggestion.key} className="stack">
            <strong>{suggestion.title}</strong>
            <span className="small muted">
              {text.escalated(suggestion.hostLabel, suggestion.incidents.length)}{" "}
              {suggestion.incidents.map((incident, index) => (
                <span key={incident.id}>
                  {index > 0 && TEXT.listComma}
                  <Link to={incidentLink(incident.id)}>{dateTime(incident.detectedAt)}</Link>
                </span>
              ))}
            </span>
            <SuggestionState
              suggestion={suggestion}
              busy={draft.isPending}
              onDraft={() => draft.mutate(suggestion.key)}
            />
          </li>
        ))}
      </ul>
      <ErrorNotice error={draft.error} />
    </section>
  );
}

export function RunbooksPage() {
  const session = useSignedInSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<string>(RUNBOOK_SCOPES[0]);
  const runbooks = useQuery({ queryKey: ["runbooks"], queryFn: () => api<RunbookView[]>("GET", API_ROUTES.runbooks) });
  const create = useMutation({
    mutationFn: (draft: Record<string, string | undefined>) => api<RunbookView>("POST", API_ROUTES.runbooks, draft),
    onSuccess: async (runbook) => {
      await queryClient.invalidateQueries({ queryKey: ["runbooks"] });
      void navigate(runbookLink(runbook.id));
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const pattern = String(form.get("pattern") ?? "").trim();
    create.mutate({ scope, title: String(form.get("title") ?? ""), body, pattern: pattern || undefined });
  };
  return (
    <div className="page">
      <PageHeader title={TEXT.nav.rules} lede={TEXT.runbooks.explanation} />
      <RulesTabs />
      {runbooks.data === undefined && <Loading />}
      {runbooks.data?.length === 0 && <p className="muted">{TEXT.runbooks.empty}</p>}
      {runbooks.data !== undefined && runbooks.data.length > 0 && (
        <ul className="card list-card">
          {runbooks.data.map((runbook) => (
            <li key={runbook.id}>
              <span className="list-card-what">
                <Link to={runbookLink(runbook.id)}>{runbook.title}</Link>
                <span className="muted small">{scopeOf(runbook)}</span>
              </span>
              <RunbookBadge runbook={runbook} />
            </li>
          ))}
        </ul>
      )}
      {isAdmin(session) && <SuggestedRunbooks />}
      {isAdmin(session) && (
        <form className="card" onSubmit={submit}>
          <h2>{TEXT.runbooks.create}</h2>
          <label>
            {TEXT.runbooks.titleLabel}
            <input name="title" required />
          </label>
          <label>
            {TEXT.runbooks.scope}
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              {RUNBOOK_SCOPES.map((value) => (
                <option key={value} value={value}>
                  {TEXT.runbooks.scopes[value]}
                </option>
              ))}
            </select>
          </label>
          {scope !== RUNBOOK_SCOPE_GLOBAL && (
            <label>
              {TEXT.runbooks.pattern}
              <input name="pattern" required />
            </label>
          )}
          <label>
            {TEXT.runbooks.body}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} required />
          </label>
          <CharacterCount text={body} />
          <ErrorNotice error={create.error} />
          <button className="primary" type="submit" disabled={create.isPending}>
            {TEXT.runbooks.create}
          </button>
        </form>
      )}
      <ErrorNotice error={runbooks.error} />
    </div>
  );
}

export function RunbookDetailPage() {
  const session = useSignedInSession();
  const { runbookId = "" } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<string | null>(null);
  const runbook = useQuery({
    queryKey: ["runbooks", runbookId],
    queryFn: () => api<RunbookView>("GET", apiPath(API_ROUTES.runbook, { runbookId })),
  });
  const refresh = (view: RunbookView) => {
    queryClient.setQueryData(["runbooks", runbookId], view);
    void queryClient.invalidateQueries({ queryKey: ["runbooks"], exact: true });
  };
  const save = useMutation({
    mutationFn: (body: string) =>
      api<RunbookView>("POST", apiPath(API_ROUTES.runbookVersions, { runbookId }), { body }),
    onSuccess: (view) => {
      refresh(view);
      setDraft(null);
    },
  });
  const publish = useMutation({
    mutationFn: (versionId: string) =>
      api<RunbookView>("POST", apiPath(API_ROUTES.runbookPublish, { runbookId, versionId })),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: () => api<RunbookView>("POST", apiPath(API_ROUTES.runbookArchive, { runbookId })),
    onSuccess: refresh,
  });
  const replay = useMutation({
    mutationFn: (versionId: string) => api<ReplayRunView>("POST", API_ROUTES.replays, { draftVersionIds: [versionId] }),
    onSuccess: (run) => void navigate(replayLink(run.id)),
  });
  if (runbook.data === undefined) {
    return runbook.error ? <ErrorNotice error={runbook.error} /> : <Loading />;
  }
  const view = runbook.data;
  const latest = view.versions[view.versions.length - 1];
  const admin = isAdmin(session);
  const editing = draft ?? latest?.body ?? "";
  return (
    <div className="page">
      <nav className="crumbs" aria-label={TEXT.rules.trail}>
        <Link to={PATHS.runbooks}>{TEXT.rules.runbooks}</Link>
        <span aria-hidden>/</span>
        <span aria-current="page">{view.title}</span>
      </nav>
      <PageHeader title={view.title} lede={scopeOf(view)}>
        <RunbookBadge runbook={view} />
      </PageHeader>
      <section className="section">
        <h2>{TEXT.runbooks.versions}</h2>
        {[...view.versions].reverse().map((version) => (
          <div key={version.id} className="card">
            <div className="row">
              <strong>v{version.version}</strong>
              <span className="muted small">
                {version.createdBy}
                {TEXT.separator}
                <TimeAgo timestamp={version.createdAt} />
              </span>
              {version.publishedAt !== null && <Badge value={TEXT.runbooks.published(version.version)} />}
            </div>
            <PlainText text={version.body} />
            {admin && !view.archived && (
              <div className="row">
                {version.publishedAt === null && (
                  <button type="button" className="primary" onClick={() => publish.mutate(version.id)}>
                    {TEXT.runbooks.publish}
                  </button>
                )}
                <button type="button" onClick={() => replay.mutate(version.id)}>
                  {TEXT.runbooks.tryIt}
                </button>
              </div>
            )}
          </div>
        ))}
      </section>
      {admin && !view.archived && (
        <section className="card">
          <h2>{TEXT.runbooks.newVersion}</h2>
          <textarea
            aria-label={TEXT.runbooks.body}
            value={editing}
            onChange={(event) => setDraft(event.target.value)}
          />
          <CharacterCount text={editing} />
          <div className="row">
            <button type="button" className="primary" onClick={() => save.mutate(editing)} disabled={save.isPending}>
              {TEXT.runbooks.newVersion}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => window.confirm(TEXT.runbooks.archiveConfirm(view.title)) && archive.mutate()}
            >
              {TEXT.runbooks.archive}
            </button>
          </div>
        </section>
      )}
      <ErrorNotice error={save.error ?? publish.error ?? archive.error ?? replay.error} />
    </div>
  );
}

/**
 * A replay to start: with the model in use or another the same Ollama has, over that many recent incidents.
 * Live decisions keep their model meanwhile.
 */
function StartReplay() {
  const navigate = useNavigate();
  const ollama = useQuery(ollamaQuery);
  const start = useMutation({
    mutationFn: (body: { incidentCount: number; modelName?: string }) =>
      api<ReplayRunView>("POST", API_ROUTES.replays, body),
    onSuccess: (run) => void navigate(replayLink(run.id)),
  });
  const current = ollama.data?.model ?? null;
  const others = (ollama.data?.models ?? []).map((model) => model.name).filter((name) => name !== current);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const chosen = String(values.get("model") ?? "");
    const another = chosen !== "" && chosen !== current;
    start.mutate({ incidentCount: Number(values.get("incidentCount")), ...(another ? { modelName: chosen } : {}) });
  };
  return (
    <form className="replay-start" onSubmit={submit}>
      <label>
        {TEXT.replays.model}
        <select name="model" defaultValue={current ?? ""}>
          {current !== null && <option value={current}>{TEXT.replays.inUse(current)}</option>}
          {others.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {TEXT.replays.incidents}
        <input
          name="incidentCount"
          type="number"
          required
          min={1}
          max={REPLAY_MAXIMUM_INCIDENTS}
          defaultValue={REPLAY_DEFAULT_INCIDENTS}
        />
      </label>
      <button type="submit" className="primary" disabled={start.isPending}>
        {TEXT.replays.run}
      </button>
      <ErrorNotice error={start.error} />
    </form>
  );
}

export function ReplaysPage() {
  const session = useSignedInSession();
  const navigate = useNavigate();
  const replays = useQuery({ queryKey: ["replays"], queryFn: () => api<ReplayRunView[]>("GET", API_ROUTES.replays) });
  return (
    <div className="page">
      <PageHeader title={TEXT.nav.rules} lede={TEXT.replays.explanation}>
        {isAdmin(session) && <StartReplay />}
      </PageHeader>
      <RulesTabs />
      <PolicyRehearsal admin={isAdmin(session)} />
      {replays.data === undefined && <Loading />}
      {replays.data?.length === 0 && <p className="muted">{TEXT.replays.empty}</p>}
      {replays.data !== undefined && replays.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.replays.started}</th>
                <th>{TEXT.replays.by}</th>
                <th>{TEXT.replays.model}</th>
                <th>{TEXT.replays.status}</th>
                <th>{TEXT.replays.changed}</th>
              </tr>
            </thead>
            <tbody>
              {replays.data.map((run) => (
                <tr key={run.id} className="clickable" onClick={rowClick(() => void navigate(replayLink(run.id)))}>
                  <td>
                    <Link to={replayLink(run.id)}>
                      <TimeAgo timestamp={run.createdAt} />
                    </Link>
                  </td>
                  <td>{run.createdBy}</td>
                  <td className="mono small">{run.modelName}</td>
                  <td>
                    <Badge value={run.status} />
                  </td>
                  <td>
                    {run.changedCount} / {run.incidentCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNotice error={replays.error} />
    </div>
  );
}

/** A finished replay with another model: that model for live decisions from now on, through the Ollama card's checks. */
function UseThisModel({ modelName }: { modelName: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery(ollamaSettingsQuery);
  const use = useMutation({
    mutationFn: (view: OllamaSettingsView) =>
      api("PUT", API_ROUTES.ollamaSettings, { url: view.url, model: modelName, contextTokens: view.contextTokens }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ollamaSettingsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: ollamaQuery.queryKey });
    },
  });
  const view = settings.data;
  if (view === undefined) {
    return null;
  }
  if (view.model === modelName) {
    return use.isSuccess ? <p className="notice success">{TEXT.replays.modelInUse}</p> : null;
  }
  return (
    <div className="row">
      <button type="button" className="primary" disabled={use.isPending} onClick={() => use.mutate(view)}>
        {TEXT.replays.useModel(modelName)}
      </button>
      <ErrorNotice error={use.error} />
    </div>
  );
}

export function ReplayDetailPage() {
  const { replayId = "" } = useParams();
  const admin = isAdmin(useSignedInSession());
  const replay = useQuery({
    queryKey: ["replays", replayId],
    queryFn: () => api<ReplayRunView>("GET", apiPath(API_ROUTES.replay, { replayId })),
    refetchInterval: (query) => (query.state.data?.status === REPLAY_RUNNING ? REPLAY_REFRESH_MILLISECONDS : false),
  });
  if (replay.data === undefined) {
    return replay.error ? <ErrorNotice error={replay.error} /> : <Loading />;
  }
  const run = replay.data;
  return (
    <div className="page">
      <nav className="crumbs" aria-label={TEXT.rules.trail}>
        <Link to={PATHS.replays}>{TEXT.rules.replays}</Link>
      </nav>
      <PageHeader
        title={TEXT.replays.title}
        lede={
          <>
            {run.createdBy}
            {TEXT.separator}
            <TimeAgo timestamp={run.createdAt} />
            {TEXT.separator}
            {run.modelName}
            {TEXT.separator}
            {run.changedCount} / {run.incidentCount} {TEXT.replays.changed.toLowerCase()}
          </>
        }
      >
        <Badge value={run.status} />
      </PageHeader>
      {run.status === REPLAY_RUNNING && <p className="muted">{TEXT.replays.running}</p>}
      {admin && run.status === REPLAY_FINISHED && <UseThisModel modelName={run.modelName} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{TEXT.incidents.container}</th>
              <th>{TEXT.replays.original}</th>
              <th>{TEXT.replays.now}</th>
              <th>{TEXT.incident.diagnosis}</th>
            </tr>
          </thead>
          <tbody>
            {run.results.map((result) => (
              <tr key={result.incidentId}>
                <td>
                  <Link to={apiPath(PATHS.incident, { incidentId: result.incidentId })}>{result.containerName}</Link>
                </td>
                <td>{actionText(result.originalAction, result.originalTarget)}</td>
                <td>
                  {result.changed ? (
                    <Badge value={actionText(result.replayAction, result.replayTarget)} />
                  ) : (
                    actionText(result.replayAction, result.replayTarget)
                  )}
                </td>
                <td className="small">{result.error ?? result.replayDiagnosis ?? TEXT.none}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UsersPage() {
  const session = useSignedInSession();
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<{ username: string; password: string } | null>(null);
  const accounts = useQuery({ queryKey: ["users"], queryFn: () => api<AccountView[]>("GET", API_ROUTES.users) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });
  const create = useMutation({
    mutationFn: (account: { username: string; role: string }) =>
      api<CreatedAccountView>("POST", API_ROUTES.users, account),
    onSuccess: (created) => {
      setRevealed({ username: created.account.username, password: created.temporaryPassword });
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ userId, change }: { userId: string; change: Record<string, string> }) =>
      api("PATCH", apiPath(API_ROUTES.user, { userId }), change),
    onSuccess: refresh,
  });
  const resetPassword = useMutation({
    mutationFn: (account: AccountView) =>
      api<TemporaryPasswordView>("POST", apiPath(API_ROUTES.userResetPassword, { userId: account.id })),
    onSuccess: (view, account) => setRevealed({ username: account.username, password: view.temporaryPassword }),
  });
  const resetTotp = useMutation({
    mutationFn: (userId: string) => api("POST", apiPath(API_ROUTES.userResetTotp, { userId })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api("DELETE", apiPath(API_ROUTES.user, { userId })),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({ username: String(form.get("username") ?? ""), role: String(form.get("role") ?? ROLE_VIEWER) });
    event.currentTarget.reset();
  };
  return (
    <SettingsSubpage current={SETTINGS_SECTIONS.people} title={TEXT.users.title} lede={TEXT.users.lede}>
      {revealed !== null && (
        <div className="notice warning stack" role="status">
          <strong>{TEXT.users.temporaryPassword(revealed.username)}</strong>
          <span className="secret">{revealed.password}</span>
          <span>{TEXT.users.temporaryExplanation}</span>
        </div>
      )}
      {accounts.data === undefined && <Loading />}
      {accounts.data !== undefined && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.users.username}</th>
                <th>{TEXT.users.role}</th>
                <th>{TEXT.users.status}</th>
                <th>{TEXT.users.totp}</th>
                <th>{TEXT.users.lastLogin}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.data.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.username}</strong>
                    {account.id === session.user.id && <span className="muted small">{TEXT.users.you}</span>}
                    {account.role === ROLE_VIEWER && <OperatorGrants userId={account.id} username={account.username} />}
                  </td>
                  <td>{account.role}</td>
                  <td>
                    <Badge value={account.status} />
                  </td>
                  <td>{account.totpEnabled ? TEXT.yes : TEXT.no}</td>
                  <td>
                    <TimeAgo timestamp={account.lastLoginAt} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        onClick={() =>
                          update.mutate({
                            userId: account.id,
                            change: { role: account.role === ROLE_ADMIN ? ROLE_VIEWER : ROLE_ADMIN },
                          })
                        }
                      >
                        {account.role === ROLE_ADMIN ? TEXT.users.makeViewer : TEXT.users.makeAdmin}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          update.mutate({
                            userId: account.id,
                            change: {
                              status:
                                account.status === USER_STATUS_ACTIVE ? USER_STATUS_DEACTIVATED : USER_STATUS_ACTIVE,
                            },
                          })
                        }
                      >
                        {account.status === USER_STATUS_ACTIVE ? TEXT.users.deactivate : TEXT.users.reactivate}
                      </button>
                      <button type="button" onClick={() => resetPassword.mutate(account)}>
                        {TEXT.users.resetPassword}
                      </button>
                      <button type="button" onClick={() => resetTotp.mutate(account.id)}>
                        {TEXT.users.resetTotp}
                      </button>
                      <button
                        type="button"
                        className="quiet danger"
                        onClick={() =>
                          window.confirm(TEXT.users.removeConfirm(account.username)) && remove.mutate(account.id)
                        }
                      >
                        {TEXT.users.remove}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="card" onSubmit={submit}>
        <h3>{TEXT.users.create}</h3>
        <div className="inline-form">
          <label>
            {TEXT.users.username}
            <input name="username" required pattern={USERNAME_PATTERN.source} />
          </label>
          <label>
            {TEXT.users.role}
            <select name="role" defaultValue={ROLE_VIEWER}>
              {ROLES.map((role) => (
                <option key={role}>{role}</option>
              ))}
            </select>
          </label>
          <button className="primary" type="submit" disabled={create.isPending}>
            {TEXT.users.create}
          </button>
        </div>
      </form>
      <ErrorNotice
        error={accounts.error ?? create.error ?? update.error ?? resetPassword.error ?? resetTotp.error ?? remove.error}
      />
    </SettingsSubpage>
  );
}

const auditPage = (before: AuditEventView | undefined) =>
  before === undefined
    ? API_ROUTES.audit
    : `${API_ROUTES.audit}?${new URLSearchParams({ [AUDIT_QUERY.before]: String(before.occurredAt), [AUDIT_QUERY.beforeId]: before.id })}`;

export function AuditLogPage() {
  const [before, setBefore] = useState<AuditEventView | undefined>(undefined);
  const events = useQuery({
    queryKey: ["audit", before?.id],
    queryFn: () => api<AuditEventView[]>("GET", auditPage(before)),
  });
  return (
    <div className="page">
      <PageHeader title={TEXT.nav.activity} lede={TEXT.audit.explanation} />
      <HistoryTabs />
      {events.data === undefined && <Loading />}
      {events.data !== undefined && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.audit.when}</th>
                <th>{TEXT.audit.who}</th>
                <th>{TEXT.audit.what}</th>
                <th>{TEXT.audit.target}</th>
                <th>{TEXT.audit.details}</th>
                <th>{TEXT.audit.from}</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((event) => (
                <tr key={event.id}>
                  <td>
                    <TimeAgo timestamp={event.occurredAt} />
                  </td>
                  <td>
                    {event.actorLabel} <span className="muted small">({event.actorKind})</span>
                  </td>
                  <td className="mono">{event.action}</td>
                  <td className="small">{event.targetKind ?? TEXT.none}</td>
                  <td>
                    {Object.keys(event.details).length > 0 && (
                      <PlainText className="mono small" text={prettyJson(event.details)} />
                    )}
                  </td>
                  <td className="mono small">{event.ip ?? TEXT.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        {before !== undefined && (
          <button type="button" onClick={() => setBefore(undefined)}>
            {TEXT.audit.newest}
          </button>
        )}
        {events.data !== undefined && events.data.length > 0 && (
          <button type="button" onClick={() => setBefore(events.data[events.data.length - 1])}>
            {TEXT.audit.older}
          </button>
        )}
      </div>
      <ErrorNotice error={events.error} />
    </div>
  );
}

export function PromptPage() {
  const { promptHash = "" } = useParams();
  const prompt = useQuery({
    queryKey: ["prompts", promptHash],
    queryFn: () => api<PromptSnapshotView>("GET", apiPath(API_ROUTES.prompt, { promptHash })),
  });
  return (
    <div className="page">
      <PageHeader title={TEXT.prompt.title} lede={TEXT.prompt.explanation} />
      <p className="mono small">{promptHash}</p>
      {prompt.data === undefined ? <Loading /> : <PlainText text={prompt.data.systemPrompt} />}
      <ErrorNotice error={prompt.error} />
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <p className="muted">{TEXT.notFound}</p>
      <Link to={PATHS.home}>{TEXT.nav.attention}</Link>
    </div>
  );
}
