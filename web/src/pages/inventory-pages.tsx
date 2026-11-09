import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  CONTAINER_QUERY,
  apiPath,
  hasNewerVersion,
  hasUpdate,
  type ContainerView,
} from "../../../src/shared/api.js";
import { CONTAINER_STATE_RUNNING, HOST_STATE } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { Badge, ErrorNotice, Loading, PageHeader, TimeAgo, rowClick } from "../components/common.js";
import { ProblemsOnlyToggle, useContainerSelection, useFilters, type Selection } from "../components/filters.js";
import { SavedViewPicker } from "../components/saved-view-picker.js";
import { WebLink } from "../components/container-actions.js";
import {
  INVENTORY_REFRESH_MILLISECONDS,
  PATHS,
  QUERY_TRUE,
  SEARCH_PARAMETERS,
  TASK_SEARCH_PARAMETERS,
  TASK_SHOW,
  TEXT,
} from "../constants.js";
import { bytes, decimal, precisePercent, rate } from "../format.js";
import { enrolledHostsQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { stateOf, stateTone } from "../components/container-cells.js";
import { ContainerInspector } from "./container-inspector.js";

const hostLink = (hostId: string) => apiPath(PATHS.host, { hostId });

function Missing() {
  return <span className="muted">{TEXT.none}</span>;
}

// --- container lists, whose rows open the container's stats beneath them ------------------------

function UsageCells({ usage }: { usage: ContainerView["usage"] }) {
  if (usage === null) {
    return (
      <>
        <td>
          <Missing />
        </td>
        <td>
          <Missing />
        </td>
        <td>
          <Missing />
        </td>
        <td>
          <Missing />
        </td>
      </>
    );
  }
  const cpuOf =
    usage.cpuLimitCores === null ? TEXT.metrics.ofHost : TEXT.metrics.cpuLimit(decimal(usage.cpuLimitCores));
  const memoryOf =
    usage.memoryLimitBytes === null ? TEXT.metrics.noLimit : TEXT.metrics.memoryLimit(bytes(usage.memoryLimitBytes));
  const hostNetwork = usage.receiveBytesPerSecond === null || usage.transmitBytesPerSecond === null;
  return (
    <>
      <td className="small">
        {precisePercent(usage.cpuPercent)}
        <div className="muted">{cpuOf}</div>
      </td>
      <td className="small">
        {bytes(usage.memoryBytes)}
        <div className="muted">{memoryOf}</div>
      </td>
      <td className="small">
        {hostNetwork ? (
          <span className="muted">{TEXT.metrics.hostNetwork}</span>
        ) : (
          rate((usage.receiveBytesPerSecond ?? 0) + (usage.transmitBytesPerSecond ?? 0))
        )}
      </td>
      <td className="small">{usage.processes ?? <Missing />}</td>
    </>
  );
}

// An update waiting behind the container's tag, unless its label turns updates off; it leads to the task.
function UpdateBadge({ container }: { container: ContainerView }) {
  if (!hasUpdate(container)) {
    return null;
  }
  const query = new URLSearchParams({
    [TASK_SEARCH_PARAMETERS.show]: TASK_SHOW.updates,
    [TASK_SEARCH_PARAMETERS.search]: container.name,
  });
  return (
    <Link to={`${PATHS.tasks}?${query}`}>
      <Badge value={TEXT.updates.available} tone="warning" />
    </Link>
  );
}

// A newer version than its tag, which only a person can move it to; it leads to the task that says how.
function NewerVersionBadge({ container }: { container: ContainerView }) {
  if (!hasNewerVersion(container)) {
    return null;
  }
  const query = new URLSearchParams({
    [TASK_SEARCH_PARAMETERS.show]: TASK_SHOW.open,
    [TASK_SEARCH_PARAMETERS.search]: container.name,
  });
  return (
    <Link to={`${PATHS.tasks}?${query}`}>
      <Badge value={TEXT.updates.newer(container.update.newerTag!)} tone="warning" />
    </Link>
  );
}

// Every column a row has, so the opened stats can span them all.
const CONTAINER_COLUMNS = 10;

function ContainerRow({
  container,
  open,
  onToggle,
}: {
  container: ContainerView;
  open: boolean;
  onToggle: () => void;
}) {
  const since = container.state === CONTAINER_STATE_RUNNING ? container.startedAt : container.finishedAt;
  const compose = [container.composeProject, container.composeService].filter(Boolean).join(" / ");
  return (
    <tr className={open ? "clickable selected" : "clickable"} onClick={rowClick(onToggle)}>
      <td>
        <button
          type="button"
          className="link container-name"
          aria-pressed={open}
          aria-expanded={open}
          onClick={onToggle}
        >
          {container.name}
        </button>{" "}
        {container.protected && <Badge value={TEXT.containers.protected} />} <UpdateBadge container={container} />{" "}
        <NewerVersionBadge container={container} /> <WebLink container={container} />
        {compose && <div className="muted small">{compose}</div>}
      </td>
      <td>
        <Link to={hostLink(container.hostId)}>{container.hostLabel}</Link>
        {container.hostState !== HOST_STATE.online && <div className="muted small">{TEXT.containers.staleHost}</div>}
      </td>
      <td className="state-cell">
        <span className={stateTone(container)}>{stateOf(container)}</span>
        {container.exitCode !== null && (
          <div className="muted small">{TEXT.containers.exitCode(container.exitCode)}</div>
        )}
      </td>
      <td>
        <TimeAgo timestamp={since} />
      </td>
      <td>{container.restartCount}</td>
      <UsageCells usage={container.usage} />
      <td className="small mono">{container.image}</td>
    </tr>
  );
}

function ContainerTable({ containers, selection }: { containers: ContainerView[]; selection: Selection }) {
  const admin = isAdmin(useSignedInSession());
  if (containers.length === 0) {
    return <p className="muted">{TEXT.containers.empty}</p>;
  }
  // Across hosts a name needs its host too.
  const keyOf = (container: ContainerView) => `${container.hostLabel}/${container.name}`;
  return (
    <div className="table-wrap container-table">
      <table>
        <thead>
          <tr>
            <th>{TEXT.containers.container}</th>
            <th>{TEXT.containers.host}</th>
            <th>{TEXT.containers.state}</th>
            <th>{TEXT.containers.since}</th>
            <th>{TEXT.containers.restarts}</th>
            <th>{TEXT.containers.cpu}</th>
            <th>{TEXT.containers.memory}</th>
            <th>{TEXT.containers.network}</th>
            <th>{TEXT.containers.processes}</th>
            <th>{TEXT.containers.image}</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((container) => {
            const open = selection.open === keyOf(container);
            return (
              <Fragment key={`${container.hostId}/${container.name}`}>
                <ContainerRow container={container} open={open} onToggle={() => selection.toggle(keyOf(container))} />
                {open && (
                  <tr className="inspector-row">
                    <td colSpan={CONTAINER_COLUMNS}>
                      <ContainerInspector
                        container={container}
                        siblings={containers.filter((sibling) => sibling.hostId === container.hostId)}
                        canAct={admin}
                        arrived={selection.arrived === keyOf(container)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Every container on every host, to search and filter. */
function ContainerList() {
  const filters = useFilters();
  const selection = useContainerSelection();
  const hosts = useQuery(enrolledHostsQuery);
  const query = new URLSearchParams(
    [
      [CONTAINER_QUERY.search, filters.search.trim()],
      [CONTAINER_QUERY.problemsOnly, filters.problemsOnly ? QUERY_TRUE : ""],
      [CONTAINER_QUERY.hostId, filters.hostId],
    ].filter(([, value]) => value !== ""),
  ).toString();
  const containers = useQuery({
    queryKey: ["containers", query],
    queryFn: () => api<ContainerView[]>("GET", `${API_ROUTES.containers}?${query}`),
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
  });
  return (
    <div className="stack">
      <div className="filters">
        <label>
          {TEXT.containers.search}
          <input
            type="search"
            value={filters.search}
            onChange={(event) => filters.set(SEARCH_PARAMETERS.search, event.target.value)}
          />
        </label>
        <label>
          {TEXT.containers.host}
          <select
            value={filters.hostId}
            onChange={(event) => filters.set(SEARCH_PARAMETERS.hostId, event.target.value)}
          >
            <option value="">{TEXT.containers.allHosts}</option>
            {hosts.data?.map((host) => (
              <option key={host.id} value={host.id}>
                {host.label}
              </option>
            ))}
          </select>
        </label>
        <ProblemsOnlyToggle
          checked={filters.problemsOnly}
          onChange={(checked) => filters.set(SEARCH_PARAMETERS.problemsOnly, checked ? QUERY_TRUE : "")}
        />
        <SavedViewPicker filters={filters} hosts={hosts.data} />
      </div>
      {containers.data === undefined ? (
        <Loading />
      ) : (
        <ContainerTable containers={containers.data} selection={selection} />
      )}
      <ErrorNotice error={containers.error} />
    </div>
  );
}

export function ContainersPage() {
  return (
    <div className="page">
      <PageHeader title={TEXT.containers.title} lede={TEXT.containers.lede} />
      <ContainerList />
    </div>
  );
}
