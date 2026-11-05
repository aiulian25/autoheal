import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import {
  PROBE_DNS_PORT,
  PROBE_KIND,
  PROBE_LIMITS,
  PROBE_SCOPE,
  PROBE_STATE,
  type ProbeAvailability,
  type ProbeBody,
  type ProbeTarget,
  type ProbeView,
} from "../../../src/shared/probes.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { TimeChart } from "./charts.js";
import { CertificateStatusLine } from "./certificate-status.js";
import { Badge, ErrorNotice, Loading, TimeAgo } from "./common.js";
import { VantageChoice, VantageLine } from "./probe-vantages.js";
import { hostsQuery } from "../queries.js";

const text = TEXT.probes;
const REFRESH_MILLISECONDS = 30_000;
const USUAL_STATUS = 200;
const FIGURE_DIGITS = 2;
const STATE_TONE = {
  [PROBE_STATE.unknown]: undefined,
  [PROBE_STATE.up]: "good",
  [PROBE_STATE.down]: "danger",
} as const;
const probesKey = (hostId: string) => ["probes", hostId];
const share = (value: number) => `${value.toFixed(FIGURE_DIGITS)}%`;

const BLANK = {
  name: "",
  kind: PROBE_KIND.http as ProbeTarget["kind"],
  scope: PROBE_SCOPE.localNetwork as ProbeBody["scope"],
  vantage: null as string | null,
  url: "",
  expectedStatus: String(USUAL_STATUS),
  ignoreCertificate: false,
  host: "",
  port: "",
  lookupName: "",
  server: "",
  expectedAnswer: "",
  serverName: "",
  warnDays: String(PROBE_LIMITS.warnDays.usual),
  caPem: "",
  intervalSeconds: String(PROBE_LIMITS.intervalSeconds.usual),
  timeoutSeconds: String(PROBE_LIMITS.timeoutSeconds.usual),
  failuresBeforeDown: String(PROBE_LIMITS.failuresBeforeDown.usual),
  objectivePercent: "",
};
type Draft = typeof BLANK;

function targetOf(draft: Draft): ProbeTarget {
  if (draft.kind === PROBE_KIND.http) {
    return {
      kind: PROBE_KIND.http,
      url: draft.url,
      expectedStatus: Number(draft.expectedStatus),
      ignoreCertificate: draft.ignoreCertificate,
    };
  }
  if (draft.kind === PROBE_KIND.tcp) return { kind: PROBE_KIND.tcp, host: draft.host, port: Number(draft.port) };
  if (draft.kind === PROBE_KIND.tls) {
    return {
      kind: PROBE_KIND.tls,
      host: draft.host,
      port: Number(draft.port),
      serverName: draft.serverName === "" ? null : draft.serverName,
      warnDays: Number(draft.warnDays),
      caPem: draft.caPem === "" ? null : draft.caPem,
    };
  }
  return {
    kind: PROBE_KIND.dns,
    name: draft.lookupName,
    server: draft.server === "" ? null : draft.server,
    port: PROBE_DNS_PORT,
    expectedAnswer: draft.expectedAnswer === "" ? null : draft.expectedAnswer,
  };
}

const bodyOf = (draft: Draft): ProbeBody => ({
  name: draft.name,
  scope: draft.scope,
  vantage: draft.vantage,
  intervalSeconds: Number(draft.intervalSeconds),
  timeoutSeconds: Number(draft.timeoutSeconds),
  failuresBeforeDown: Number(draft.failuresBeforeDown),
  objectivePercent: draft.objectivePercent === "" ? null : Number(draft.objectivePercent),
  target: targetOf(draft),
});

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function AddProbe({ hostId, onDone }: { hostId: string; onDone: () => void }) {
  const [draft, setDraft] = useState(BLANK);
  const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: () => api("POST", apiPath(API_ROUTES.hostProbes, { hostId }), bodyOf(draft)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: probesKey(hostId) });
      onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };
  return (
    <form className="stack small" onSubmit={submit}>
      <Field label={text.name} value={draft.name} onChange={(name) => set({ name })} />
      <label>
        {text.kind}
        <select value={draft.kind} onChange={(event) => set({ kind: event.target.value as Draft["kind"] })}>
          {Object.values(PROBE_KIND).map((kind) => (
            <option key={kind} value={kind}>
              {text.kinds[kind]}
            </option>
          ))}
        </select>
      </label>
      {draft.kind === PROBE_KIND.http && (
        <>
          <Field label={text.url} value={draft.url} onChange={(url) => set({ url })} />
          <Field
            label={text.expectedStatus}
            value={draft.expectedStatus}
            onChange={(expectedStatus) => set({ expectedStatus })}
          />
          <label>
            <input
              type="checkbox"
              checked={draft.ignoreCertificate}
              onChange={(event) => set({ ignoreCertificate: event.target.checked })}
            />{" "}
            {text.ignoreCertificate}
          </label>
        </>
      )}
      {draft.kind === PROBE_KIND.tcp && (
        <>
          <Field label={text.host} value={draft.host} onChange={(host) => set({ host })} />
          <Field label={text.port} value={draft.port} onChange={(port) => set({ port })} />
        </>
      )}
      {draft.kind === PROBE_KIND.dns && (
        <>
          <Field label={text.lookupName} value={draft.lookupName} onChange={(lookupName) => set({ lookupName })} />
          <Field label={text.server} value={draft.server} onChange={(server) => set({ server })} />
          <Field
            label={text.expectedAnswer}
            value={draft.expectedAnswer}
            onChange={(expectedAnswer) => set({ expectedAnswer })}
          />
        </>
      )}
      {draft.kind === PROBE_KIND.tls && (
        <>
          <Field label={text.host} value={draft.host} onChange={(host) => set({ host })} />
          <Field label={text.port} value={draft.port} onChange={(port) => set({ port })} />
          <Field label={text.serverName} value={draft.serverName} onChange={(serverName) => set({ serverName })} />
          <Field label={text.warnDays} value={draft.warnDays} onChange={(warnDays) => set({ warnDays })} />
          <label>
            {text.caPem}
            <textarea value={draft.caPem} onChange={(event) => set({ caPem: event.target.value })} />
          </label>
        </>
      )}
      <VantageChoice hostId={hostId} value={draft.vantage} onChange={(vantage) => set({ vantage })} />
      <label>
        {text.scope}
        <select value={draft.scope} onChange={(event) => set({ scope: event.target.value as Draft["scope"] })}>
          {Object.values(PROBE_SCOPE).map((scope) => (
            <option key={scope} value={scope}>
              {text.scopes[scope]}
            </option>
          ))}
        </select>
      </label>
      <Field
        label={text.interval}
        value={draft.intervalSeconds}
        onChange={(intervalSeconds) => set({ intervalSeconds })}
      />
      <Field label={text.timeout} value={draft.timeoutSeconds} onChange={(timeoutSeconds) => set({ timeoutSeconds })} />
      <Field
        label={text.failures}
        value={draft.failuresBeforeDown}
        onChange={(failuresBeforeDown) => set({ failuresBeforeDown })}
      />
      <Field
        label={text.objective}
        value={draft.objectivePercent}
        onChange={(objectivePercent) => set({ objectivePercent })}
      />
      <ErrorNotice error={add.error} />
      <div className="card-actions">
        <button type="submit" disabled={add.isPending}>
          {text.save}
        </button>
        <button type="button" className="quiet" onClick={onDone}>
          {text.cancel}
        </button>
      </div>
    </form>
  );
}

function objectiveWords(percent: number | null, objective: number | null) {
  if (percent === null || objective === null) return null;
  return percent >= objective ? text.objectiveMet(share(objective)) : text.objectiveMissed(share(objective));
}

function Availability({
  period,
  figures,
  objective,
}: {
  period: string;
  figures: ProbeAvailability;
  objective: number | null;
}) {
  const value = figures.percent === null ? text.noFigure : share(figures.percent);
  const notes = [
    objectiveWords(figures.percent, objective),
    figures.unknownPercent >= 1 ? text.notLooked(share(figures.unknownPercent)) : null,
  ].filter((note) => note !== null);
  return (
    <p className="small">
      {text.availability(period, value)}
      {notes.length > 0 && <span className="muted"> · {notes.join(" · ")}</span>}
    </p>
  );
}

function Probe({ hostId, probe }: { hostId: string; probe: ProbeView }) {
  const [removing, setRemoving] = useState(false);
  const hosts = useQuery(hostsQuery);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api("DELETE", apiPath(API_ROUTES.hostProbe, { hostId, probeId: probe.id })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: probesKey(hostId) }),
  });
  return (
    <article className="stack">
      <p>
        <strong>{probe.name}</strong> <Badge value={text.states[probe.state]} tone={STATE_TONE[probe.state]} />{" "}
        <span className="small muted">
          {text.since} <TimeAgo timestamp={probe.stateSince} />
        </span>{" "}
        <VantageLine vantage={probe.vantage} hosts={hosts.data ?? []} />
      </p>
      {probe.inMaintenance && <p className="small muted">{text.maintenance}</p>}
      {probe.lastProblem !== null && <p className="small text-danger">{probe.lastProblem}</p>}
      {probe.certificate !== null && probe.certificateStatus !== null && (
        <CertificateStatusLine certificate={probe.certificate} status={probe.certificateStatus} />
      )}
      <Availability period={text.periods.day} figures={probe.day} objective={probe.objectivePercent} />
      <Availability period={text.periods.month} figures={probe.month} objective={probe.objectivePercent} />
      <TimeChart
        title={text.latency}
        times={probe.samples.map(({ at }) => at)}
        format={text.milliseconds}
        series={[
          {
            label: text.latency,
            tone: "blue",
            values: probe.samples.map(({ latencyMilliseconds }) => latencyMilliseconds),
          },
        ]}
      />
      <ErrorNotice error={remove.error} />
      {!removing && (
        <div className="card-actions">
          <button type="button" className="quiet" onClick={() => setRemoving(true)}>
            {text.remove}
          </button>
        </div>
      )}
      {removing && (
        <div className="notice warning small">
          <p>{text.removeConfirm(probe.name)}</p>
          <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {text.removeYes}
          </button>
          <button type="button" className="quiet" onClick={() => setRemoving(false)}>
            {text.cancel}
          </button>
        </div>
      )}
    </article>
  );
}

/** A host's service checks: closed until asked for, and asking changes nothing until one is added. */
export function ServiceProbes({ hostId }: { hostId: string }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const probes = useQuery({
    queryKey: probesKey(hostId),
    queryFn: () => api<ProbeView[]>("GET", apiPath(API_ROUTES.hostProbes, { hostId })),
    enabled: open,
    refetchInterval: REFRESH_MILLISECONDS,
  });
  return (
    <details className="card fold" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{text.title}</summary>
      {open && (
        <div className="stack small">
          <p className="muted">{text.explanation}</p>
          {probes.isPending && <Loading />}
          <ErrorNotice error={probes.error} />
          {probes.data?.length === 0 && !adding && <p className="muted">{text.none}</p>}
          {probes.data?.map((probe) => (
            <Probe key={probe.id} hostId={hostId} probe={probe} />
          ))}
          {adding ? (
            <AddProbe hostId={hostId} onDone={() => setAdding(false)} />
          ) : (
            <div className="card-actions">
              <button type="button" onClick={() => setAdding(true)}>
                {text.add}
              </button>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
