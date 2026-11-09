import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { API_ROUTES, apiPath, type ContainerView, type JobView } from "../../../src/shared/api.js";
import {
  DOCKER_OWN_NETWORKS,
  JOB_ACTION,
  MILLISECONDS_PER_SECOND,
  PORT_PROTOCOL,
  sizeText,
} from "../../../src/shared/constants.js";
import type { ContainerDetailsView, SettingsAnswer } from "../../../src/shared/protocol.js";
import { api } from "../api-client.js";
import { CONTAINER_DETAILS_REFRESH_MILLISECONDS, SECRET_NAME_PATTERN, TEXT } from "../constants.js";
import { ErrorNotice, Loading, PlainText, TimeAgo } from "./common.js";
import { jobsQuery } from "./container-actions.js";
import { ContainerFiles } from "./container-files.js";
import { ContainerTimeline } from "./container-timeline.js";
import { TakeAway } from "./take-away.js";

const text = TEXT.containerDetails;
export const DETAIL_TABS = Object.keys(text.tabs) as (keyof typeof text.tabs)[];
export type DetailTab = (typeof DETAIL_TABS)[number];

const settingsPath = (container: ContainerView) =>
  apiPath(API_ROUTES.containerSettings, { hostId: container.hostId, containerName: container.name });

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="detail-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={typeof value === "string" ? value : undefined}>{value === "" ? TEXT.none : value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Rows({ heads, rows }: { heads: string[]; rows: ReactNode[][] }) {
  if (rows.length === 0) return <p className="small muted">{text.nothing}</p>;
  return (
    <div className="detail-table">
      <table>
        <thead>
          <tr>
            {heads.map((head) => (
              <th key={head}>{head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const timestampOf = (iso: string | null) => {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(at) || at <= 0 ? null : at;
};

function When({ iso }: { iso: string | null }) {
  const at = timestampOf(iso);
  return at === null ? <>{TEXT.none}</> : <TimeAgo timestamp={at} />;
}

function Overview({ container, details }: { container: ContainerView; details: ContainerDetailsView | null }) {
  const facts = text.facts;
  const ports = (container.ports ?? []).map((port) => `${port.published} → ${port.target}/${port.protocol}`);
  return (
    <div className="detail-overview">
      <Facts
        rows={[
          [facts.image, container.image],
          [facts.imageId, details?.imageId?.slice(0, text.imageIdCharacters) ?? ""],
          [facts.created, <When key="created" iso={details?.createdAt ?? null} />],
          [facts.started, <When key="started" iso={details?.startedAt ?? null} />],
          [
            facts.command,
            <span key="command" className="mono">
              {details?.command.join(" ") ?? ""}
            </span>,
          ],
          [facts.workingFolder, details?.workingFolder ?? ""],
          [facts.user, details?.user ?? ""],
          [facts.hostname, details?.hostname ?? ""],
          [facts.stack, container.composeProject ?? ""],
          [facts.version, container.version ?? ""],
          [facts.restarts, String(container.restartCount)],
          [facts.restartPolicy, container.restartPolicy],
          [facts.ports, ports.join(TEXT.listComma)],
          [facts.networks, details?.networks.map((network) => network.name).join(TEXT.listComma) ?? ""],
        ]}
      />
      <div className="stack">
        <ContainerTimeline hostId={container.hostId} containerName={container.name} />
        {details?.installedIn !== undefined && (
          <div className="stack small">
            <p className="muted">{text.installedHere(details.installedIn)}</p>
            <p>
              <TakeAway
                hostId={container.hostId}
                name={container.name}
                folder={details.installedIn}
                label={text.takeAway}
              />
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Asked for when the tab opens, the same read as the button on its row, and shown here.
function Logs({ container }: { container: ContainerView }) {
  const queryClient = useQueryClient();
  const logsJobs = jobsQuery(container.hostId, container.name);
  const jobs = useQuery({
    ...logsJobs,
    refetchInterval: (query) =>
      query.state.data?.find((job) => job.action === JOB_ACTION.logs)?.output == null
        ? CONTAINER_DETAILS_REFRESH_MILLISECONDS
        : false,
  });
  const read = useMutation({
    mutationFn: () =>
      api<JobView>(
        "POST",
        apiPath(API_ROUTES.containerActions, { hostId: container.hostId, containerName: container.name }),
        { action: JOB_ACTION.logs },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: logsJobs.queryKey }),
  });
  useEffect(() => read.mutate(), []);
  const latest = jobs.data?.find((job) => job.action === JOB_ACTION.logs);
  return (
    <div className="stack">
      <p>
        <button type="button" className="small" disabled={read.isPending} onClick={() => read.mutate()}>
          {text.readLogs}
        </button>
      </p>
      {latest?.output != null ? <PlainText text={latest.output} /> : <Loading />}
      <ErrorNotice error={read.error ?? jobs.error} />
    </div>
  );
}

function Layers({ details }: { details: ContainerDetailsView }) {
  return (
    <Rows
      heads={[text.layers.size, text.layers.created, text.layers.step]}
      rows={details.layers.map((layer) => [
        sizeText(layer.sizeBytes),
        <TimeAgo key="at" timestamp={layer.createdAt * MILLISECONDS_PER_SECOND} />,
        <span key="step" className="mono">
          {layer.step}
        </span>,
      ])}
    />
  );
}

function Processes({ details }: { details: ContainerDetailsView }) {
  if (details.processes === null) return <p className="small muted">{text.notRunningNow}</p>;
  return <Rows heads={details.processes.titles} rows={details.processes.rows} />;
}

// Each network the host offers: a click joins it, another leaves it, live.
function NetworkChoices({ container, details }: { container: ContainerView; details: ContainerDetailsView }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (network: { name: string; joined: boolean }) =>
      api<SettingsAnswer>(
        "POST",
        apiPath(API_ROUTES.containerNetwork, { hostId: container.hostId, containerName: container.name }),
        network,
      ),
    onSuccess: (answer) => {
      if (answer.details != null) {
        queryClient.setQueryData(["container-details", container.hostId, container.name], answer);
      }
    },
  });
  const joined = new Set(details.networks.map((network) => network.name));
  const available = details.availableNetworks;
  if (available === undefined) return <p className="small muted">{text.olderRunner}</p>;
  if (available.length === 0) return <p className="small muted">{text.fixedNetwork(details.networkMode ?? "")}</p>;
  return (
    <div className="stack">
      <div className="install-row-choices" role="group" aria-label={text.joinLabel}>
        {available.map((name) => (
          <button
            key={name}
            type="button"
            className="install-choice"
            aria-pressed={joined.has(name)}
            disabled={change.isPending}
            onClick={() => change.mutate({ name, joined: !joined.has(name) })}
          >
            {name}
          </button>
        ))}
      </div>
      {change.data?.error != null && (
        <p className="notice warning small" role="alert">
          {change.data.error}
        </p>
      )}
      {change.isSuccess && change.data.error === null && change.data.details == null && (
        <p className="small muted">{text.olderRunner}</p>
      )}
      <ErrorNotice error={change.error} />
      <p className="small muted">{container.composeProject === null ? text.joinLive : text.joinLiveCompose}</p>
    </div>
  );
}

function Network({ container, details }: { container: ContainerView; details: ContainerDetailsView }) {
  const network = text.network;
  return (
    <div className="stack">
      <NetworkChoices container={container} details={details} />
      <Rows
        heads={[network.name, network.address, network.gateway, network.aliases]}
        rows={details.networks.map((each) => [
          each.name,
          each.address || TEXT.none,
          each.gateway || TEXT.none,
          each.aliases.join(TEXT.listComma) || TEXT.none,
        ])}
      />
      <Ports container={container} details={details} />
    </div>
  );
}

type DetailPorts = NonNullable<ContainerDetailsView["ports"]>;

// From a runner too old to list them all: those it publishes, which its host's report carries.
function publishedPorts(container: ContainerView): DetailPorts {
  const byPort = new Map<string, DetailPorts[number]>();
  for (const { published, target, protocol } of container.ports ?? []) {
    const name = `${target}/${protocol}`;
    const entry = byPort.get(name) ?? { port: target, protocol, published: [] };
    entry.published.push({ address: "", port: published });
    byPort.set(name, entry);
  }
  return [...byPort.values()];
}

const onTheHost = ({ address, port }: DetailPorts[number]["published"][number]) => {
  if (address === "") return String(port);
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
};

// What a proxy needs: each port it has in the container, where the host publishes it, and its name on its networks.
function Ports({ container, details }: { container: ContainerView; details: ContainerDetailsView }) {
  const ports = details.ports ?? publishedPorts(container);
  // Docker's own networks give it no name to be reached by.
  const shared = details.networks.map(({ name }) => name).filter((name) => !DOCKER_OWN_NETWORKS.has(name));
  const example = ports.find(({ protocol }) => protocol === PORT_PROTOCOL.tcp);
  return (
    <div className="stack">
      <h4>{text.portsTitle}</h4>
      <Rows
        heads={[text.containerPort, text.hostPort]}
        rows={ports.map((each) => [
          `${each.port}/${each.protocol}`,
          each.published.length === 0 ? text.notPublished : each.published.map(onTheHost).join(TEXT.listComma),
        ])}
      />
      {example !== undefined && shared.length > 0 && (
        <p className="small muted">{text.proxyAt(shared.join(TEXT.listComma), `${container.name}:${example.port}`)}</p>
      )}
    </div>
  );
}

function Mounts({ details }: { details: ContainerDetailsView }) {
  const mounts = text.mounts;
  return (
    <Rows
      heads={[mounts.kind, mounts.source, mounts.target, mounts.mode]}
      rows={details.mounts.map((mount) => [
        mount.kind,
        <span key="source" className="mono">
          {mount.source}
        </span>,
        <span key="target" className="mono">
          {mount.target}
        </span>,
        mount.readOnly ? mounts.readOnly : mounts.readWrite,
      ])}
    />
  );
}

function SecretValue({ name, value }: { name: string; value: string }) {
  const [shown, setShown] = useState(false);
  if (!SECRET_NAME_PATTERN.test(name) || value === "") return <span className="mono">{value}</span>;
  return (
    <span className="row">
      <span className="mono">{shown ? value : text.hidden}</span>
      <button type="button" className="link small" onClick={() => setShown(!shown)}>
        {shown ? text.hide : text.show}
      </button>
    </span>
  );
}

// Environment and labels are its settings: read only when one of these tabs asks, and noted in the audit log.
function Pairs({ container, kind }: { container: ContainerView; kind: "environment" | "labels" }) {
  const settings = useQuery({
    queryKey: ["container-settings-read", container.hostId, container.name],
    queryFn: () => api<SettingsAnswer>("GET", settingsPath(container)),
  });
  if (settings.isPending) return <Loading />;
  const pairs = settings.data?.settings?.[kind] ?? [];
  return (
    <div className="stack">
      <Rows
        heads={[text.pair.name, text.pair.value]}
        rows={pairs.map((pair) => [
          <span key="name" className="mono">
            {pair.name}
          </span>,
          <SecretValue key="value" name={pair.name} value={pair.value} />,
        ])}
      />
      <p className="small muted">{settings.data?.error ?? text.changeThrough}</p>
      <ErrorNotice error={settings.error} />
    </div>
  );
}

function Security({ details }: { details: ContainerDetailsView }) {
  const words = text.security;
  const { security } = details;
  const yesNo = (value: boolean) => (value ? words.yes : words.no);
  const good = (value: string, fine: boolean) => <span className={fine ? "detail-good" : "text-warning"}>{value}</span>;
  return (
    <Facts
      rows={[
        [words.user, details.user === "" ? words.root : details.user],
        [words.privileged, good(yesNo(security.privileged), !security.privileged)],
        [words.added, security.capabilitiesAdded.join(TEXT.listComma) || words.none],
        [words.dropped, security.capabilitiesDropped.join(TEXT.listComma) || words.none],
        [words.readOnly, good(yesNo(security.readOnlyRoot), security.readOnlyRoot)],
        [words.noNewPrivileges, good(yesNo(security.noNewPrivileges), security.noNewPrivileges)],
        [words.appArmor, security.appArmor || words.standard],
        [words.seccomp, security.seccomp || words.standard],
        [words.socket, good(security.dockerSocket ? words.mounted : words.notMounted, !security.dockerSocket)],
      ]}
    />
  );
}

function Resources({
  container,
  details,
  trend,
}: {
  container: ContainerView;
  details: ContainerDetailsView;
  trend: ReactNode;
}) {
  const words = text.resources;
  const { resources } = details;
  const throttled = container.usage?.throttledPercent;
  return (
    <div className="stack">
      <Facts
        rows={[
          [words.cpu, resources.cpuCores === null ? words.none : words.cores(resources.cpuCores)],
          [words.memory, resources.memoryBytes === null ? words.none : sizeText(resources.memoryBytes)],
          [words.processes, resources.processes === null ? words.none : String(resources.processes)],
          [words.throttled, throttled == null ? TEXT.none : `${throttled}%`],
          [words.oom, resources.oomKilled ? words.killed : words.never],
        ]}
      />
      {trend}
    </div>
  );
}

function Health({ details }: { details: ContainerDetailsView }) {
  const words = text.health;
  const { health } = details;
  if (health === null) return <p className="small muted">{words.none}</p>;
  const seconds = (value: number | null) => (value === null ? TEXT.none : words.seconds(value));
  return (
    <div className="stack">
      <Facts
        rows={[
          [words.status, health.status],
          [
            words.check,
            <span key="check" className="mono">
              {health.test.join(" ")}
            </span>,
          ],
          [words.every, seconds(health.everySeconds)],
          [words.timeout, seconds(health.timeoutSeconds)],
          [words.streak, String(health.failingStreak)],
        ]}
      />
      <Rows
        heads={[words.when, words.result, words.output]}
        rows={health.checks.map((check) => [
          <When key="at" iso={check.at} />,
          <span key="result" className={check.exitCode === 0 ? "detail-good" : "text-warning"}>
            {check.exitCode === 0 ? words.passed : words.failed}
          </span>,
          <span key="output" className="mono">
            {check.output}
          </span>,
        ])}
      />
    </div>
  );
}

const COUNTS: Partial<Record<DetailTab, (details: ContainerDetailsView) => number | undefined>> = {
  layers: (details) => details.layers.length,
  processes: (details) => details.processes?.rows.length,
  network: (details) => details.networks.length,
  mounts: (details) => details.mounts.length,
};

/** A container told by topic, in place under its row: one tab at a time, Overview first. */
export function ContainerDetailTabs({
  container,
  tab,
  onTab,
  trend,
}: {
  container: ContainerView;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  trend: ReactNode;
}) {
  const details = useQuery({
    queryKey: ["container-details", container.hostId, container.name],
    queryFn: () => api<SettingsAnswer>("GET", `${settingsPath(container)}?details=true`),
    // What runs in it changes as you watch; the rest hardly does.
    refetchInterval: tab === "processes" ? CONTAINER_DETAILS_REFRESH_MILLISECONDS : false,
  });
  const view = details.data?.details ?? null;
  const needsDetails = (panel: (loaded: ContainerDetailsView) => ReactNode) => {
    if (details.isPending) return <Loading />;
    if (details.error) return <ErrorNotice error={details.error} />;
    if (view === null) return <p className="small muted">{details.data?.error ?? text.olderRunner}</p>;
    return panel(view);
  };
  return (
    <div className="stack detail-tabs-panel">
      <div className="detail-tabs" role="tablist" aria-label={text.label(container.name)}>
        {DETAIL_TABS.map((each) => {
          const count = view === null ? undefined : COUNTS[each]?.(view);
          return (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={tab === each}
              className={tab === each ? "active" : undefined}
              onClick={() => onTab(each)}
            >
              {text.tabs[each]}
              {count !== undefined && <span className="tab-count">{count}</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">
        {tab === "overview" && <Overview container={container} details={view} />}
        {tab === "logs" && <Logs container={container} />}
        {tab === "layers" && needsDetails((loaded) => <Layers details={loaded} />)}
        {tab === "processes" && needsDetails((loaded) => <Processes details={loaded} />)}
        {tab === "network" && needsDetails((loaded) => <Network container={container} details={loaded} />)}
        {tab === "mounts" && needsDetails((loaded) => <Mounts details={loaded} />)}
        {tab === "files" && (
          <ContainerFiles hostId={container.hostId} containerName={container.name} onClose={() => onTab("overview")} />
        )}
        {tab === "environment" && <Pairs container={container} kind="environment" />}
        {tab === "labels" && <Pairs container={container} kind="labels" />}
        {tab === "security" && needsDetails((loaded) => <Security details={loaded} />)}
        {tab === "resources" &&
          needsDetails((loaded) => <Resources container={container} details={loaded} trend={trend} />)}
        {tab === "health" && needsDetails((loaded) => <Health details={loaded} />)}
      </div>
    </div>
  );
}
