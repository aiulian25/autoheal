import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath, type ContainerView, type JobView } from "../../../src/shared/api.js";
import {
  ROLLOUT_LIMITS,
  ROLLOUT_ROUTES,
  ROLLOUT_STATUS,
  rolloutCreateSchema,
  type RolloutCreate,
  type RolloutView,
} from "../../../src/shared/rollouts.js";
import { operationPreviewAnswerSchema, type OperationImpactView } from "../../../src/shared/topology.js";
import { api, ReadableError } from "../api-client.js";
import { ROLLOUT_FORM, TEXT } from "../constants.js";
import { ErrorNotice } from "./common.js";

const text = TEXT.rollout;
// A plan still moving, which a person may hold.
const HOLDABLE: readonly string[] = [ROLLOUT_STATUS.updating, ROLLOUT_STATUS.observing, ROLLOUT_STATUS.ready];
import { UpdateStream } from "./update-stream.js";
function RolloutProgress({ plan }: { plan: RolloutView }) {
  const jobId = plan.targets[plan.current]?.jobId;
  const job = useQuery({
    queryKey: ["job", jobId],
    enabled: !!jobId,
    queryFn: () => api<JobView>("GET", apiPath(API_ROUTES.job, { jobId: jobId! })),
    refetchInterval: 5000,
  });
  const target = plan.targets[plan.current]!;
  return (
    <>
      {job.data?.progress && (
        <UpdateStream name={target.containerName} image={target.targetReference} progress={job.data.progress} />
      )}
      <ErrorNotice error={job.error} />
    </>
  );
}
/** Explicit review; one canary and then one follower at a time. No app-native checks are invented. */
export function RolloutPlan({ hostId }: { hostId: string }) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState([
    { key: "", targetReference: "" },
    { key: "", targetReference: "" },
  ]);
  const [minutes, setMinutes] = useState<number>(ROLLOUT_FORM.observeMinutes);
  const [isolated, setIsolated] = useState(false);
  const [serviceRequired, setServiceRequired] = useState(true);
  const [verified, setVerified] = useState<Record<string, number>>({});
  const containers = useQuery({
    queryKey: ["rollout-targets"],
    enabled: open,
    queryFn: () => api<ContainerView[]>("GET", API_ROUTES.containers),
  });
  const plans = useQuery({
    queryKey: ["rollouts"],
    enabled: open,
    queryFn: () => api<RolloutView[]>("GET", ROLLOUT_ROUTES.rollouts),
    refetchInterval: open ? 5000 : false,
  });
  const review = useMutation({
    mutationFn: async () => {
      const selected = targets.map((target) => {
        const container = containers.data?.find((value) => `${value.hostId}/${value.name}` === target.key);
        if (!container) throw new ReadableError(text.selectEvery);
        return { hostId: container.hostId, containerName: container.name, targetReference: target.targetReference };
      });
      const views: OperationImpactView[] = [];
      for (const target of selected) {
        const view = await api<OperationImpactView>("POST", apiPath(API_ROUTES.operationPreview, target), {
          action: "update",
        });
        const answer = operationPreviewAnswerSchema.safeParse(view.answer);
        if (
          !answer.success ||
          !answer.data.ok ||
          answer.data.refusals.length ||
          answer.data.members.length !== 1 ||
          answer.data.rolloutSafety?.writableData !== "none" ||
          !answer.data.rolloutSafety.platform ||
          !answer.data.rolloutSafety.sourceContainerId
        )
          throw new ReadableError(text.needsProof);
        views.push({ ...view, answer: answer.data });
      }
      const body = rolloutCreateSchema.parse({
        targets: selected.map((target, index) => ({ ...target, previewId: views[index]!.id })),
        observeMinutes: minutes,
        externalDataIsolated: isolated,
        serviceVerificationRequired: serviceRequired,
      });
      return { body, views };
    },
  });
  const submit = useMutation({
    mutationFn: (body: RolloutCreate) => api<RolloutView>("POST", ROLLOUT_ROUTES.rollouts, body),
    onSuccess: () => {
      review.reset();
      void cache.invalidateQueries({ queryKey: ["rollouts"] });
    },
  });
  const action = useMutation({
    mutationFn: ({ id, kind, cohort }: { id: string; kind: "hold" | "promote"; cohort: number }) =>
      api(
        "POST",
        apiPath(kind === "hold" ? ROLLOUT_ROUTES.rolloutHold : ROLLOUT_ROUTES.rolloutPromote, { rolloutId: id }),
        kind === "promote" ? { serviceVerified: verified[id] === cohort } : undefined,
      ),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["rollouts"] }),
  });
  const editing = !review.data && !review.isPending && !submit.isPending;
  return (
    <details className="card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{text.title}</summary>
      {open && (
        <>
          <p>{text.explanation(ROLLOUT_LIMITS.targets, ROLLOUT_LIMITS.hosts)}</p>
          <p className="notice warning">{text.limits}</p>
          <fieldset disabled={!editing}>
            <legend>{text.cohorts}</legend>
            {targets.map((target, index) => (
              <div className="stack" key={index}>
                <label>
                  {text.target(index + 1)}
                  <select
                    value={target.key}
                    onChange={(event) =>
                      setTargets(
                        targets.map((value, at) => (at === index ? { ...value, key: event.target.value } : value)),
                      )
                    }
                  >
                    <option value="">{text.chooseContainer}</option>
                    {[...(containers.data ?? [])]
                      .sort((a, b) => Number(b.hostId === hostId) - Number(a.hostId === hostId))
                      .map((container) => (
                        <option
                          key={`${container.hostId}/${container.name}`}
                          value={`${container.hostId}/${container.name}`}
                        >
                          {container.hostLabel}
                          {TEXT.separator}
                          {container.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  {text.image}
                  <input
                    value={target.targetReference}
                    onChange={(event) =>
                      setTargets(
                        targets.map((value, at) =>
                          at === index ? { ...value, targetReference: event.target.value } : value,
                        ),
                      )
                    }
                  />
                </label>
                {targets.length > 2 && (
                  <button type="button" onClick={() => setTargets(targets.filter((_, at) => at !== index))}>
                    {text.removeTarget(index + 1)}
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              disabled={targets.length >= ROLLOUT_LIMITS.targets}
              onClick={() => setTargets([...targets, { key: "", targetReference: "" }])}
            >
              {text.addFollower}
            </button>
            <label>
              {text.observe(ROLLOUT_LIMITS.observeMinutes.min, ROLLOUT_LIMITS.observeMinutes.max)}
              <input
                type="number"
                min={ROLLOUT_LIMITS.observeMinutes.min}
                max={ROLLOUT_LIMITS.observeMinutes.max}
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
              />
            </label>
            <label>
              <input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} />{" "}
              {text.isolated}
            </label>
            <label>
              <input
                type="checkbox"
                checked={serviceRequired}
                onChange={(event) => setServiceRequired(event.target.checked)}
              />{" "}
              {text.serviceRequired}
            </label>
            <button type="button" disabled={!isolated} onClick={() => review.mutate()}>
              {text.review}
            </button>
          </fieldset>
          {review.data && (
            <section className="notice warning">
              <h3>{text.confirm}</h3>
              <ol>
                {review.data.views.map((view, index) => (
                  <li key={view.id}>
                    {text.plannedTarget(view.containerName, review.data!.body.targets[index]!.targetReference)}
                    <br />
                    {text.affected(
                      view.answer.ok
                        ? view.answer.members.map((member) => member.name).join(TEXT.listComma)
                        : text.unknown,
                    )}
                  </li>
                ))}
              </ol>
              <p>{text.runnerRejects}</p>
              <button type="button" disabled={submit.isPending} onClick={() => submit.mutate(review.data!.body)}>
                {text.start}
              </button>
              <button type="button" onClick={() => review.reset()}>
                {text.cancel}
              </button>
            </section>
          )}
          {[containers.error, review.error, submit.error, plans.error, action.error].map((error, index) => (
            <ErrorNotice key={index} error={error} />
          ))}
          {plans.data?.map((plan) => (
            <section key={plan.id} className="card">
              <h3>{text.plan(plan.status)}</h3>
              <p role="status">
                {plan.targets.length > 0 && text.cohort(plan.current + 1, plan.targets.length, plan.samples)}
                {plan.reason}
              </p>
              <ol>
                {plan.targets.map((target) => (
                  <li key={`${target.hostId}/${target.containerName}`}>
                    {target.containerName}
                    {TEXT.separator}
                    <span className="mono">{target.targetReference}</span>
                    {TEXT.separator}
                    {target.jobId ? text.queued : text.awaiting}
                  </li>
                ))}
              </ol>
              <RolloutProgress plan={plan} />
              {plan.status === "ready" && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={verified[plan.id] === plan.current}
                      onChange={(event) =>
                        setVerified({ ...verified, [plan.id]: event.target.checked ? plan.current : -1 })
                      }
                    />{" "}
                    {text.verified}
                  </label>
                  <button
                    type="button"
                    disabled={
                      action.isPending || (plan.serviceVerificationRequired && verified[plan.id] !== plan.current)
                    }
                    onClick={() => action.mutate({ id: plan.id, kind: "promote", cohort: plan.current })}
                  >
                    {plan.current === plan.targets.length - 1 ? text.accept : text.promote}
                  </button>
                </>
              )}
              {HOLDABLE.includes(plan.status) && (
                <button
                  type="button"
                  disabled={action.isPending}
                  onClick={() => action.mutate({ id: plan.id, kind: "hold", cohort: plan.current })}
                >
                  {text.hold}
                </button>
              )}
            </section>
          ))}
        </>
      )}
    </details>
  );
}
