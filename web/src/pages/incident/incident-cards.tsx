import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  API_ROUTES,
  INCIDENT_QUERY,
  apiPath,
  type ContainerView,
  type IncidentDetailView,
  type ReplayRunView,
  type RunbookVersionView,
  type RunbookView,
} from "../../../../src/shared/api.js";
import { TRACE, wordsOf } from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { MINIMUM_POINTS } from "../../components/charts.js";
import { ErrorNotice, Loading, TimeAgo } from "../../components/common.js";
import { incidentLink } from "../../components/incident-parts.js";
import { PATHS, TEXT } from "../../constants.js";
import { ContainerCharts } from "../container-inspector.js";
import { eventOf } from "./timeline.js";

const text = TEXT.incidentPage;

interface RunbookUse {
  title: string;
  version: number;
}

// The runbooks the prompt carried, as its trace event recorded them.
function runbooksOf(incident: IncidentDetailView): RunbookUse[] {
  const recorded = eventOf(incident, TRACE.promptBuilt)?.payload.runbooks;
  return Array.isArray(recorded) ? (recorded as RunbookUse[]) : [];
}

export function ContainerCard({
  incident,
  container,
}: {
  incident: IncidentDetailView;
  container: ContainerView | undefined;
}) {
  return (
    <section className="card side-card facts-card">
      <h2>{text.thisContainer}</h2>
      <dl className="facts">
        <dt>{text.host}</dt>
        <dd>
          <Link to={apiPath(PATHS.host, { hostId: incident.hostId })}>{incident.hostLabel}</Link>
        </dd>
        <dt>{text.state}</dt>
        <dd>{container === undefined ? text.gone : wordsOf(container.state)}</dd>
        {container !== undefined && (
          <>
            <dt>{text.whenItFails}</dt>
            <dd>{text.rules[container.byItself.restart]}</dd>
            <dt>{text.protectedFact}</dt>
            <dd>{container.protected ? TEXT.yes : TEXT.no}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** The failed container's half hour before Autoheal looked, as measured: kept with the incident. */
export function LastHalfHour({ incident }: { incident: IncidentDetailView }) {
  if (incident.usage.length < MINIMUM_POINTS) {
    return null;
  }
  return (
    <section className="incident-usage" aria-labelledby="incident-usage-title">
      <h2 id="incident-usage-title">{text.usage}</h2>
      <ContainerCharts points={incident.usage} />
    </section>
  );
}

/** The same container's incidents before this one, from the month before: what the model heard of. */
export function EarlierIncidents({ incident }: { incident: IncidentDetailView }) {
  if (incident.earlier.length === 0) {
    return null;
  }
  const allOfContainer = new URLSearchParams({
    [INCIDENT_QUERY.hostId]: incident.hostId,
    [INCIDENT_QUERY.containerName]: incident.containerName,
  });
  return (
    <section className="card side-card">
      <h2>{text.earlier}</h2>
      <ul className="side-list">
        {incident.earlier.map((earlier) => (
          <li key={earlier.id}>
            <Link to={incidentLink(earlier.id)}>{wordsOf(earlier.verdict ?? earlier.status)}</Link>
            <TimeAgo timestamp={earlier.detectedAt} />
          </li>
        ))}
      </ul>
      <Link to={`${PATHS.incidents}?${allOfContainer}`}>{text.allOfContainer(incident.containerName)}</Link>
    </section>
  );
}

interface Draft {
  runbook: RunbookView;
  version: RunbookVersionView;
}

// A runbook's newest version while it is not published yet: what a person is still editing.
function draftOf(runbook: RunbookView): Draft[] {
  const newest = runbook.versions.at(-1);
  const editing = !runbook.archived && newest !== undefined && newest.publishedAt === null;
  return editing ? [{ runbook, version: newest }] : [];
}

/** This incident against a draft: the drafts there are, one click each, and the replay's page after. */
function ReplayAgainstDraft({ incident }: { incident: IncidentDetailView }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const runbooks = useQuery({
    queryKey: ["runbooks"],
    queryFn: () => api<RunbookView[]>("GET", API_ROUTES.runbooks),
    enabled: open,
  });
  const replay = useMutation({
    mutationFn: (versionId: string) =>
      api<ReplayRunView>("POST", API_ROUTES.replays, { draftVersionIds: [versionId], incidentIds: [incident.id] }),
    onSuccess: (run) => void navigate(apiPath(PATHS.replay, { replayId: run.id })),
  });
  if (!open) {
    return (
      <button type="button" className="button" onClick={() => setOpen(true)}>
        {text.replay}
      </button>
    );
  }
  const drafts = (runbooks.data ?? []).flatMap(draftOf);
  return (
    <div className="stack">
      {runbooks.data === undefined && runbooks.error === null && <Loading />}
      {runbooks.data !== undefined && drafts.length === 0 && (
        <p className="small muted">
          {text.noDraft} <Link to={PATHS.runbooks}>{text.toRunbooks}</Link>
        </p>
      )}
      {drafts.map(({ runbook, version }) => (
        <button
          key={version.id}
          type="button"
          className="button"
          disabled={replay.isPending}
          onClick={() => replay.mutate(version.id)}
        >
          {text.replayWith(runbook.title, version.version)}
        </button>
      ))}
      <ErrorNotice error={runbooks.error ?? replay.error} />
    </div>
  );
}

export function RunbookCard({ incident, admin }: { incident: IncidentDetailView; admin: boolean }) {
  const runbooks = runbooksOf(incident);
  return (
    <section className="card side-card">
      <h2>{text.runbookUsed}</h2>
      {runbooks.length === 0 ? (
        <p className="side-empty muted">{text.noRunbook}</p>
      ) : (
        runbooks.map((runbook) => (
          <p key={runbook.title} className="runbook-name small muted">
            {text.runbookVersion(runbook.title, runbook.version)}
          </p>
        ))
      )}
      <p className="small muted">{text.replayHint}</p>
      {admin ? (
        <ReplayAgainstDraft incident={incident} />
      ) : (
        <Link className="button" to={PATHS.replays}>
          {TEXT.replays.title}
        </Link>
      )}
    </section>
  );
}
