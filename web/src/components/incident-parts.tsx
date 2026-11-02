import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type ApprovalView,
  type IncidentDetailView,
  type IncidentSummaryView,
} from "../../../src/shared/api.js";
import {
  ACTION_RESTART,
  ACTION_RESTART_DEPENDENCY,
  APPROVAL_DISMISS,
  APPROVAL_NOTE_LIMIT,
  INCIDENT_STATUS,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { PATHS, REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { incidentSteps } from "../incident-steps.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { boardQuery } from "../queries.js";
import { Badge, ErrorNotice, Loading, PlainText, TimeAgo } from "./common.js";

export const incidentLink = (incidentId: string) => apiPath(PATHS.incident, { incidentId });

export const incidentQuery = (incidentId: string) => ({
  queryKey: ["incidents", "detail", incidentId],
  queryFn: () => api<IncidentDetailView>("GET", apiPath(API_ROUTES.incident, { incidentId })),
  refetchInterval: REFRESH_MILLISECONDS,
});

/** From noticed to done: across the incident page, down the board's panel. */
export function IncidentSteps({ incident, layout }: { incident: IncidentDetailView; layout: "across" | "down" }) {
  return (
    <ol className={`steps ${layout}`} aria-label={TEXT.steps.label}>
      {incidentSteps(incident).map((step) => (
        <li key={step.name} className={step.state}>
          <strong>{step.name}</strong>
          {step.at !== null && <TimeAgo timestamp={step.at} />}
          {step.detail && <span>{step.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

export const canDecide = (incident: IncidentDetailView, admin: boolean) =>
  admin && incident.status === INCIDENT_STATUS.awaitingApproval;

/** A person's decision on an incident, wherever it is taken: the incident and the board follow it. */
export function useApproval(incidentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { choice: string; target?: string; note?: string }) =>
      api<ApprovalView>("POST", apiPath(API_ROUTES.incidentApproval, { incidentId }), body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
    },
  });
}

/**
 * Approving Ollama's call: the dependency it named, or else a restart of the container itself. One it handed
 * over is "escalate", which is no choice a person makes, whatever target it named.
 */
export const approvalOf = (incident: Pick<IncidentSummaryView, "action" | "target">) =>
  incident.action === ACTION_RESTART_DEPENDENCY && incident.target !== null
    ? { choice: ACTION_RESTART_DEPENDENCY, target: incident.target }
    : { choice: ACTION_RESTART };

export function ApprovalForm({ incident }: { incident: IncidentDetailView }) {
  const [choice, setChoice] = useState<string>(ACTION_RESTART);
  const candidates =
    incident.report?.knownContainers.filter(
      (name) => name !== incident.containerName && !incident.report!.protectedContainers.includes(name),
    ) ?? [];
  const decide = useApproval(incident.id);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const note = String(form.get("note") ?? "").trim();
    const target = choice === ACTION_RESTART_DEPENDENCY ? String(form.get("target") ?? "") : undefined;
    decide.mutate({ choice, target, note: note || undefined });
  };
  const choices = [
    [ACTION_RESTART, TEXT.incident.restart(incident.containerName)],
    [ACTION_RESTART_DEPENDENCY, TEXT.incident.restartDependency],
    [APPROVAL_DISMISS, TEXT.incident.dismiss],
  ] as const;
  return (
    <form className="card" onSubmit={submit}>
      <h2>{TEXT.incident.approveTitle}</h2>
      <fieldset>
        {choices.map(([value, label]) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="choice"
              value={value}
              checked={choice === value}
              onChange={() => setChoice(value)}
              disabled={value === ACTION_RESTART_DEPENDENCY && candidates.length === 0}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {choice === ACTION_RESTART_DEPENDENCY && (
        <label>
          {TEXT.incident.target}
          <select name="target" required>
            {candidates.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        {TEXT.incident.note}
        <input name="note" maxLength={APPROVAL_NOTE_LIMIT} />
      </label>
      <ErrorNotice error={decide.error} />
      <button className="primary" type="submit" disabled={decide.isPending}>
        {TEXT.incident.submit}
      </button>
      <p className="muted small">{TEXT.incident.approveExplanation}</p>
    </form>
  );
}

/**
 * An incident in short, with the decision when it waits for one: the board's panel (which can close
 * it) and the Needs you list.
 */
export function IncidentSummary({ incidentId, onClose }: { incidentId: string; onClose?: () => void }) {
  const admin = isAdmin(useSignedInSession());
  const incident = useQuery(incidentQuery(incidentId));
  if (incident.data === undefined) {
    return incident.error ? <ErrorNotice error={incident.error} /> : <Loading />;
  }
  const view = incident.data;
  return (
    <div className="stack">
      <header className="panel-header">
        <div className="row">
          <h2>{TEXT.incident.onHost(view.containerName, view.hostLabel)}</h2>
          <Badge value={view.verdict ?? view.status} />
        </div>
        {onClose !== undefined && (
          <button type="button" className="link" onClick={onClose} aria-label={TEXT.board.close}>
            {TEXT.tasks.removeMark}
          </button>
        )}
      </header>
      <IncidentSteps incident={view} layout="down" />
      {view.diagnosis !== null && <PlainText className="text" text={view.diagnosis} />}
      {canDecide(view, admin) && <ApprovalForm incident={view} />}
      <Link to={incidentLink(view.id)}>{TEXT.board.details}</Link>
    </div>
  );
}
