import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { Link } from "react-router";
import {
  hasUpdate,
  type ContainerView,
  type HostPackagesView,
  type HostView,
  type TaskSummaryView,
  type UpdateRunView,
} from "../../../../src/shared/api.js";
import {
  HOST_SECTIONS,
  TASK_RESOURCE,
  UPDATE_ASSESSMENT,
  UPDATE_RUN_STATUS,
  type UpdateAssessment,
} from "../../../../src/shared/constants.js";
import {
  packageItem,
  packagesHandable,
  startDrag,
  tagHandable,
  tagItem,
  updateHandable,
  updateItem,
  type Selection,
} from "../../agent-dispatch.js";
import { hostSectionLink } from "../../host-links.js";
import { ErrorNotice } from "../../components/common.js";
import { ImageVersions } from "../../components/container-actions.js";
import { IgnoreMenu, useIgnoreVersions } from "../../components/newer-versions.js";
import { imageTag } from "../../../../src/shared/image-reference.js";
import { Icon, type IconName } from "../../components/icons.js";
import { TEXT } from "../../constants.js";
import { hostUpdatesQuery } from "../../queries.js";
import { runLine } from "../../update-runs.js";
import { Grip } from "./attention-parts.js";
import { ReleaseNotesLink } from "../../components/release-notes-link.js";

export interface UpdateGroupFacts {
  host: HostView;
  tasks: TaskSummaryView[];
  // The host's containers, for what each update brings.
  containers: ContainerView[];
  packages: HostPackagesView | undefined;
  // Its containers with a newer version of their pinned tag out, which the agent can move them to.
  newer: ContainerView[];
}

// What the update brings when its images say; else what updating does.
export function UpdateLine({ container }: { container: ContainerView | undefined }) {
  const generic = <span className="small faint">{TEXT.attention.containerImage}</span>;
  return container === undefined ? generic : <ImageVersions container={container} fallback={generic} />;
}

export const UpdateTile = ({ icon }: { icon: IconName }) => (
  <span className="update-tile" aria-hidden>
    <Icon name={icon} />
  </span>
);

/**
 * One update's row: for an admin, its handle and its tick, the row itself dragged onto the Ollama agent with the
 * other ticked rows; where its runner would refuse it, only the space they take, so the names line up.
 */
export function HandableRow(props: {
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

export function PackageRows({
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
        <Link className="small update-review" to={hostSectionLink(host.id, HOST_SECTIONS.updates)}>
          {TEXT.attention.review}
        </Link>
      </HandableRow>
    );
  });
}

// The container an update task is about: the one a run updates.
export const containerOf = (task: TaskSummaryView) =>
  task.resource?.kind === TASK_RESOURCE.container ? task.resource.id : null;

// As its host last reported it, the container still has its new image waiting: its task is no history.
export const stillWaits = (task: TaskSummaryView, containers: readonly ContainerView[]) =>
  containers.some(
    (container) => container.hostId === task.hostId && container.name === containerOf(task) && hasUpdate(container),
  );

export function AdviceBadge({ advice }: { advice: UpdateAssessment | null }) {
  if (advice === null) {
    return null;
  }
  const safe = advice === UPDATE_ASSESSMENT.update;
  return <span className={safe ? "badge good" : "badge warning"}>{TEXT.attention.advice[advice]}</span>;
}

// Under the button: how a run goes, or how it would.
export const footNote = (run: UpdateRunView | null) =>
  run === null || run.status === UPDATE_RUN_STATUS.finished ? TEXT.attention.oneAtATime : runLine(run);

export const containerFor = (group: UpdateGroupFacts, task: TaskSummaryView) =>
  group.containers.find((container) => container.name === containerOf(task));

// What of a host's updates may be handed to the Ollama agent: what its runner would not refuse.
export function handableItems(group: UpdateGroupFacts): string[] {
  const updates = group.tasks.filter((task) => updateHandable(containerFor(group, task))).map((task) => task.id);
  const packages = group.packages !== undefined && packagesHandable(group.host, group.packages) ? group.packages : null;
  return [
    ...updates.map(updateItem),
    ...(packages?.packages ?? []).map((item) => packageItem(group.host.id, item.name)),
    ...group.newer.filter((container) => tagHandable(group.host, container)).map(tagItem),
  ];
}

/** A newer version of a pinned tag: handed to the agent as an update is, or ignored from its menu. */
export function NewerRows({
  group,
  admin,
  selection,
}: {
  group: UpdateGroupFacts;
  admin: boolean;
  selection: Selection;
}) {
  const ignore = useIgnoreVersions(group.host.id);
  return (
    <>
      {group.newer.map((container) => (
        <HandableRow
          key={tagItem(container)}
          item={tagItem(container)}
          admin={admin}
          handable={admin && tagHandable(group.host, container)}
          label={TEXT.containerImages.tickOne(container.name)}
          selection={selection}
          className="update-row container-update newer-update"
        >
          <UpdateTile icon="circleArrowUp" />
          <span className="update-what">
            <span className="mono">{container.name}</span>
            <span className="small faint">
              {TEXT.attention.newerVersion(imageTag(container.image), container.update.newerTag!)}
              <ReleaseNotesLink container={container} version={container.update.newerTag!} />
            </span>
          </span>
          {admin && (
            <IgnoreMenu
              container={container}
              disabled={ignore.isPending}
              onIgnore={(version) => ignore.mutate([{ container: container.name, version }])}
            />
          )}
          <Link className="small update-review" to={hostSectionLink(group.host.id, HOST_SECTIONS.updates)}>
            {TEXT.attention.review}
          </Link>
        </HandableRow>
      ))}
      {ignore.error !== null && (
        <li className="update-row">
          <ErrorNotice error={ignore.error} />
        </li>
      )}
    </>
  );
}
