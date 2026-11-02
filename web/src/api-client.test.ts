import { describe, expect, it } from "vitest";
import { ApiError, queryRetryDelay, shouldRetryQuery } from "./api-client.js";

const refused = (status: number, body: Record<string, unknown> = {}) => new ApiError(status, "refused", body);

describe("asking again after a failed query", () => {
  it("waits as long as the server says after too many requests, a few times, and anything else once, at once", () => {
    const tooMany = refused(429, { retryAfterSeconds: 21 });
    expect([0, 1, 2, 3].map((failures) => shouldRetryQuery(failures, tooMany))).toEqual([true, true, true, false]);
    expect(queryRetryDelay(0, tooMany)).toBe(21_000);
    // Without the server's word, the rate limit's whole window.
    expect(queryRetryDelay(0, refused(429))).toBe(60_000);

    const broken = refused(500);
    expect([0, 1].map((failures) => shouldRetryQuery(failures, broken))).toEqual([true, false]);
    expect(queryRetryDelay(0, broken)).toBe(1_000);
    expect(shouldRetryQuery(1, new TypeError("Failed to fetch"))).toBe(false);
  });
});
