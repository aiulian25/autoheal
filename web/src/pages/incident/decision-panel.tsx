import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type ContainerControlChange,
  type ContainerView,
  type HostView,
  type IncidentDetailView,
} from "../../../../src/shared/api.js";
import {
  ACTION_ESCALATE,
  ACTION_RESTART,
  ACTION_RESTART_DEPENDENCY,
  APPROVAL_DISMISS,
  INCIDENT_STATUS,
  OUTCOMES,
  RESTART_CHOICE,
  isParkedContainer,
} from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { containerLink } from "../../host-links.js";
import { ErrorNotice, PlainText } from "../../components/common.js";
import { Icon } from "../../components/icons.js";
import { approvalOf, useApproval } from "../../components/incident-parts.js";
import { TEXT } from "../../constants.js";

const text = TEXT.incidentPage;

function callTitle(incident: IncidentDetailView): string {
  if (incident.action === ACTION_RESTART) {
    return text.calls.restart;
  }
  if (incident.action === ACTION_RESTART_DEPENDENCY) {
    return text.calls.dependency(incident.target ?? "");
  }
  return incident.action === ACTION_ESCALATE ? text.calls.escalate : text.calls.none;
}

const asksFirst = (incident: IncidentDetailView) =>
  incident.outcome === OUTCOMES.asksFirst(incident.target ?? incident.containerName);

// Why it waits for a person: its rule, Ollama, or what went wrong; for a settled incident, how it ended.
function WhyItWaits({ incident, container }: { incident: IncidentDetailView; container: ContainerView | undefined }) {
  if (asksFirst(incident)) {
    return (
      <p className="small muted">
        {text.waitingBecause}
        <strong>{text.askFirst}</strong>.{" "}
        {container !== undefined && (
          <Link to={containerLink(incident.hostId, incident.containerName)}>{text.changeRule}</Link>
        )}
      </p>
    );
  }
  // A person's choice was carried out and did not hold: what happened is why it waits again.
  const triedAlready = incident.outcome !== null && incident.approvals.length > 0;
  if (!triedAlready && incident.action === ACTION_ESCALATE && incident.status === INCIDENT_STATUS.awaitingApproval) {
    return <p className="small muted">{text.yoursToDecide}</p>;
  }
  return incident.outcome === null ? null : <p className="small muted">{incident.outcome}</p>;
}

function GuardChecks({ incident, host }: { incident: IncidentDetailView; host: HostView | undefined }) {
  const isProtected = incident.report?.protectedContainers.includes(incident.containerName) ?? false;
  const used = host?.restartBudget[incident.containerName] ?? 0;
  const checks = [
    isProtected ? text.checks.protected : text.checks.notProtected,
    text.checks.notStoppedOnPurpose,
    text.checks.noRecentRestart,
    text.checks.restartsUsed(used),
  ];
  return (
    <div className="guard">
      <p className="label">{text.guardChecks}</p>
      <ul className="checks">
        {checks.map((check) => (
          <li key={check}>
            <Icon name="check" />
            {check}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Any container on the host but this one and the protected ones: a person's choice is theirs to make. */
function DependencyChooser({ incident, onCancel }: { incident: IncidentDetailView; onCancel: () => void }) {
  const decide = useApproval(incident.id);
  const candidates =
    incident.report?.knownContainers.filter(
      (name) =>
        name !== incident.containerName &&
        !incident.report!.protectedContainers.includes(name) &&
        !isParkedContainer(name),
    ) ?? [];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = String(new FormData(event.currentTarget).get("target") ?? "");
    decide.mutate({ choice: ACTION_RESTART_DEPENDENCY, target });
  };
  return (
    <form className="dependency-chooser" onSubmit={submit}>
      <label>
        {text.which}
        <select name="target" required>
          {candidates.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="primary" disabled={decide.isPending || candidates.length === 0}>
        {text.restartThat}
      </button>
      <button type="button" className="quiet" onClick={onCancel}>
        {text.cancel}
      </button>
      <ErrorNotice error={decide.error} />
    </form>
  );
}

function DecisionActions({
  incident,
  container,
}: {
  incident: IncidentDetailView;
  container: ContainerView | undefined;
}) {
  const queryClient = useQueryClient();
  const decide = useApproval(incident.id);
  const [choosing, setChoosing] = useState(false);
  const restartAlone = useMutation({
    mutationFn: (change: ContainerControlChange) =>
      api<void>("PUT", apiPath(API_ROUTES.containerControls, { hostId: incident.hostId }), change),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });
  if (choosing) {
    return <DependencyChooser incident={incident} onCancel={() => setChoosing(false)} />;
  }
  const approve = () => decide.mutate(approvalOf(incident));
  const canRestartAlone =
    container !== undefined &&
    container.byItself.restart !== RESTART_CHOICE.restart &&
    container.byItself.restartLock === null;
  return (
    <>
      <button type="button" className="primary" disabled={decide.isPending} onClick={approve}>
        {text.approve}
      </button>
      <button type="button" className="warm" disabled={decide.isPending} onClick={() => setChoosing(true)}>
        {text.dependencyInstead}
      </button>
      <button
        type="button"
        className="quiet"
        disabled={decide.isPending}
        onClick={() => decide.mutate({ choice: APPROVAL_DISMISS })}
      >
        {text.leave}
      </button>
      {canRestartAlone && (
        <button
          type="button"
          className="quiet push"
          disabled={restartAlone.isPending}
          onClick={() => restartAlone.mutate({ names: [incident.containerName], restart: RESTART_CHOICE.restart })}
        >
          {text.restartAlone}
        </button>
      )}
      {container?.byItself.restart === RESTART_CHOICE.restart && asksFirst(incident) && (
        <span className="small text-good push">{text.restartsAlone}</span>
      )}
      <ErrorNotice error={decide.error ?? restartAlone.error} />
    </>
  );
}

export function DecisionPanel(props: {
  incident: IncidentDetailView;
  host: HostView | undefined;
  container: ContainerView | undefined;
  admin: boolean;
}) {
  const { incident, host, container, admin } = props;
  const waiting = incident.status === INCIDENT_STATUS.awaitingApproval;
  return (
    <section className={waiting ? "decision-panel waiting" : "decision-panel"}>
      <div className="decision-panel-body">
        <div className="call">
          <p className="label text-warning">{text.ollamasCall}</p>
          <h2>{callTitle(incident)}</h2>
          {incident.diagnosis !== null && <PlainText className="text diagnosis" text={incident.diagnosis} />}
          <WhyItWaits incident={incident} container={container} />
        </div>
        <GuardChecks incident={incident} host={host} />
      </div>
      {waiting && admin && (
        <div className="decision-panel-actions">
          <DecisionActions incident={incident} container={container} />
        </div>
      )}
    </section>
  );
}
