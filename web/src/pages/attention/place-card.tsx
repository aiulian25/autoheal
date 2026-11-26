import { MaintenanceBadge } from "../../components/maintenance-dialog.js";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import {
  type ContainerView,
  type HomeAssistantUpdateView,
  type HostPackagesView,
  type HostView,
  type TaskSummaryView,
} from "../../../../src/shared/api.js";
import { DETECTOR_THRESHOLDS, HOST_STATE, JOB_ACTION, TASK_ABOUT } from "../../../../src/shared/constants.js";
import { packageItem, updateHandable, updateItem, type Selection } from "../../agent-dispatch.js";
import type { NeedsYouPlace, UpdateGroupFacts } from "../../attention-places.js";
import { containerOf } from "../../board.js";
import { useAskInPlace } from "../../components/ask-in-place.js";
import { ErrorNotice } from "../../components/common.js";
import { Icon } from "../../components/icons.js";
import { SnoozeMenu } from "../../components/snooze-menu.js";
import { TEXT } from "../../constants.js";
import { percent, timeOfDay } from "../../format.js";
import { hostLink, taskPlaceLink } from "../../host-links.js";
import { hostPackagesQuery, hostUpdatesQuery } from "../../queries.js";
import { stateIn, useUpdateRun } from "../../update-runs.js";
import { healingPaused, hostStateText } from "../fleet-page.js";
import { ReleaseNotes } from "../home-assistant-system.js";
import { diskUsedPercent, fullestDisk } from "../host-dial-values.js";
import { isWaiting } from "../host-package-rows.js";
import { mayChangePackages, useHostPackageBusy, useHostPackageJob } from "../host-packages.js";
import { type HandOver, placeLink, placeName, useTaskChange } from "./attention-parts.js";
import { DecisionRow } from "./decision-row.js";
import { FixRow } from "./fix-row.js";
import {
  containerFor,
  HandableRow,
  UpdateTile,
  UpdateLine,
  AdviceBadge,
  AssistantBadge,
  HeldBadge,
  NewerRows,
  PackageRows,
  footNote,
  handableItems,
} from "./update-rows.js";

/** A release's end, or a host's updates while its list is empty: what it says, the way to it, and Snooze. */
function HostTaskRow({ task, host, admin }: { task: TaskSummaryView; host: HostView; admin: boolean }) {
  const change = useTaskChange(task.id);
  return (
    <li className="update-row place-row tone-warning">
      <UpdateTile icon="alert" tone="warning" />
      <div className="update-what">
        <div className="row-title">
          <h3>{task.title}</h3>
        </div>
        <ErrorNotice error={change.error} />
      </div>
      <span className="row-actions">
        <Link className="button" to={taskPlaceLink(task) ?? hostLink(host.id)}>
          {TEXT.attention.review}
        </Link>
        {admin && <SnoozeMenu disabled={change.isPending} onChoose={(snoozed) => change.mutate({ snoozed })} />}
      </span>
    </li>
  );
}

/** A host that needs a reboot: what waits for it, the reboot itself asked in place where its .env allows, Snooze. */
function RebootRow({ task, host, admin }: { task: TaskSummaryView; host: HostView; admin: boolean }) {
  const change = useTaskChange(task.id);
  const packages = useQuery(hostPackagesQuery(host.id));
  const run = useHostPackageJob(host.id);
  const asking = useAskInPlace();
  const busy = useHostPackageBusy(host.id, packages.data, packages.isError);
  const view = packages.data;
  const text = TEXT.hostPackages;
  const details =
    view === undefined ? "" : text.rebootDetails(view.facts?.rebootPackages ?? [], view.facts?.kernelWaiting ?? null);
  // The last reboot asked for since the host's last check: on its way, or what the host said.
  const lastReboot = view?.recent.find(
    (job) => job.action === JOB_ACTION.reboot && job.createdAt >= (view.checkedAt ?? 0),
  );
  const rebootLine = isWaiting(lastReboot ?? null) ? text.running : lastReboot?.outcome;
  const reboot = () =>
    asking.confirm(text.confirmReboot(host.label), () => run.mutate({ action: JOB_ACTION.reboot, names: [] }));
  return (
    <li className="update-row place-row tone-warning">
      <UpdateTile icon="power" tone="warning" />
      <div className="update-what">
        <div className="row-title">
          <h3>{task.title}</h3>
        </div>
        {details !== "" && <p className="row-detail">{details}</p>}
        {rebootLine !== undefined && rebootLine !== null && <p className="row-detail">{rebootLine}</p>}
        {asking.question}
        <ErrorNotice error={run.error ?? change.error} />
      </div>
      <span className="row-actions">
        {view !== undefined && mayChangePackages(view, admin) && (
          <button type="button" disabled={busy} onClick={reboot}>
            {text.rebootNow}
          </button>
        )}
        {admin && <SnoozeMenu disabled={change.isPending} onChoose={(snoozed) => change.mutate({ snoozed })} />}
      </span>
    </li>
  );
}

/**
 * A host's packages in one row: how many, how many are security fixes, what goes in tonight and what waits for a
 * person, with the list opened in place to tick and hand over, and the way to put them all in now.
 */
function PackageSummaryRows({
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
  const window = useQuery(hostUpdatesQuery).data;
  const run = useHostPackageJob(host.id);
  const busy = useHostPackageBusy(host.id, view, false);
  const [opened, setOpened] = useState(false);
  // Nothing ticked is out of sight: the list stays open while one of its packages is ticked.
  const ticked = view.packages.some((item) => selection.selected.has(packageItem(host.id, item.name)));
  const open = opened || ticked;
  const names = view.packages.map(({ name }) => name);
  const security = view.packages.filter((item) => item.security).length;
  const automatic = names.filter((name) => view.automatic.includes(name)).length;
  const text = TEXT.attention;
  const tonight = automatic > 0 && window !== undefined ? text.goesInTonight(window.windowStart, window.windowEnd) : "";
  const forYou = names.length - automatic;
  const install = automatic === names.length ? TEXT.hostPackages.installNowInstead : TEXT.hostPackages.installNow;
  return (
    <>
      <li className="update-row place-row tone-accent">
        <UpdateTile icon="clock" />
        <div className="update-what">
          <div className="row-title">
            <h3>{text.packageUpdates(names.length)}</h3>
            {security > 0 && <span className="mono muted">{text.securityFixes(security)}</span>}
          </div>
          <p className="row-detail">
            {[tonight, forYou > 0 ? text.waitForYou(forYou) : ""].filter(Boolean).join(TEXT.separator)}
          </p>
          <ErrorNotice error={run.error} />
        </div>
        <span className="row-actions">
          <button type="button" aria-expanded={open} onClick={() => setOpened(!open)}>
            {open ? text.hideList : text.reviewCount(names.length)}
          </button>
          {mayChangePackages(view, admin) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run.mutate({ action: JOB_ACTION.upgradePackages, names })}
            >
              {install}
            </button>
          )}
        </span>
      </li>
      {open && <PackageRows view={view} host={host} admin={admin} selection={selection} />}
    </>
  );
}

/** A host's containers with new images waiting: each with its tick, what it brings, and its own Update. */
function ContainerUpdateRows({
  group,
  admin,
  selection,
  updates,
}: {
  group: UpdateGroupFacts;
  admin: boolean;
  selection: Selection;
  updates: ReturnType<typeof useUpdateRun>;
}) {
  return group.tasks.map((task) => {
    const name = containerOf(task);
    const state = name === null ? null : stateIn(updates.run, name);
    const container = containerFor(group, task);
    const handable = admin && updateHandable(container);
    return (
      <HandableRow
        key={task.id}
        item={updateItem(task.id)}
        admin={admin}
        handable={handable}
        disabled={updates.busy}
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
        <AssistantBadge assistant={task.assistant} />
        <HeldBadge because={task.heldBecause} />
        {handable && name !== null && (
          <button type="button" disabled={updates.busy} onClick={() => updates.review([name])}>
            {TEXT.attention.update}
          </button>
        )}
        <Link className="small update-review" to={taskPlaceLink(task) ?? hostLink(group.host.id)}>
          {TEXT.attention.review}
        </Link>
      </HandableRow>
    );
  });
}

/** Everything a host's updates ask: its own tasks, its packages, its containers' images, newer tags; then the foot. */
function HostUpdates({
  group,
  admin,
  selection,
  onHandOver,
  handing,
}: {
  group: UpdateGroupFacts;
  admin: boolean;
  selection: Selection;
  onHandOver: HandOver;
  handing: boolean;
}) {
  const updates = useUpdateRun(group.host.id);
  const runnable = group.tasks.filter((task) => updateHandable(containerFor(group, task)));
  // The ticked ones, in their order, for a person's own run.
  const selected = runnable
    .filter((task) => selection.selected.has(updateItem(task.id)))
    .map(containerOf)
    .filter((name): name is string => name !== null);
  const handable = admin ? handableItems(group) : [];
  const ticked = handable.filter((item) => selection.selected.has(item));
  return (
    <>
      <ul className="update-rows">
        {group.hostTasks.map((task) =>
          task.about === TASK_ABOUT.reboot ? (
            <RebootRow key={task.id} task={task} host={group.host} admin={admin} />
          ) : (
            <HostTaskRow key={task.id} task={task} host={group.host} admin={admin} />
          ),
        )}
        {group.packages !== undefined && (
          <PackageSummaryRows view={group.packages} host={group.host} admin={admin} selection={selection} />
        )}
        <ContainerUpdateRows group={group} admin={admin} selection={selection} updates={updates} />
        <NewerRows group={group} admin={admin} selection={selection} />
      </ul>
      {admin && (runnable.length > 0 || handable.length > 0) && (
        <div className="update-group-foot">
          {runnable.length > 0 && (
            <>
              <button
                type="button"
                className="primary"
                disabled={selected.length === 0 || updates.busy}
                onClick={() => updates.review(selected)}
              >
                {TEXT.attention.updateNow(selected.length)}
              </button>
              <span className="small muted">{footNote(updates.run)}</span>
            </>
          )}
          {handable.length > 0 && (
            <button
              type="button"
              className="agent-button push"
              disabled={ticked.length === 0 || handing}
              onClick={() => onHandOver(ticked)}
            >
              <Icon name="zap" />
              {TEXT.attention.handTicked(ticked.length)}
            </button>
          )}
        </div>
      )}
      {updates.impact}
      <ErrorNotice error={updates.error} />
    </>
  );
}

/** Home Assistant's own updates: a person installs them there, so they are listed with nothing to tick. */
function HomeAssistantUpdates({ updates }: { updates: readonly HomeAssistantUpdateView[] }) {
  return (
    <>
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
        <span className="small muted">{TEXT.attention.installInHomeAssistant(updates.length)}</span>
      </div>
    </>
  );
}

// What a host's head says after its state: its containers, a disk nearly full, a reboot waiting, its last word.
function HostFacts({ host }: { host: HostView }) {
  const disk = fullestDisk(host.health);
  const filled = disk === undefined ? null : diskUsedPercent(disk);
  // A host gone quiet says when it last reported.
  const lastReport = host.state === HOST_STATE.online ? null : host.lastHeartbeatAt;
  return (
    <span className="place-facts">
      {TEXT.hosts.running(host.runningCount, host.containerCount)}
      {filled !== null && filled >= DETECTOR_THRESHOLDS.diskPercent && (
        <>
          {TEXT.separator}
          <span className="text-danger">{TEXT.attention.fullestDisk(percent(filled))}</span>
        </>
      )}
      {host.health?.rebootRequired === true && `${TEXT.separator}${TEXT.attention.rebootWaiting}`}
      {lastReport !== null && `${TEXT.separator}${TEXT.attention.lastReport(timeOfDay(lastReport))}`}
    </span>
  );
}

function PlaceHead({ place, titleId }: { place: NeedsYouPlace; titleId: string }) {
  const name = placeName(place.kind, place.hostLabel);
  const link = placeLink(place.kind, place.host?.id ?? null);
  const host = place.host;
  const healing = host !== null && host.state === HOST_STATE.online && !healingPaused(host);
  return (
    <header className="place-head">
      <h3 id={titleId}>{name}</h3>
      {host !== null && (
        <span className={healing ? "state tone-good" : "state tone-danger"}>
          <span className="status-dot" />
          {hostStateText(host)}
        </span>
      )}
      {host !== null && <HostFacts host={host} />}
      {link !== null && (
        <Link className="push small" to={link}>
          {TEXT.attention.open(name)}
        </Link>
      )}
    </header>
  );
}

/** One place with things for a person: its head, then each thing in its row with its own buttons, the most pressing first. */
export function PlaceCard({
  place,
  containers,
  viewerId,
  admin,
  selection,
  onHandOver,
  handing,
}: {
  place: NeedsYouPlace;
  containers: readonly ContainerView[];
  viewerId: string;
  admin: boolean;
  selection: Selection;
  onHandOver: HandOver;
  handing: boolean;
}) {
  const titleId = useId();
  const host = place.host ?? undefined;
  const containerOn = (name: string) =>
    containers.find((container) => container.hostId === place.key && container.name === name);
  return (
    <article className="place-card" aria-labelledby={titleId}>
      <PlaceHead place={place} titleId={titleId} />
      {(place.decisions.length > 0 || place.problems.length > 0) && (
        <ul className="update-rows">
          {place.decisions.map((incident) => (
            <DecisionRow
              key={incident.id}
              incident={incident}
              host={host}
              container={containerOn(incident.containerName)}
              admin={admin}
              onHandOver={onHandOver}
            />
          ))}
          {place.problems.map((task) => (
            <FixRow key={task.id} task={task} host={host} viewerId={viewerId} admin={admin} />
          ))}
        </ul>
      )}
      {place.updates !== null && (
        <HostUpdates
          group={place.updates}
          admin={admin}
          selection={selection}
          onHandOver={onHandOver}
          handing={handing}
        />
      )}
      {place.homeAssistantUpdates.length > 0 && <HomeAssistantUpdates updates={place.homeAssistantUpdates} />}
    </article>
  );
}
