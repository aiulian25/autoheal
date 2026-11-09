import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContainerView, JobView } from "../../src/shared/api.js";
import { CONTAINER_STATE_PAUSED, CONTAINER_STATE_RUNNING, JOB_ACTION, JOB_STATUS } from "../../src/shared/constants.js";
import { isWaiting } from "./components/container-actions.js";
import {
  AWAIT_REPORT_MILLISECONDS,
  FINISHED_LINE_MILLISECONDS,
  MOTION,
  MOTION_MILLISECONDS,
  type Motion,
} from "./constants.js";

const LIST_BOX = ".table-wrap";

// The jobs that change a container while they run: a logs job only reads, and a host's own jobs name none.
export const WORKING_ACTIONS = [
  JOB_ACTION.backupContainer,
  JOB_ACTION.restoreContainer,
  JOB_ACTION.restart,
  JOB_ACTION.start,
  JOB_ACTION.stop,
  JOB_ACTION.remove,
  JOB_ACTION.pause,
  JOB_ACTION.unpause,
  JOB_ACTION.update,
  JOB_ACTION.rollBack,
  JOB_ACTION.edit,
  JOB_ACTION.recreate,
  // A stack's: every container of its Compose project is at work while one runs.
  JOB_ACTION.stackUp,
  JOB_ACTION.stackRebuild,
  JOB_ACTION.stackStop,
  JOB_ACTION.stackStart,
  JOB_ACTION.stackRemove,
  JOB_ACTION.changeTag,
] as const;
export type WorkingAction = (typeof WORKING_ACTIONS)[number];
export type WorkingJob = JobView & { action: WorkingAction };

const isWorkingAction = (job: JobView): job is WorkingJob =>
  (WORKING_ACTIONS as readonly string[]).includes(job.action);
const isWorking = (job: JobView): job is WorkingJob => isWaiting(job) && isWorkingAction(job);

// The jobs whose way shows in one line under their row: when one ends, that line says how it went for a moment.
const LINE_ACTIONS = [
  JOB_ACTION.update,
  JOB_ACTION.recreate,
  JOB_ACTION.stackUp,
  JOB_ACTION.stackRebuild,
  JOB_ACTION.changeTag,
] as const;
export type LineAction = (typeof LINE_ACTIONS)[number];
export type LineJob = JobView & { action: LineAction };
const isLineJob = (job: JobView): job is LineJob => (LINE_ACTIONS as readonly string[]).includes(job.action);

// The jobs that take a container away: once done, its row fades instead of waiting for a report.
const REMOVING_ACTIONS: ReadonlySet<string> = new Set([JOB_ACTION.remove, JOB_ACTION.stackRemove]);

/** The rows a job works on: a stack job's are its Compose project's containers, any other job's is its container. */
export function rowsOf(job: JobView, containers: Iterable<ContainerView>): string[] {
  if (job.stack === null) return [job.containerName];
  return [...containers].filter((container) => container.composeProject === job.stack).map(({ name }) => name);
}

/** The job working on each container now, by its name; the newest when there are two, as the list comes newest first. */
export function workOf(jobs: readonly JobView[], containers: Iterable<ContainerView> = []): Map<string, WorkingJob> {
  const known = [...containers];
  const working = new Map<string, WorkingJob>();
  for (const job of jobs.filter(isWorking)) {
    for (const name of rowsOf(job, known).filter((row) => !working.has(row))) {
      working.set(name, job);
    }
  }
  return working;
}

/** What changed in a container from one report to the next, as one effect; null when nothing a person sees did. */
export function motionOf(before: ContainerView, after: ContainerView): Motion | null {
  // A new container under the same name: an update, a recreate, or Compose putting it back.
  if (before.containerId !== after.containerId) {
    return MOTION.updated;
  }
  if (after.problem !== null && before.problem === null) {
    return MOTION.failed;
  }
  if (after.state === CONTAINER_STATE_PAUSED && before.state !== CONTAINER_STATE_PAUSED) {
    return MOTION.paused;
  }
  const wasRunning = before.state === CONTAINER_STATE_RUNNING;
  const running = after.state === CONTAINER_STATE_RUNNING;
  if (running !== wasRunning) {
    return running ? MOTION.started : MOTION.stopped;
  }
  return running && after.startedAt !== before.startedAt ? MOTION.restarted : null;
}

interface Moving {
  motion: Motion;
  // A removed container, drawn as it was while it fades.
  gone: ContainerView | null;
}

// Compares a container with how it was known, keeps it as known from now on, and notes what changed; true if it did.
function noteChange(known: Map<string, ContainerView>, container: ContainerView, moved: Map<string, Moving>): boolean {
  const was = known.get(container.name);
  known.set(container.name, container);
  const motion = was === undefined ? MOTION.appeared : motionOf(was, container);
  if (motion !== null) {
    moved.set(container.name, { motion, gone: null });
  }
  return motion !== null;
}

const without = <Value>(entries: ReadonlyMap<string, Value>, names: ReadonlySet<string>) =>
  new Map([...entries].filter(([name]) => !names.has(name)));

/**
 * What each row shows for a moment after its container changed, told by comparing each report with how it was: the
 * first list moves nothing. A removed container stays as a fading row for that moment. While a job works on a
 * container, how it was before the job is held, and so is its row, even when a report catches it gone (an update
 * renames the old container before it makes the new one): what changes on the way stays quiet, and the first report
 * after the job ended moves the row once, as it shows the outcome. Until that report comes, a job that went well still
 * shows as at work, so the row never shows its old state in between. A job that failed flashes its row red.
 */
export function useContainerMotion(
  containers: readonly ContainerView[] | undefined,
  jobs: readonly JobView[] | undefined,
) {
  const [moving, setMoving] = useState<ReadonlyMap<string, Moving>>(new Map());
  const [awaiting, setAwaiting] = useState<ReadonlyMap<string, WorkingJob>>(new Map());
  const known = useRef<Map<string, ContainerView> | null>(null);
  // The latest report, for a job that ends after it came.
  const latest = useRef<ReadonlyMap<string, ContainerView>>(new Map());
  const openJobs = useRef<ReadonlySet<string> | null>(null);
  const worked = useRef<ReadonlySet<string>>(new Set());
  const awaited = useRef<ReadonlyMap<string, WorkingJob>>(new Map());
  const timers = useRef(new Set<number>());

  const show = useCallback((moved: ReadonlyMap<string, Moving>) => {
    if (moved.size === 0) {
      return;
    }
    setMoving((current) => new Map([...current, ...moved]));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      // Only these: a row that moved again since keeps its newer effect.
      setMoving((current) => new Map([...current].filter(([name, entry]) => moved.get(name) !== entry)));
    }, MOTION_MILLISECONDS);
    timers.current.add(timer);
  }, []);

  const setAwaited = useCallback((next: ReadonlyMap<string, WorkingJob>) => {
    awaited.current = next;
    setAwaiting(next);
  }, []);

  // Its job's moment is over: a container still gone was removed after all.
  const goneIfAbsent = useCallback(
    (names: Iterable<string>) => {
      const moved = new Map<string, Moving>();
      for (const name of names) {
        const was = known.current?.get(name);
        if (was !== undefined && !latest.current.has(name) && !worked.current.has(name)) {
          known.current!.delete(name);
          moved.set(name, { motion: MOTION.removed, gone: was });
        }
      }
      show(moved);
    },
    [show],
  );

  // Before the page is painted, as the jobs' below: a row is never drawn between its job's end and being held at work.
  useLayoutEffect(() => {
    if (containers === undefined) {
      return;
    }
    const now = new Map(containers.map((container) => [container.name, container]));
    latest.current = now;
    if (known.current === null) {
      known.current = new Map(now);
      return;
    }
    const moved = new Map<string, Moving>();
    for (const container of now.values()) {
      if (!worked.current.has(container.name)) {
        noteChange(known.current, container, moved);
      }
    }
    for (const [name, container] of known.current) {
      const held = worked.current.has(name) || awaited.current.has(name);
      if (!now.has(name) && !held) {
        known.current.delete(name);
        moved.set(name, { motion: MOTION.removed, gone: container });
      }
    }
    const reported = new Set(moved.keys());
    if ([...reported].some((name) => awaited.current.has(name))) {
      setAwaited(without(awaited.current, reported));
    }
    show(moved);
  }, [containers, show, setAwaited]);

  useLayoutEffect(() => {
    if (jobs === undefined) {
      return;
    }
    const before = openJobs.current;
    openJobs.current = new Set(jobs.filter(isWaiting).map((job) => job.id));
    const rows = [...(known.current?.values() ?? [])];
    worked.current = new Set(workOf(jobs, rows).keys());
    if (before === null || known.current === null) {
      return;
    }
    const moved = new Map<string, Moving>();
    const unreported = new Map<string, WorkingJob>();
    const ended = jobs.filter(
      (job): job is WorkingJob => before.has(job.id) && !isWaiting(job) && isWorkingAction(job),
    );
    const endedRows = ended.flatMap((job) => rowsOf(job, rows).map((name) => ({ job, name })));
    // Its job ended: the latest report of it counts now, against how it was before the job.
    for (const { job, name } of endedRows.filter((row) => !worked.current.has(row.name))) {
      const container = latest.current.get(name);
      const shown = container !== undefined && noteChange(known.current, container, moved);
      if (!shown && job.status === JOB_STATUS.succeeded) {
        unreported.set(name, job);
      }
    }
    for (const { name } of endedRows.filter(({ job }) => job.status !== JOB_STATUS.succeeded)) {
      moved.set(name, { motion: MOTION.failed, gone: null });
    }
    // A removal done is its row fading now; nothing more to wait for.
    const removed = [...unreported].filter(([, job]) => REMOVING_ACTIONS.has(job.action)).map(([name]) => name);
    for (const name of removed) {
      unreported.delete(name);
    }
    show(moved);
    goneIfAbsent(removed);
    if (unreported.size > 0) {
      setAwaited(new Map([...awaited.current, ...unreported]));
      // ponytail: a report that changes nothing (a start of one already running) leaves the row at work this long.
      const timer = window.setTimeout(() => {
        timers.current.delete(timer);
        setAwaited(new Map([...awaited.current].filter(([name, job]) => unreported.get(name) !== job)));
        goneIfAbsent(unreported.keys());
      }, AWAIT_REPORT_MILLISECONDS);
      timers.current.add(timer);
    }
  }, [jobs, show, setAwaited, goneIfAbsent]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const ghosts = [...moving.values()].flatMap((entry) => (entry.gone === null ? [] : [entry.gone]));
  // Rows a job holds though the latest report missed their container: shown as they were, at work.
  const listed = new Set((containers ?? []).map((container) => container.name));
  const busy = new Set([...workOf(jobs ?? [], known.current?.values() ?? []).keys(), ...awaiting.keys()]);
  const held = [...(known.current?.values() ?? [])].filter(
    (container) => busy.has(container.name) && !listed.has(container.name),
  );
  return { motions: new Map([...moving].map(([name, entry]) => [name, entry.motion])), ghosts, awaiting, held };
}

/**
 * What was just opened, up under the list's header, with the list's whole box on the screen: the box sits lower than
 * the page's top, so its bottom, where a panel's buttons stay, would otherwise start below the screen.
 */
export function bringUnderListHeader(element: HTMLElement) {
  const box = element.closest<HTMLElement>(LIST_BOX);
  if (box === null) return;
  box.scrollIntoView?.({ block: "end" });
  const header = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  box.scrollTop += element.getBoundingClientRect().top - box.getBoundingClientRect().top - header;
}

/**
 * The updates and recreates that just ended while this page was open, by job id, each kept a few seconds so its line
 * can say how it went before it goes.
 */
export function useFinishedJobs(jobs: readonly JobView[] | undefined): ReadonlyMap<string, LineJob> {
  const [finished, setFinished] = useState<ReadonlyMap<string, LineJob>>(new Map());
  const waiting = useRef<ReadonlySet<string> | null>(null);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    if (jobs === undefined) return;
    const before = waiting.current;
    waiting.current = new Set(jobs.filter(isWaiting).map((job) => job.id));
    if (before === null) return;
    const ended = jobs.filter(isLineJob).filter((job) => before.has(job.id) && !isWaiting(job));
    if (ended.length === 0) return;
    setFinished((current) => new Map([...current, ...ended.map((job) => [job.id, job] as const)]));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setFinished((current) => new Map([...current].filter(([id]) => !ended.some((job) => job.id === id))));
    }, FINISHED_LINE_MILLISECONDS);
    timers.current.add(timer);
  }, [jobs]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);
  return finished;
}
