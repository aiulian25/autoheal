import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { NOTIFICATION_KINDS, TASK_PRIORITIES, wordsOf, type NotificationKind } from "../../../src/shared/constants.js";
import {
  DELIVERY_ATTEMPT_LIMIT,
  NOTIFICATION_ROUTING_LIMITS,
  notificationRoutingSchema,
  type NotificationInbox,
  type NotificationRoutingView,
  type NotificationRule,
} from "../../../src/shared/notification-deliveries.js";
import { api } from "../api-client.js";
import { INVENTORY_REFRESH_MILLISECONDS, NOTIFICATION_ROUTING_DEFAULTS, PATHS, TEXT } from "../constants.js";
import { hostsQuery } from "../queries.js";
import { ErrorNotice, Loading, TimeAgo } from "./common.js";

const inbox = TEXT.notificationInbox;
const routing = TEXT.notificationRouting;

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
      <summary>{inbox.title}</summary>
      {open && (
        <>
          <p className="small muted">{inbox.explanation}</p>
          {!query.data && !query.error && <Loading />}
          {query.data && (
            <>
              <p>{inbox.pending(query.data.pendingCount)}</p>
              {query.data.overflowCount > 0 && (
                <p className="notice warning" role="status">
                  {inbox.overflow(query.data.overflowCount)} <TimeAgo timestamp={query.data.lastOverflowAt} />
                  {inbox.overflowAfter}
                </p>
              )}
              {query.data.events.length === 0 && <p className="muted">{inbox.none}</p>}
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
                        {inbox.open(event.resourceKind)}
                      </Link>
                    )}
                    {admin && event.acknowledgedAt === null && (
                      <button type="button" disabled={busy} onClick={() => acknowledge.mutate(event.id)}>
                        {inbox.acknowledge}
                      </button>
                    )}
                  </header>
                  {event.acknowledgedAt !== null && (
                    <p className="small muted">
                      {inbox.acknowledgedBy(event.acknowledgedBy ?? "")}
                      {TEXT.separator}
                      <TimeAgo timestamp={event.acknowledgedAt} />
                    </p>
                  )}
                  {event.deliveries.length === 0 ? (
                    <div>
                      <p className="muted">{inbox.noChannel}</p>
                      {admin && event.acknowledgedAt === null && (
                        <button type="button" disabled={busy} onClick={() => route.mutate(event.id)}>
                          {inbox.queue}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>{inbox.columns.channel}</th>
                            <th>{inbox.columns.state}</th>
                            <th>{inbox.columns.attempts}</th>
                            <th>{inbox.columns.lastAttempt}</th>
                            <th>{inbox.columns.accepted}</th>
                            <th>{inbox.columns.nextAttempt}</th>
                            {admin && <th>{inbox.columns.recovery}</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {event.deliveries.map((delivery) => (
                            <tr key={delivery.id}>
                              <td>
                                {delivery.channel}
                                {delivery.stage > 0 ? `${TEXT.separator}${inbox.escalation}` : ""}
                              </td>
                              <td>
                                {delivery.status === "accepted" ? inbox.columns.accepted : wordsOf(delivery.status)}
                                {delivery.failureCode && (
                                  <span className="small muted">
                                    {TEXT.separator}
                                    {wordsOf(delivery.failureCode)}
                                  </span>
                                )}
                              </td>
                              <td>{inbox.attempts(delivery.attempts, DELIVERY_ATTEMPT_LIMIT)}</td>
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
                                      {inbox.retry}
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
              <p className="small faint">{inbox.history}</p>
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
      <summary>{routing.title}</summary>
      {open && (
        <>
          <p className="small muted">{routing.explanation}</p>
          {!current.data && !current.error && <Loading />}
          <fieldset disabled={!admin || save.isPending}>
            <legend>{routing.rules}</legend>
            {rules.map((rule, index) => (
              <section className="section" key={rule.id}>
                <h3>{routing.rule(index + 1)}</h3>
                <label>
                  {routing.host}
                  <select
                    value={rule.hostId ?? ""}
                    onChange={(event) => change(index, { hostId: event.target.value || null })}
                  >
                    <option value="">{routing.allHosts}</option>
                    {hosts.data?.map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.label}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset>
                  <legend>{routing.severity}</legend>
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
                  <legend>{routing.primaryChannels}</legend>
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
                        quietStartMinute: event.target.checked ? NOTIFICATION_ROUTING_DEFAULTS.quietStartMinute : null,
                        quietEndMinute: event.target.checked ? NOTIFICATION_ROUTING_DEFAULTS.quietEndMinute : null,
                      })
                    }
                  />
                  {routing.quietHours}
                </label>
                {rule.quietStartMinute !== null && (
                  <div className="row">
                    <label>
                      {routing.quietFrom}
                      <input
                        type="time"
                        value={timeValue(rule.quietStartMinute)}
                        onChange={(event) => change(index, { quietStartMinute: minuteValue(event.target.value) })}
                      />
                    </label>
                    <label>
                      {routing.quietUntil}
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
                  {routing.urgentOverride}
                </label>
                <label className="choice-option">
                  <input
                    type="checkbox"
                    checked={rule.escalateAfterMinutes !== null}
                    onChange={(event) =>
                      change(index, {
                        escalateAfterMinutes: event.target.checked
                          ? NOTIFICATION_ROUTING_DEFAULTS.escalateAfterMinutes
                          : null,
                      })
                    }
                  />
                  {routing.escalateOnce}
                </label>
                {rule.escalateAfterMinutes !== null && (
                  <>
                    <label>
                      {routing.escalateAfter}
                      <input
                        type="number"
                        min={NOTIFICATION_ROUTING_LIMITS.escalateMinutes.min}
                        max={NOTIFICATION_ROUTING_LIMITS.escalateMinutes.max}
                        value={rule.escalateAfterMinutes}
                        onChange={(event) => change(index, { escalateAfterMinutes: Number(event.target.value) })}
                      />
                    </label>
                    <fieldset>
                      <legend>{routing.escalationChannels}</legend>
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
                    {routing.moveUp}
                  </button>
                  <button type="button" onClick={() => setDraft(rules.filter((item) => item.id !== rule.id))}>
                    {routing.remove}
                  </button>
                </div>
              </section>
            ))}
            {admin && (
              <div className="row">
                <button
                  type="button"
                  disabled={rules.length >= NOTIFICATION_ROUTING_LIMITS.rules}
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
                  {routing.add}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={invalid || !current.data}
                  onClick={() => save.mutate()}
                >
                  {routing.save}
                </button>
              </div>
            )}
          </fieldset>
          {invalid && <p className="notice warning">{routing.invalid}</p>}
          <ErrorNotice error={current.error ?? hosts.error ?? save.error} />
          {save.isSuccess && <p role="status">{routing.saved}</p>}
        </>
      )}
    </details>
  );
}
