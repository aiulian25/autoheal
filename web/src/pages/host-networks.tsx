import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ROUTES, apiPath, type HostNetworksView, type HostView, type JobView } from "../../../src/shared/api.js";
import { JOB_ACTION, JOB_STATUS } from "../../../src/shared/constants.js";
import {
  NETWORK_STATE,
  isCleanable,
  isLeftBehind,
  isLocked,
  networkState,
  type NetworkReport,
  type NetworkState,
} from "../../../src/shared/networks.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { isWaiting } from "../components/container-actions.js";
import { Icon } from "../components/icons.js";
import { INVENTORY_REFRESH_MILLISECONDS, JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { NewNetworkDialog } from "./new-network.js";
import { networksKey, Members, madeByOf, StateCell, RowActions, NetworkPanel } from "./host-network-panel.js";
import { toggled, chipClassOf } from "./resource-chips.js";

const text = TEXT.hostNetworks;

const SECTION_ID = "host-networks";
const TITLE_ID = "host-networks-title";
const NETWORK_COLUMNS = 7;
const COLUMNS = 6;

const networksQuery = (hostId: string) => ({
  queryKey: networksKey(hostId),
  queryFn: () => api<HostNetworksView>("GET", apiPath(API_ROUTES.hostNetworks, { hostId })),
  refetchInterval: (query: { state: { data: HostNetworksView | undefined } }) => {
    const job = query.state.data?.lastJob;
    return job && isWaiting(job) ? JOB_REFRESH_MILLISECONDS : INVENTORY_REFRESH_MILLISECONDS;
  },
});

function useNetworkRemoval(hostId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ names, evenIfStoppedNeedIt = false }: { names: readonly string[]; evenIfStoppedNeedIt?: boolean }) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId }), {
        action: JOB_ACTION.removeNetworks,
        removal: { names, evenIfStoppedNeedIt },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: networksKey(hostId) }),
  });
}

// What needs a person comes first, then what is busiest.
const ORDER: readonly NetworkState[] = [
  NETWORK_STATE.leftBehind,
  NETWORK_STATE.empty,
  NETWORK_STATE.projectStillHere,
  NETWORK_STATE.keptForStopped,
  NETWORK_STATE.inUse,
  NETWORK_STATE.autohealOwn,
  NETWORK_STATE.dockerOwn,
];
const inOrder = (networks: readonly NetworkReport[]) =>
  networks.toSorted(
    (first, second) =>
      ORDER.indexOf(networkState(first)) - ORDER.indexOf(networkState(second)) ||
      second.members.length - first.members.length ||
      first.name.localeCompare(second.name),
  );

const NOT_USED: readonly NetworkState[] = [
  NETWORK_STATE.leftBehind,
  NETWORK_STATE.empty,
  NETWORK_STATE.projectStillHere,
];
const FILTERS = {
  all: () => true,
  notUsed: (network: NetworkReport) => NOT_USED.includes(networkState(network)),
  inUse: (network: NetworkReport) =>
    !NOT_USED.includes(networkState(network)) && networkState(network) !== NETWORK_STATE.dockerOwn,
  dockerOwn: (network: NetworkReport) => networkState(network) === NETWORK_STATE.dockerOwn,
};
type Filter = keyof typeof FILTERS;
const FILTER_NAMES = Object.keys(FILTERS) as Filter[];

/** Every Docker network on a host: what is on each, who made it, and what was left behind to clear in one click. */
export function HostNetworks({
  host,
  admin,
  find = "",
  leftAsked = 0,
}: {
  host: HostView;
  admin: boolean;
  // What Find holds while this list is the one showing.
  find?: string;
  // Goes up each time a person clicks the button while it says something was left behind.
  leftAsked?: number;
}) {
  const queryClient = useQueryClient();
  const view = useQuery(networksQuery(host.id));
  const removal = useNetworkRemoval(host.id);
  const [filter, setFilter] = useState<Filter>("all");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const [asking, setAsking] = useState<NetworkReport | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (leftAsked > 0) setFilter("notUsed");
  }, [leftAsked]);
  const data = view.data;
  if (data === undefined) {
    return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  }
  const networks = data.networks;
  const remove = (names: readonly string[], evenIfStoppedNeedIt = false) => {
    removal.mutate({ names, evenIfStoppedNeedIt });
    setTicked(new Set());
    setAsking(null);
  };
  if (networks === null) {
    return (
      <section id={SECTION_ID} className="section host-networks" aria-labelledby={TITLE_ID}>
        <p className="muted">{text.notReported}</p>
      </section>
    );
  }
  const canChange = admin && host.dryRun === false;
  const cleanable = networks.filter(isCleanable);
  const chosen = networks.filter((network) => ticked.has(network.name));
  const words = find.trim().toLowerCase();
  const shown = inOrder(networks.filter(FILTERS[filter]).filter(({ name }) => name.toLowerCase().includes(words)));
  const lastJob = data.lastJob;
  const answered = lastJob !== null && removal.data?.id === lastJob.id && !isWaiting(lastJob);
  const failed = answered && lastJob.status === JOB_STATUS.failed;
  const removedNames = removal.variables?.names ?? [];
  const stuck = networks.find(
    (network) => removedNames.includes(network.name) && network.members.some((member) => member.running),
  );
  return (
    <section id={SECTION_ID} className="section host-networks" aria-labelledby={TITLE_ID}>
      <div className="row spread panel-filters">
        <div className="show-chips" role="group" aria-label={text.filterLabel}>
          {FILTER_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className={name === filter ? "chip-button active" : "chip-button"}
              aria-pressed={name === filter}
              onClick={() => setFilter(name)}
            >
              {text.filters[name]} <span className="tab-count">{networks.filter(FILTERS[name]).length}</span>
            </button>
          ))}
        </div>
        {canChange && (
          <span className="row">
            {cleanable.length > 0 && (
              <button
                type="button"
                className="primary"
                disabled={removal.isPending}
                onClick={() => remove(cleanable.map(({ name }) => name))}
              >
                {text.cleanUp(cleanable.length)}
              </button>
            )}
            <button type="button" className="add-container" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {text.newNetwork}
            </button>
          </span>
        )}
      </div>
      {!canChange && admin && <p className="small muted">{text.watchOnly}</p>}
      {chosen.length > 0 && (
        <div className="bulk-bar action-bar" role="group" aria-label={text.barLabel}>
          <span>{text.ticked(chosen.length)}</span>
          <button type="button" className="quiet" onClick={() => setTicked(new Set())}>
            {text.clear}
          </button>
          <button
            type="button"
            className="danger"
            disabled={removal.isPending}
            onClick={() => remove(chosen.map(({ name }) => name))}
          >
            {text.remove(chosen.length)}
          </button>
        </div>
      )}
      {asking !== null && (
        <div className="notice warning row spread" role="alert">
          <span>
            {text.stoppedAsk(
              asking.name,
              asking.members.map(({ name }) => name),
            )}
          </span>
          <span className="row">
            <button type="button" onClick={() => setAsking(null)}>
              {text.keepIt}
            </button>
            <button type="button" className="danger" onClick={() => remove([asking.name], true)}>
              {text.removeAnyway}
            </button>
          </span>
        </div>
      )}
      {answered && (
        <p className={failed ? "text-danger small" : "small"} role="status">
          {lastJob.outcome}{" "}
          {failed && stuck !== undefined && (
            <button type="button" className="link" onClick={() => setOpened(stuck.name)}>
              {text.openNetwork}
            </button>
          )}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {canChange && <th className="tick-column" />}
              <th>{text.columns.name}</th>
              <th>{text.columns.who}</th>
              <th>{text.columns.addresses}</th>
              <th>{text.columns.madeBy}</th>
              <th>{text.columns.state}</th>
              <th>{text.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={NETWORK_COLUMNS} className="muted">
                  {text.nothingFound}
                </td>
              </tr>
            )}
            {shown.flatMap((network) => {
              const open = opened === network.name;
              const tickable = !isLocked(network) && network.members.length === 0;
              const row = (
                <tr key={network.name} className={ticked.has(network.name) ? "selected" : undefined}>
                  {canChange && (
                    <td className="tick-column">
                      {tickable && (
                        <input
                          type="checkbox"
                          checked={ticked.has(network.name)}
                          aria-label={text.tick(network.name)}
                          onChange={() => setTicked(toggled(ticked, network.name))}
                        />
                      )}
                    </td>
                  )}
                  <td className="mono">{network.name}</td>
                  <td>
                    <Members network={network} />
                  </td>
                  <td className="mono muted">{network.subnet ?? text.none}</td>
                  <td className="muted">{madeByOf(network)}</td>
                  <StateCell network={network} />
                  <td>
                    <RowActions
                      network={network}
                      canChange={canChange}
                      open={open}
                      busy={removal.isPending}
                      onToggle={() => setOpened(open ? null : network.name)}
                      onOpen={() => setOpened(network.name)}
                      onRemove={() => (network.members.length > 0 ? setAsking(network) : remove([network.name]))}
                    />
                  </td>
                </tr>
              );
              if (!open) return [row];
              return [
                row,
                <tr key={`${network.name}-panel`}>
                  <td colSpan={canChange ? COLUMNS + 1 : COLUMNS}>
                    <NetworkPanel host={host} network={network} networks={networks} canChange={canChange} />
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      <ErrorNotice error={removal.error} />
      {creating && (
        <NewNetworkDialog
          host={host}
          networks={networks}
          lastJob={lastJob}
          onChanged={() => queryClient.invalidateQueries({ queryKey: networksKey(host.id) })}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}

/** The heading while this list is the one showing. */
export function NetworksHeading({ host }: { host: HostView }) {
  const networks = useQuery(networksQuery(host.id)).data?.networks;
  return (
    <h2 id={TITLE_ID}>
      {text.title}
      {networks != null && (
        <span className="muted">
          {TEXT.separator}
          {text.summary(networks.length, host.label)}
        </span>
      )}
    </h2>
  );
}

/** Beside the containers' filters: opens the networks, and says when something was left behind. */
export function NetworksChip({
  hostId,
  active,
  onOpen,
}: {
  hostId: string;
  active: boolean;
  onOpen: (leftBehind: boolean) => void;
}) {
  const view = useQuery(networksQuery(hostId));
  const networks = view.data?.networks ?? [];
  const left = networks.filter(isCleanable).length;
  const hasLeft = left > 0;
  return (
    <button
      type="button"
      className={chipClassOf(active, hasLeft)}
      aria-pressed={active}
      onClick={() => onOpen(hasLeft)}
    >
      {text.chip} <span className="tab-count">{hasLeft ? text.chipLeft(left) : networks.length}</span>
    </button>
  );
}

/** On the line that says containers were removed: the networks that leaves behind, gone in one more click. */
export function LeftBehindOffer({ hostId, projects }: { hostId: string; projects: readonly string[] }) {
  const view = useQuery(networksQuery(hostId));
  const removal = useNetworkRemoval(hostId);
  const [dismissed, setDismissed] = useState(false);
  const left = (view.data?.networks ?? []).filter(
    (network) => isLeftBehind(network) && network.project !== null && projects.includes(network.project),
  );
  if (left.length === 0 || dismissed) return null;
  const names = left.map(({ name }) => name);
  return (
    <span className="left-behind-offer">
      <span className="text-warning">{text.offer(names)}</span>
      <button
        type="button"
        className="danger"
        disabled={removal.isPending}
        onClick={() => {
          removal.mutate({ names });
          setDismissed(true);
        }}
      >
        {text.removeToo(names.length)}
      </button>
      <button type="button" className="quiet" onClick={() => setDismissed(true)}>
        {text.keepAll(names.length)}
      </button>
    </span>
  );
}
