import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES, apiPath, type ContainerView, type HostView } from "../../../src/shared/api.js";
import {
  MEMBER_EVIDENCE,
  type AvailabilityGroupView,
  type GroupMember,
  type MemberStanding,
} from "../../../src/shared/availability-groups.js";
import { AVAILABILITY_GROUPS } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "./common.js";
import { TEXT } from "../constants.js";
import { availabilityGroupsQuery, containersQuery, hostsQuery } from "../queries.js";

const text = TEXT.availability;

const EVIDENCE_CLASS: Record<MemberStanding["evidence"], string> = {
  [MEMBER_EVIDENCE.available]: "text-good",
  [MEMBER_EVIDENCE.unavailable]: "text-danger",
  [MEMBER_EVIDENCE.unknown]: "text-warning",
};

const labelOf = (hosts: readonly HostView[], hostId: string) =>
  hosts.find((host) => host.id === hostId)?.label ?? text.hostGone;

/** Each replica with what the fleet sees of it, so a refusal is never a mystery. */
function Standing({ standing, hosts }: { standing: MemberStanding; hosts: readonly HostView[] }) {
  return (
    <div className="key-row">
      <span className="mono">
        {standing.containerName} {text.onHost(labelOf(hosts, standing.hostId))}
      </span>
      <span className={`small ${EVIDENCE_CLASS[standing.evidence]}`}>
        {text.evidence[standing.evidence]}
        {standing.problem !== null && `${TEXT.separator}${standing.problem}`}
      </span>
      <span className="small muted">
        {standing.failureDomain === null ? text.ownDomain : text.inDomain(standing.failureDomain)}
        {standing.goingDown && `${TEXT.separator}${text.goingDown}`}
      </span>
    </div>
  );
}

/**
 * The applications whose replicas must keep serving through a reboot or a rollout: what each holds, what is serving
 * now, and what would be left. An operational guard over what Autoheal can see, not a claim about a cluster's own
 * view of itself.
 */
export function AvailabilityGroups({ admin }: { admin: boolean }) {
  const queryClient = useQueryClient();
  const groups = useQuery(availabilityGroupsQuery);
  const hosts = useQuery(hostsQuery);
  const containers = useQuery(containersQuery);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const refresh = () => queryClient.invalidateQueries({ queryKey: availabilityGroupsQuery.queryKey });
  const add = useMutation({
    mutationFn: (body: {
      name: string;
      minimumAvailable: number;
      evidenceFreshSeconds: number;
      members: GroupMember[];
    }) => api<{ id: string }>("POST", API_ROUTES.availabilityGroups, body),
    onSuccess: () => {
      setPicked(new Set());
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (groupId: string) => api("DELETE", apiPath(API_ROUTES.availabilityGroup, { groupId })),
    onSuccess: refresh,
  });
  const fleet = hosts.data ?? [];
  const replicas = containers.data ?? [];
  const keyOf = (container: ContainerView) => `${container.hostId}/${container.name}`;
  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const members = [...picked].map((key) => {
      const [hostId = "", containerName = ""] = key.split("/");
      const domain = String(form.get(`domain-${key}`) ?? "").trim();
      return { hostId, containerName, failureDomain: domain === "" ? null : domain, probeId: null };
    });
    add.mutate({
      name: String(form.get("name") ?? "").trim(),
      minimumAvailable: Number(form.get("minimumAvailable") ?? 1),
      evidenceFreshSeconds: Number(form.get("evidenceFreshSeconds") ?? AVAILABILITY_GROUPS.freshSeconds.usual),
      members,
    });
  };
  return (
    <section className="card stack" aria-labelledby="availability-title">
      <div>
        <h3 id="availability-title">{text.title}</h3>
        <p className="small muted">{text.explanation}</p>
      </div>
      {groups.data === undefined && (groups.error ? <ErrorNotice error={groups.error} /> : <Loading />)}
      {groups.data?.length === 0 && <p className="muted">{text.none}</p>}
      {(groups.data ?? []).map((group: AvailabilityGroupView) => (
        <div key={group.id} className="stack small">
          <div className="key-row">
            <strong>{group.name}</strong>
            <span className="small muted">
              {text.summary(group.availableDomains, group.minimumAvailable)}
              {group.remainingDomains !== group.availableDomains &&
                `${TEXT.separator}${text.afterWhatIsUnderWay(group.remainingDomains)}`}
            </span>
            {admin && (
              <button
                className="quiet danger"
                type="button"
                aria-label={text.removeFor(group.name)}
                onClick={() => {
                  if (window.confirm(text.removeConfirm(group.name))) remove.mutate(group.id);
                }}
              >
                {text.remove}
              </button>
            )}
          </div>
          {group.standings.map((standing) => (
            <Standing key={`${standing.hostId}/${standing.containerName}`} standing={standing} hosts={fleet} />
          ))}
        </div>
      ))}
      <ErrorNotice error={add.error ?? remove.error} />
      {admin && (
        <form className="step-form" onSubmit={submit} aria-label={text.add}>
          <h4>{text.add}</h4>
          <label>
            {text.name}
            <input name="name" required maxLength={AVAILABILITY_GROUPS.nameLength} />
          </label>
          <fieldset>
            <legend>{text.replicas}</legend>
            <p className="small muted">{text.replicasNote}</p>
            {replicas.map((container) => (
              <label key={keyOf(container)}>
                <input
                  type="checkbox"
                  checked={picked.has(keyOf(container))}
                  onChange={() => toggle(keyOf(container))}
                />{" "}
                {container.name} {text.onHost(container.hostLabel)}
              </label>
            ))}
          </fieldset>
          {[...picked].map((key) => (
            <label key={key}>
              {text.domainFor(key.split("/")[1] ?? "", labelOf(fleet, key.split("/")[0] ?? ""))}
              <input name={`domain-${key}`} maxLength={AVAILABILITY_GROUPS.domainLength} />
            </label>
          ))}
          <label>
            {text.minimum}
            <input name="minimumAvailable" type="number" min={1} defaultValue={1} required />
          </label>
          <label>
            {text.freshness}
            <input
              name="evidenceFreshSeconds"
              type="number"
              min={AVAILABILITY_GROUPS.freshSeconds.minimum}
              max={AVAILABILITY_GROUPS.freshSeconds.maximum}
              defaultValue={AVAILABILITY_GROUPS.freshSeconds.usual}
              required
            />
          </label>
          <button type="submit" disabled={add.isPending || picked.size === 0}>
            {text.add}
          </button>
        </form>
      )}
    </section>
  );
}
