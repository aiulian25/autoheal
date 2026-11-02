import { UTC_MINUTE_FORMAT } from "./constants.js";

/** A time as a clock on the wall shows it, in one time zone. Months count from 1. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const WALL_CLOCK_FIELDS = ["year", "month", "day", "hour", "minute", "second"] as const;

/** A moment to the minute in UTC, as "2026-10-24 14:02 UTC". */
export const utcMinute = (at: number) => {
  const { isoMinuteLength, dateTimeSeparator, joiner, zone } = UTC_MINUTE_FORMAT;
  return `${new Date(at).toISOString().slice(0, isoMinuteLength).replace(dateTimeSeparator, joiner)}${joiner}${zone}`;
};
const MILLISECONDS_PER_SECOND = 1000;

export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** What a clock in `timeZone` shows at this instant. */
export function wallClock(instant: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const field = (name: (typeof WALL_CLOCK_FIELDS)[number]) =>
    Number(parts.find((part) => part.type === name)?.value ?? 0);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

const asIfUtc = (wall: WallClock) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

/**
 * The instant a clock in `timeZone` showed this time. The zone's offset is taken twice, the second time
 * at the first guess, which settles it on both sides of a daylight-saving change. A time the change
 * skips or repeats comes out as one of its two readings.
 */
export function instantOf(wall: WallClock, timeZone: string): number {
  const offsetAt = (instant: number) =>
    asIfUtc(wallClock(instant, timeZone)) - Math.floor(instant / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND;
  const guess = asIfUtc(wall) - offsetAt(asIfUtc(wall));
  return asIfUtc(wall) - offsetAt(guess);
}
