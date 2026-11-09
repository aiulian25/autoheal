import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, AUDIT_QUERY, type AuditEventView } from "../../../src/shared/api.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading, PageHeader, PlainText, TimeAgo, prettyJson } from "../components/common.js";
import { HistoryTabs } from "../components/section-tabs.js";
import { TEXT } from "../constants.js";

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
