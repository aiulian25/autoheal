import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath, type ContainerView, type HostView } from "../../../src/shared/api.js";
import {
  NETWORK_STATE,
  isLocked,
  networkState,
  type NetworkReport,
  type NetworkState,
} from "../../../src/shared/networks.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import { hostContainersQuery } from "../queries.js";
import { toggled } from "./resource-chips.js";

const text = TEXT.hostNetworks;

const SHOWN_MEMBERS = 3;

export const networksKey = (hostId: string) => ["host-networks", hostId];

export function madeByOf(network: NetworkReport): string {
  const state = networkState(network);
  if (state === NETWORK_STATE.dockerOwn) return text.madeBy.docker;
  if (state === NETWORK_STATE.autohealOwn) return text.madeBy.autoheal;
  return network.project === null ? text.madeBy.hand : text.madeBy.compose(network.project);
}

const STATE_CLASS: Partial<Record<NetworkState, string>> = {
  [NETWORK_STATE.leftBehind]: "text-warning",
  [NETWORK_STATE.empty]: "text-warning",
  [NETWORK_STATE.inUse]: "text-good",
};

export function StateCell({ network }: { network: NetworkReport }) {
  const state = networkState(network);
  return (
    <td className={STATE_CLASS[state] ?? "muted"}>
      {text.states[state](network.members.length, network.project ?? "")}
    </td>
  );
}

export function Members({ network }: { network: NetworkReport }) {
  if (network.members.length === 0) return <span className="faint">{text.nobody}</span>;
  const shown = network.members.toSorted((first, second) => Number(second.running) - Number(first.running));
  const rest = shown.length - SHOWN_MEMBERS;
  return (
    <span className="network-members">
      {shown.slice(0, SHOWN_MEMBERS).map((member) => (
        <span key={member.name} className={member.running ? "network-member" : "network-member text-warning"}>
          {member.running ? member.name : `${member.name} · ${text.stopped}`}
        </span>
      ))}
      {rest > 0 && <span className="faint">{text.more(rest)}</span>}
    </span>
  );
}

function Facts({ network }: { network: NetworkReport }) {
  const facts = [
    { label: text.facts.driver, value: network.driver, mono: false },
    { label: text.facts.addresses, value: network.subnet ?? text.none, mono: true },
    { label: text.facts.gateway, value: network.gateway ?? text.none, mono: true },
    { label: text.facts.internet, value: network.internal ? text.no : text.yes, mono: false },
    { label: text.facts.madeBy, value: madeByOf(network), mono: false },
  ];
  return (
    <dl className="network-facts">
      {facts.map(({ label, value, mono }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={mono ? "mono" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What opens under a network's row: its facts, and moving containers on and off it, live. */
export function NetworkPanel({
  host,
  network,
  networks,
  canChange,
}: {
  host: HostView;
  network: NetworkReport;
  networks: readonly NetworkReport[];
  canChange: boolean;
}) {
  const queryClient = useQueryClient();
  const containers = useQuery(hostContainersQuery(host.id));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const change = useMutation({
    mutationFn: async ({ names, joined }: { names: readonly string[]; joined: boolean }) => {
      for (const containerName of names) {
        await api("POST", apiPath(API_ROUTES.containerNetwork, { hostId: host.id, containerName }), {
          name: network.name,
          joined,
        });
      }
    },
    onSuccess: () => setChosen(new Set()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: networksKey(host.id) }),
  });
  const othersOf = (member: string) =>
    networks
      .filter((other) => other.name !== network.name && other.members.some(({ name }) => name === member))
      .map(({ name }) => name);
  const onIt = new Set(network.members.map(({ name }) => name));
  const addable = (containers.data ?? []).filter(
    (container: ContainerView) => !onIt.has(container.name) && container.handsOff === null,
  );
  const movable = canChange && !isLocked(network);
  const canMove = movable && host.containerAccess !== false;
  return (
    <div className="network-panel">
      <Facts network={network} />
      {network.members.map((member) => {
        const others = othersOf(member.name);
        return (
          <div key={member.name} className="network-panel-row">
            <span className="mono">{member.name}</span>
            <span className="mono muted">{member.address || text.stopped}</span>
            <span className="muted">{others.length > 0 ? text.alsoOn(others) : text.onlyHere}</span>
            {canMove && (
              <button
                type="button"
                className={others.length === 0 ? "warning-button" : undefined}
                disabled={change.isPending}
                onClick={() => change.mutate({ names: [member.name], joined: false })}
              >
                {text.takeOff}
              </button>
            )}
          </div>
        );
      })}
      {canMove && addable.length > 0 && (
        <div className="network-add" role="group" aria-label={text.addLabel}>
          <span className="muted">{text.addHeading}</span>
          {addable.map(({ name }) => (
            <button
              key={name}
              type="button"
              className="install-choice"
              aria-pressed={chosen.has(name)}
              onClick={() => setChosen(toggled(chosen, name))}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            className="primary"
            disabled={chosen.size === 0 || change.isPending}
            onClick={() => change.mutate({ names: [...chosen], joined: true })}
          >
            {text.add(chosen.size)}
          </button>
        </div>
      )}
      {movable && !canMove && <p className="small muted">{text.noAccess}</p>}
      {canMove && <p className="small faint network-hint">{text.joinHint}</p>}
      <ErrorNotice error={change.error} />
    </div>
  );
}

export function RowActions({
  network,
  canChange,
  open,
  busy,
  onToggle,
  onOpen,
  onRemove,
}: {
  network: NetworkReport;
  canChange: boolean;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const locked = isLocked(network);
  const running = network.members.some((member) => member.running);
  return (
    <span className="network-actions">
      <button
        type="button"
        className="icon-button"
        title={text.open(network.name)}
        aria-label={text.open(network.name)}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="eye" />
      </button>
      {canChange && !locked && (
        <>
          <button
            type="button"
            className="icon-button"
            title={text.addTo(network.name)}
            aria-label={text.addTo(network.name)}
            onClick={onOpen}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="icon-button icon-danger"
            title={running ? text.busy : text.removeOne(network.name)}
            aria-label={text.removeOne(network.name)}
            disabled={running || busy}
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        </>
      )}
      {locked && (
        <span className="locked" title={text.lockedNote}>
          <Icon name="lock" />
        </span>
      )}
    </span>
  );
}
