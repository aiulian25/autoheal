import { ERROR_TEXT_LIMIT } from "./constants.js";

/** One line for a log or a trace: fetch hides the useful part (ECONNREFUSED, a TLS error) in `cause`. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error).slice(0, ERROR_TEXT_LIMIT);
  }
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`.slice(0, ERROR_TEXT_LIMIT);
}
