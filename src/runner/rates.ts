import { PERCENT } from "../shared/constants.js";

/** A value held within 0–100, so rounding never pushes a share past either end. */
export const clampShare = (value: number) => Math.min(PERCENT, Math.max(0, value));

/** `part` as a share of `whole`, 0–100; nothing of nothing is 0. */
export const shareOf = (part: number, whole: number) => (whole > 0 ? clampShare((part / whole) * PERCENT) : 0);

/** How fast a counter grew; one that went back (a reset, a restart) counts as no growth. */
export const perSecond = (current: number, previous: number, seconds: number) =>
  Math.max(0, current - previous) / seconds;
