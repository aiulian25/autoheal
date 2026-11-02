import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { API_ROUTES, apiPath, type HostControlView } from "../../../src/shared/api.js";
import {
  HOST_RESTART_CHOICES,
  MAX_RESTARTS_PER_WINDOW,
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
import { ErrorNotice, Loading } from "./common.js";

const EVENT_LABELS: Record<RehearsalEvent["kind"], string> = {
  failure: "Container fails",
  stop: "Planned stop",
  "operation-start": "Group operation starts",
  "operation-end": "Group operation ends",
  "host-operation-start": "Host operation starts",
  "host-operation-end": "Host operation ends",
  offline: "Runner loses connection",
  online: "Runner receives fresh policy",
  "runner-restart": "Runner restarts",
  "clock-change": "Runner clock changes",
};
const REASONS: Record<RehearsalReason, string> = {
  allowed: "Restart permitted",
  "empty-name": "Missing container",
  "safety-state": "Recovery safety state unavailable",
  protected: "Protected container",
  "operation-held": "Another operation holds this resource",
  maintenance: "Maintenance window active",
  "deliberate-stop": "Recent deliberate stop",
  cooldown: "Incident cooldown active",
  "restart-budget": "Hourly restart budget exhausted",
  "policy-unavailable": "Fresh maintenance policy unavailable",
  "policy-ask": "A person's approval is required",
  "policy-tell": "Policy only reports failures",
  "policy-ignore": "Policy leaves this container unwatched",
  "dry-run": "Would restart; no Docker change",
  "runner-restart": "Runner reconstructed",
  "clock-change": "Clock change recorded",
  "state-updated": "Scenario state updated",
};
const named = (kind: RehearsalEvent["kind"]) => ["failure", "stop", "operation-start", "operation-end"].includes(kind);
interface Row {
  seconds: number;
  kind: RehearsalEvent["kind"];
  name: string;
  clockOffsetSeconds: number;
  statePreserved: boolean;
}
const initialRows = (name: string): Row[] =>
  [0, 61, 600, 1200, 3600].map((seconds) => ({
    seconds,
    kind: "failure",
    name,
    clockOffsetSeconds: 0,
    statePreserved: true,
  }));
const eventOf = (row: Row, start: number): RehearsalEvent => {
  const at = start + row.seconds * 1000;
  if (row.kind === "runner-restart") return { at, kind: row.kind, statePreserved: row.statePreserved };
  if (row.kind === "clock-change") return { at, kind: row.kind, offsetMilliseconds: row.clockOffsetSeconds * 1000 };
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
      if (current.restartDefault !== result.change.before)
        throw new ReadableError(
          "This host's default changed after rehearsal. Refresh and rehearse the current policy before applying.",
        );
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
      <p className="small muted">
        Rehearse guard decisions without Docker or model calls. A rehearsal does not prove application recovery or
        checkpoint compatibility. Current policy is unchanged until you separately review and apply a default below.
      </p>
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
          Host{" "}
          <select
            aria-label="Rehearsal host"
            value={hostId}
            disabled={busy}
            onChange={(event) => {
              setHostId(event.target.value);
              resetPlan();
            }}
          >
            <option value="">Choose a host</option>
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
          Refresh current controls
        </button>
        {context.isFetching && <Loading />}
        {data && (
          <>
            <p className="small">
              Current default: <strong>{wordsOf(data.restartDefault)}</strong>.{" "}
              {data.dryRun
                ? "This host only watches; reached restart stages reserve credits but do not change Docker."
                : "Live host: rehearsal still performs no action."}
            </p>
            <label>
              Proposed failure policy{" "}
              <select
                aria-label="Proposed failure policy"
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
              Event source{" "}
              <select
                aria-label="Rehearsal event source"
                value={source}
                disabled={busy}
                onChange={(event) => {
                  setSource(event.target.value as typeof source);
                  resetPlan();
                }}
              >
                <option value="synthetic">Custom timeline</option>
                <option value="history">Captured failures from the last seven days</option>
              </select>
            </label>
            {source === "synthetic" && (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Seconds after start</th>
                        <th>Event</th>
                        <th>Container / detail</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={index}>
                          <td>
                            <input
                              aria-label={`Event ${index + 1} seconds`}
                              type="number"
                              required
                              min={0}
                              max={604800}
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
                              aria-label={`Event ${index + 1} type`}
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
                                aria-label={`Event ${index + 1} container`}
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
                                Saved safety state available
                              </label>
                            )}
                            {row.kind === "clock-change" && (
                              <label>
                                Clock offset in seconds{" "}
                                <input
                                  type="number"
                                  min={-86400}
                                  max={86400}
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
                              aria-label={`Remove event ${index + 1}`}
                              disabled={busy || rows.length <= 1}
                              onClick={() => {
                                setRows((current) => current.filter((_item, at) => at !== index));
                                resetPlan();
                              }}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  disabled={busy || rows.length >= 50}
                  onClick={() => {
                    setRows((current) => [
                      ...current,
                      {
                        ...initialRows(data.containers[0]?.name ?? "")[0]!,
                        seconds: (current.at(-1)?.seconds ?? 0) + 60,
                      },
                    ]);
                    resetPlan();
                  }}
                >
                  Add event
                </button>
                {data.containers.length > 1 && (
                  <fieldset disabled={busy}>
                    <legend>Declared dependency group for this scenario</legend>
                    <p className="small muted">
                      Selected members share an operation hold in this rehearsal. Confirm the real dependency graph
                      separately.
                    </p>
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
              Run policy rehearsal
            </button>
            {!admin && <p className="muted small">An administrator runs and applies policy rehearsals.</p>}
          </>
        )}
      </form>
      <ErrorNotice error={hosts.error ?? context.error ?? rehearsal.error ?? apply.error} />
      {result && (
        <section aria-label="Policy rehearsal result">
          <h3>Reviewed policy difference</h3>
          <p>
            Host default: {wordsOf(result.change.before)} → {wordsOf(result.change.after)}. Explicit container overrides
            and protected resources stay in force.
          </p>
          {result.change.containers.length > 0 ? (
            <ul>
              {result.change.containers.map((container) => (
                <li key={container.name}>
                  {container.name}: {wordsOf(container.before)} → {wordsOf(container.after)}
                </li>
              ))}
            </ul>
          ) : (
            <p>No existing container inherits a different choice in this rehearsal.</p>
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
                  <th>At</th>
                  <th>Container</th>
                  <th>Event</th>
                  <th>Current policy</th>
                  <th>Proposed policy</th>
                  <th>Credits used</th>
                </tr>
              </thead>
              <tbody>
                {result.proposed.decisions.map((decision, index) => (
                  <tr key={index}>
                    <td>{new Date(decision.at).toLocaleString()}</td>
                    <td>{decision.name ?? "Whole host"}</td>
                    <td>{EVENT_LABELS[decision.event]}</td>
                    <td>
                      {wordsOf(result.current.decisions[index]!.result)} ·{" "}
                      {REASONS[result.current.decisions[index]!.reason]}
                    </td>
                    <td>
                      {wordsOf(decision.result)} · {REASONS[decision.reason]}
                    </td>
                    <td>
                      {decision.restartsUsed} / {MAX_RESTARTS_PER_WINDOW}
                    </td>
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
                I reviewed the default change and the rehearsal assumptions.
              </label>
              <button
                type="button"
                disabled={!reviewed || busy || apply.isSuccess}
                onClick={() => apply.mutate(result)}
              >
                Apply reviewed host default
              </button>
            </div>
          )}
        </section>
      )}
      {apply.isSuccess && (
        <p role="status">
          Host default saved through the normal control policy. Runners receive it at their next heartbeat.
        </p>
      )}
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
      <summary>Rehearse recovery policy</summary>
      {open && <RehearsalForm admin={admin} initialHostId={parameters.get("hostId") ?? ""} />}
    </details>
  );
}
