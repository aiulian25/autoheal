import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { Link } from "react-router";
import { apiPath, type BoardCardView, type HostView, type OllamaServersView } from "../../../../src/shared/api.js";
import { INTEGRITY_OK, UPDATE_CHECK_INTERVAL_MILLISECONDS } from "../../../../src/shared/constants.js";
import { FLEET_STATE, answeringFor, fleetOf } from "../../ollama-fleet.js";
import { isIncident } from "../../board.js";
import { TimeAgo } from "../../components/common.js";
import { incidentLink } from "../../components/incident-parts.js";
import { MILLISECONDS_PER_HOUR, PATHS, TEXT } from "../../constants.js";
import { backupsQuery, hostUpdatesQuery, ollamaQuery, ollamaServersQuery } from "../../queries.js";
import { serverLabel } from "./attention-parts.js";

export function SideCard({ title, children, muted = false }: { title: string; children: ReactNode; muted?: boolean }) {
  return (
    <section className={muted ? "card side-card muted-surface" : "card side-card"}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const cardTitle = (card: BoardCardView) => (isIncident(card) ? card.incident.containerName : card.task.title);

const cardKey = (card: BoardCardView) => (isIncident(card) ? card.incident.id : card.task.id);

const cardLink = (card: BoardCardView) =>
  isIncident(card) ? incidentLink(card.incident.id) : apiPath(PATHS.task, { taskId: card.task.id });

// Whether the agent can take work now, and has some.
export function AgentPill({ working, hosts }: { working: boolean; hosts: readonly HostView[] }) {
  const ollama = useQuery(ollamaQuery);
  const servers = useQuery(ollamaServersQuery);
  const text = TEXT.attention.agent;
  if (ollama.data === undefined) {
    return null;
  }
  const { state } = fleetOf(ollama.data, servers.data, hosts);
  if (state === FLEET_STATE.none) {
    return <span className="agent-pill tone-danger">{text.offline}</span>;
  }
  if (state === FLEET_STATE.some) {
    return <span className="agent-pill tone-warning">{text.partlyOffline}</span>;
  }
  return <span className="agent-pill">{working ? text.working : text.ready}</span>;
}

const hostOfCard = (card: BoardCardView) => (isIncident(card) ? card.incident.hostId : card.task.hostId);

export function CardList({
  cards,
  empty,
  servers,
}: {
  cards: readonly BoardCardView[];
  empty: string;
  // Given where it matters who is working on each, with several servers to choose from.
  servers?: OllamaServersView | undefined;
}) {
  const several = (servers?.extras.length ?? 0) > 0;
  if (cards.length === 0) {
    return <p className="side-empty muted">{empty}</p>;
  }
  return (
    <ul className="side-list">
      {cards.map((card) => (
        <li key={cardKey(card)}>
          <Link to={cardLink(card)}>{cardTitle(card)}</Link>
          {several && hostOfCard(card) !== null && (
            <span className="small muted">{serverLabel(answeringFor(servers, hostOfCard(card)))}</span>
          )}
          <TimeAgo timestamp={isIncident(card) ? card.incident.updatedAt : card.task.updatedAt} />
        </li>
      ))}
    </ul>
  );
}

export function ComingUp({ admin }: { admin: boolean }) {
  const updates = useQuery(hostUpdatesQuery);
  // Only admins may list backups: everyone else sees the schedule alone.
  const backups = useQuery({ ...backupsQuery, enabled: admin });
  const verified = backups.data?.[0]?.integrityCheck === INTEGRITY_OK;
  const text = TEXT.attention;
  return (
    <SideCard title={text.comingUp}>
      <dl className="side-facts">
        <dt>{text.imageCheck}</dt>
        <dd>{text.everyHours(UPDATE_CHECK_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR)}</dd>
        {updates.data !== undefined && (
          <>
            <dt>{text.hostPackages}</dt>
            <dd>{text.tonightAt(updates.data.windowStart)}</dd>
          </>
        )}
        <dt>{text.databaseBackup}</dt>
        <dd>{verified ? text.dailyVerified : text.daily}</dd>
      </dl>
    </SideCard>
  );
}
