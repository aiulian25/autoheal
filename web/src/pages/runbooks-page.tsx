import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type ReplayRunView,
  type RunbookSuggestionView,
  type RunbookView,
} from "../../../src/shared/api.js";
import {
  REPLAY_RUNNING,
  RUNBOOK_CHARACTER_LIMIT,
  RUNBOOK_SCOPE_GLOBAL,
  RUNBOOK_SCOPES,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { useAskInPlace } from "../components/ask-in-place.js";
import { Badge, ErrorNotice, Loading, PageHeader, PlainText, TimeAgo } from "../components/common.js";
import { incidentLink } from "../components/incident-parts.js";
import { RulesTabs } from "../components/section-tabs.js";
import { PATHS, REPLAY_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { dateTime } from "../format.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { runbookLink, replayLink } from "./management-links.js";

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

// One runbook's page at a time: a draft, and a save on its way, belong to the runbook they were made for.
export function RunbookDetailPage() {
  const { runbookId = "" } = useParams();
  return <RunbookDetail key={runbookId} runbookId={runbookId} />;
}

function RunbookDetail({ runbookId }: { runbookId: string }) {
  const session = useSignedInSession();
  const asking = useAskInPlace();
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
                <button type="button" onClick={() => setDraft(version.body)}>
                  {TEXT.runbooks.startFrom(version.version)}
                </button>
              </div>
            )}
          </div>
        ))}
      </section>
      {admin && !view.archived && (
        <section className="card">
          <h2>{TEXT.runbooks.newVersion}</h2>
          <p className="small muted">{TEXT.runbooks.keptAsWritten}</p>
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
              onClick={() => asking.confirm(TEXT.runbooks.archiveConfirm(view.title), () => archive.mutate())}
            >
              {TEXT.runbooks.archive}
            </button>
          </div>
        </section>
      )}
      {asking.question}
      <ErrorNotice error={save.error ?? publish.error ?? archive.error ?? replay.error} />
    </div>
  );
}
