import { NotificationDeliveryInbox } from "../components/notification-deliveries.js";
import { DiagnosticsPreview } from "../components/diagnostics-preview.js";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { apiPath } from "../../../src/shared/api.js";
import { ACTION_ESCALATE, INCIDENT_STATUS } from "../../../src/shared/constants.js";
import { containerLink } from "../host-links.js";
import { Badge, ErrorNotice, Loading } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { incidentQuery } from "../components/incident-parts.js";
import { PATHS, TEXT } from "../constants.js";
import { timeAgo } from "../format.js";
import { hostContainersQuery, hostsQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { DecisionPanel } from "./incident/decision-panel.js";
import { Timeline } from "./incident/timeline.js";
import { LastHalfHour, ContainerCard, EarlierIncidents, RunbookCard } from "./incident/incident-cards.js";

const text = TEXT.incidentPage;

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
