import {
  INTERNET_STATE,
  NETWORK_LIMITS,
  SPEED_SOURCE,
  type InternetState,
  type SpeedTestView,
} from "../../shared/network.js";

const HOUR = 60 * 60 * 1000;
const WEEK_HOURS = 24 * 7;

/** Counters restart when a device reconnects: only what was added since the last reading counts. */
export const addedSince = (before: number | undefined, now: number) =>
  before === undefined || now < before ? 0 : now - before;

/** Whose fault a minute was, from the router and from Autoheal's own check together. */
export function internetStateOf(
  routerAnswers: boolean,
  lines: readonly { wan: string; up: boolean }[],
  ownCheckWorks: boolean,
): InternetState {
  if (!routerAnswers) return ownCheckWorks ? INTERNET_STATE.dashboardOnly : INTERNET_STATE.routerDown;
  const first = lines[0];
  const firstUp = first?.up ?? false;
  if (!firstUp && lines.some(({ up }) => up) && ownCheckWorks) return INTERNET_STATE.onSecondLine;
  if (!firstUp && !ownCheckWorks) return INTERNET_STATE.lineDown;
  if (firstUp && !ownCheckWorks) return INTERNET_STATE.nothingGetsOut;
  return INTERNET_STATE.up;
}

// Time the dashboard alone could not reach the router is not time the internet was down.
const COUNTS_AS_DOWN: ReadonlySet<InternetState> = new Set([
  INTERNET_STATE.lineDown,
  INTERNET_STATE.nothingGetsOut,
  INTERNET_STATE.routerDown,
]);
export const isDown = (state: string) => COUNTS_AS_DOWN.has(state as InternetState);

/** What is usual: the median of the same stretch of time, in up to four weeks back. Null while it is still learned. */
export function usualOf(earlier: readonly (number | undefined)[], firstSeen: number, at: number): number | null {
  if (at - firstSeen < NETWORK_LIMITS.learningDays * 24 * HOUR) return null;
  const known = earlier.filter((value) => value !== undefined).toSorted((one, other) => one - other);
  return known.length === 0 ? null : (known[Math.floor(known.length / 2)] ?? null);
}

export const WEEK_MILLISECONDS = WEEK_HOURS * HOUR;

/** Well above its usual, and enough to matter: never a fixed limit alone. */
export const isUnusual = (bytes: number, usual: number | null) =>
  usual !== null && bytes > NETWORK_LIMITS.unusualBytes && bytes > usual * NETWORK_LIMITS.unusualTimes;

/** A fair speed test: the line was not already busy. With no contract or no reading, it cannot be called unfair. */
export const isFairTest = (busyMbps: number | null, contractDownMbps: number | null) =>
  busyMbps === null || contractDownMbps === null || busyMbps < contractDownMbps * NETWORK_LIMITS.fairBusyShare;

/** Whether a test says anything of the provider. One from this machine may only be showing this machine's own link. */
export const countsForContract = ({ fair, source }: SpeedTestView) => fair && source === SPEED_SOURCE.router;

const IP_PATTERN = "(\\d{1,3}(?:\\.\\d{1,3}){3}|[0-9a-fA-F:]{3,})";
const FIELD = (name: string) => new RegExp(`(?:^|[\\s|])${name}=${IP_PATTERN}(?:\\s|$)`);
const PORT = /(?:^|[\s|])(?:DPT|dpt)=(\d{1,5})/;
const BLOCK_WORD = /\b(block|blocked|deny|denied|drop|dropped|reject|rejected)\b|-D-|-R-|act=(?:block|drop|deny)/i;

export interface LoggedFlow {
  source: string;
  destination: string;
  port: number;
  blocked: boolean;
}

/** One line of the router's log: its iptables form or CEF. Null for what names no addresses. */
export function flowInLine(line: string): LoggedFlow | null {
  const source = FIELD("SRC").exec(line)?.[1] ?? FIELD("src").exec(line)?.[1];
  const destination = FIELD("DST").exec(line)?.[1] ?? FIELD("dst").exec(line)?.[1];
  if (source === undefined || destination === undefined) return null;
  return {
    source,
    destination,
    port: Number(PORT.exec(line)?.[1] ?? 0),
    blocked: BLOCK_WORD.test(line),
  };
}
