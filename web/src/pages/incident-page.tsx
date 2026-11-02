import { NotificationDeliveryInbox } from "../components/notification-deliveries.js";
import { DiagnosticsPreview } from "../components/diagnostics-preview.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  API_ROUTES,
  INCIDENT_QUERY,
  apiPath,
  type ContainerControlChange,
  type ContainerView,
  type HostView,
  type IncidentDetailView,
  type ReplayRunView,
  type RunbookVersionView,
  type RunbookView,
} from "../../../src/shared/api.js";
import {
  ACTION_ESCALATE,
  ACTION_RESTART,
  ACTION_RESTART_DEPENDENCY,
  APPROVAL_DISMISS,
  INCIDENT_STATUS,
  MILLISECONDS_PER_SECOND,
  NOTIFICATION_KINDS,
  OUTCOMES,
  RESTART_CHOICE,
  TRACE,
  TRIGGER_DIE,
  TRIGGER_OOM,
  isParkedContainer,
  wordsOf,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { MINIMUM_POINTS } from "../components/charts.js";
import { Badge, ErrorNotice, Loading, PlainText, TimeAgo } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { approvalOf, incidentLink, incidentQuery, useApproval } from "../components/incident-parts.js";
import { EXIT_CODE_IN_STATE, LOG_EXCERPT_LINES, PATHS, SEARCH_PARAMETERS, TEXT } from "../constants.js";
import { duration, timeAgo } from "../format.js";
import { REPAIR_STATE, repairOf, type RepairState, type RepairView } from "../incident-steps.js";
import { hostContainersQuery, hostsQuery, integrationsQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { ContainerCharts } from "./host-stats.js";

const text = TEXT.incidentPage;

const containerLink = (hostId: string, name: string) =>
  `${apiPath(PATHS.host, { hostId })}?${new URLSearchParams({ [SEARCH_PARAMETERS.container]: name })}`;

const eventOf = (incident: IncidentDetailView, kind: string) =>
  incident.trace.find((event) => event.kind === kind) ?? null;

interface RunbookUse {
  title: string;
  version: number;
}

// The runbooks the prompt carried, as its trace event recorded them.
function runbooksOf(incident: IncidentDetailView): RunbookUse[] {
  const recorded = eventOf(incident, TRACE.promptBuilt)?.payload.runbooks;
  return Array.isArray(recorded) ? (recorded as RunbookUse[]) : [];
}

const lastLines = (logs: string) =>
  logs
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-LOG_EXCERPT_LINES)
    .join("\n");

function callTitle(incident: IncidentDetailView): string {
  if (incident.action === ACTION_RESTART) {
    return text.calls.restart;
  }
  if (incident.action === ACTION_RESTART_DEPENDENCY) {
    return text.calls.dependency(incident.target ?? "");
  }
  return incident.action === ACTION_ESCALATE ? text.calls.escalate : text.calls.none;
}

const asksFirst = (incident: IncidentDetailView) =>
  incident.outcome === OUTCOMES.asksFirst(incident.target ?? incident.containerName);

// Why it waits for a person: its rule, Ollama, or what went wrong; for a settled incident, how it ended.
function WhyItWaits({ incident, container }: { incident: IncidentDetailView; container: ContainerView | undefined }) {
  if (asksFirst(incident)) {
    return (
      <p className="small muted">
        {text.waitingBecause}
        <strong>{text.askFirst}</strong>.{" "}
        {container !== undefined && (
          <Link to={containerLink(incident.hostId, incident.containerName)}>{text.changeRule}</Link>
        )}
      </p>
    );
  }
  // A person's choice was carried out and did not hold: what happened is why it waits again.
  const triedAlready = incident.outcome !== null && incident.approvals.length > 0;
  if (!triedAlready && incident.action === ACTION_ESCALATE && incident.status === INCIDENT_STATUS.awaitingApproval) {
    return <p className="small muted">{text.yoursToDecide}</p>;
  }
  return incident.outcome === null ? null : <p className="small muted">{incident.outcome}</p>;
}

function GuardChecks({ incident, host }: { incident: IncidentDetailView; host: HostView | undefined }) {
  const isProtected = incident.report?.protectedContainers.includes(incident.containerName) ?? false;
  const used = host?.restartBudget[incident.containerName] ?? 0;
  const checks = [
    isProtected ? text.checks.protected : text.checks.notProtected,
    text.checks.notStoppedOnPurpose,
    text.checks.noRecentRestart,
    text.checks.restartsUsed(used),
  ];
  return (
    <div className="guard">
      <p className="label">{text.guardChecks}</p>
      <ul className="checks">
        {checks.map((check) => (
          <li key={check}>
            <Icon name="check" />
            {check}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Any container on the host but this one and the protected ones: a person's choice is theirs to make. */
function DependencyChooser({ incident, onCancel }: { incident: IncidentDetailView; onCancel: () => void }) {
  const decide = useApproval(incident.id);
  const candidates =
    incident.report?.knownContainers.filter(
      (name) =>
        name !== incident.containerName &&
        !incident.report!.protectedContainers.includes(name) &&
        !isParkedContainer(name),
    ) ?? [];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = String(new FormData(event.currentTarget).get("target") ?? "");
    decide.mutate({ choice: ACTION_RESTART_DEPENDENCY, target });
  };
  return (
    <form className="dependency-chooser" onSubmit={submit}>
      <label>
        {text.which}
        <select name="target" required>
          {candidates.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="primary" disabled={decide.isPending || candidates.length === 0}>
        {text.restartThat}
      </button>
      <button type="button" className="quiet" onClick={onCancel}>
        {text.cancel}
      </button>
      <ErrorNotice error={decide.error} />
    </form>
  );
}

function DecisionActions({
  incident,
  container,
}: {
  incident: IncidentDetailView;
  container: ContainerView | undefined;
}) {
  const queryClient = useQueryClient();
  const decide = useApproval(incident.id);
  const [choosing, setChoosing] = useState(false);
  const restartAlone = useMutation({
    mutationFn: (change: ContainerControlChange) =>
      api<void>("PUT", apiPath(API_ROUTES.containerControls, { hostId: incident.hostId }), change),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });
  if (choosing) {
    return <DependencyChooser incident={incident} onCancel={() => setChoosing(false)} />;
  }
  const approve = () => decide.mutate(approvalOf(incident));
  const canRestartAlone =
    container !== undefined &&
    container.byItself.restart !== RESTART_CHOICE.restart &&
    container.byItself.restartLock === null;
  return (
    <>
      <button type="button" className="primary" disabled={decide.isPending} onClick={approve}>
        {text.approve}
      </button>
      <button type="button" className="warm" disabled={decide.isPending} onClick={() => setChoosing(true)}>
        {text.dependencyInstead}
      </button>
      <button
        type="button"
        className="quiet"
        disabled={decide.isPending}
        onClick={() => decide.mutate({ choice: APPROVAL_DISMISS })}
      >
        {text.leave}
      </button>
      {canRestartAlone && (
        <button
          type="button"
          className="quiet push"
          disabled={restartAlone.isPending}
          onClick={() => restartAlone.mutate({ names: [incident.containerName], restart: RESTART_CHOICE.restart })}
        >
          {text.restartAlone}
        </button>
      )}
      {container?.byItself.restart === RESTART_CHOICE.restart && asksFirst(incident) && (
        <span className="small text-good push">{text.restartsAlone}</span>
      )}
      <ErrorNotice error={decide.error ?? restartAlone.error} />
    </>
  );
}

function DecisionPanel(props: {
  incident: IncidentDetailView;
  host: HostView | undefined;
  container: ContainerView | undefined;
  admin: boolean;
}) {
  const { incident, host, container, admin } = props;
  const waiting = incident.status === INCIDENT_STATUS.awaitingApproval;
  return (
    <section className={waiting ? "decision-panel waiting" : "decision-panel"}>
      <div className="decision-panel-body">
        <div className="call">
          <p className="label text-warning">{text.ollamasCall}</p>
          <h2>{callTitle(incident)}</h2>
          {incident.diagnosis !== null && <PlainText className="text diagnosis" text={incident.diagnosis} />}
          <WhyItWaits incident={incident} container={container} />
        </div>
        <GuardChecks incident={incident} host={host} />
      </div>
      {waiting && admin && (
        <div className="decision-panel-actions">
          <DecisionActions incident={incident} container={container} />
        </div>
      )}
    </section>
  );
}

type StepMarker = "danger" | "neutral" | "good" | "warning" | "next";

function Step(props: { marker: StepMarker; title: ReactNode; children?: ReactNode }) {
  return (
    <li className={`step ${props.marker}`}>
      <span className="step-marker" aria-hidden>
        {props.marker === "good" && <Icon name="check" />}
      </span>
      <div className="step-body">
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </li>
  );
}

function sawText(incident: IncidentDetailView): string {
  if (incident.trigger === TRIGGER_OOM) {
    return text.sawOom(incident.hostLabel);
  }
  if (incident.trigger !== TRIGGER_DIE) {
    return text.sawUnhealthy(incident.hostLabel);
  }
  const code = EXIT_CODE_IN_STATE.exec(incident.report?.stateSummary ?? "")?.[1];
  return code === undefined ? text.sawStop(incident.hostLabel) : text.sawExit(incident.hostLabel, code);
}

// The others of its compose project as Docker showed them then, with the last lines of those in trouble.
function Neighbours({ report }: { report: NonNullable<IncidentDetailView["report"]> }) {
  if (report.composeProject === null || report.neighbours.length === 0) {
    return null;
  }
  return (
    <>
      <h4>{text.neighbours(report.composeProject)}</h4>
      <ul className="record">
        {report.neighbours.map((neighbour) => (
          <li key={neighbour.name}>
            <strong className="mono">{neighbour.name}</strong> {neighbour.status}
            {neighbour.logs !== null && <PlainText text={neighbour.logs} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function ReportStep({ incident }: { incident: IncidentDetailView }) {
  const [open, setOpen] = useState(false);
  const report = incident.report;
  return (
    <Step marker="neutral" title={text.reportWritten}>
      <p className="muted">{text.reportText}</p>
      {report !== null && <PlainText className="log excerpt" text={lastLines(report.logs)} />}
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? text.hideReport : text.readReport}
      </button>
      {open && report !== null && (
        <div className="report">
          <h4>{text.stateLine}</h4>
          <PlainText className="mono small" text={report.stateSummary} />
          {report.healthOutputs.length > 0 && (
            <>
              <h4>{text.healthOutput}</h4>
              <PlainText text={report.healthOutputs.join("\n---\n")} />
            </>
          )}
          <Neighbours report={report} />
          <h4>{text.allLogs}</h4>
          <PlainText text={report.logs} />
          <h4>{text.record}</h4>
          <ul className="record">
            {incident.trace.map((event) => (
              <li key={event.id}>
                <strong>{wordsOf(event.kind)}</strong> <TimeAgo timestamp={event.createdAt} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Step>
  );
}

// The model's own notes before it answered: long, so they stay folded until asked for.
function Reasoning({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? text.hideReasoning : text.seeReasoning}
      </button>
      {open && (
        <div className="report">
          <p className="small muted">{text.reasoningNote}</p>
          <PlainText className="log text" text={reasoning} />
        </div>
      )}
    </>
  );
}

function DecisionStep({ incident }: { incident: IncidentDetailView }) {
  const [open, setOpen] = useState(false);
  const failed = eventOf(incident, TRACE.modelFailed);
  if (failed !== null) {
    return (
      <Step marker="danger" title={text.modelFailed}>
        <p className="muted">{String(failed.payload.error ?? "")}</p>
      </Step>
    );
  }
  if (incident.action === null) {
    return null;
  }
  const answer = eventOf(incident, TRACE.modelAnswered)?.payload.raw;
  const fellBack = eventOf(incident, TRACE.serverFellBack)?.payload.from;
  const asked = eventOf(incident, TRACE.promptBuilt)?.payload.server;
  return (
    <Step marker="neutral" title={text.decided(text.choices[incident.action])}>
      {typeof fellBack === "string" && <p className="small text-warning">{text.fellBack(fellBack)}</p>}
      {typeof fellBack !== "string" && typeof asked === "string" && (
        <p className="small muted">{text.askedServer(asked)}</p>
      )}
      <p className="muted">
        {eventOf(incident, TRACE.handledLocally) === null ? text.askedThrough : text.askedDirectly}
        <span className="mono">{incident.modelName ?? TEXT.none}</span>
        {text.couldChoose}
      </p>
      {incident.reasoning !== null && <Reasoning reasoning={incident.reasoning} />}
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? text.hidePrompt : text.seePrompt}
      </button>
      {open && (
        <div className="report">
          {incident.evidence.length > 0 && (
            <>
              <h4>{text.evidence}</h4>
              {incident.evidence.map((section) => (
                <PlainText key={section} text={section} />
              ))}
            </>
          )}
          {typeof answer === "string" && (
            <>
              <h4>{text.answer}</h4>
              <PlainText text={answer} />
            </>
          )}
          {incident.promptHash !== null && (
            <Link to={apiPath(PATHS.prompt, { promptHash: incident.promptHash })}>{text.instructions}</Link>
          )}
        </div>
      )}
    </Step>
  );
}

const REPAIR_MARKERS = {
  looking: "next",
  under_way: "next",
  held: "good",
  failed: "danger",
  reported: "warning",
  skipped: "neutral",
} as const satisfies Record<RepairState, StepMarker>;

// "recreate it from its settings, update it to the newer image or write you a report".
function choicesOf(repair: RepairView): string {
  const names = repair.offered.map((choice) => text.repair.choices[choice]);
  const last = names.pop() ?? "";
  return names.length === 0 ? last : `${names.join(TEXT.listComma)}${text.repair.choicesJoin}${last}`;
}

// What Ollama found and why, and its steps by hand when its repair did not hold or was too much to make.
function RepairReport({ repair }: { repair: RepairView }) {
  const byHand = repair.state === REPAIR_STATE.failed || repair.state === REPAIR_STATE.reported;
  return (
    <div className="report">
      {repair.findings !== "" && (
        <>
          <h4>{text.repair.found}</h4>
          <PlainText className="text" text={repair.findings} />
        </>
      )}
      {repair.cause !== "" && (
        <>
          <h4>{text.repair.cause}</h4>
          <PlainText className="text" text={repair.cause} />
        </>
      )}
      {byHand && repair.steps.length > 0 && (
        <>
          <h4>{text.repair.steps}</h4>
          <ol className="repair-steps">
            {repair.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function RepairStep({ incident }: { incident: IncidentDetailView }) {
  const repair = repairOf(incident);
  if (repair === null) {
    return null;
  }
  const chose = repair.repair === null || repair.state === REPAIR_STATE.reported ? null : repair.repair;
  return (
    <Step marker={REPAIR_MARKERS[repair.state]} title={text.repair.titles[repair.state]}>
      {repair.handedBy !== null && <p className="muted">{text.repair.handedBy(repair.handedBy)}</p>}
      {repair.state === REPAIR_STATE.looking && <p className="muted">{text.repair.looking(choicesOf(repair))}</p>}
      {repair.state === REPAIR_STATE.reported && <p className="muted">{text.repair.tooMuch}</p>}
      {chose !== null && <p className="muted">{text.repair.chose(text.repair.choices[chose])}</p>}
      {repair.outcome !== null && <p className="muted">{repair.outcome}</p>}
      {repair.thinking !== null && <Reasoning reasoning={repair.thinking} />}
      {repair.repair !== null && <RepairReport repair={repair} />}
    </Step>
  );
}

function PersonStep({ incident }: { incident: IncidentDetailView }) {
  const integrations = useQuery(integrationsQuery);
  const approval = incident.approvals.at(-1);
  if (approval !== undefined) {
    return (
      <Step marker="neutral" title={text.approvedBy(wordsOf(approval.choice), approval.decidedBy)}>
        <p className="muted">
          <TimeAgo timestamp={approval.decidedAt} />
        </p>
      </Step>
    );
  }
  if (incident.status !== INCIDENT_STATUS.awaitingApproval) {
    return null;
  }
  const channels = (integrations.data ?? [])
    .filter((view) => view.source !== null && NOTIFICATION_KINDS.some((kind) => kind === view.kind))
    .map((view) => TEXT.services.names[view.kind]);
  const waited = duration((Date.now() - incident.detectedAt) / MILLISECONDS_PER_SECOND);
  return (
    <Step marker="warning" title={text.waitingFor(waited)}>
      <p className="muted">
        {channels.length === 0 ? text.notSent : text.sentThrough(channels.join(text.channelsJoin))}
      </p>
    </Step>
  );
}

function Timeline({ incident }: { incident: IncidentDetailView }) {
  const restarting = incident.action === ACTION_RESTART || incident.action === ACTION_RESTART_DEPENDENCY;
  const waiting = incident.status === INCIDENT_STATUS.awaitingApproval;
  return (
    <ol className="steps-timeline">
      <Step
        marker="danger"
        title={
          <>
            {text.dockerReported}
            <span className="mono text-danger">{incident.trigger}</span>
          </>
        }
      >
        <p className="muted">{sawText(incident)}</p>
      </Step>
      <ReportStep incident={incident} />
      <DecisionStep incident={incident} />
      {restarting && (
        <Step marker="good" title={text.guardPassed}>
          {<p className="muted">{text.allFour}</p>}
        </Step>
      )}
      <RepairStep incident={incident} />
      <PersonStep incident={incident} />
      {waiting && restarting && (
        <Step
          marker="next"
          title={incident.action === ACTION_RESTART ? text.next.restart : text.next.dependency(incident.target ?? "")}
        />
      )}
      {incident.outcome !== null && incident.approvals.length > 0 && (
        <Step marker="neutral" title={text.outcome}>
          <p className="muted">{incident.outcome}</p>
        </Step>
      )}
    </ol>
  );
}

function ContainerCard({
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
function LastHalfHour({ incident }: { incident: IncidentDetailView }) {
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
function EarlierIncidents({ incident }: { incident: IncidentDetailView }) {
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

function RunbookCard({ incident, admin }: { incident: IncidentDetailView; admin: boolean }) {
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

/** One incident: Ollama's call and the guard's checks, the decision if it waits for one, and every step. */
export function IncidentDetailPage() {
  const admin = isAdmin(useSignedInSession());
  const { incidentId = "" } = useParams();
  const incident = useQuery(incidentQuery(incidentId));
  const hosts = useQuery(hostsQuery);
  const hostId = incident.data?.hostId ?? "";
  const containers = useQuery({ ...hostContainersQuery(hostId), enabled: hostId !== "" });
  if (incident.data === undefined) {
    return incident.error ? <ErrorNotice error={incident.error} /> : <Loading />;
  }
  const view = incident.data;
  const host = hosts.data?.find((candidate) => candidate.id === view.hostId);
  const container = containers.data?.find((candidate) => candidate.name === view.containerName);
  const waiting = view.status === INCIDENT_STATUS.awaitingApproval;
  const escalated = view.action === ACTION_ESCALATE;
  return (
    <div className="page incident">
      <nav className="crumbs" aria-label={text.trail}>
        <Icon name="server" />
        <Link to={apiPath(PATHS.host, { hostId: view.hostId })}>{view.hostLabel}</Link>
        <span aria-hidden>/</span>
        <Link to={PATHS.home}>{TEXT.nav.attention}</Link>
        <span aria-hidden>/</span>
        <span aria-current="page">{view.containerName}</span>
      </nav>
      <p className="incident-state">
        {waiting ? (
          <span className={escalated ? "badge danger" : "badge warning"}>
            {escalated ? text.escalated : text.awaiting}
          </span>
        ) : (
          <Badge value={view.verdict ?? view.status} />
        )}
        <span className="muted">{text.happened(TEXT.attention.happened[view.trigger], timeAgo(view.detectedAt))}</span>
      </p>
      <header className="incident-title">
        <h1>
          <span className="mono">{view.containerName}</span>{" "}
          <span className="on-host">{text.onHost(view.hostLabel)}</span>
        </h1>
        {container !== undefined && (
          <Link to={containerLink(view.hostId, view.containerName)}>{text.openContainer}</Link>
        )}
      </header>
      <DiagnosticsPreview incidentId={view.id} />
      <NotificationDeliveryInbox incidentId={view.id} admin={admin} />
      <DecisionPanel incident={view} host={host} container={container} admin={admin} />
      <div className="incident-layout">
        <div className="incident-main">
          <section className="incident-steps" aria-labelledby="incident-steps-title">
            <h2 id="incident-steps-title">{text.whatHappened}</h2>
            <Timeline incident={view} />
          </section>
          <LastHalfHour incident={view} />
        </div>
        <aside className="attention-side">
          <ContainerCard incident={view} container={container} />
          <EarlierIncidents incident={view} />
          <RunbookCard incident={view} admin={admin} />
        </aside>
      </div>
    </div>
  );
}
