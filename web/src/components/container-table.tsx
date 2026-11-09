import {
  type ContainerControlView,
  type ContainerControlChange,
  hasUpdate,
  type ContainerView,
} from "../../../src/shared/api.js";
import { CONTAINER_STATE_RUNNING, isKeptAsideCopy } from "../../../src/shared/constants.js";
import type { WorkingJob } from "../container-motion.js";
import { type ContainerShow, CONTAINER_SHOW, TEXT, CONTAINER_SHOWS } from "../constants.js";
import type { ReactNode } from "react";

// Container, state, image, ports, CPU, RAM and the two choices, and an admin's ticks and actions: an opened row's stats
// span them all.
export const COLUMN_COUNT = 9;
export const ADMIN_COLUMN_COUNT = COLUMN_COUNT + 2;
const byName = (first: ContainerView, second: ContainerView) => first.name.localeCompare(second.name);
// --- the host's containers, each with what it does when it fails and when a new image is out --------
interface Group {
  // The compose project of two or more containers here; null for the ones that stand alone.
  stack: string | null;
  containers: ContainerView[];
}
/**
 * The host's containers by stack, each in name order, so a row keeps its place whatever happens to it: an update,
 * a problem or a restart never moves it. What needs a look has its own filters above the table. A copy an update
 * keeps aside goes with its container, by its name, and never makes a stack of its own.
 */
export function groupsOf(containers: readonly ContainerView[]): Group[] {
  const counted = new Map<string, number>();
  for (const container of containers) {
    if (container.composeProject === null || isKeptAsideCopy(container.name)) continue;
    counted.set(container.composeProject, (counted.get(container.composeProject) ?? 0) + 1);
  }
  const stackOf = ({ composeProject }: ContainerView) =>
    composeProject !== null && (counted.get(composeProject) ?? 0) > 1 ? composeProject : null;
  const byStack = new Map<string | null, ContainerView[]>();
  for (const container of [...containers].sort(byName)) {
    const stack = stackOf(container);
    byStack.set(stack, [...(byStack.get(stack) ?? []), container]);
  }
  const stacks = [...byStack.entries()]
    .flatMap(([stack, members]) => (stack === null ? [] : [{ stack, containers: members }]))
    .sort((first, second) => first.stack.localeCompare(second.stack));
  const alone = byStack.get(null) ?? [];
  return alone.length === 0 ? stacks : [...stacks, { stack: null, containers: alone }];
}
export const matches = (container: ContainerView, words: string) =>
  container.name.toLowerCase().includes(words) || container.image.toLowerCase().includes(words);
export type Working = ReadonlyMap<string, WorkingJob>;
// Which containers the table shows: all, or one kind of them.
export const SHOWS: Record<ContainerShow, (container: ContainerView, working: Working) => boolean> = {
  [CONTAINER_SHOW.all]: () => true,
  [CONTAINER_SHOW.running]: (container) => container.state === CONTAINER_STATE_RUNNING,
  [CONTAINER_SHOW.stopped]: (container) => container.state !== CONTAINER_STATE_RUNNING,
  [CONTAINER_SHOW.problems]: (container) => container.problem !== null,
  [CONTAINER_SHOW.updates]: hasUpdate,
  [CONTAINER_SHOW.working]: (container, working) => working.has(container.name),
};
// Each kind with how many it holds now; one with none is left out, unless it is the one chosen.
export function ShowChips({
  containers,
  working,
  chosen,
  onChoose,
  children,
}: {
  containers: readonly ContainerView[];
  working: Working;
  // Null while the list showing is not the containers.
  chosen: ContainerShow | null;
  onChoose: (show: ContainerShow) => void;
  children?: ReactNode;
}) {
  const text = TEXT.hostContainers;
  const counted = CONTAINER_SHOWS.map((show) => ({
    show,
    count: containers.filter((container) => SHOWS[show](container, working)).length,
  }));
  return (
    <div className="show-chips" role="group" aria-label={text.showLabel}>
      {counted
        .filter(({ show, count }) => count > 0 || show === chosen || show === CONTAINER_SHOW.all)
        .map(({ show, count }) => (
          <button
            key={show}
            type="button"
            className={show === chosen ? "chip-button active" : "chip-button"}
            aria-pressed={show === chosen}
            onClick={() => onChoose(show)}
          >
            {text.shows[show]} <span className="tab-count">{count}</span>
          </button>
        ))}
      {children}
    </div>
  );
}
export const HOST_PANEL = { containers: "containers", networks: "networks", volumes: "volumes" } as const;
export type HostPanel = (typeof HOST_PANEL)[keyof typeof HOST_PANEL];
export const PANEL_TITLES: Record<HostPanel, string> = {
  containers: "host-containers-title",
  networks: "host-networks-title",
  volumes: "host-volumes-title",
};
export const ticksOf = (change: ContainerControlChange): Partial<ContainerControlView> => ({
  ...(change.restart === undefined ? {} : { restart: change.restart }),
  ...(change.update === undefined ? {} : { update: change.update }),
});
