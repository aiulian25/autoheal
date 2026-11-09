import { PolicyRehearsal } from "../components/policy-rehearsal.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { API_ROUTES, apiPath, type OllamaSettingsView, type ReplayRunView } from "../../../src/shared/api.js";
import {
  REPLAY_DEFAULT_INCIDENTS,
  REPLAY_FINISHED,
  REPLAY_MAXIMUM_INCIDENTS,
  REPLAY_RUNNING,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { Badge, ErrorNotice, Loading, PageHeader, TimeAgo, rowClick } from "../components/common.js";
import { RulesTabs } from "../components/section-tabs.js";
import { PATHS, REPLAY_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { actionText } from "../format.js";
import { ollamaQuery, ollamaServersQuery, ollamaSettingsQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { replayLink } from "./management-links.js";

/**
 * A replay to start: with the model each host's Ollama uses, or another the default Ollama has, over that many recent
 * incidents. Live decisions keep their model meanwhile.
 */
function StartReplay() {
  const navigate = useNavigate();
  const ollama = useQuery(ollamaQuery);
  const servers = useQuery(ollamaServersQuery);
  const start = useMutation({
    mutationFn: (body: { incidentCount: number; modelName?: string }) =>
      api<ReplayRunView>("POST", API_ROUTES.replays, body),
    onSuccess: (run) => void navigate(replayLink(run.id)),
  });
  const current = ollama.data?.model ?? null;
  const others = (ollama.data?.models ?? []).map((model) => model.name).filter((name) => name !== current);
  // A host another Ollama watches replays on that one, so the other models are said to be the default's.
  const split = (servers.data?.extras ?? []).some(({ hostIds }) => hostIds.length > 0);
  const defaultServer = servers.data?.defaultName ?? TEXT.settingsPage.ollama.unnamedDefault;
  const otherOptions = others.map((name) => (
    <option key={name} value={name}>
      {name}
    </option>
  ));
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
          {current !== null && (
            <option value={current}>{split ? TEXT.replays.inUseOnEachHost : TEXT.replays.inUse(current)}</option>
          )}
          {split ? <optgroup label={TEXT.replays.otherModelsOn(defaultServer)}>{otherOptions}</optgroup> : otherOptions}
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
  const ollama = useQuery(ollamaQuery);
  const use = useMutation({
    mutationFn: (view: OllamaSettingsView) =>
      api("PUT", API_ROUTES.ollamaSettings, { url: view.url, model: modelName, contextTokens: view.contextTokens }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ollamaSettingsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: ollamaQuery.queryKey });
    },
  });
  const view = settings.data;
  // A run on another server's model, or on several servers' models, may name none the default has to switch to.
  const onDefault = (ollama.data?.models ?? []).some(({ name }) => name === modelName);
  if (view === undefined || !onDefault) {
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
