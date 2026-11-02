import { INCIDENT_LINK, NOTIFY_BODY, NOTIFY_TITLE, PRIORITY_BY_VERDICT } from "./constants.js";
import type { IncidentNotice } from "./protocol.js";

export interface IncidentMessage {
  title: string;
  body: string;
  // Gotify's scale: 8 and up alerts loudly on the phone.
  priority: number;
  // The incident's page, once the dashboard knows the incident and its address is known.
  link: string | null;
}

/** How a handled incident reads in a notification, from the control plane or a runner on its own. */
export function incidentMessage(
  hostLabel: string,
  notice: IncidentNotice,
  publicBaseUrl: string | null,
): IncidentMessage {
  const link =
    publicBaseUrl === null || notice.incidentId === null ? null : INCIDENT_LINK(publicBaseUrl, notice.incidentId);
  return {
    title: NOTIFY_TITLE(hostLabel, notice.containerName, notice.verdict),
    body: NOTIFY_BODY(notice.outcome, notice.diagnosis, notice.stateSummary, link),
    priority: PRIORITY_BY_VERDICT[notice.verdict],
    link,
  };
}
