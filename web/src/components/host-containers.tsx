import { type ContainerView, type HostView } from "../../../src/shared/api.js";
import { HOST_KIND } from "../../../src/shared/constants.js";
import {
  type LineJob,
  workOf,
  useFinishedJobs,
  useContainerMotion,
  bringUnderListHeader,
} from "../container-motion.js";
import { type ContainerShow, CONTAINER_SHOW, TEXT, INVENTORY_REFRESH_MILLISECONDS } from "../constants.js";
import { useState, useRef, useEffect, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ResourceAction } from "../../../src/shared/resource-permissions.js";
import { useBulkAction } from "../container-bulk.js";
import { AddContainer } from "../pages/add-container.js";
import { type BackupDialogMode, BackupDialog } from "../pages/container-backup.js";
import { NetworksHeading, NetworksChip, HostNetworks } from "../pages/host-networks.js";
import { type InspectorTabRequest, ContainerInspector } from "../pages/container-inspector.js";
import { VolumesHeading, VolumesChip, HostVolumes } from "../pages/host-volumes.js";
import { hostContainersQuery, hostJobsQuery, hostTasksQuery } from "../queries.js";
import { useResourcePermissions } from "../session.js";
import { updateRunQuery, waitInRun } from "../update-runs.js";
import { useAskInPlace } from "./ask-in-place.js";
import { ErrorNotice, Loading } from "./common.js";
import { WebLink } from "./container-actions.js";
import {
  isPersonsUpdate,
  GoneRow,
  rowClassOf,
  stateTone,
  stateOf,
  WorkingState,
  RestartsUsed,
  UpForCell,
  ImageCell,
  PortsCell,
  UsageCells,
  ChoiceCells,
} from "./container-cells.js";
import { type Reach, permissionOf, RowActions, PanelReach, ReachPanel } from "./container-row-actions.js";
import { OperationImpactReview } from "./dependency-map.js";
import { useContainerSelection } from "./filters.js";
import { BulkBar, BULK_TEXT, toggled } from "./host-bulk-bar.js";
import { Icon } from "./icons.js";
import { MaintenanceBadge } from "./maintenance-dialog.js";
import { useContainerActions } from "./container-table-actions.js";
import { useSavedNote, SavedNote } from "./saved-note.js";
import { StackHead } from "./stack-head.js";
import { UpdateConfirm } from "./update-confirm.js";
import { UpdateStream, FinishedLine } from "./update-stream.js";
import {
  ADMIN_COLUMN_COUNT,
  COLUMN_COUNT,
  groupsOf,
  HOST_PANEL,
  type HostPanel,
  matches,
  PANEL_TITLES,
  ShowChips,
  SHOWS,
  type Working,
} from "./container-table.js";

/**
 * One host's containers, stacks first: what each does when it fails and when a new image is out, set
 * in place. A container's name opens its stats beneath it, as everywhere. Live: a row shows the job at work on it,
 * an update's pull under it, and each change of its container for a moment as it happens.
 */

export function HostContainers({
  host,
  admin,
  containersAsked = 0,
}: {
  host: HostView;
  admin: boolean;
  // Goes up each time a person clicks the page's Containers tab, which leads back to this list.
  containersAsked?: number;
}) {
  const permissions = useResourcePermissions();
  const allowed = (action: ResourceAction, container: ContainerView) => admin || permissions.allowed(action, container);
  const asking = useAskInPlace();
  const query = hostContainersQuery(host.id);
  const containers = useQuery({ ...query, refetchInterval: INVENTORY_REFRESH_MILLISECONDS });
  const jobs = useQuery(hostJobsQuery(host.id));
  const run = useQuery(updateRunQuery(host.id));
  const motion = useContainerMotion(containers.data, jobs.data);
  const working: Working = new Map([...motion.awaiting, ...workOf(jobs.data ?? [], containers.data ?? [])]);
  const finished = useFinishedJobs(jobs.data);
  const [show, setShow] = useState<ContainerShow>(CONTAINER_SHOW.all);
  const tasks = useQuery(hostTasksQuery(host.id));
  const heldUpdates = new Map(
    (tasks.data ?? []).filter(isPersonsUpdate).map((task) => [task.resource?.id ?? "", task] as const),
  );
  const selection = useContainerSelection();
  const saved = useSavedNote();
  const [find, setFind] = useState("");
  const [panel, setPanel] = useState<HostPanel>(HOST_PANEL.containers);
  const [networksLeftAsked, setNetworksLeftAsked] = useState(0);
  const [volumesLeftAsked, setVolumesLeftAsked] = useState(0);
  const openPanel = (next: HostPanel) => {
    if (next !== panel) setFind("");
    setPanel(next);
  };
  useEffect(() => {
    if (containersAsked > 0) openPanel(HOST_PANEL.containers);
  }, [containersAsked]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  // The container reached into under its row, and how: one at a time.
  const [reach, setReach] = useState<{ name: string; kind: Reach } | null>(null);
  const [backingUp, setBackingUp] = useState<{ name: string; mode: BackupDialogMode } | null>(null);
  const [logsAsked, setLogsAsked] = useState<{ name: string; request: InspectorTabRequest } | null>(null);
  const reachingOf = (name: string) => (reach?.name === name ? reach.kind : null);
  // The one being worked on keeps its row in view: the last thing opened, if two are.
  const pinnedName = reach?.name ?? selection.open;
  const pinnedRow = useRef<HTMLTableRowElement>(null);
  // A panel with buttons at its foot needs the room; stats opened by a click on the row leave that row where it is.
  useEffect(() => {
    if (reach !== null && pinnedRow.current !== null) bringUnderListHeader(pinnedRow.current);
  }, [reach?.name]);
  const toggleReach = (name: string, kind: Reach) => setReach(reachingOf(name) === kind ? null : { name, kind });
  // Once an action is asked, from a row or for the ticked ones, no tick stays behind to be acted on again by mistake.
  const clearTicks = () => setTicked(new Set());
  const bulk = useBulkAction(host.id, clearTicks);
  const {
    operatorReview,
    setOperatorReview,
    updateAsked,
    setUpdateAsked,
    canUpdate,
    operatorAction,
    ask,
    updateConfirmed,
    choose,
  } = useContainerActions({ hostId: host.id, admin, allowed, bulk, asking, clearTicks, onSaved: saved.show });
  const list = containers.data;
  const text = TEXT.hostContainers;
  const showingContainers = panel === HOST_PANEL.containers;
  const words = showingContainers ? find.trim().toLowerCase() : "";
  const gone = new Set(motion.ghosts.map((container) => container.name));
  const found = [...(list ?? []), ...motion.held, ...motion.ghosts].filter(
    (container) => matches(container, words) && SHOWS[show](container, working),
  );
  const groups = groupsOf(found);
  // A stack job's line goes once, under its stack's header; any other job's under its row, as does a stack's own
  // container when it is shown on its own.
  const lineOwner = (job: { stack: string | null }, groupStack: string | null) =>
    job.stack === null || groupStack === null;
  const stackLine = (stack: string) =>
    [...working.values()].find((job) => job.stack === stack && job.progress !== null) ?? null;
  const ended = [...finished.values()];
  const endedForStack = (stack: string) => ended.find((job) => job.stack === stack) ?? null;
  const endedForRow = (container: ContainerView, groupStack: string | null): LineJob | null =>
    ended.find((job) =>
      job.stack === null
        ? job.containerName === container.name
        : groupStack === null && job.stack === container.composeProject,
    ) ?? null;
  // A stack's score counts all its containers, whatever the list is filtered to.
  const membersOf = (stack: string) => (list ?? []).filter((container) => container.composeProject === stack);
  // Restart stack restarts the ones Autoheal may change: the person must be let restart every one of them.
  const mayRestart = (stack: string) => {
    const restartable = membersOf(stack).filter((container) => container.handsOff === null);
    return restartable.length > 0 && restartable.every((container) => allowed("lifecycle", container));
  };
  const actionsShown =
    admin ||
    list?.some((container) =>
      (["lifecycle", "update", "logs", "terminal", "files", "settings"] as const).some((action) =>
        allowed(action, container),
      ),
    ) === true;
  const columns = admin ? ADMIN_COLUMN_COUNT : COLUMN_COUNT + (actionsShown ? 1 : 0);
  useEffect(() => {
    if (!reach || admin) return;
    const container = list?.find((item) => item.name === reach.name);
    if (!container || !allowed(permissionOf(reach.kind), container)) setReach(null);
  }, [reach, list, admin, permissions.allowed]);
  const address = host.health?.address ?? null;
  // Only what the host lets Autoheal change can be ticked; ticks on containers gone since are left out.
  const tickable = groups
    .flatMap((group) => group.containers)
    .filter((container) => container.handsOff === null && !gone.has(container.name));
  const tickableIn = (stack: string) => tickable.filter((container) => container.composeProject === stack);
  const tickStack = (stack: string) => {
    const members = tickableIn(stack).map(({ name }) => name);
    const allOn = members.length > 0 && members.every((name) => ticked.has(name));
    setTicked(
      allOn ? new Set([...ticked].filter((name) => !members.includes(name))) : new Set([...ticked, ...members]),
    );
  };
  const allTicked = tickable.length > 0 && tickable.every((container) => ticked.has(container.name));
  const tickedContainers = (list ?? []).filter((container) => ticked.has(container.name));
  return (
    <section className="host-containers" aria-labelledby={PANEL_TITLES[panel]}>
      <header className="section-head">
        {panel === HOST_PANEL.networks && <NetworksHeading host={host} />}
        {panel === HOST_PANEL.volumes && <VolumesHeading host={host} />}
        {showingContainers && (
          <h2 id="host-containers-title">
            {text.title}
            <span className="muted">
              {TEXT.separator}
              {TEXT.hosts.running(host.runningCount, host.containerCount)}
            </span>
          </h2>
        )}
        <SavedNote shown={saved.shown} />
        {asking.question}
        <label className="find">
          {text.find}
          <input
            type="search"
            value={find}
            placeholder={showingContainers ? text.findPlaceholder : text.findNamePlaceholder}
            onChange={(event) => setFind(event.target.value)}
          />
        </label>
      </header>
      {list !== undefined && (
        <ShowChips
          containers={list}
          working={working}
          chosen={showingContainers ? show : null}
          onChoose={(next) => {
            openPanel(HOST_PANEL.containers);
            setShow(next);
          }}
        >
          <span className="chip-divider" aria-hidden="true" />
          <NetworksChip
            hostId={host.id}
            active={panel === HOST_PANEL.networks}
            onOpen={(leftBehind) => {
              openPanel(HOST_PANEL.networks);
              if (leftBehind) setNetworksLeftAsked((asked) => asked + 1);
            }}
          />
          <VolumesChip
            hostId={host.id}
            active={panel === HOST_PANEL.volumes}
            onOpen={(leftBehind) => {
              openPanel(HOST_PANEL.volumes);
              if (leftBehind) setVolumesLeftAsked((asked) => asked + 1);
            }}
          />
          <span className="chip-divider" aria-hidden="true" />
          {admin && host.hostDeploy === true && !host.dryRun && <AddContainer host={host} />}
          {backingUp !== null && (
            <BackupDialog
              hostId={host.id}
              target={{ container: backingUp.name, stack: null }}
              mode={backingUp.mode}
              onClose={() => setBackingUp(null)}
            />
          )}
        </ShowChips>
      )}
      <div hidden={panel !== HOST_PANEL.networks}>
        <HostNetworks
          host={host}
          admin={admin}
          find={panel === HOST_PANEL.networks ? find : ""}
          leftAsked={networksLeftAsked}
        />
      </div>
      <div hidden={panel !== HOST_PANEL.volumes}>
        <HostVolumes
          host={host}
          admin={admin}
          find={panel === HOST_PANEL.volumes ? find : ""}
          leftAsked={volumesLeftAsked}
        />
      </div>
      <div hidden={!showingContainers}>
        {admin && (
          <BulkBar
            hostId={host.id}
            ticked={tickedContainers}
            bulk={bulk}
            ask={ask}
            onClear={clearTicks}
            onLookAtVolumes={() => openPanel(HOST_PANEL.volumes)}
          />
        )}
        {list === undefined && (containers.error ? <ErrorNotice error={containers.error} /> : <Loading />)}
        {list !== undefined && (
          <div className="table-wrap container-table">
            <table>
              <thead>
                <tr>
                  {admin && (
                    <th className="tick-column">
                      <input
                        type="checkbox"
                        checked={allTicked}
                        disabled={tickable.length === 0}
                        aria-label={BULK_TEXT.tickAll}
                        onChange={() =>
                          setTicked(allTicked ? new Set() : new Set(tickable.map((container) => container.name)))
                        }
                      />
                    </th>
                  )}
                  <th className="name-column">{text.container}</th>
                  <th className="state-column">{text.state}</th>
                  <th className="up-column">{text.upFor}</th>
                  <th className="image-column">{text.image}</th>
                  <th className="ports-column">{text.ports}</th>
                  <th className="cpu-column usage-cell">{TEXT.metrics.cpu}</th>
                  <th className="memory-column usage-cell">{text.ram}</th>
                  <th className="choice-column">{text.ifItFails}</th>
                  <th className="choice-column">{text.newImage}</th>
                  {actionsShown && <th className="actions-column">{text.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {found.length === 0 && (
                  <tr>
                    <td colSpan={columns} className="muted">
                      {list.length === 0 ? TEXT.containers.empty : text.nothingFound}
                    </td>
                  </tr>
                )}
                {groups.map((group) => (
                  <Fragment key={group.stack ?? ""}>
                    {(group.stack !== null || groups.length > 1) && (
                      <tr className="group-row">
                        <th scope="rowgroup" colSpan={columns}>
                          {group.stack === null ? (
                            text.single
                          ) : (
                            <StackHead
                              hostId={host.id}
                              stack={group.stack}
                              members={membersOf(group.stack)}
                              canRestart={mayRestart(group.stack)}
                              admin={admin}
                              overSsh={host.kind === HOST_KIND.ssh}
                              tick={
                                admin
                                  ? {
                                      ticked:
                                        tickableIn(group.stack).length > 0 &&
                                        tickableIn(group.stack).every(({ name }) => ticked.has(name)),
                                      onChange: () => tickStack(group.stack!),
                                    }
                                  : undefined
                              }
                            />
                          )}
                        </th>
                      </tr>
                    )}
                    {group.stack !== null && stackLine(group.stack) !== null && (
                      <tr className="update-stream-row">
                        <td colSpan={columns}>
                          <UpdateStream
                            name={group.stack}
                            image={group.stack}
                            progress={stackLine(group.stack)!.progress!}
                          />
                        </td>
                      </tr>
                    )}
                    {group.stack !== null && stackLine(group.stack) === null && endedForStack(group.stack) !== null && (
                      <tr className="update-stream-row">
                        <td colSpan={columns}>
                          <FinishedLine job={endedForStack(group.stack)!} image={group.stack} />
                        </td>
                      </tr>
                    )}
                    {group.containers.map((container) => {
                      if (gone.has(container.name)) {
                        return (
                          <GoneRow key={container.name} container={container} admin={admin} actions={actionsShown} />
                        );
                      }
                      const open = selection.open === container.name;
                      const job = working.get(container.name) ?? null;
                      const waits = waitInRun(run.data ?? null, container.name);
                      return (
                        <Fragment key={container.name}>
                          <tr
                            ref={pinnedName === container.name ? pinnedRow : undefined}
                            className={rowClassOf(
                              open,
                              pinnedName === container.name,
                              job,
                              motion.motions.get(container.name),
                            )}
                            aria-busy={job !== null}
                          >
                            {admin && (
                              <td className="tick-column">
                                {container.handsOff === null && (
                                  <input
                                    type="checkbox"
                                    checked={ticked.has(container.name)}
                                    aria-label={BULK_TEXT.tickOne(container.name)}
                                    onChange={() => setTicked((names) => toggled(names, container.name))}
                                  />
                                )}
                              </td>
                            )}
                            <td>
                              <span className="name-cell">
                                <button
                                  type="button"
                                  className="link container-name"
                                  title={container.name}
                                  aria-expanded={open}
                                  onClick={() => selection.toggle(container.name)}
                                >
                                  <span className="name-text">{container.name}</span>
                                </button>
                                {job === null && canUpdate(container) && (
                                  <button
                                    type="button"
                                    className="icon-button update-ready"
                                    title={TEXT.hostContainers.updateBox.icon(container.name)}
                                    aria-label={TEXT.hostContainers.updateBox.icon(container.name)}
                                    aria-expanded={updateAsked?.target.name === container.name}
                                    disabled={bulk.run.isPending || operatorAction.isPending}
                                    onClick={(event) =>
                                      setUpdateAsked({ target: container, anchor: event.currentTarget })
                                    }
                                  >
                                    <Icon name="circleArrowUp" />
                                  </button>
                                )}
                                <MaintenanceBadge hostId={container.hostId} containerName={container.name} />
                                <WebLink container={container} />
                              </span>
                            </td>
                            <td className={job === null ? stateTone(container) : undefined}>
                              {job === null ? stateOf(container) : <WorkingState job={job} />}
                              {waits !== null && <div className="state-note muted">{waits}</div>}
                              <RestartsUsed host={host} name={container.name} admin={admin} />
                            </td>
                            <UpForCell container={container} />
                            <td>
                              <ImageCell container={container} held={heldUpdates.get(container.name)} admin={admin} />
                            </td>
                            <td>
                              <PortsCell container={container} address={address} />
                            </td>
                            <UsageCells container={container} />
                            <ChoiceCells
                              container={container}
                              canAct={admin}
                              onChange={(change) => choose.mutate({ names: [container.name], ...change })}
                            />
                            {actionsShown && (
                              <td>
                                <RowActions
                                  admin={admin}
                                  onBackup={(mode) => setBackingUp({ name: container.name, mode })}
                                  host={host}
                                  container={container}
                                  open={open}
                                  reaching={reachingOf(container.name)}
                                  busy={bulk.run.isPending || operatorAction.isPending}
                                  ask={ask}
                                  onToggle={() => selection.toggle(container.name)}
                                  onLogs={() =>
                                    setLogsAsked({
                                      name: container.name,
                                      request: { tab: "logs", count: (logsAsked?.request.count ?? 0) + 1 },
                                    })
                                  }
                                  onReach={(kind) => toggleReach(container.name, kind)}
                                  allowed={(action) => allowed(action, container)}
                                />
                              </td>
                            )}
                          </tr>
                          {job !== null && job.progress !== null && lineOwner(job, group.stack) && (
                            <tr className="update-stream-row">
                              <td colSpan={columns}>
                                <UpdateStream name={container.name} image={container.image} progress={job.progress} />
                              </td>
                            </tr>
                          )}
                          {job === null && endedForRow(container, group.stack) !== null && (
                            <tr className="update-stream-row">
                              <td colSpan={columns}>
                                <FinishedLine job={endedForRow(container, group.stack)!} image={container.image} />
                              </td>
                            </tr>
                          )}
                          {open && (
                            <tr className="inspector-row">
                              <td colSpan={columns}>
                                <ContainerInspector
                                  container={container}
                                  siblings={list}
                                  canAct={admin}
                                  arrived={selection.arrived === container.name}
                                  tabRequest={logsAsked?.name === container.name ? logsAsked.request : null}
                                  tools={(files) => (
                                    <PanelReach
                                      host={host}
                                      container={container}
                                      reaching={reachingOf(container.name)}
                                      onReach={(kind) => toggleReach(container.name, kind)}
                                      allowed={(action) => allowed(action, container)}
                                      files={files}
                                    />
                                  )}
                                />
                              </td>
                            </tr>
                          )}
                          {reach?.name === container.name && allowed(permissionOf(reach.kind), container) && (
                            <tr className="reach-row">
                              <td colSpan={columns}>
                                <ReachPanel
                                  reach={reach.kind}
                                  hostId={host.id}
                                  containerName={container.name}
                                  composeProject={container.composeProject}
                                  keptByHost={container.handsOff !== null}
                                  onClose={() => setReach(null)}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {bulk.impact}
        {updateAsked && (
          <UpdateConfirm
            key={updateAsked.target.name}
            hostId={host.id}
            container={updateAsked.target}
            anchor={updateAsked.anchor}
            onCancel={() => setUpdateAsked(null)}
            onConfirm={(previews) => updateConfirmed(updateAsked.target, previews)}
          />
        )}
        {operatorReview && (
          <OperationImpactReview
            hostId={host.id}
            action={operatorReview.action}
            names={[operatorReview.target.name]}
            onCancel={() => setOperatorReview(null)}
            onConfirm={(previews) => {
              operatorAction.mutate({ ...operatorReview, previewId: previews[operatorReview.target.name] });
              setOperatorReview(null);
            }}
          />
        )}
        <ErrorNotice error={choose.error ?? operatorAction.error} />
      </div>
    </section>
  );
}
