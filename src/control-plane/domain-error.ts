import type { ApiErrorCode } from "../shared/api.js";

/** A business rule said no ("last admin", "not found"); the HTTP layer picks the status. */
export class DomainError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    // What the person is told beside the code, such as how long to wait.
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/**
 * Whether a check a business rule may refuse passes: its refusal is a no, unless it is one of `passing`, refusals that
 * will lift by themselves; anything else still throws.
 */
export function accepts(check: () => unknown, passing: readonly ApiErrorCode[] = []): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof DomainError) return passing.includes(error.code);
    throw error;
  }
}
