import { MaintenanceBadge } from "../../components/maintenance-dialog.js";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import {
  hasNewerVersion,
  type ContainerView,
  type HomeAssistantUpdateView,
  type HostView,
  type TaskSummaryView,
} from "../../../../src/shared/api.js";
import { TASK_LABEL, HOST_SECTIONS } from "../../../../src/shared/constants.js";
import { updateHandable, updateItem, type Selection } from "../../agent-dispatch.js";
import { hostLink, hostSectionLink, taskPlaceLink } from "../../host-links.js";
import { ErrorNotice } from "../../components/common.js";
import { Icon } from "../../components/icons.js";
import { PATHS, TEXT } from "../../constants.js";
import { hostPackagesQuery } from "../../queries.js";
import { stateIn, useUpdateRun } from "../../update-runs.js";
import { ReleaseNotes } from "../home-assistant-system.js";
import {
  type UpdateGroupFacts,
  containerFor,
  containerOf,
  HandableRow,
  UpdateTile,
  UpdateLine,
  AdviceBadge,
  AssistantBadge,
  NewerRows,
  PackageRows,
  footNote,
  stillWaits,
  handableItems,
} from "./update-rows.js";
import { type HandOver, SectionLabel } from "./attention-parts.js";

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
  const count = group.tasks.length + (group.packages?.packages.length ?? 0) + group.newer.length;
  // Open as the page opens it, or as a person did: its head says which, whoever opened it.
  const [expanded, setExpanded] = useState(open);
  return (
    <details className="update-group" open={open} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span>
          <strong>{group.host.label}</strong>
          {TEXT.separator}
          {TEXT.attention.waiting(count)}
        </span>
        {expanded ? (
          <Link to={hostSectionLink(group.host.id, HOST_SECTIONS.updates)}>
            {TEXT.attention.reviewOn(group.host.label)}
          </Link>
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
              <AssistantBadge assistant={task.assistant} />
              <Link className="small update-review" to={taskPlaceLink(task) ?? hostLink(group.host.id)}>
                {TEXT.attention.review}
              </Link>
            </HandableRow>
          );
        })}
        <NewerRows group={group} admin={admin} selection={selection} />
        {group.packages !== undefined && (
          <PackageRows view={group.packages} host={group.host} admin={admin} selection={selection} />
        )}
      </ul>
      {admin && runnable.length > 0 && (
        <div className="update-group-foot">
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

export function Updates({
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
        newer: containers.filter((container) => container.hostId === host.id && hasNewerVersion(container)),
      };
    })
    .filter((group) => group.tasks.length > 0 || group.packages !== undefined || group.newer.length > 0);
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
