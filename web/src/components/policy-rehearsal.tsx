import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { API_ROUTES, apiPath, type HostControlView } from "../../../src/shared/api.js";
import {
  HOST_RESTART_CHOICES,
  MAX_RESTARTS_PER_WINDOW,
  MILLISECONDS_PER_SECOND,
  wordsOf,
  type HostRestartChoice,
} from "../../../src/shared/constants.js";
import type {
  PolicyRehearsalContext,
  PolicyRehearsalRequest,
  PolicyRehearsalResult,
  RehearsalEvent,
  RehearsalReason,
} from "../../../src/shared/recovery-policy-simulator.js";
import { api, ReadableError } from "../api-client.js";
import { hostsQuery, containerQueryMatchesHosts } from "../queries.js";
import { REHEARSAL_FORM, TEXT } from "../constants.js";
import { ErrorNotice, Loading } from "./common.js";

const text = TEXT.rehearsal;
const EVENT_LABELS: Record<RehearsalEvent["kind"], string> = text.events;
const REASONS: Record<RehearsalReason, string> = text.reasons;
const named = (kind: RehearsalEvent["kind"]) => ["failure", "stop", "operation-start", "operation-end"].includes(kind);
interface Row {
  seconds: number;
  kind: RehearsalEvent["kind"];
  name: string;
  clockOffsetSeconds: number;
  statePreserved: boolean;
}
const initialRows = (name: string): Row[] =>
  REHEARSAL_FORM.startSeconds.map((seconds) => ({
    seconds,
    kind: "failure",
    name,
    clockOffsetSeconds: 0,
    statePreserved: true,
  }));
const eventOf = (row: Row, start: number): RehearsalEvent => {
  const at = start + row.seconds * MILLISECONDS_PER_SECOND;
  if (row.kind === "runner-restart") return { at, kind: row.kind, statePreserved: row.statePreserved };
  if (row.kind === "clock-change")
    return { at, kind: row.kind, offsetMilliseconds: row.clockOffsetSeconds * MILLISECONDS_PER_SECOND };
  if (row.kind === "failure" || row.kind === "stop" || row.kind === "operation-start" || row.kind === "operation-end")
    return { at, kind: row.kind, name: row.name };
  return { at, kind: row.kind };
};

function RehearsalForm({ admin, initialHostId }: { admin: boolean; initialHostId: string }) {
  const client = useQueryClient();
  const hosts = useQuery(hostsQuery);
  const [hostId, setHostId] = useState(initialHostId);
  const [choice, setChoice] = useState<HostRestartChoice>("ask");
  const [source, setSource] = useState<"synthetic" | "history">("synthetic");
  const [rows, setRows] = useState<Row[]>([]);
  const [group, setGroup] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false);
  // The host the form was last filled for. Its data comes again on every fetch, with a new time and heartbeat in it:
  // the form is filled when a newly chosen host's data first comes, never again, or what a person chose is undone.
  const [filledFor, setFilledFor] = useState<string | null>(null);
  const contextQueryKey = ["policy-rehearsal", "context", hostId];
  const context = useQuery({
    queryKey: contextQueryKey,
    queryFn: () => api<PolicyRehearsalContext>("GET", apiPath(API_ROUTES.policyRehearsalContext, { hostId })),
    enabled: hostId !== "",
  });
  const rehearsal = useMutation({
    mutationFn: (request: PolicyRehearsalRequest) =>
      api<PolicyRehearsalResult>("POST", API_ROUTES.policyRehearsal, request),
  });
  const apply = useMutation({
    mutationFn: async (result: PolicyRehearsalResult) => {
      const path = apiPath(API_ROUTES.hostControl, { hostId: result.hostId });
      const current = await api<HostControlView>("GET", path);
      if (current.restartDefault !== result.change.before) throw new ReadableError(text.changedMeanwhile);
      return api<HostControlView>("PUT", path, { restartDefault: result.change.after });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["host-control", hostId] });
      void client.invalidateQueries({
        predicate: (query) => containerQueryMatchesHosts(query.queryKey, new Set([hostId])),
      });
      void client.invalidateQueries({ queryKey: contextQueryKey });
    },
  });
  const resetPlan = () => {
    rehearsal.reset();
    apply.reset();
    setReviewed(false);
  };
  useEffect(() => {
    if (!hostId && hosts.data?.[0]) setHostId(hosts.data[0].id);
  }, [hostId, hosts.data]);
  useEffect(() => {
    if (!context.data || context.data.hostId !== hostId || filledFor === hostId) return;
    const next = context.data.restartDefault;
    setChoice(HOST_RESTART_CHOICES.includes(next as HostRestartChoice) ? (next as HostRestartChoice) : "ask");
    setRows(initialRows(context.data.containers[0]?.name ?? ""));
    setGroup([]);
    setFilledFor(hostId);
  }, [context.data, hostId, filledFor]);
  const data = context.data;
  const busy = rehearsal.isPending || apply.isPending;
  const result = rehearsal.data;
  return (
    <div>
      <p className="small muted">{text.explanation}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!data) return;
          rehearsal.mutate({
            hostId,
            source,
            proposedRestartDefault: choice,
            groups: group.length > 1 ? [group] : [],
            ...(source === "synthetic" ? { events: rows.map((row) => eventOf(row, data.now)) } : {}),
          });
        }}
      >
        <label>
          {text.host}{" "}
          <select
            aria-label={text.hostLabel}
            value={hostId}
            disabled={busy}
            onChange={(event) => {
              setHostId(event.target.value);
              resetPlan();
            }}
          >
            <option value="">{text.chooseHost}</option>
            {hosts.data?.map((host) => (
              <option key={host.id} value={host.id}>
                {host.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || hostId === ""}
          onClick={() => {
            resetPlan();
            void context.refetch();
          }}
        >
          {text.refresh}
        </button>
        {context.isFetching && <Loading />}
        {data && (
          <>
            <p className="small">
              {text.currentDefault} <strong>{wordsOf(data.restartDefault)}</strong>
              {TEXT.sentenceEnd} {data.dryRun ? text.watchingHost : text.liveHost}
            </p>
            <label>
              {text.proposedPolicy}{" "}
              <select
                aria-label={text.proposedPolicy}
                value={choice}
                disabled={busy || !admin}
                onChange={(event) => {
                  setChoice(event.target.value as HostRestartChoice);
                  resetPlan();
                }}
              >
                {HOST_RESTART_CHOICES.map((policy) => (
                  <option key={policy} value={policy}>
                    {wordsOf(policy)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {text.eventSource}{" "}
              <select
                aria-label={text.eventSourceLabel}
                value={source}
                disabled={busy}
                onChange={(event) => {
                  setSource(event.target.value as typeof source);
                  resetPlan();
                }}
              >
                <option value="synthetic">{text.sources.synthetic}</option>
                <option value="history">{text.sources.history}</option>
              </select>
            </label>
            {source === "synthetic" && (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{text.columns.seconds}</th>
                        <th>{text.columns.event}</th>
                        <th>{text.columns.detail}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={index}>
                          <td>
                            <input
                              aria-label={text.rowSeconds(index + 1)}
                              type="number"
                              required
                              min={0}
                              max={REHEARSAL_FORM.latestSeconds}
                              step={1}
                              value={row.seconds}
                              disabled={busy}
                              onChange={(event) => {
                                setRows((current) =>
                                  current.map((item, at) =>
                                    at === index ? { ...item, seconds: Number(event.target.value) } : item,
                                  ),
                                );
                                resetPlan();
                              }}
                            />
                          </td>
                          <td>
                            <select
                              aria-label={text.rowType(index + 1)}
                              value={row.kind}
                              disabled={busy}
                              onChange={(event) => {
                                setRows((current) =>
                                  current.map((item, at) =>
                                    at === index ? { ...item, kind: event.target.value as Row["kind"] } : item,
                                  ),
                                );
                                resetPlan();
                              }}
                            >
                              {Object.entries(EVENT_LABELS).map(([kind, label]) => (
                                <option key={kind} value={kind}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {named(row.kind) && (
                              <select
                                aria-label={text.rowContainer(index + 1)}
                                value={row.name}
                                disabled={busy}
                                onChange={(event) => {
                                  setRows((current) =>
                                    current.map((item, at) =>
                                      at === index ? { ...item, name: event.target.value } : item,
                                    ),
                                  );
                                  resetPlan();
                                }}
                              >
                                {data.containers.map((container) => (
                                  <option key={container.name} value={container.name}>
                                    {container.name}
                                  </option>
                                ))}
                              </select>
                            )}
                            {row.kind === "runner-restart" && (
                              <label>
                                <input
                                  type="checkbox"
                                  checked={row.statePreserved}
                                  disabled={busy}
                                  onChange={(event) => {
                                    setRows((current) =>
                                      current.map((item, at) =>
                                        at === index ? { ...item, statePreserved: event.target.checked } : item,
                                      ),
                                    );
                                    resetPlan();
                                  }}
                                />
                                {text.statePreserved}
                              </label>
                            )}
                            {row.kind === "clock-change" && (
                              <label>
                                {text.clockOffset}{" "}
                                <input
                                  type="number"
                                  min={-REHEARSAL_FORM.clockOffsetSeconds}
                                  max={REHEARSAL_FORM.clockOffsetSeconds}
                                  value={row.clockOffsetSeconds}
                                  disabled={busy}
                                  onChange={(event) => {
                                    setRows((current) =>
                                      current.map((item, at) =>
                                        at === index
                                          ? { ...item, clockOffsetSeconds: Number(event.target.value) }
                                          : item,
                                      ),
                                    );
                                    resetPlan();
                                  }}
                                />
                              </label>
                            )}
                          </td>
                          <td>
                            <button
                              type="button"
                              aria-label={text.removeRow(index + 1)}
                              disabled={busy || rows.length <= 1}
                              onClick={() => {
                                setRows((current) => current.filter((_item, at) => at !== index));
                                resetPlan();
                              }}
                            >
                              {text.remove}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  disabled={busy || rows.length >= REHEARSAL_FORM.rows}
                  onClick={() => {
                    setRows((current) => [
                      ...current,
                      {
                        ...initialRows(data.containers[0]?.name ?? "")[0]!,
                        seconds: (current.at(-1)?.seconds ?? 0) + REHEARSAL_FORM.stepSeconds,
                      },
                    ]);
                    resetPlan();
                  }}
                >
                  {text.addRow}
                </button>
                {data.containers.length > 1 && (
                  <fieldset disabled={busy}>
                    <legend>{text.group}</legend>
                    <p className="small muted">{text.groupExplanation}</p>
                    {data.containers.map((container) => (
                      <label key={container.name}>
                        <input
                          type="checkbox"
                          checked={group.includes(container.name)}
                          onChange={(event) => {
                            setGroup((current) =>
                              event.target.checked
                                ? [...current, container.name]
                                : current.filter((name) => name !== container.name),
                            );
                            resetPlan();
                          }}
                        />
                        {container.name}
                      </label>
                    ))}
                  </fieldset>
                )}
              </>
            )}
            <button
              type="submit"
              className="primary"
              disabled={
                busy ||
                !admin ||
                (source === "synthetic" && (!rows.length || rows.some((row) => named(row.kind) && !row.name)))
              }
            >
              {text.run}
            </button>
            {!admin && <p className="muted small">{text.adminOnly}</p>}
          </>
        )}
      </form>
      <ErrorNotice error={hosts.error ?? context.error ?? rehearsal.error ?? apply.error} />
      {result && (
        <section aria-label={text.result}>
          <h3>{text.difference}</h3>
          <p>{text.hostDefault(wordsOf(result.change.before), wordsOf(result.change.after))}</p>
          {result.change.containers.length > 0 ? (
            <ul>
              {result.change.containers.map((container) => (
                <li key={container.name}>
                  {text.containerChange(container.name, wordsOf(container.before), wordsOf(container.after))}
                </li>
              ))}
            </ul>
          ) : (
            <p>{text.noContainerChanges}</p>
          )}
          <ul className="small muted">
            {[...result.evidence.assumptions, ...result.proposed.assumptions].map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{text.decisionColumns.at}</th>
                  <th>{text.decisionColumns.container}</th>
                  <th>{text.decisionColumns.event}</th>
                  <th>{text.decisionColumns.current}</th>
                  <th>{text.decisionColumns.proposed}</th>
                  <th>{text.decisionColumns.credits}</th>
                </tr>
              </thead>
              <tbody>
                {result.proposed.decisions.map((decision, index) => (
                  <tr key={index}>
                    <td>{new Date(decision.at).toLocaleString()}</td>
                    <td>{decision.name ?? TEXT.maintenance.wholeHost}</td>
                    <td>{EVENT_LABELS[decision.event]}</td>
                    <td>
                      {wordsOf(result.current.decisions[index]!.result)}
                      {TEXT.separator}
                      {REASONS[result.current.decisions[index]!.reason]}
                    </td>
                    <td>
                      {wordsOf(decision.result)}
                      {TEXT.separator}
                      {REASONS[decision.reason]}
                    </td>
                    <td>{text.credits(decision.restartsUsed, MAX_RESTARTS_PER_WINDOW)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {admin && result.change.before !== result.change.after && (
            <div className="notice warning">
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                {text.reviewed}
              </label>
              <button
                type="button"
                disabled={!reviewed || busy || apply.isSuccess}
                onClick={() => apply.mutate(result)}
              >
                {text.apply}
              </button>
            </div>
          )}
        </section>
      )}
      {apply.isSuccess && <p role="status">{text.applied}</p>}
    </div>
  );
}

export function PolicyRehearsal({ admin }: { admin: boolean }) {
  const location = useLocation();
  const [parameters] = useSearchParams();
  const [open, setOpen] = useState(location.hash === "#policy-rehearsal");
  useEffect(() => {
    if (location.hash === "#policy-rehearsal") setOpen(true);
  }, [location.hash]);
  return (
    <details id="policy-rehearsal" className="card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{text.title}</summary>
      {open && <RehearsalForm admin={admin} initialHostId={parameters.get("hostId") ?? ""} />}
    </details>
  );
}
