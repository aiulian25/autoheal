import type { ApiErrorCode } from "../shared/api.js";

/** A business rule said no ("last admin", "not found"); the HTTP layer picks the status. */
export class DomainError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
  }
}
