import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { apiPath, type IncidentDetailView } from "../../../../src/shared/api.js";
import {
  ACTION_RESTART,
  ACTION_RESTART_DEPENDENCY,
  INCIDENT_STATUS,
  MILLISECONDS_PER_SECOND,
  NOTIFICATION_KINDS,
  TRACE,
  TRIGGER_DIE,
  TRIGGER_OOM,
  wordsOf,
} from "../../../../src/shared/constants.js";
import { PlainText, TimeAgo } from "../../components/common.js";
import { Icon } from "../../components/icons.js";
import { EXIT_CODE_IN_STATE, LOG_EXCERPT_LINES, PATHS, TEXT } from "../../constants.js";
import { duration } from "../../format.js";
import { REPAIR_STATE, repairOf, type RepairState, type RepairView } from "../../incident-steps.js";
import { integrationsQuery } from "../../queries.js";

const text = TEXT.incidentPage;

export const eventOf = (incident: IncidentDetailView, kind: string) =>
  incident.trace.find((event) => event.kind === kind) ?? null;

const lastLines = (logs: string) =>
  logs
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-LOG_EXCERPT_LINES)
    .join("\n");

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

export function Timeline({ incident }: { incident: IncidentDetailView }) {
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
