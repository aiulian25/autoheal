import { NotificationDeliveryInbox } from "../components/notification-deliveries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { API_ROUTES, INCIDENT_QUERY, type IncidentSummaryView } from "../../../src/shared/api.js";
import { INCIDENT_STATUSES, wordsOf } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { Badge, ErrorNotice, Loading, PageHeader, TimeAgo, rowClick } from "../components/common.js";
import { incidentLink } from "../components/incident-parts.js";
import { HistoryTabs } from "../components/section-tabs.js";
import { PATHS, REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { actionText } from "../format.js";

const decisionText = (incident: IncidentSummaryView) => actionText(incident.action, incident.target);

export function IncidentTable({ incidents }: { incidents: IncidentSummaryView[] }) {
  const navigate = useNavigate();
  if (incidents.length === 0) {
    return <p className="muted">{TEXT.incidents.empty}</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{TEXT.incidents.when}</th>
            <th>{TEXT.incidents.host}</th>
            <th>{TEXT.incidents.container}</th>
            <th>{TEXT.incidents.trigger}</th>
            <th>{TEXT.incidents.status}</th>
            <th>{TEXT.incidents.decision}</th>
            <th>{TEXT.incidents.verdict}</th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((incident) => (
            <tr
              key={incident.id}
              className="clickable"
              onClick={rowClick(() => void navigate(incidentLink(incident.id)))}
            >
              <td>
                <TimeAgo timestamp={incident.detectedAt} />
              </td>
              <td>{incident.hostLabel}</td>
              <td>
                <Link to={incidentLink(incident.id)}>{incident.containerName}</Link>
              </td>
              <td>{TEXT.incident.triggers[incident.trigger]}</td>
              <td>
                <Badge value={incident.status} />
              </td>
              <td>{decisionText(incident)}</td>
              <td>
                <Badge value={incident.verdict} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FILTERS = [INCIDENT_QUERY.status, INCIDENT_QUERY.hostId, INCIDENT_QUERY.containerName] as const;

// The filters the address carries, with the status changed: a host or container chosen elsewhere stays.
function withStatus(filters: URLSearchParams, status: string): URLSearchParams {
  const changed = new URLSearchParams(filters);
  changed.delete(INCIDENT_QUERY.status);
  if (status !== "") {
    changed.set(INCIDENT_QUERY.status, status);
  }
  return changed;
}

// Only one container's or host's incidents, as a link from an incident led here: and the way back to all.
function FilterNotice({ filters }: { filters: URLSearchParams }) {
  const containerName = filters.get(INCIDENT_QUERY.containerName);
  if (containerName === null && !filters.has(INCIDENT_QUERY.hostId)) {
    return null;
  }
  return (
    <p className="muted small">
      {containerName === null ? TEXT.incidents.oneHost : TEXT.incidents.oneContainer(containerName)}{" "}
      <Link to={PATHS.incidents}>{TEXT.incidents.showAll}</Link>
    </p>
  );
}

export function IncidentsPage() {
  const admin = isAdmin(useSignedInSession());
  const [search, setSearch] = useSearchParams();
  const filters = new URLSearchParams(
    FILTERS.flatMap((name) => {
      const value = search.get(name);
      return value === null || value === "" ? [] : [[name, value]];
    }),
  );
  const status = filters.get(INCIDENT_QUERY.status) ?? "";
  const query = filters.toString() === "" ? "" : `?${filters}`;
  const incidents = useQuery({
    queryKey: ["incidents", "list", query],
    queryFn: () => api<IncidentSummaryView[]>("GET", `${API_ROUTES.incidents}${query}`),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  return (
    <div className="page">
      <PageHeader title={TEXT.nav.activity} lede={TEXT.incidents.lede}>
        <select
          aria-label={TEXT.incidents.status}
          value={status}
          onChange={(event) => setSearch(withStatus(filters, event.target.value))}
        >
          <option value="">{TEXT.incidents.allStatuses}</option>
          {INCIDENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {wordsOf(value)}
            </option>
          ))}
        </select>
      </PageHeader>
      <HistoryTabs />
      <NotificationDeliveryInbox admin={admin} />
      <FilterNotice filters={filters} />
      {incidents.data === undefined ? <Loading /> : <IncidentTable incidents={incidents.data} />}
      <ErrorNotice error={incidents.error} />
    </div>
  );
}
