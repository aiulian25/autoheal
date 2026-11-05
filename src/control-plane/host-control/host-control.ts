import type { ContainerControlView, HostUpdateSettingsView } from "../../shared/api.js";
import {
  CONTROL_LOCK,
  DATABASE_IMAGE_NAMES,
  FIRST_WEEK_LAST_DAY,
  IMAGE_CLEANUP,
  IMAGE_CLEANUP_GAP_DAYS,
  IMAGE_CLEANUP_LOOKAHEAD_DAYS,
  IMAGE_CLEANUP_WEEKDAY,
  IMAGE_REFERENCE,
  MILLISECONDS_PER_DAY,
  MINUTES_PER_HOUR,
  RESTART_CHOICE,
  UPDATE_CHOICE,
  UPDATE_POLICY,
  isKeptAsideCopy,
  type ControlLock,
  type ImageCleanup,
  type RestartChoice,
  type UpdateChoice,
  type UpdatePolicy,
} from "../../shared/constants.js";
import { imageRepository } from "../../shared/image-reference.js";
import { instantOf, wallClock, type WallClock } from "../../shared/time-zones.js";
import { minuteOfDay, windowMilliseconds } from "../host-packages/host-packages-service.js";

/** A container's own answers, once someone changed them on its host's page. */
export interface SavedControl {
  restart: RestartChoice;
  update: UpdateChoice;
}

type Day = Pick<WallClock, "year" | "month" | "day">;

// A label's auto or ask counts until someone answers for the container on its host's page.
const LABELLED_UPDATE: Partial<Record<UpdatePolicy, UpdateChoice>> = {
  [UPDATE_POLICY.always]: UPDATE_CHOICE.always,
  [UPDATE_POLICY.auto]: UPDATE_CHOICE.apply,
  [UPDATE_POLICY.ask]: UPDATE_CHOICE.ask,
};

// What the rules make of each answer about new images: never is as if the label turned updates off.
const POLICY_OF: Record<UpdateChoice, UpdatePolicy> = {
  [UPDATE_CHOICE.always]: UPDATE_POLICY.always,
  [UPDATE_CHOICE.apply]: UPDATE_POLICY.auto,
  [UPDATE_CHOICE.ask]: UPDATE_POLICY.ask,
  [UPDATE_CHOICE.never]: UPDATE_POLICY.off,
};

/** postgres:16-alpine, ghcr.io/immich-app/postgres:14 and bitnami/postgresql all run a database. */
export function isDatabaseImage(image: string): boolean {
  const name = imageRepository(image).split(IMAGE_REFERENCE.pathSeparator).at(-1) ?? "";
  return DATABASE_IMAGE_NAMES.some((database) => name.startsWith(database));
}

// Never updated: its label says so, or it is the old container an update keeps aside.
const NEVER_UPDATED: ReadonlySet<ControlLock | null> = new Set([CONTROL_LOCK.labelledOff, CONTROL_LOCK.parked]);

const bothFixedBy = (lock: ControlLock): ContainerControlView => ({
  restart: RESTART_CHOICE.ask,
  update: UPDATE_CHOICE.ask,
  restartLock: lock,
  updateLock: lock,
});

function updateLockOf(image: string, policy: UpdatePolicy | null | undefined): ControlLock | null {
  if (policy === UPDATE_POLICY.off) {
    return CONTROL_LOCK.labelledOff;
  }
  return isDatabaseImage(image) ? CONTROL_LOCK.database : null;
}

/**
 * What a container may have Autoheal do on its own. The host's .env has the last word: a container it
 * protects takes no tick, and neither does the old container an update keeps aside for rolling back. A
 * label that turns updates off, or a database's image, locks the update tick. Otherwise a tick someone
 * set wins; without one, a label's auto or ask, then the host's default.
 */
export function controlOf(
  container: { name: string; image: string; updatePolicy?: UpdatePolicy | null },
  isProtected: boolean,
  saved: SavedControl | undefined,
  defaults: { restart: RestartChoice; update: UpdateChoice },
): ContainerControlView {
  if (isProtected) {
    return bothFixedBy(CONTROL_LOCK.protected);
  }
  if (isKeptAsideCopy(container.name)) {
    return bothFixedBy(CONTROL_LOCK.parked);
  }
  const updateLock = updateLockOf(container.image, container.updatePolicy);
  const labelled = container.updatePolicy ? LABELLED_UPDATE[container.updatePolicy] : undefined;
  const chosenUpdate = saved?.update ?? labelled ?? defaults.update;
  return {
    restart: saved?.restart ?? defaults.restart,
    update: updateLock === null ? chosenUpdate : UPDATE_CHOICE.ask,
    restartLock: null,
    updateLock,
  };
}

/**
 * The update policy the rules read: off when never updated, auto when Autoheal may apply it if Ollama calls it safe,
 * always when it applies each, else ask.
 */
export function policyOf(control: ContainerControlView): UpdatePolicy {
  if (NEVER_UPDATED.has(control.updateLock)) {
    return UPDATE_POLICY.off;
  }
  return POLICY_OF[control.update];
}

const weekdayOf = (day: Day) => new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();

/**
 * Whether the host removes unused images on this local day, at `at`: on a Sunday (the month's first, for
 * monthly), far enough from the last clean-up that none runs twice in its period.
 */
export function cleansOn(cleanup: ImageCleanup, day: Day, at: number, lastCleanupAt: number | null): boolean {
  if (cleanup === IMAGE_CLEANUP.off || weekdayOf(day) !== IMAGE_CLEANUP_WEEKDAY) {
    return false;
  }
  if (cleanup === IMAGE_CLEANUP.monthly && day.day > FIRST_WEEK_LAST_DAY) {
    return false;
  }
  return lastCleanupAt === null || at - lastCleanupAt >= IMAGE_CLEANUP_GAP_DAYS[cleanup] * MILLISECONDS_PER_DAY;
}

/**
 * When the next clean-up starts: the opening of the host's window on the first day that cleans, or now
 * while that window is open. Null when the schedule is off.
 */
export function nextCleanupAt(
  cleanup: ImageCleanup,
  lastCleanupAt: number | null,
  timeZone: string,
  window: HostUpdateSettingsView,
  now: number,
): number | null {
  const today = wallClock(now, timeZone);
  const opening = minuteOfDay(window.windowStart);
  const length = windowMilliseconds(window);
  for (let offset = 0; offset < IMAGE_CLEANUP_LOOKAHEAD_DAYS; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const day = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    const hour = Math.floor(opening / MINUTES_PER_HOUR);
    const opens = instantOf({ ...day, hour, minute: opening % MINUTES_PER_HOUR, second: 0 }, timeZone);
    const startsAt = Math.max(opens, now);
    if (opens + length > now && cleansOn(cleanup, day, startsAt, lastCleanupAt)) {
      return startsAt;
    }
  }
  return null;
}
