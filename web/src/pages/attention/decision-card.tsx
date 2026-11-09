import { MaintenanceBadge } from "../../components/maintenance-dialog.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type ContainerView,
  type HostView,
  type IncidentDetailView,
  type IncidentSummaryView,
} from "../../../../src/shared/api.js";
import {
  ACTION_ESCALATE,
  ACTION_RESTART,
  APPROVAL_DISMISS,
  INCIDENT_STATUS,
  OUTCOMES,
  RESTART_CHOICE,
} from "../../../../src/shared/constants.js";
import { incidentHandable, incidentItem, startDrag } from "../../agent-dispatch.js";
import { api } from "../../api-client.js";
import { ErrorNotice } from "../../components/common.js";
import { Icon } from "../../components/icons.js";
import { approvalOf, incidentLink, incidentQuery, useApproval } from "../../components/incident-parts.js";
import { TEXT } from "../../constants.js";
import { timeAgo } from "../../format.js";
import { type HandOver, Grip } from "./attention-parts.js";

// Why it waits for a person, in a sentence: the rule asked first, Ollama handed it over, or what went wrong.
function reasonOf(incident: IncidentSummaryView, detail: IncidentDetailView | undefined): string {
  const text = TEXT.attention;
  const outcome = detail?.outcome ?? null;
  // A person's choice was carried out and did not hold: what happened is why it waits again.
  if (outcome !== null && (detail?.approvals.length ?? 0) > 0) {
    return outcome;
  }
  if (incident.action === ACTION_ESCALATE) {
    return text.handedOver;
  }
  const target = incident.target ?? incident.containerName;
  if (outcome === OUTCOMES.asksFirst(target)) {
    const suggestion = incident.action === ACTION_RESTART ? text.suggestsRestart : text.suggestsDependency(target);
    return `${suggestion} ${text.ruleAsksFirst}`;
  }
  return outcome ?? "";
}

// Its failures are neither handled nor told from now on, and this one is left as it is.
function useStopWatching(incident: IncidentSummaryView) {
  const queryClient = useQueryClient();
  const decide = useApproval(incident.id);
  const stop = useMutation({
    mutationFn: async () => {
      await api("PUT", apiPath(API_ROUTES.containerControls, { hostId: incident.hostId }), {
        names: [incident.containerName],
        restart: RESTART_CHOICE.ignore,
      });
      await decide.mutateAsync({ choice: APPROVAL_DISMISS });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });
  return stop;
}

export function DecisionCard({
  incident,
  host,
  container,
  admin,
  onHandOver,
}: {
  incident: IncidentSummaryView;
  host: HostView | undefined;
  container: ContainerView | undefined;
  admin: boolean;
  onHandOver: HandOver;
}) {
  const detail = useQuery(incidentQuery(incident.id));
  const decide = useApproval(incident.id);
  const stopWatching = useStopWatching(incident);
  const nameId = useId();
  const text = TEXT.attention;
  const escalated = incident.action === ACTION_ESCALATE;
  const decidable = admin && incident.status === INCIDENT_STATUS.awaitingApproval;
  const handable = decidable && incidentHandable(host, container);
  const item = incidentItem(incident.id);
  const used = host?.restartBudget[incident.containerName] ?? 0;
  const approve = () => decide.mutate(approvalOf(incident));
  const classes = ["card", "decision", escalated ? "" : "waiting", handable ? "handable" : ""];
  return (
    <article
      className={classes.filter(Boolean).join(" ")}
      aria-labelledby={nameId}
      draggable={handable}
      onDragStart={handable ? (event) => startDrag(event, item, new Set()) : undefined}
    >
      <p className="decision-meta">
        {handable && <Grip />}
        <span className={escalated ? "badge danger" : "badge warning"}>
          {escalated ? text.escalated : text.awaiting}
        </span>
        <span>
          <MaintenanceBadge hostId={incident.hostId} containerName={incident.containerName} />
          {incident.hostLabel}
          {TEXT.separator}
          {text.happened[incident.trigger]} {timeAgo(incident.detectedAt)}
        </span>
      </p>
      <h3 id={nameId} className="decision-name mono">
        {incident.containerName}
      </h3>
      <p className="reading">{reasonOf(incident, detail.data)}</p>
      {!escalated && (
        <p className="chips">
          <span className="chip">
            <Icon name="check" />
            {text.guardPasses}
          </span>
          <span className="chip">{text.restartsUsed(used)}</span>
        </p>
      )}
      <div className="card-actions">
        {decidable && (
          <>
            <button
              type="button"
              className={escalated ? undefined : "primary"}
              disabled={decide.isPending}
              onClick={approve}
            >
              {escalated ? text.restartIt : text.approve}
            </button>
            <button
              type="button"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ choice: APPROVAL_DISMISS })}
            >
              {text.leave}
            </button>
            {escalated && (
              <button
                type="button"
                className="quiet"
                disabled={stopWatching.isPending}
                onClick={() => stopWatching.mutate()}
              >
                {text.stopWatching}
              </button>
            )}
            {handable && (
              <button type="button" className="agent-button" onClick={() => onHandOver([item])}>
                <Icon name="zap" />
                {text.agent.handOver}
              </button>
            )}
          </>
        )}
        <Link className="push" to={incidentLink(incident.id)}>
          {text.seeWhy}
        </Link>
      </div>
      <ErrorNotice error={decide.error ?? stopWatching.error} />
    </article>
  );
}
