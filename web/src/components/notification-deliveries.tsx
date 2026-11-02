import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { NOTIFICATION_KINDS, TASK_PRIORITIES, wordsOf, type NotificationKind } from "../../../src/shared/constants.js";
import {
  notificationRoutingSchema,
  type NotificationInbox,
  type NotificationRoutingView,
  type NotificationRule,
} from "../../../src/shared/notification-deliveries.js";
import { api } from "../api-client.js";
import { INVENTORY_REFRESH_MILLISECONDS, PATHS } from "../constants.js";
import { hostsQuery } from "../queries.js";
import { ErrorNotice, Loading, TimeAgo } from "./common.js";

export function NotificationDeliveryInbox({ admin, incidentId }: { admin: boolean; incidentId?: string }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["notification-deliveries", incidentId ?? "all"],
    queryFn: () =>
      api<NotificationInbox>(
        "GET",
        API_ROUTES.notificationDeliveries + (incidentId ? `?incidentId=${encodeURIComponent(incidentId)}` : ""),
      ),
    enabled: open,
    refetchInterval: open ? INVENTORY_REFRESH_MILLISECONDS : false,
  });
  const acknowledge = useMutation({
    mutationFn: (eventId: string) => api("POST", apiPath(API_ROUTES.notificationAcknowledge, { eventId })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["notification-deliveries"] });
    },
  });
  const retry = useMutation({
    mutationFn: (deliveryId: string) => api("POST", apiPath(API_ROUTES.notificationRetry, { deliveryId })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["notification-deliveries"] });
    },
  });
  const route = useMutation({
    mutationFn: (eventId: string) => api("POST", apiPath(API_ROUTES.notificationRouteUnsent, { eventId })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["notification-deliveries"] });
    },
  });
  const busy = acknowledge.isPending || retry.isPending || route.isPending;
  return (
    <details className="card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Notification deliveries</summary>
      {open && (
        <>
          <p className="small muted">
            Server accepted means Gotify or ntfy accepted the request; it does not confirm device receipt. Acknowledging
            records human review and stops queued retries and escalation. Message bodies and credentials are excluded
            from this inbox.
          </p>
          {!query.data && !query.error && <Loading />}
          {query.data && (
            <>
              <p>{query.data.pendingCount} channel deliveries pending.</p>
              {query.data.overflowCount > 0 && (
                <p className="notice warning" role="status">
                  {query.data.overflowCount} alerts could not be enqueued because capacity was reached. Last occurrence:{" "}
                  <TimeAgo timestamp={query.data.lastOverflowAt} />. Review affected tasks and incidents.
                </p>
              )}
              {query.data.events.length === 0 && <p className="muted">No captured notification deliveries.</p>}
              {query.data.events.map((event) => (
                <section key={event.id} className="section">
                  <header className="row">
                    <strong>{wordsOf(event.kind)}</strong>
                    <span className="badge warning">{event.priority}</span>
                    <TimeAgo timestamp={event.createdAt} />
                    {event.resourceId && event.resourceKind !== "system" && (
                      <Link
                        to={apiPath(event.resourceKind === "incident" ? PATHS.incident : PATHS.task, {
                          incidentId: event.resourceId,
                          taskId: event.resourceId,
                        })}
                      >
                        Open {event.resourceKind}
                      </Link>
                    )}
                    {admin && event.acknowledgedAt === null && (
                      <button type="button" disabled={busy} onClick={() => acknowledge.mutate(event.id)}>
                        Acknowledge
                      </button>
                    )}
                  </header>
                  {event.acknowledgedAt !== null && (
                    <p className="small muted">
                      Acknowledged by {event.acknowledgedBy} · <TimeAgo timestamp={event.acknowledgedAt} />
                    </p>
                  )}
                  {event.deliveries.length === 0 ? (
                    <div>
                      <p className="muted">
                        No channel selected or configured when this alert was captured. Configure a channel and routing
                        in Settings first.
                      </p>
                      {admin && event.acknowledgedAt === null && (
                        <button type="button" disabled={busy} onClick={() => route.mutate(event.id)}>
                          Queue using current routing
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Channel</th>
                            <th>State</th>
                            <th>Attempts</th>
                            <th>Last attempt</th>
                            <th>Server accepted</th>
                            <th>Next attempt</th>
                            {admin && <th>Recovery</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {event.deliveries.map((delivery) => (
                            <tr key={delivery.id}>
                              <td>
                                {delivery.channel}
                                {delivery.stage > 0 ? " · escalation" : ""}
                              </td>
                              <td>
                                {delivery.status === "accepted" ? "Server accepted" : wordsOf(delivery.status)}
                                {delivery.failureCode && (
                                  <span className="small muted"> · {wordsOf(delivery.failureCode)}</span>
                                )}
                              </td>
                              <td>{delivery.attempts} / 8</td>
                              <td>
                                <TimeAgo timestamp={delivery.lastAttemptAt} />
                              </td>
                              <td>
                                <TimeAgo timestamp={delivery.acceptedAt} />
                              </td>
                              <td>
                                <TimeAgo timestamp={delivery.nextAttemptAt} />
                              </td>
                              {admin && (
                                <td>
                                  {delivery.status === "failed" && event.acknowledgedAt === null && (
                                    <button type="button" disabled={busy} onClick={() => retry.mutate(delivery.id)}>
                                      Retry with current channel settings
                                    </button>
                                  )}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              ))}
              <p className="small faint">
                History retains up to 30 days and 2,000 alerts. Interrupted provider requests may produce duplicate
                device pushes; each logical alert remains one inbox event.
              </p>
            </>
          )}
          <ErrorNotice error={query.error ?? acknowledge.error ?? retry.error ?? route.error} />
        </>
      )}
    </details>
  );
}
const timeValue = (minutes: number | null) =>
  minutes === null
    ? ""
    : `${Math.floor(minutes / 60)
        .toString()
        .padStart(2, "0")}:${(minutes % 60).toString().padStart(2, "0")}`;
const minuteValue = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};
const toggle = <Value,>(values: Value[], value: Value, checked: boolean) =>
  checked ? [...values, value] : values.filter((item) => item !== value);
export function NotificationRoutingEditor({ admin }: { admin: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NotificationRule[] | null>(null);
  const client = useQueryClient();
  const current = useQuery({
    queryKey: ["notification-routing"],
    queryFn: () => api<NotificationRoutingView>("GET", API_ROUTES.notificationRouting),
    enabled: open,
  });
  const hosts = useQuery({ ...hostsQuery, enabled: open });
  const rules = draft ?? current.data?.rules ?? [];
  const change = (index: number, patch: Partial<NotificationRule>) =>
    setDraft(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  const save = useMutation({
    mutationFn: () => api<NotificationRoutingView>("PUT", API_ROUTES.notificationRouting, { rules }),
    onSuccess: (view) => {
      client.setQueryData(["notification-routing"], view);
      setDraft(null);
    },
  });
  const invalid = !notificationRoutingSchema.safeParse({ rules }).success;
  return (
    <details className="card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Notification routing and quiet hours</summary>
      {open && (
        <>
          <p className="small muted">
            The first matching rule selects the primary channels. Without a match, configured channels receive alerts as
            before. Rules apply to new alerts; queued alerts retain their captured rule. Quiet hours use UTC. Urgent
            override permits urgent alerts during quiet hours. Escalation sends once to the selected channel after the
            first permitted send slot if nobody acknowledges.
          </p>
          {!current.data && !current.error && <Loading />}
          <fieldset disabled={!admin || save.isPending}>
            <legend>Routing rules</legend>
            {rules.map((rule, index) => (
              <section className="section" key={rule.id}>
                <h3>Rule {index + 1}</h3>
                <label>
                  Host
                  <select
                    value={rule.hostId ?? ""}
                    onChange={(event) => change(index, { hostId: event.target.value || null })}
                  >
                    <option value="">All hosts</option>
                    {hosts.data?.map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.label}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset>
                  <legend>Severity</legend>
                  {TASK_PRIORITIES.map((priority) => (
                    <label className="choice-option" key={priority}>
                      <input
                        type="checkbox"
                        checked={rule.priorities.includes(priority)}
                        onChange={(event) =>
                          change(index, { priorities: toggle(rule.priorities, priority, event.target.checked) })
                        }
                      />
                      {priority}
                    </label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>Primary channels (none suppresses primary sends)</legend>
                  {NOTIFICATION_KINDS.map((channel) => (
                    <label className="choice-option" key={channel}>
                      <input
                        type="checkbox"
                        checked={rule.channels.includes(channel)}
                        onChange={(event) =>
                          change(index, { channels: toggle(rule.channels, channel, event.target.checked) })
                        }
                      />
                      {channel}
                    </label>
                  ))}
                </fieldset>
                <label className="choice-option">
                  <input
                    type="checkbox"
                    checked={rule.quietStartMinute !== null}
                    onChange={(event) =>
                      change(index, {
                        quietStartMinute: event.target.checked ? 22 * 60 : null,
                        quietEndMinute: event.target.checked ? 7 * 60 : null,
                      })
                    }
                  />
                  Quiet hours (UTC)
                </label>
                {rule.quietStartMinute !== null && (
                  <div className="row">
                    <label>
                      Quiet from
                      <input
                        type="time"
                        value={timeValue(rule.quietStartMinute)}
                        onChange={(event) => change(index, { quietStartMinute: minuteValue(event.target.value) })}
                      />
                    </label>
                    <label>
                      Quiet until
                      <input
                        type="time"
                        value={timeValue(rule.quietEndMinute)}
                        onChange={(event) => change(index, { quietEndMinute: minuteValue(event.target.value) })}
                      />
                    </label>
                  </div>
                )}
                <label className="choice-option">
                  <input
                    type="checkbox"
                    checked={rule.urgentOverride}
                    onChange={(event) => change(index, { urgentOverride: event.target.checked })}
                  />
                  Urgent alerts override quiet hours
                </label>
                <label className="choice-option">
                  <input
                    type="checkbox"
                    checked={rule.escalateAfterMinutes !== null}
                    onChange={(event) => change(index, { escalateAfterMinutes: event.target.checked ? 15 : null })}
                  />
                  Escalate once if unacknowledged
                </label>
                {rule.escalateAfterMinutes !== null && (
                  <>
                    <label>
                      Escalate after minutes
                      <input
                        type="number"
                        min={5}
                        max={1440}
                        value={rule.escalateAfterMinutes}
                        onChange={(event) => change(index, { escalateAfterMinutes: Number(event.target.value) })}
                      />
                    </label>
                    <fieldset>
                      <legend>Escalation channels</legend>
                      {NOTIFICATION_KINDS.map((channel: NotificationKind) => (
                        <label className="choice-option" key={channel}>
                          <input
                            type="checkbox"
                            checked={rule.escalationChannels.includes(channel)}
                            onChange={(event) =>
                              change(index, {
                                escalationChannels: toggle(rule.escalationChannels, channel, event.target.checked),
                              })
                            }
                          />
                          {channel}
                        </label>
                      ))}
                    </fieldset>
                  </>
                )}
                <div className="row">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...rules];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      setDraft(next);
                    }}
                  >
                    Move up
                  </button>
                  <button type="button" onClick={() => setDraft(rules.filter((item) => item.id !== rule.id))}>
                    Remove rule
                  </button>
                </div>
              </section>
            ))}
            {admin && (
              <div className="row">
                <button
                  type="button"
                  disabled={rules.length >= 16}
                  onClick={() =>
                    setDraft([
                      ...rules,
                      {
                        id: crypto.randomUUID(),
                        hostId: null,
                        priorities: ["urgent", "high"],
                        channels: [...NOTIFICATION_KINDS],
                        quietStartMinute: null,
                        quietEndMinute: null,
                        urgentOverride: true,
                        escalateAfterMinutes: null,
                        escalationChannels: [],
                      },
                    ])
                  }
                >
                  Add routing rule
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={invalid || !current.data}
                  onClick={() => save.mutate()}
                >
                  Save routing
                </button>
              </div>
            )}
          </fieldset>
          {invalid && (
            <p className="notice warning">
              Choose at least one severity, different quiet start/end times and an escalation channel when escalation is
              enabled.
            </p>
          )}
          <ErrorNotice error={current.error ?? hosts.error ?? save.error} />
          {save.isSuccess && <p role="status">Notification routing saved.</p>}
        </>
      )}
    </details>
  );
}
