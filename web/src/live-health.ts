import { LIVE_SAFETY_REFRESH_MILLISECONDS, LIVE_STALL_MILLISECONDS } from "./constants.js";

// When the live stream last said anything, its alive beat included; null while it is not connected.
let lastHeardAt: number | null = null;

export const liveHeard = (now: number = Date.now()) => {
  lastHeardAt = now;
};

export const liveLost = () => {
  lastHeardAt = null;
};

/** Connected, and heard from within the time its alive beat comes, with room for a late one. */
export const liveIsHealthy = (now: number = Date.now()) =>
  lastHeardAt !== null && now - lastHeardAt <= LIVE_STALL_MILLISECONDS;

/** How often a read the live stream keeps current asks again: seldom while the stream is healthy, else as given. */
export const liveAware = (interval: number) => () => (liveIsHealthy() ? LIVE_SAFETY_REFRESH_MILLISECONDS : interval);
