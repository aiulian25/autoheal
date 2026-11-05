import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { HOST_KIND } from "../../../src/shared/constants.js";
import type { ProbeView } from "../../../src/shared/probes.js";
import {
  REBOOT_PLAN,
  REBOOT_PLAN_ROUTES,
  REBOOT_PLAN_STATUS,
  type RebootPlanBody,
  type RebootPlanPreview,
  type RebootPlanView,
} from "../../../src/shared/reboot-plans.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { Badge, ErrorNotice } from "./common.js";

const text = TEXT.rebootPlans;
const PLANS_KEY = ["reboot-plans"];
/** What the review called a check, for saying which one has gone since. */
const checkName = (preview: RebootPlanPreview, probeId: string) =>
  preview.checks.find((check) => check.probeId === probeId)?.name ?? text.checkGoneUnnamed;
const isOpen = ({ status }: RebootPlanView) =>
  status === REBOOT_PLAN_STATUS.running || status === REBOOT_PLAN_STATUS.paused;
const momentOf = (value: string) => (value === "" ? null : new Date(value).getTime());

function ActivePlan({ plan }: { plan: RebootPlanView }) {
  const [cancelling, setCancelling] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: PLANS_KEY });
  const act = useMutation({
    mutationFn: (route: string) => api<RebootPlanView>("POST", apiPath(route, { planId: plan.id })),
    onSuccess: async () => {
      setCancelling(false);
      await refresh();
    },
  });
  const open = isOpen(plan);
  return (
    <div className="stack">
      <p>
        <strong>{plan.body.name}</strong> <Badge value={text.status[plan.status]} />
      </p>
      {plan.reason !== null && <p className="notice warning small">{plan.reason}</p>}
      {plan.cancelAsked && open && <p className="small muted">{text.cancelling}</p>}
      <ol className="small">
        {plan.steps.map((step) => (
          <li key={step.hostId}>
            {step.hostLabel}: {text.step[step.status]}
          </li>
        ))}
      </ol>
      <ErrorNotice error={act.error} />
      {open && !plan.cancelAsked && !cancelling && (
        <div className="card-actions">
          {plan.status === REBOOT_PLAN_STATUS.paused && (
            <button type="button" disabled={act.isPending} onClick={() => act.mutate(REBOOT_PLAN_ROUTES.resume)}>
              {text.resume}
            </button>
          )}
          <button type="button" className="quiet" onClick={() => setCancelling(true)}>
            {text.cancel}
          </button>
        </div>
      )}
      {cancelling && (
        <div className="notice warning small">
          <p>{text.cancelConfirm}</p>
          <button type="button" disabled={act.isPending} onClick={() => act.mutate(REBOOT_PLAN_ROUTES.cancel)}>
            {text.cancelYes}
          </button>
          <button type="button" className="quiet" onClick={() => setCancelling(false)}>
            {text.keep}
          </button>
        </div>
      )}
    </div>
  );
}

function PreviewOf({ preview }: { preview: RebootPlanPreview }) {
  return (
    <div className="stack small">
      <ol>
        {preview.hosts.map((host) => (
          <li key={host.hostId}>
            <strong>{host.label}</strong>: {host.problem ?? text.healthy} ·{" "}
            {host.rebootRequired === true ? text.needsReboot : text.noReboot}
            {host.openJobs > 0 && ` · ${text.openJobs(host.openJobs)}`}
          </li>
        ))}
      </ol>
      {preview.checks.map((check) => (
        <p key={check.probeId}>
          {check.name}: {check.problem ?? text.healthy}
        </p>
      ))}
      <p className={preview.problem === null ? "text-good" : "text-warning"}>
        {preview.problem === null ? text.wouldStart : text.wouldNotStart(preview.problem)}
      </p>
    </div>
  );
}

function NewPlan({ hosts }: { hosts: readonly HostView[] }) {
  const [name, setName] = useState("");
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [minimumHealthy, setMinimumHealthy] = useState("1");
  const [probeIds, setProbeIds] = useState<string[]>([]);
  const [returnMinutes, setReturnMinutes] = useState(String(REBOOT_PLAN.returnMinutes.usual));
  const [notBefore, setNotBefore] = useState("");
  const [notAfter, setNotAfter] = useState("");
  // What the review answered, kept with the body it answered for: that exact body is what approval sends.
  const [reviewed, setReviewed] = useState<{ body: RebootPlanBody; preview: RebootPlanPreview } | null>(null);
  const queryClient = useQueryClient();
  const eligible = hosts.filter(({ kind }) => kind !== HOST_KIND.local);
  const probeQueries = useQueries({
    queries: hostIds.map((hostId) => ({
      queryKey: ["probes", hostId],
      queryFn: () => api<ProbeView[]>("GET", apiPath(API_ROUTES.hostProbes, { hostId })),
    })),
  });
  const probes = probeQueries.flatMap(({ data }) => data ?? []);
  const body = (): RebootPlanBody => ({
    name,
    hostIds,
    minimumHealthy: Number(minimumHealthy),
    probeIds: probeIds.filter((id) => probes.some((probe) => probe.id === id)),
    returnMinutes: Number(returnMinutes),
    notBefore: momentOf(notBefore),
    notAfter: momentOf(notAfter),
  });
  const review = useMutation({
    mutationFn: async () => {
      const asked = body();
      return { body: asked, preview: await api<RebootPlanPreview>("POST", REBOOT_PLAN_ROUTES.preview, asked) };
    },
    onSuccess: setReviewed,
  });
  const approve = useMutation({
    mutationFn: (approved: RebootPlanBody) => api<RebootPlanView>("POST", REBOOT_PLAN_ROUTES.plans, approved),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PLANS_KEY }),
  });
  // A check that has gone since the review would quietly leave the approved plan, so it has to be reviewed again.
  const everyProbeKnown = probeQueries.every(({ data }) => data !== undefined);
  const goneChecks = (reviewed?.body.probeIds ?? []).filter((id) => !probes.some((probe) => probe.id === id));
  const checksChanged = everyProbeKnown && goneChecks.length > 0;
  const toggled = (list: string[], id: string) =>
    list.includes(id) ? list.filter((each) => each !== id) : [...list, id];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    review.mutate();
  };
  if (reviewed !== null) {
    return (
      <div className="stack">
        <PreviewOf preview={reviewed.preview} />
        {checksChanged && (
          <p className="text-warning">
            {text.checksGone(goneChecks.map((id) => checkName(reviewed.preview, id)).join(", "))}
          </p>
        )}
        <ErrorNotice error={approve.error} />
        <div className="card-actions">
          <button
            type="button"
            disabled={approve.isPending || reviewed.preview.problem !== null || checksChanged}
            onClick={() => approve.mutate(reviewed.body)}
          >
            {text.approve}
          </button>
          <button type="button" className="quiet" onClick={() => setReviewed(null)}>
            {text.edit}
          </button>
        </div>
      </div>
    );
  }
  return (
    <form className="stack small" onSubmit={submit}>
      <label>
        {text.name}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <fieldset>
        <legend>{text.hosts}</legend>
        {eligible.map((host) => {
          const position = hostIds.indexOf(host.id);
          return (
            <label key={host.id}>
              <input
                type="checkbox"
                checked={position >= 0}
                onChange={() => setHostIds((list) => toggled(list, host.id))}
              />{" "}
              {position >= 0 ? text.previewOf(host.label, position + 1) : host.label}
            </label>
          );
        })}
        <p className="muted">{text.localHostNote}</p>
      </fieldset>
      <label>
        {text.minimum}
        <input value={minimumHealthy} onChange={(event) => setMinimumHealthy(event.target.value)} />
      </label>
      {probes.length > 0 && (
        <fieldset>
          <legend>{text.checks}</legend>
          {probes.map((probe) => (
            <label key={probe.id}>
              <input
                type="checkbox"
                checked={probeIds.includes(probe.id)}
                onChange={() => setProbeIds((list) => toggled(list, probe.id))}
              />{" "}
              {probe.name}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        {text.returnMinutes}
        <input value={returnMinutes} onChange={(event) => setReturnMinutes(event.target.value)} />
      </label>
      <label>
        {text.notBefore}
        <input type="datetime-local" value={notBefore} onChange={(event) => setNotBefore(event.target.value)} />
      </label>
      <label>
        {text.notAfter}
        <input type="datetime-local" value={notAfter} onChange={(event) => setNotAfter(event.target.value)} />
      </label>
      <ErrorNotice error={review.error} />
      <div className="card-actions">
        <button type="submit" disabled={review.isPending}>
          {text.review}
        </button>
      </div>
    </form>
  );
}

/** Reboots across several hosts: the open plan or the last one, and a new one once none is open. */
export function RebootPlanPanel({ hosts }: { hosts: readonly HostView[] }) {
  const plans = useQuery({
    queryKey: PLANS_KEY,
    queryFn: () => api<RebootPlanView[]>("GET", REBOOT_PLAN_ROUTES.plans),
    refetchInterval: REBOOT_PLAN.tickMilliseconds,
  });
  const latest = plans.data?.[0];
  const anyOpen = latest !== undefined && isOpen(latest);
  return (
    <details className="card fold" open={anyOpen || undefined}>
      <summary>{text.title}</summary>
      <div className="stack small">
        <p className="muted">{text.lede}</p>
        <ErrorNotice error={plans.error} />
        {latest !== undefined && <ActivePlan plan={latest} />}
        {plans.data !== undefined && !anyOpen && <NewPlan hosts={hosts} />}
      </div>
    </details>
  );
}
