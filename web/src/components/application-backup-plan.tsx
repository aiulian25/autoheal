import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import {
  APPLICATION_BACKUP_ARTIFACT_STATUS,
  APPLICATION_BACKUP_OPERATION,
  APPLICATION_BACKUP_RUN_STATUS,
  APPLICATION_BACKUPS,
  APPLICATION_BOOT_DRILL,
  OPEN_APPLICATION_BACKUP_RUN_STATUSES,
  type ApplicationBackupRunStatus,
  type ApplicationBackupsView,
  type ApplicationPlanDefinition,
  type RequestedApplicationBackupOperation,
} from "../../../src/shared/application-backups.js";
import { BYTES_PER_MEBIBYTE, MILLISECONDS_PER_SECOND } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { APPLICATION_BACKUP_FORM, TEXT } from "../constants.js";
import { hostsQuery } from "../queries.js";
import { ErrorNotice, Loading, TimeAgo } from "./common.js";
import { RestoreDrillResult } from "./restore-drill-result.js";
const key = ["application-backups"];
const bootText = TEXT.applicationBackups.boot;
const text = TEXT.applicationBackups.plans;
const OPEN_RUNS: readonly ApplicationBackupRunStatus[] = OPEN_APPLICATION_BACKUP_RUN_STATUSES;
type Plan = ApplicationBackupsView["plans"][number];

// How often a plan takes a backup: on a schedule, by hand, or not while paused.
function scheduleOf(plan: Plan): string {
  if (!plan.enabled) return text.paused;
  if (plan.definition.intervalHours === null) return text.manual;
  return text.every(plan.definition.intervalHours);
}
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
        throw new Error(text.unavailable);
      return value;
    },
    refetchInterval: APPLICATION_BACKUP_FORM.refreshMilliseconds,
  });
  const hosts = useQuery(hostsQuery);
  const [name, setName] = useState(""),
    [host, setHost] = useState(""),
    [container, setContainer] = useState(""),
    [interval, setInterval] = useState(""),
    [mount, setMount] = useState(""),
    [path, setPath] = useState(""),
    [bootAllowed, setBootAllowed] = useState(false),
    [readySeconds, setReadySeconds] = useState(String(APPLICATION_BACKUP_FORM.readySeconds)),
    [testSettings, setTestSettings] = useState(""),
    [bootAsked, setBootAsked] = useState<string | null>(null);
  const [exclusive, setExclusive] = useState(false);
  const [preview, setPreview] = useState<{ id: string; planId: string; artifactId: string } | null>(null),
    [approved, setApproved] = useState(false),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MILLISECONDS_PER_SECOND);
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
      operation: RequestedApplicationBackupOperation;
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
    mutationFn: (plan: Plan) =>
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
      retain: APPLICATION_BACKUP_FORM.retain,
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
      <h2>{text.title}</h2>
      <p>{text.explanation}</p>
      <p className="notice warning">
        {text.budget(
          APPLICATION_BACKUPS.storedBytes / BYTES_PER_MEBIBYTE,
          APPLICATION_BACKUPS.sourceBytes / BYTES_PER_MEBIBYTE,
          APPLICATION_BACKUPS.mounts,
        )}
      </p>
      <ErrorNotice
        error={
          view.error ?? create.error ?? action.error ?? prepare.error ?? restore.error ?? resume.error ?? toggle.error
        }
      />
      {!view.data && !view.error && <Loading />}
      {view.data && !view.data.available && <p className="notice warning">{text.needsPassphrase}</p>}
      {view.data?.available && (
        <details>
          <summary>{text.create}</summary>
          <form onSubmit={submit} className="form-grid">
            <label>
              {text.name}
              <input
                required
                maxLength={APPLICATION_BACKUPS.nameCharacters}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {text.host}
              <select required value={host} onChange={(e) => setHost(e.target.value)}>
                <option value="">{text.chooseHost}</option>
                {hosts.data?.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {text.containerName}
              <input
                required
                maxLength={APPLICATION_BACKUPS.containerNameCharacters}
                value={container}
                onChange={(e) => setContainer(e.target.value)}
              />
            </label>
            <label>
              {text.repeat}
              <input
                type="number"
                min={APPLICATION_BACKUPS.scheduleMinimumHours}
                max={APPLICATION_BACKUPS.scheduleMaximumHours}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              />
            </label>
            <label>
              {text.sqliteMount}
              <input
                placeholder={text.sqliteMountExample}
                value={mount}
                onChange={(e) => setMount(e.target.value)}
                required={!!path}
              />
            </label>
            <label>
              {text.sqliteFile}
              <input
                placeholder={text.sqliteFileExample}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                required={!!mount}
              />
            </label>
            <p className="muted">{text.sqliteNote}</p>
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
              {text.exclusive}
            </label>
            <button type="submit" disabled={create.isPending || !exclusive}>
              {text.save}
            </button>
          </form>
        </details>
      )}
      {view.data?.plans.map((plan) => {
        const artifacts = view.data.artifacts.filter(
          (a) => a.planId === plan.id && a.status === APPLICATION_BACKUP_ARTIFACT_STATUS.ready,
        );
        const active = view.data.runs.some((r) => r.hostId === plan.hostId && OPEN_RUNS.includes(r.status));
        return (
          <section key={plan.id} className="card">
            <h3>{plan.definition.name}</h3>
            <p>
              {plan.definition.containerName}
              {TEXT.separator}
              {scheduleOf(plan)}
              {TEXT.separator}
              {text.keep(plan.definition.retain)}
            </p>
            <div className="row">
              <button
                type="button"
                disabled={busy || active}
                onClick={() => action.mutate({ planId: plan.id, operation: APPLICATION_BACKUP_OPERATION.capture })}
              >
                {text.capture}
              </button>
              <button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate(plan)}>
                {plan.enabled ? text.pause : text.enable}
              </button>
            </div>
            {bootAsked !== null && artifacts.some(({ id }) => id === bootAsked) && (
              <div className="notice warning small">
                <p>{bootText.confirm}</p>
                <button
                  type="button"
                  disabled={busy || active}
                  onClick={() => {
                    action.mutate({
                      planId: plan.id,
                      operation: APPLICATION_BACKUP_OPERATION.bootDrill,
                      artifactId: bootAsked,
                    });
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
                    text.notDrilled
                  ) : (
                    <>
                      {bootText.integrityVerified} <TimeAgo timestamp={artifact.lastDrillAt} />
                    </>
                  )}
                  {artifact.retained ? `${TEXT.separator}${text.retained}` : ""}
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
                  onClick={() =>
                    action.mutate({
                      planId: plan.id,
                      operation: APPLICATION_BACKUP_OPERATION.drill,
                      artifactId: artifact.id,
                    })
                  }
                >
                  {text.drill}
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
                  {text.reviewRestore}
                </button>
              </div>
            ))}
          </section>
        );
      })}
      {preview && (
        <section className="notice warning" aria-label={text.restoreReview}>
          <h3>{text.replacement}</h3>
          {review?.failure && <p role="status">{TEXT.applicationBackups.failure[review.failure]}</p>}
          {awaitingWriters && <p role="status">{text.awaitingWriters}</p>}
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
                  <p>{text.willStop}</p>
                  <label>
                    <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                    {text.approve}
                  </label>
                  <button
                    type="button"
                    disabled={!approved || !fresh || restore.isPending}
                    onClick={() => restore.mutate()}
                  >
                    {text.restore}
                  </button>
                  {!fresh && <p role="status">{text.expired}</p>}
                </>
              )}
            </>
          )}
          <button type="button" disabled={restore.isPending} onClick={() => setPreview(null)}>
            {text.cancel}
          </button>
        </section>
      )}
      {view.data?.runs
        .filter((run) => run.operation !== APPLICATION_BACKUP_OPERATION.preview)
        .slice(0, APPLICATION_BACKUP_FORM.runsShown)
        .map((run) => (
          <div key={run.id} className="card">
            <p>
              <strong>
                {run.operation}
                {TEXT.separator}
                {run.status}
              </strong>{" "}
              <TimeAgo timestamp={run.createdAt} />
            </p>
            {run.result && <p>{run.result.message}</p>}
            {run.result?.boot && <RestoreDrillResult boot={run.result.boot} />}
            {run.failure && <p>{TEXT.applicationBackups.failure[run.failure]}</p>}
            {run.result?.stopped.length ? (
              <p className="notice warning">{text.stillBlocks(run.result.stopped.join(TEXT.listComma))}</p>
            ) : null}
            {run.status === APPLICATION_BACKUP_RUN_STATUS.recoveryRequired && (
              <button type="button" disabled={resume.isPending} onClick={() => resume.mutate(run.id)}>
                {text.resume}
              </button>
            )}
          </div>
        ))}
    </section>
  );
}
