import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import {
  APPLICATION_BACKUPS,
  APPLICATION_BOOT_DRILL,
  type ApplicationBackupsView,
  type ApplicationPlanDefinition,
} from "../../../src/shared/application-backups.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { hostsQuery } from "../queries.js";
import { ErrorNotice, Loading, TimeAgo } from "./common.js";
import { RestoreDrillResult } from "./restore-drill-result.js";
const key = ["application-backups"];
const bootText = TEXT.applicationBackups.boot;
// One NAME=value a line; what has no name is left out, and the server checks what is left.
const settingsFrom = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("=") && !line.startsWith("="))
    .map((line) => {
      const split = line.indexOf("=");
      return { name: line.slice(0, split), value: line.slice(split + 1) };
    });
export function ApplicationBackupPlans() {
  const client = useQueryClient();
  const view = useQuery({
    queryKey: key,
    queryFn: async () => {
      const value = await api<ApplicationBackupsView>("GET", API_ROUTES.applicationBackups);
      if (!value || !Array.isArray(value.plans) || !Array.isArray(value.runs) || !Array.isArray(value.artifacts))
        throw new Error("Application backup plans are unavailable. Refresh after updating the dashboard.");
      return value;
    },
    refetchInterval: 3000,
  });
  const hosts = useQuery(hostsQuery);
  const [name, setName] = useState(""),
    [host, setHost] = useState(""),
    [container, setContainer] = useState(""),
    [interval, setInterval] = useState(""),
    [mount, setMount] = useState(""),
    [path, setPath] = useState(""),
    [bootAllowed, setBootAllowed] = useState(false),
    [readySeconds, setReadySeconds] = useState("30"),
    [testSettings, setTestSettings] = useState(""),
    [bootAsked, setBootAsked] = useState<string | null>(null);
  const [exclusive, setExclusive] = useState(false);
  const [preview, setPreview] = useState<{ id: string; planId: string; artifactId: string } | null>(null),
    [approved, setApproved] = useState(false),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: (definition: ApplicationPlanDefinition) =>
      api("POST", API_ROUTES.applicationBackups, { hostId: host, definition, enabled: true }),
    onSuccess: async () => {
      setName("");
      setContainer("");
      await refresh();
    },
  });
  const action = useMutation({
    mutationFn: ({
      planId,
      operation,
      artifactId,
    }: {
      planId: string;
      operation: "capture" | "drill" | "boot-drill";
      artifactId?: string;
    }) =>
      api("POST", apiPath(API_ROUTES.applicationBackupRun, { planId }), {
        operation,
        artifactId,
        requestKey: crypto.randomUUID(),
      }),
    onSuccess: refresh,
  });
  const prepare = useMutation({
    mutationFn: async ({ planId, artifactId }: { planId: string; artifactId: string }) => {
      const result = await api<{ id: string }>("POST", apiPath(API_ROUTES.applicationBackupPrepare, { planId }), {
        artifactId,
      });
      return { ...result, planId, artifactId };
    },
    onSuccess: async (value) => {
      setPreview(value);
      setApproved(false);
      await refresh();
    },
  });
  const restore = useMutation({
    mutationFn: () =>
      api("POST", apiPath(API_ROUTES.applicationBackupRestore, { planId: preview!.planId }), {
        artifactId: preview!.artifactId,
        previewRunId: preview!.id,
        requestKey: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      setPreview(null);
      setApproved(false);
      await refresh();
    },
  });
  const resume = useMutation({
    mutationFn: (runId: string) => api("POST", apiPath(API_ROUTES.applicationBackupResume, { runId })),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (plan: ApplicationBackupsView["plans"][number]) =>
      api("PUT", apiPath(API_ROUTES.applicationBackupPlan, { planId: plan.id }), {
        revision: plan.revision,
        hostId: plan.hostId,
        definition: plan.definition,
        enabled: !plan.enabled,
      }),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      version: 1,
      name,
      containerName: container,
      consistency: "coordinated-clean-stop",
      exclusiveDockerWriters: true,
      sqlite: mount && path ? { mountTarget: mount, path } : null,
      intervalHours: interval ? Number(interval) : null,
      retain: 3,
      bootDrill: bootAllowed ? { readySeconds: Number(readySeconds), environment: settingsFrom(testSettings) } : null,
    });
  };
  const review = view.data?.runs.find((run) => run.id === preview?.id);
  const awaitingWriters = !review?.result && !review?.failure;
  const fresh =
    !!review?.finishedAt &&
    Math.max(now, Date.now()) >= review.finishedAt &&
    Math.max(now, Date.now()) - review.finishedAt < APPLICATION_BACKUPS.reviewMilliseconds;
  const busy = action.isPending || prepare.isPending || restore.isPending;
  return (
    <section className="card" id="application-plans">
      <h2>Application backup plans</h2>
      <p>
        Application data is separate from the dashboard database backup above. These plans stop every service that
        shares writable data, require clean exits, and encrypt both file data and the backup manifest. This is a
        coordinated file backup, not a database-native dump.
      </p>
      <p className="notice warning">
        Storage budget: 512 MiB of encrypted application artifacts per dashboard. Initial limit:{" "}
        {APPLICATION_BACKUPS.sourceBytes / 1024 / 1024} MiB of source data per plan, up to {APPLICATION_BACKUPS.mounts}{" "}
        local Docker directory volumes. Bind mounts, remote/aliased drivers and shutdown grace periods over 30 seconds
        are unsupported. Larger data, unsupported metadata and unclean shutdowns are refused. Schedules cause service
        downtime. A restore drill uses isolated copies and leaves live data unchanged.
      </p>
      <ErrorNotice
        error={
          view.error ?? create.error ?? action.error ?? prepare.error ?? restore.error ?? resume.error ?? toggle.error
        }
      />
      {!view.data && !view.error && <Loading />}
      {view.data && !view.data.available && (
        <p className="notice warning">
          Set a protected backup passphrase before creating application plans. A connected, updated runner is required.
        </p>
      )}
      {view.data?.available && (
        <details>
          <summary>Create application plan</summary>
          <form onSubmit={submit} className="form-grid">
            <label>
              Plan name
              <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Host
              <select required value={host} onChange={(e) => setHost(e.target.value)}>
                <option value="">Choose host</option>
                {hosts.data?.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Container name
              <input required maxLength={256} value={container} onChange={(e) => setContainer(e.target.value)} />
            </label>
            <label>
              Repeat every (hours; blank for manual)
              <input type="number" min={1} max={8760} value={interval} onChange={(e) => setInterval(e.target.value)} />
            </label>
            <label>
              Optional SQLite mount target
              <input placeholder="/data" value={mount} onChange={(e) => setMount(e.target.value)} required={!!path} />
            </label>
            <label>
              SQLite file within that mount
              <input
                placeholder="app.sqlite"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                required={!!mount}
              />
            </label>
            <p className="muted">
              SQLite drills run only the fixed read-only integrity check. No commands, SQL or credentials are accepted.
              Keep the dashboard backup passphrase separately: it protects the independent application backup keys.
            </p>
            <label>
              <input type="checkbox" checked={bootAllowed} onChange={(e) => setBootAllowed(e.target.checked)} />{" "}
              {bootText.allow}
            </label>
            <p className="muted">{bootText.allowNote}</p>
            <p className="muted">{bootText.healthCheckNote}</p>
            {bootAllowed && (
              <>
                <label>
                  {bootText.readySeconds}
                  <input
                    type="number"
                    min={APPLICATION_BOOT_DRILL.readyMinimumSeconds}
                    max={APPLICATION_BOOT_DRILL.readyMaximumSeconds}
                    required
                    value={readySeconds}
                    onChange={(e) => setReadySeconds(e.target.value)}
                  />
                </label>
                <label>
                  {bootText.environment}
                  <textarea value={testSettings} onChange={(e) => setTestSettings(e.target.value)} />
                </label>
                <p className="muted">{bootText.environmentNote}</p>
              </>
            )}
            <label>
              <input
                type="checkbox"
                required
                checked={exclusive}
                onChange={(event) => setExclusive(event.target.checked)}
              />
              I confirm that only Docker containers write these local volumes; no host process or external export writes
              to them.
            </label>
            <button type="submit" disabled={create.isPending || !exclusive}>
              Save plan
            </button>
          </form>
        </details>
      )}
      {view.data?.plans.map((plan) => {
        const artifacts = view.data.artifacts.filter((a) => a.planId === plan.id && a.status === "ready");
        const active = view.data.runs.some(
          (r) =>
            r.hostId === plan.hostId &&
            (r.status === "queued" || r.status === "running" || r.status === "recovery-required"),
        );
        return (
          <section key={plan.id} className="card">
            <h3>{plan.definition.name}</h3>
            <p>
              {plan.definition.containerName} ·{" "}
              {plan.enabled
                ? plan.definition.intervalHours
                  ? `Every ${plan.definition.intervalHours} hours`
                  : "Manual captures"
                : "Paused"}{" "}
              · Keep {plan.definition.retain} backups
            </p>
            <div className="row">
              <button
                type="button"
                disabled={busy || active}
                onClick={() => action.mutate({ planId: plan.id, operation: "capture" })}
              >
                Capture application backup
              </button>
              <button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate(plan)}>
                {plan.enabled ? "Pause plan" : "Enable plan"}
              </button>
            </div>
            {bootAsked !== null && artifacts.some(({ id }) => id === bootAsked) && (
              <div className="notice warning small">
                <p>{bootText.confirm}</p>
                <button
                  type="button"
                  disabled={busy || active}
                  onClick={() => {
                    action.mutate({ planId: plan.id, operation: "boot-drill", artifactId: bootAsked });
                    setBootAsked(null);
                  }}
                >
                  {bootText.confirmRun}
                </button>
                <button type="button" onClick={() => setBootAsked(null)}>
                  {bootText.cancel}
                </button>
              </div>
            )}
            {artifacts.map((artifact) => (
              <div key={artifact.id} className="row">
                <TimeAgo timestamp={artifact.createdAt} />
                <span>
                  {artifact.lastDrillAt === null ? (
                    "Not yet restore-drilled"
                  ) : (
                    <>
                      {bootText.integrityVerified} <TimeAgo timestamp={artifact.lastDrillAt} />
                    </>
                  )}
                  {artifact.retained ? " · Retained for recovery" : ""}
                </span>
                {plan.definition.bootDrill != null && (
                  <span className="small">
                    {artifact.bootVerifiedAt === null ? (
                      bootText.notVerified
                    ) : (
                      <>
                        {bootText.verified} <TimeAgo timestamp={artifact.bootVerifiedAt} />
                      </>
                    )}
                  </span>
                )}
                <button
                  type="button"
                  disabled={busy || active}
                  onClick={() => action.mutate({ planId: plan.id, operation: "drill", artifactId: artifact.id })}
                >
                  Run isolated restore drill
                </button>
                {plan.definition.bootDrill != null && artifact.imageId !== null && (
                  <button type="button" disabled={busy || active} onClick={() => setBootAsked(artifact.id)}>
                    {bootText.run}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || active || !artifact.lastDrillAt}
                  onClick={() => prepare.mutate({ planId: plan.id, artifactId: artifact.id })}
                >
                  Review live restore
                </button>
              </div>
            ))}
          </section>
        );
      })}
      {preview && (
        <section className="notice warning" aria-label="Application restore review">
          <h3>Review live data replacement</h3>
          {review?.failure && <p role="status">{TEXT.applicationBackups.failure[review.failure]}</p>}
          {awaitingWriters && <p role="status">Waiting for the runner to discover every shared-data writer…</p>}
          {review?.result && (
            <>
              <p>{review.result.message}</p>
              <ul>
                {review.result.writers.map((writer) => (
                  <li key={writer}>{writer}</li>
                ))}
              </ul>
              {review.result.ok && (
                <>
                  <p>
                    These services will stop. All covered data will be replaced after an isolated integrity drill and an
                    encrypted safety backup. This review expires after one minute.
                  </p>
                  <label>
                    <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />I
                    approve replacing this application’s live data
                  </label>
                  <button
                    type="button"
                    disabled={!approved || !fresh || restore.isPending}
                    onClick={() => restore.mutate()}
                  >
                    Restore reviewed application data
                  </button>
                  {!fresh && <p role="status">Review expired. Cancel and request a fresh review.</p>}
                </>
              )}
            </>
          )}
          <button type="button" disabled={restore.isPending} onClick={() => setPreview(null)}>
            Cancel
          </button>
        </section>
      )}
      {view.data?.runs
        .filter((run) => run.operation !== "preview")
        .slice(0, 20)
        .map((run) => (
          <div key={run.id} className="card">
            <p>
              <strong>
                {run.operation} · {run.status}
              </strong>{" "}
              <TimeAgo timestamp={run.createdAt} />
            </p>
            {run.result && <p>{run.result.message}</p>}
            {run.result?.boot && <RestoreDrillResult boot={run.result.boot} />}
            {run.failure && <p>{TEXT.applicationBackups.failure[run.failure]}</p>}
            {run.result?.stopped.length ? (
              <p className="notice warning">Recovery still blocks: {run.result.stopped.join(", ")}</p>
            ) : null}
            {run.status === "recovery-required" && (
              <button type="button" disabled={resume.isPending} onClick={() => resume.mutate(run.id)}>
                Resume interrupted recovery
              </button>
            )}
          </div>
        ))}
    </section>
  );
}
