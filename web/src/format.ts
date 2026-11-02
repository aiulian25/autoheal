import {
  MEGABITS_PER_GIGABIT,
  MEGAHERTZ_PER_GIGAHERTZ,
  SECONDS_PER_MINUTE,
  SYSTEM_RELEASE,
  TEXT,
  USER_AGENT_BROWSERS,
  USER_AGENT_SYSTEMS,
} from "./constants.js";
import {
  BYTES_PER_KIBIBYTE,
  IMAGE_ID_PREFIX,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_SECOND,
  PERCENT,
  SHORT_IMAGE_ID_LENGTH,
  wordsOf,
} from "../../src/shared/constants.js";

/** An image id as `docker images` shows it: its first twelve hex digits. */
export const shortImageId = (id: string) =>
  id.slice(IMAGE_ID_PREFIX.length, IMAGE_ID_PREFIX.length + SHORT_IMAGE_ID_LENGTH);

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000],
];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const unitOf = (difference: number) =>
  UNITS.find(([, length]) => Math.abs(difference) >= length) ?? UNITS[UNITS.length - 1]!;

export function timeAgo(timestamp: number, now: number = Date.now()): string {
  const difference = timestamp - now;
  const [unit, size] = unitOf(difference);
  return relative.format(Math.round(difference / size), unit);
}

/** "5 s ago", "3 min ago": for a card with little room. */
export function shortTimeAgo(timestamp: number, now: number = Date.now()): string {
  const difference = now - timestamp;
  const [unit, size] = unitOf(difference);
  return TEXT.ago(Math.max(0, Math.round(difference / size)), TEXT.shortUnits[unit as keyof typeof TEXT.shortUnits]);
}

export const dateTime = (timestamp: number) => absolute.format(timestamp);

const clockTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
export const timeOfDay = (timestamp: number) => clockTime.format(timestamp);

// A day such as "2030-06-30", the way the reader writes dates; in UTC, so it stays that day.
const DAY_TIME_ZONE = "UTC";
const calendarDay = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: DAY_TIME_ZONE });
export const day = (isoDate: string) => calendarDay.format(Date.parse(isoDate));

/** A moment as a clock in another place shows it: "Sunday, 25 October at 03:00". */
export const timeIn = (timestamp: number, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(timestamp);

// A clean-up a week or more off is named with its date.
const DAYS_NAMED_BY_WEEKDAY = 6;

/** "Sunday" for a day this week, "Sunday 1 November" further off, as the host's own clock has it. */
export function dayIn(timestamp: number, timeZone: string, now: number = Date.now()): string {
  const soon = timestamp - now < DAYS_NAMED_BY_WEEKDAY * MILLISECONDS_PER_DAY;
  const options: Intl.DateTimeFormatOptions = soon
    ? { weekday: "long", timeZone }
    : { weekday: "long", day: "numeric", month: "long", timeZone };
  return new Intl.DateTimeFormat(undefined, options).format(timestamp);
}

/** A moment in full as a clock in another place shows it: "Saturday 24 October 2026, 00:12"; null for a zone the browser doesn't know. */
export function dateTimeIn(timestamp: number, timeZone: string): string | null {
  try {
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone }).format(timestamp);
    const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short", timeZone }).format(timestamp);
    return `${date}${TEXT.listComma}${time}`;
  } catch {
    return null;
  }
}

const firstMatch = (patterns: readonly (readonly [RegExp, string])[], text: string) =>
  patterns.find(([pattern]) => pattern.test(text))?.[1];

/** 2 → "Two", for a count that starts a sentence; past ten, the figure. */
export const countInWords = (count: number) => TEXT.countWords[count] ?? String(count);

/** What goes before the item at `index` in a list said as a sentence: "a, b and c". */
export function listSeparator(index: number, length: number): string {
  if (index === 0) {
    return "";
  }
  return index === length - 1 ? TEXT.listAnd : TEXT.listComma;
}

/** "Ubuntu 24.04.5 LTS" → "Ubuntu 24.04"; a name without a release number stays whole. */
export const shortSystemName = (name: string) => SYSTEM_RELEASE.exec(name)?.[0] ?? name;

/** "Chrome on Linux" from a session's user agent; a client that is no known browser shows as it calls itself. */
export function browserName(userAgent: string | null): string {
  if (userAgent === null) {
    return TEXT.account.unknownBrowser;
  }
  const browser = firstMatch(USER_AGENT_BROWSERS, userAgent);
  if (browser === undefined) {
    return userAgent;
  }
  const system = firstMatch(USER_AGENT_SYSTEMS, userAgent);
  return system === undefined ? browser : TEXT.account.browserOn(browser, system);
}

/** "restart dependency → tika", or "—" when there is no action. */
export function actionText(action: string | null, target: string | null): string {
  if (action === null) {
    return TEXT.none;
  }
  const readable = wordsOf(action);
  return target ? `${readable} → ${target}` : readable;
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

const exponentOf = (count: number, step: number) =>
  Math.min(Math.floor(Math.log(Math.max(count, 1)) / Math.log(step)), BYTE_UNITS.length - 1);

/** 1536 → "1.5 kB"; binary steps, the way `df -h` and `docker stats` count, unless told Docker's decimal ones for images. */
export function bytes(count: number, step: number = BYTES_PER_KIBIBYTE): string {
  const exponent = exponentOf(count, step);
  // Intl spells a lone byte out ("0 byte"); everything bigger gets a symbol ("1.5 kB").
  if (exponent === 0) {
    return TEXT.bytes(oneDecimal.format(count));
  }
  const unit = BYTE_UNITS[exponent]!;
  const format = new Intl.NumberFormat(undefined, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 1,
  });
  return format.format(count / step ** exponent);
}

/** 3.5 and 62.5 GB → "3.5 of 62.5 GB": the part in the whole's unit, which is written once. */
export function bytesOf(part: number, whole: number): string {
  const exponent = exponentOf(whole, BYTES_PER_KIBIBYTE);
  return TEXT.metrics.partOf(oneDecimal.format(part / BYTES_PER_KIBIBYTE ** exponent), bytes(whole));
}

export const percentOf = (part: number, whole: number) => (whole <= 0 ? 0 : (part / whole) * PERCENT);

export const percent = (value: number) => `${Math.round(value)}%`;

/** 200000 seconds → "2 days": the largest whole unit, like the uptime a host reports. */
/** Elapsed time as a stopwatch shows it: "1:12". */
export const stopwatch = (seconds: number) =>
  `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(Math.floor(seconds % SECONDS_PER_MINUTE)).padStart(2, "0")}`;

export function duration(seconds: number): string {
  const milliseconds = seconds * MILLISECONDS_PER_SECOND;
  const [unit, size] = UNITS.find(([, length]) => milliseconds >= length) ?? UNITS[UNITS.length - 1]!;
  const format = new Intl.NumberFormat(undefined, { style: "unit", unit, unitDisplay: "long" });
  return format.format(Math.floor(milliseconds / size));
}

const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const wholeNumbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const twoDecimals = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const degreesCelsius = new Intl.NumberFormat(undefined, { style: "unit", unit: "celsius", maximumFractionDigits: 0 });
const megabitsPerSecond = new Intl.NumberFormat(undefined, { style: "unit", unit: "megabit-per-second" });
const gigabitsPerSecond = new Intl.NumberFormat(undefined, {
  style: "unit",
  unit: "gigabit-per-second",
  maximumFractionDigits: 1,
});

/** 14.24 → "14.2" */
export const decimal = (value: number) => oneDecimal.format(value);

/** 1319 → "1,319" */
export const wholeNumber = (value: number) => wholeNumbers.format(value);

// A load average as uptime prints it: 0.45.
export const loadAverage = (value: number) => twoDecimals.format(value);

/** 1536 → "1.5 kB/s" */
export const rate = (bytesPerSecond: number) => `${bytes(bytesPerSecond)}/s`;

export const celsius = (degrees: number) => degreesCelsius.format(degrees);

// A package's source as shown: "noble-security" is "Noble-security".
export const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const gigahertz = (megahertz: number) =>
  TEXT.metrics.gigahertz(twoDecimals.format(megahertz / MEGAHERTZ_PER_GIGAHERTZ));

export const watts = (value: number) => TEXT.metrics.watts(oneDecimal.format(value));

/** A network card's link speed: 1000 → "1 Gb/s", 100 → "100 Mb/s". */
export const linkSpeed = (megabits: number) =>
  megabits >= MEGABITS_PER_GIGABIT
    ? gigabitsPerSecond.format(megabits / MEGABITS_PER_GIGABIT)
    : megabitsPerSecond.format(megabits);

/** 14.24 → "14.2%" */
export const precisePercent = (value: number) => `${decimal(value)}%`;
