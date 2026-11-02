import { AgentNetwork } from "../components/agent-network.js";
import { AnomalyExplanation } from "../components/anomaly-explanation.js";
import { ANOMALY_TASK_LABEL, TREND_METRICS } from "../../../src/shared/metric-trends.js";
import { MaintenanceBadge } from "../components/maintenance-dialog.js";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  hasUpdate,
  type BoardCardView,
  type ContainerView,
  type HomeAssistantUpdateView,
  type HostPackagesView,
  type HostView,
  type OllamaServersView,
  type IncidentDetailView,
  type IncidentSummaryView,
  type TaskChangeRequest,
  type TaskSummaryView,
  type UpdateRunView,
} from "../../../src/shared/api.js";
import {
  ACTION_ESCALATE,
  ACTION_RESTART,
  APPROVAL_DISMISS,
  DETECTOR_THRESHOLDS,
  HOST_STATE,
  INCIDENT_STATUS,
  INTEGRATION_KIND,
  INTEGRITY_OK,
  OUTCOMES,
  PERCENT,
  RESTART_CHOICE,
  TASK_LABEL,
  TASK_RESOURCE,
  TASK_STATUS,
  UPDATE_ASSESSMENT,
  UPDATE_CHECK_INTERVAL_MILLISECONDS,
  UPDATE_RUN_STATUS,
  VERDICT_FIXED,
  type UpdateAssessment,
} from "../../../src/shared/constants.js";
import {
  carriesHandOver,
  droppedItems,
  handedCount,
  incidentHandable,
  incidentItem,
  packageItem,
  packagesHandable,
  startDrag,
  updateHandable,
  updateItem,
  useHandOver,
  useSelection,
  type Selection,
  hostsOfItems,
} from "../agent-dispatch.js";
import { FLEET_STATE, answeringFor, fleetOf, serversFor, type Fleet, type FleetState } from "../ollama-fleet.js";
import { api } from "../api-client.js";
import { isIncident, isTask, isUpdateTask, whatNeedsYou } from "../board.js";
import { Bar, ErrorNotice, Loading, PageHeader, TimeAgo } from "../components/common.js";
import { ImageVersions } from "../components/container-actions.js";
import { Icon, type IconName } from "../components/icons.js";
import { approvalOf, incidentLink, incidentQuery, useApproval } from "../components/incident-parts.js";
import { DISK_FULL_DANGER_PERCENT, MILLISECONDS_PER_HOUR, PATHS, SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { percent, timeAgo } from "../format.js";
import {
  backupsQuery,
  boardQuery,
  containersQuery,
  enrolledHostsQuery,
  hostPackagesQuery,
  hostUpdatesQuery,
  integrationsQuery,
  ollamaQuery,
  networkOverviewQuery,
  ollamaServersQuery,
  routerSettingsQuery,
  overviewQuery,
} from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { runLine, stateIn, useUpdateRun } from "../update-runs.js";
import { healingPaused, hostStateText } from "./fleet-page.js";
import { ReleaseNotes, homeAssistantProblems } from "./home-assistant-system.js";
import { diskUsedPercent, fullestDisk } from "./host-stats.js";

const hostLink = (hostId: string) => apiPath(PATHS.host, { hostId });

// How full the host's fullest disk is; 0 before its first report.
function fullestPercent(host: HostView): number {
  const fullest = fullestDisk(host.health);
  return fullest === undefined ? 0 : diskUsedPercent(fullest);
}
const updatesOn = (containers: readonly ContainerView[], hostId: string) =>
  containers.filter((container) => container.hostId === hostId && hasUpdate(container)).length;

// One more fact after the running count, the most pressing: a disk nearly full, else updates waiting.
function HostCardFact({ disk, updates }: { disk: number; updates: number }) {
  if (disk >= DETECTOR_THRESHOLDS.diskPercent) {
    return (
      <>
        {TEXT.separator}
        <span className="text-danger">{TEXT.attention.fullestDisk(percent(disk))}</span>
      </>
    );
  }
  return updates > 0 ? `${TEXT.separator}${TEXT.hosts.updates(updates)}` : null;
}

function HostCard({ host, updates }: { host: HostView; updates: number }) {
  const disk = fullestPercent(host);
  const healing = host.state === HOST_STATE.online && !healingPaused(host);
  return (
    <Link className="status-card" to={hostLink(host.id)}>
      <span className="status-card-head">
        <strong>{host.label}</strong>
        <span className={healing ? "state tone-good" : "state tone-danger"}>
          <span className="status-dot" />
          {hostStateText(host)}
        </span>
      </span>
      <span className="status-card-line">
        {TEXT.hosts.running(host.runningCount, host.containerCount)}
        <HostCardFact disk={disk} updates={updates} />
      </span>
    </Link>
  );
}

function HomeAssistantCard() {
  const integrations = useQuery(integrationsQuery);
  const overview = useQuery(overviewQuery);
  const text = TEXT.attention.homeAssistant;
  const configured = integrations.data?.some(
    (view) => view.kind === INTEGRATION_KIND.homeAssistant && view.source !== null,
  );
  if (!configured) {
    return (
      <Link className="status-card dashed" to={`${PATHS.settings}#${SETTINGS_SECTIONS.connections}`}>
        <span className="status-card-head">
          <strong>{text.title}</strong>
          <span className="state">{text.notConnected}</span>
        </span>
        <span className="status-card-line accent">{text.connect}</span>
      </Link>
    );
  }
  const home = overview.data?.homeAssistant ?? null;
  if (home === null || !home.connected) {
    return (
      <Link className="status-card" to={`${PATHS.settings}#${SETTINGS_SECTIONS.connections}`}>
        <span className="status-card-head">
          <strong>{text.title}</strong>
          <span className="state tone-danger">
            <span className="status-dot" />
            {text.notAnswering}
          </span>
        </span>
        <span className="status-card-line accent">{text.checkIt}</span>
      </Link>
    );
  }
  const problems = homeAssistantProblems(home);
  return (
    <Link className="status-card" to={PATHS.homeAssistant}>
      <span className="status-card-head">
        <strong>{text.title}</strong>
        <span className="state tone-good">
          <span className="status-dot" />
          {text.connected}
        </span>
      </span>
      <span className="status-card-line">{problems === 0 ? text.allFine : text.toLookAt(problems)}</span>
    </Link>
  );
}

// Updates and escalated incidents dropped on the Ollama agent's card, as their keys.
type HandOver = (items: readonly string[]) => void;

// The default has no name of its own.
const serverLabel = (name: string | null) => name ?? TEXT.attention.ollama.defaultName;

// With several servers: each one, what it runs and who it watches.
function FleetLines({ fleet }: { fleet: Fleet }) {
  const onDefault = fleet.lines[0]?.name ?? TEXT.attention.ollama.defaultServer;
  const text = TEXT.attention.ollama;
  return (
    <span className="agent-servers">
      {fleet.lines.map((line) => (
        <span key={line.id ?? ""} className="agent-server">
          <span className={line.reachable ? "agent-server-name" : "agent-server-name tone-danger"}>
            {serverLabel(line.name)}
          </span>
          <span className="mono">{line.model}</span>
          <span className="muted">{text.watching(line.hosts)}</span>
          {!line.reachable && line.id !== null && (
            <span className="agent-server-note tone-danger">{text.onDefault(onDefault)}</span>
          )}
        </span>
      ))}
    </span>
  );
}

const FLEET_TONE: Record<FleetState, string> = {
  [FLEET_STATE.all]: "tone-good",
  [FLEET_STATE.some]: "tone-warning",
  [FLEET_STATE.none]: "tone-danger",
};

// Where what is being dragged goes. Nothing is said while there is only one place it could.
function dropWords(servers: OllamaServersView | undefined, draggingHosts: readonly (string | null)[]): string {
  const { dropTarget, goesTo, goesToServers } = TEXT.attention.agent;
  if ((servers?.extras.length ?? 0) === 0 || draggingHosts.length === 0) return dropTarget;
  const going = serversFor(servers, draggingHosts);
  return going.length === 1 ? goesTo(going[0] ?? TEXT.attention.ollama.defaultServer) : goesToServers(going.length);
}

function OllamaCard({
  hosts,
  onHandOver,
  draggingHosts,
  working,
}: {
  hosts: readonly HostView[];
  onHandOver?: HandOver;
  draggingHosts: readonly (string | null)[];
  working: boolean;
}) {
  const ollama = useQuery(ollamaQuery);
  const servers = useQuery(ollamaServersQuery);
  const [over, setOver] = useState(false);
  if (ollama.data === undefined) {
    return null;
  }
  const fleet = fleetOf(ollama.data, servers.data, hosts);
  const several = fleet.lines.length > 1;
  const text = TEXT.attention;
  const dropping = onHandOver !== undefined;
  const singleWords = ollama.data.reachable ? text.ollama.answering : text.ollama.notAnswering;
  const stateWords = several ? text.ollama.answeringOf(fleet.answering, fleet.lines.length) : singleWords;
  // Only a hand-over may be dropped here: anything else dragged over it is left to the browser.
  const dragOver = (event: DragEvent) => {
    if (!carriesHandOver(event)) {
      return;
    }
    event.preventDefault();
    setOver(true);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const items = droppedItems(event);
    if (items.length > 0) {
      onHandOver?.(items);
    }
  };
  const classes = ["status-card", "agent-card", dropping ? "drop-target" : "", over ? "dragged-over" : ""];
  return (
    <Link
      className={classes.filter(Boolean).join(" ")}
      to={`${PATHS.settings}#${SETTINGS_SECTIONS.connections}`}
      title={dropping ? text.agent.dropHere : undefined}
      onDragEnter={dropping ? dragOver : undefined}
      onDragOver={dropping ? dragOver : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={dropping ? drop : undefined}
    >
      <span className="status-card-head">
        <strong>
          <span className="agent-avatar" aria-hidden />
          {text.ollama.title}
        </strong>
        <span className={`state ${FLEET_TONE[fleet.state]}`}>
          <span className="status-dot" />
          {stateWords}
        </span>
      </span>
      {several && <FleetLines fleet={fleet} />}
      <AgentNetwork working={working || over} answering={fleet.state !== FLEET_STATE.none} />
      <span className={several ? "status-card-line agent-line agent-line-end" : "status-card-line agent-line"}>
        {!several && <span className="mono">{ollama.data.model}</span>}
        {dropping && (
          <span className="drop-chip">
            <Icon name="arrowDown" />
            {dropWords(servers.data, draggingHosts)}
          </span>
        )}
      </span>
    </Link>
  );
}

// With a router set up: how the network is doing, a click from its page. Its details are for admins.
function NetworkCard() {
  const admin = isAdmin(useSignedInSession());
  const router = useQuery({ ...routerSettingsQuery, enabled: admin });
  const overview = useQuery({ ...networkOverviewQuery, enabled: admin && router.data?.configured === true });
  const view = overview.data;
  if (view === undefined) return null;
  const text = TEXT.network.card;
  const toLookAt = view.toLookAt > 0;
  const words = toLookAt ? text.toLookAt(view.toLookAt) : text.allFine;
  const tone = toLookAt ? "tone-warning" : "tone-good";
  return (
    <Link className="status-card" to={PATHS.network}>
      <span className="status-card-head">
        <strong>{text.title}</strong>
        <span className={`state ${view.connected ? tone : "tone-danger"}`}>
          <span className="status-dot" />
          {view.connected ? words : text.notRead}
        </span>
      </span>
      <span className="status-card-line">
        {view.internet.upPercent === null
          ? TEXT.none
          : TEXT.network.stats.internetLine(view.internet.outages, view.internet.downMinutes)}
      </span>
    </Link>
  );
}

/**
 * Each host, Home Assistant and Ollama in a line of cards: how each is doing, each a link to more. Where work may
 * be handed to the Ollama agent, its card takes what is dropped on it.
 */
export function StatusStrip({
  hosts,
  containers,
  onHandOver,
  draggingHosts = [],
  working = false,
}: {
  hosts: readonly HostView[];
  containers: readonly ContainerView[];
  onHandOver?: HandOver;
  // The hosts of what is being dragged now.
  draggingHosts?: readonly (string | null)[];
  // Whether the agent has something in hand.
  working?: boolean;
}) {
  return (
    <nav className="status-strip" aria-label={TEXT.attention.services}>
      <div className="status-hosts">
        {hosts.map((host) => (
          <HostCard key={host.id} host={host} updates={updatesOn(containers, host.id)} />
        ))}
        <HomeAssistantCard />
        <NetworkCard />
      </div>
      <OllamaCard hosts={hosts} onHandOver={onHandOver} draggingHosts={draggingHosts} working={working} />
    </nav>
  );
}

// The handle a row or card is dragged by onto the Ollama agent: its words are the tick's, or the card's button.
const Grip = () => <Icon name="grip" className="grip" />;

function SectionLabel({
  tone,
  text,
}: {
  tone: "warning" | "danger" | "accent";
  text: { label: string; hint: string };
}) {
  return (
    <h2 className={`section-label tone-${tone}`}>
      {text.label}
      <span className="section-hint">{text.hint}</span>
    </h2>
  );
}

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

function DecisionCard({
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

const ownerOf = (task: TaskSummaryView, viewerId: string) => {
  const since = timeAgo(task.createdAt);
  if (task.assignee === null) {
    return TEXT.attention.openSince(since);
  }
  return task.assignee.kind === "user" && task.assignee.id === viewerId
    ? TEXT.attention.yoursSince(since)
    : TEXT.attention.theirsSince(task.assignee.name, since);
};

function FixCard({
  task,
  host,
  viewerId,
  admin,
}: {
  task: TaskSummaryView;
  host: HostView | undefined;
  viewerId: string;
  admin: boolean;
}) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (body: TaskChangeRequest) => api("PATCH", apiPath(API_ROUTES.task, { taskId: task.id }), body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardQuery.queryKey }),
  });
  const disk =
    task.resource?.kind === TASK_RESOURCE.disk
      ? host?.health?.disks.find((candidate) => candidate.path === task.resource?.id)
      : undefined;
  const filled = disk === undefined ? null : diskUsedPercent(disk);
  const tone = filled !== null && filled >= DISK_FULL_DANGER_PERCENT ? "danger" : "warning";
  const where = disk === undefined ? (task.hostLabel ?? "") : TEXT.attention.diskOn(task.hostLabel ?? "");
  return (
    <article className="card fix">
      <header className="fix-head">
        <h3 className={disk === undefined ? undefined : "mono"}>{disk === undefined ? task.title : disk.path}</h3>
        {filled !== null && <span className={`fix-figure text-${tone}`}>{percent(filled)}</span>}
      </header>
      {filled !== null && <Bar fraction={filled / PERCENT} tone={tone} />}
      <p className="small muted">{[where, ownerOf(task, viewerId)].filter(Boolean).join(TEXT.separator)}</p>
      {task.hostId !== null && (
        <MaintenanceBadge
          hostId={task.hostId}
          containerName={task.resource?.kind === TASK_RESOURCE.container ? task.resource?.id : undefined}
        />
      )}
      {task.hostId !== null && task.labels.includes(ANOMALY_TASK_LABEL) && (
        <AnomalyExplanation
          hostId={task.hostId}
          containerName={task.resource?.kind === TASK_RESOURCE.container ? task.resource.id : null}
          metric={TREND_METRICS.find(
            (metric) =>
              task.labels.includes(`${ANOMALY_TASK_LABEL}-${metric}`) ||
              task.labels.includes(`${ANOMALY_TASK_LABEL}:${metric}`),
          )}
          admin={admin}
        />
      )}
      <div className="card-actions">
        {task.hostId !== null && task.hostLabel !== null ? (
          <Link className="button" to={hostLink(task.hostId)}>
            {TEXT.attention.open(task.hostLabel)}
          </Link>
        ) : (
          <Link className="button" to={apiPath(PATHS.task, { taskId: task.id })}>
            {TEXT.attention.open(`#${task.number}`)}
          </Link>
        )}
        {admin && (
          <>
            <button
              type="button"
              className="quiet"
              disabled={change.isPending}
              onClick={() => change.mutate({ snoozed: true })}
            >
              {TEXT.attention.snooze}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={change.isPending}
              onClick={() => change.mutate({ status: TASK_STATUS.done })}
            >
              {TEXT.attention.done}
            </button>
          </>
        )}
      </div>
      <ErrorNotice error={change.error} />
    </article>
  );
}

interface UpdateGroupFacts {
  host: HostView;
  tasks: TaskSummaryView[];
  // The host's containers, for what each update brings.
  containers: ContainerView[];
  packages: HostPackagesView | undefined;
}

// What the update brings when its images say; else what updating does.
function UpdateLine({ container }: { container: ContainerView | undefined }) {
  const generic = <span className="small faint">{TEXT.attention.containerImage}</span>;
  return container === undefined ? generic : <ImageVersions container={container} fallback={generic} />;
}

const UpdateTile = ({ icon }: { icon: IconName }) => (
  <span className="update-tile" aria-hidden>
    <Icon name={icon} />
  </span>
);

/**
 * One update's row: for an admin, its handle and its tick, the row itself dragged onto the Ollama agent with the
 * other ticked rows; where its runner would refuse it, only the space they take, so the names line up.
 */
function HandableRow(props: {
  item: string;
  admin: boolean;
  handable: boolean;
  disabled?: boolean;
  label: string;
  selection: Selection;
  className: string;
  children: ReactNode;
}) {
  const { item, admin, handable, selection } = props;
  return (
    <li
      className={handable ? `${props.className} handable` : props.className}
      draggable={handable}
      onDragStart={handable ? (event) => startDrag(event, item, selection.selected) : undefined}
    >
      {admin && (handable ? <Grip /> : <span className="grip-space" />)}
      {admin &&
        (handable ? (
          <input
            type="checkbox"
            checked={selection.selected.has(item)}
            disabled={props.disabled}
            onChange={() => selection.toggle(item)}
            aria-label={props.label}
          />
        ) : (
          <span className="tick-space" />
        ))}
      {props.children}
    </li>
  );
}

function PackageRows({
  view,
  host,
  admin,
  selection,
}: {
  view: HostPackagesView;
  host: HostView;
  admin: boolean;
  selection: Selection;
}) {
  const updates = useQuery(hostUpdatesQuery);
  const window = updates.data;
  const handable = admin && packagesHandable(host, view);
  return view.packages.map((item) => {
    const automatic = view.automatic.includes(item.name);
    return (
      <HandableRow
        key={item.name}
        item={packageItem(host.id, item.name)}
        admin={admin}
        handable={handable}
        label={TEXT.containerImages.selectOne(item.name)}
        selection={selection}
        className="update-row"
      >
        <UpdateTile icon="clock" />
        <span className="update-what">
          <span className="mono">{item.name}</span>
          <span className="small faint">{TEXT.attention.hostPackage(item.security)}</span>
        </span>
        {automatic && window !== undefined && (
          <span className="small muted">{TEXT.attention.goesInTonight(window.windowStart, window.windowEnd)}</span>
        )}
      </HandableRow>
    );
  });
}

// The container an update task is about: the one a run updates.
const containerOf = (task: TaskSummaryView) =>
  task.resource?.kind === TASK_RESOURCE.container ? task.resource.id : null;

// As its host last reported it, the container still has its new image waiting: its task is no history.
const stillWaits = (task: TaskSummaryView, containers: readonly ContainerView[]) =>
  containers.some(
    (container) => container.hostId === task.hostId && container.name === containerOf(task) && hasUpdate(container),
  );

function AdviceBadge({ advice }: { advice: UpdateAssessment | null }) {
  if (advice === null) {
    return null;
  }
  const safe = advice === UPDATE_ASSESSMENT.update;
  return <span className={safe ? "badge good" : "badge warning"}>{TEXT.attention.advice[advice]}</span>;
}

// Under the button: how a run goes, or how it would.
const footNote = (run: UpdateRunView | null) =>
  run === null || run.status === UPDATE_RUN_STATUS.finished ? TEXT.attention.oneAtATime : runLine(run);

const containerFor = (group: UpdateGroupFacts, task: TaskSummaryView) =>
  group.containers.find((container) => container.name === containerOf(task));

// What of a host's updates may be handed to the Ollama agent: what its runner would not refuse.
function handableItems(group: UpdateGroupFacts): string[] {
  const updates = group.tasks.filter((task) => updateHandable(containerFor(group, task))).map((task) => task.id);
  const packages = group.packages !== undefined && packagesHandable(group.host, group.packages) ? group.packages : null;
  return [
    ...updates.map(updateItem),
    ...(packages?.packages ?? []).map((item) => packageItem(group.host.id, item.name)),
  ];
}

function UpdateGroup({
  group,
  open,
  admin,
  selection,
}: {
  group: UpdateGroupFacts;
  open: boolean;
  admin: boolean;
  selection: Selection;
}) {
  const { run, review, impact, busy, error } = useUpdateRun(group.host.id);
  const runnable = group.tasks.filter((task) => updateHandable(containerFor(group, task)));
  // The ticked ones, in their order, for a person's own run.
  const selected = runnable
    .filter((task) => selection.selected.has(updateItem(task.id)))
    .map(containerOf)
    .filter((name): name is string => name !== null);
  const count = group.tasks.length + (group.packages?.packages.length ?? 0);
  return (
    <details className="update-group" open={open}>
      <summary>
        <span>
          <strong>{group.host.label}</strong>
          {TEXT.separator}
          {TEXT.attention.waiting(count)}
        </span>
        {open ? (
          <Link to={hostLink(group.host.id)}>{TEXT.attention.reviewOn(group.host.label)}</Link>
        ) : (
          <span className="accent">{TEXT.attention.review}</span>
        )}
      </summary>
      <ul className="update-rows">
        {group.tasks.map((task) => {
          const name = containerOf(task);
          const state = name === null ? null : stateIn(run, name);
          const container = containerFor(group, task);
          return (
            <HandableRow
              key={task.id}
              item={updateItem(task.id)}
              admin={admin}
              handable={admin && updateHandable(container)}
              disabled={busy}
              label={TEXT.containerImages.selectOne(name ?? task.title)}
              selection={selection}
              className="update-row container-update"
            >
              <UpdateTile icon="download" />
              <span className="update-what">
                <span className="mono">{task.resource?.label ?? task.title}</span>
                {state === null ? (
                  <UpdateLine container={container} />
                ) : (
                  <span className="small faint">{TEXT.containerImages.states[state]}</span>
                )}
              </span>
              <MaintenanceBadge hostId={group.host.id} containerName={name ?? undefined} />
              <AdviceBadge advice={task.advice} />
            </HandableRow>
          );
        })}
        {group.packages !== undefined && (
          <PackageRows view={group.packages} host={group.host} admin={admin} selection={selection} />
        )}
      </ul>
      {admin && runnable.length > 0 && (
        <div className="update-group-foot">
          <p className="notice warning small">{TEXT.actions.checkpointWarning}</p>
          <button
            type="button"
            className="primary"
            disabled={selected.length === 0 || busy}
            onClick={() => review(selected)}
          >
            {TEXT.attention.updateNow(selected.length)}
          </button>
          <span className="small muted">{footNote(run)}</span>
        </div>
      )}
      {impact}
      <ErrorNotice error={error} />
    </details>
  );
}

/** Home Assistant's own updates: a person installs them there, so they are listed with nothing to tick. */
function HomeAssistantUpdates({ updates, open }: { updates: readonly HomeAssistantUpdateView[]; open: boolean }) {
  const text = TEXT.attention;
  return (
    <details className="update-group" open={open}>
      <summary>
        <span>
          <strong>{text.homeAssistant.title}</strong>
          {TEXT.separator}
          {text.waiting(updates.length)}
        </span>
        <Link to={PATHS.homeAssistant}>{text.reviewOn(text.homeAssistant.title)}</Link>
      </summary>
      <ul className="update-rows">
        {updates.map((update) => (
          <li key={update.title} className="update-row container-update">
            <span className="tick-space" />
            <span className="update-what">
              <span>{update.title}</span>
              <span className="small faint">
                {TEXT.homeAssistant.box.update("", update.installed, update.latest).trim()}
                <ReleaseNotes link={update.releaseUrl} />
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="update-group-foot">
        <span className="small muted">{text.installInHomeAssistant(updates.length)}</span>
      </div>
    </details>
  );
}

// How to hand updates over without ticking: shown where a pointer can drag.
function DragTip() {
  const text = TEXT.attention.agent;
  return (
    <p className="drag-tip">
      <Icon name="lightbulb" />
      <span>
        {text.tipBefore}
        <strong>{text.tipAgent}</strong>
        {text.tipAfter}
      </span>
      <span className="drag-badge">{text.dragActive}</span>
    </p>
  );
}

function Updates({
  tasks,
  hosts,
  containers,
  homeAssistantUpdates,
  admin,
  selection,
  onHandOver,
  handing,
}: {
  tasks: readonly TaskSummaryView[];
  hosts: readonly HostView[];
  containers: readonly ContainerView[];
  homeAssistantUpdates: readonly HomeAssistantUpdateView[];
  admin: boolean;
  selection: Selection;
  onHandOver: HandOver;
  handing: boolean;
}) {
  const packages = useQueries({ queries: hosts.map((host) => hostPackagesQuery(host.id)) });
  const groups = hosts
    .map((host, index): UpdateGroupFacts => {
      const view = packages[index]?.data;
      return {
        host,
        tasks: tasks.filter(
          (task) => task.hostId === host.id && task.labels.includes(TASK_LABEL.update) && stillWaits(task, containers),
        ),
        containers: containers.filter((container) => container.hostId === host.id),
        packages: view !== undefined && view.packages.length > 0 ? view : undefined,
      };
    })
    .filter((group) => group.tasks.length > 0 || group.packages !== undefined);
  if (groups.length === 0 && homeAssistantUpdates.length === 0) {
    return null;
  }
  const text = TEXT.attention.agent;
  const handable = admin ? groups.flatMap(handableItems) : [];
  const allTicked = handable.length > 0 && handable.every((item) => selection.selected.has(item));
  const ticked = handable.filter((item) => selection.selected.has(item));
  return (
    <section className="attention-section">
      <div className="section-row">
        <SectionLabel tone="accent" text={TEXT.attention.sections.updates} />
        {handable.length > 0 && (
          <div className="section-actions">
            <button type="button" className="link" onClick={() => selection.select(allTicked ? [] : handable)}>
              {allTicked ? text.selectNone : text.selectAll(handable.length)}
            </button>
            <button
              type="button"
              className="agent-button"
              disabled={ticked.length === 0 || handing}
              onClick={() => onHandOver(ticked)}
            >
              <Icon name="zap" />
              {text.dispatch}
            </button>
          </div>
        )}
      </div>
      {groups.map((group, index) => (
        <UpdateGroup
          key={group.host.id}
          group={group}
          // What is ticked shows: a host's updates open once one of them is.
          open={index === 0 || handableItems(group).some((item) => selection.selected.has(item))}
          admin={admin}
          selection={selection}
        />
      ))}
      {homeAssistantUpdates.length > 0 && (
        <HomeAssistantUpdates updates={homeAssistantUpdates} open={groups.length === 0} />
      )}
      {handable.length > 0 && <DragTip />}
    </section>
  );
}

function SideCard({ title, children, muted = false }: { title: string; children: ReactNode; muted?: boolean }) {
  return (
    <section className={muted ? "card side-card muted-surface" : "card side-card"}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const cardTitle = (card: BoardCardView) => (isIncident(card) ? card.incident.containerName : card.task.title);
const cardKey = (card: BoardCardView) => (isIncident(card) ? card.incident.id : card.task.id);
const cardLink = (card: BoardCardView) =>
  isIncident(card) ? incidentLink(card.incident.id) : apiPath(PATHS.task, { taskId: card.task.id });

// Whether the agent can take work now, and has some.
function AgentPill({ working, hosts }: { working: boolean; hosts: readonly HostView[] }) {
  const ollama = useQuery(ollamaQuery);
  const servers = useQuery(ollamaServersQuery);
  const text = TEXT.attention.agent;
  if (ollama.data === undefined) {
    return null;
  }
  const { state } = fleetOf(ollama.data, servers.data, hosts);
  if (state === FLEET_STATE.none) {
    return <span className="agent-pill tone-danger">{text.offline}</span>;
  }
  if (state === FLEET_STATE.some) {
    return <span className="agent-pill tone-warning">{text.partlyOffline}</span>;
  }
  return <span className="agent-pill">{working ? text.working : text.ready}</span>;
}

const hostOfCard = (card: BoardCardView) => (isIncident(card) ? card.incident.hostId : card.task.hostId);

function CardList({
  cards,
  empty,
  servers,
}: {
  cards: readonly BoardCardView[];
  empty: string;
  // Given where it matters who is working on each, with several servers to choose from.
  servers?: OllamaServersView | undefined;
}) {
  const several = (servers?.extras.length ?? 0) > 0;
  if (cards.length === 0) {
    return <p className="side-empty muted">{empty}</p>;
  }
  return (
    <ul className="side-list">
      {cards.map((card) => (
        <li key={cardKey(card)}>
          <Link to={cardLink(card)}>{cardTitle(card)}</Link>
          {several && hostOfCard(card) !== null && (
            <span className="small muted">{serverLabel(answeringFor(servers, hostOfCard(card)))}</span>
          )}
          <TimeAgo timestamp={isIncident(card) ? card.incident.updatedAt : card.task.updatedAt} />
        </li>
      ))}
    </ul>
  );
}

function ComingUp({ admin }: { admin: boolean }) {
  const updates = useQuery(hostUpdatesQuery);
  // Only admins may list backups: everyone else sees the schedule alone.
  const backups = useQuery({ ...backupsQuery, enabled: admin });
  const verified = backups.data?.[0]?.integrityCheck === INTEGRITY_OK;
  const text = TEXT.attention;
  return (
    <SideCard title={text.comingUp}>
      <dl className="side-facts">
        <dt>{text.imageCheck}</dt>
        <dd>{text.everyHours(UPDATE_CHECK_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR)}</dd>
        {updates.data !== undefined && (
          <>
            <dt>{text.hostPackages}</dt>
            <dd>{text.tonightAt(updates.data.windowStart)}</dd>
          </>
        )}
        <dt>{text.databaseBackup}</dt>
        <dd>{verified ? text.dailyVerified : text.daily}</dd>
      </dl>
    </SideCard>
  );
}

/** What needs a person now, then what Autoheal has in hand, has healed, and will do next. */
export function AttentionPage() {
  const session = useSignedInSession();
  const admin = isAdmin(session);
  const board = useQuery(boardQuery);
  const hosts = useQuery(enrolledHostsQuery);
  const containers = useQuery(containersQuery);
  const overview = useQuery(overviewQuery);
  const selection = useSelection();
  const handOver = useHandOver();
  // How many the agent took last, said until the next hand-over.
  const [handed, setHanded] = useState<number | null>(null);
  // A hand-over on its way to the agent's card, which stays in sight meanwhile.
  const [dragging, setDragging] = useState(false);
  const [draggingHosts, setDraggingHosts] = useState<readonly (string | null)[]>([]);
  const servers = useQuery(ollamaServersQuery);
  const stopDragging = () => {
    setDragging(false);
    setDraggingHosts([]);
  };
  const give: HandOver = (items) => {
    setHanded(null);
    handOver.mutate(items, {
      onSuccess: (view) => {
        setHanded(handedCount(view));
        selection.select([]);
      },
    });
  };
  if (board.data === undefined || hosts.data === undefined) {
    return (
      <div className="page">
        <ErrorNotice error={board.error ?? hosts.error} />
        {board.error === null && hosts.error === null && <Loading />}
      </div>
    );
  }
  const { needsYou, autoheal, noticed, done } = board.data;
  const hostOf = (hostId: string | null) => hosts.data.find((host) => host.id === hostId);
  const containerOn = (hostId: string, name: string) =>
    containers.data?.find((container) => container.hostId === hostId && container.name === name);
  const { decisions, problems } = whatNeedsYou(needsYou);
  const updateTasks = [...needsYou, ...noticed, ...autoheal]
    .filter(isTask)
    .map((card) => card.task)
    .filter(isUpdateTask);
  const healed = done.filter((card) => isIncident(card) && card.incident.verdict === VERDICT_FIXED);
  // Null until Home Assistant is set up in Settings.
  const home = overview.data?.homeAssistant ?? null;
  const text = TEXT.attention;
  return (
    <div
      className={dragging ? "page attention dragging" : "page attention"}
      onDragStart={(event) => {
        setDragging(carriesHandOver(event));
        setDraggingHosts(hostsOfItems(droppedItems(event), [...needsYou, ...noticed, ...autoheal]));
      }}
      onDragEnd={stopDragging}
      onDrop={stopDragging}
    >
      <PageHeader title={text.title} lede={text.lede(needsYou.length)}>
        <Link to={PATHS.board}>{text.allItems(needsYou.length + autoheal.length + noticed.length)}</Link>
      </PageHeader>
      <StatusStrip
        hosts={hosts.data}
        containers={containers.data ?? []}
        onHandOver={admin ? give : undefined}
        draggingHosts={draggingHosts}
        working={autoheal.length > 0}
      />
      <div className="attention-layout">
        <div className="attention-main">
          {handed !== null && (
            <p className="small text-good" role="status">
              {TEXT.attention.agent.handed(handed)}
            </p>
          )}
          <ErrorNotice error={handOver.error} />
          {decisions.length > 0 && (
            <section className="attention-section">
              <SectionLabel tone="warning" text={text.sections.decide} />
              {decisions.map((card) => (
                <DecisionCard
                  key={card.incident.id}
                  incident={card.incident}
                  host={hostOf(card.incident.hostId)}
                  container={containerOn(card.incident.hostId, card.incident.containerName)}
                  admin={admin}
                  onHandOver={give}
                />
              ))}
            </section>
          )}
          {problems.length > 0 && (
            <section className="attention-section">
              <SectionLabel tone="danger" text={text.sections.fix} />
              <div className="fix-grid">
                {problems.map((card) => (
                  <FixCard
                    key={card.task.id}
                    task={card.task}
                    host={hostOf(card.task.hostId)}
                    viewerId={session.user.id}
                    admin={admin}
                  />
                ))}
              </div>
            </section>
          )}
          <Updates
            tasks={updateTasks}
            hosts={hosts.data}
            containers={containers.data ?? []}
            homeAssistantUpdates={home?.connected === true ? home.system.updates : []}
            admin={admin}
            selection={selection}
            onHandOver={give}
            handing={handOver.isPending}
          />
          {needsYou.length === 0 && <p className="card muted">{text.nothingNeedsYou}</p>}
        </div>
        <aside className="attention-side">
          <SideCard title={text.onItNow}>
            <div className="side-row">
              <CardList cards={autoheal} empty={text.nothingInHand} servers={servers.data} />
              <AgentPill hosts={hosts.data} working={autoheal.length > 0} />
            </div>
          </SideCard>
          <SideCard title={text.healed}>
            <CardList cards={healed} empty={text.nothingHealed} />
          </SideCard>
          <ComingUp admin={admin} />
          <SideCard title={text.howFar} muted>
            <p className="small muted">
              {text.howFarBefore}
              <code>{text.howFarCommand}</code>
              {text.howFarAfter}
            </p>
            <Link className="small" to={PATHS.runbooks}>
              {text.changeRules}
            </Link>
          </SideCard>
        </aside>
      </div>
    </div>
  );
}
