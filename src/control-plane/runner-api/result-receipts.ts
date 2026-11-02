import { API_ERRORS } from "../../shared/api.js";
import { sha256Hex } from "../../shared/hash.js";
import type { DatabaseHandle } from "../database/connection.js";
import { DomainError } from "../domain-error.js";

/** Commit completion evidence and its receipt together. Duplicate reports never repeat side effects. */
export class ResultReceipts {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly clock: () => number = Date.now,
  ) {}

  accept<T>(hostId: string, kind: string, resultId: string, payload: unknown, apply: () => T): T {
    const sqlite = this.handle.sqlite;
    const id = sha256Hex(JSON.stringify([hostId, kind, resultId]));
    const hash = sha256Hex(JSON.stringify(payload));
    return sqlite.transaction(() => {
      const existing = sqlite.prepare("SELECT payload_hash, response_json FROM runner_results WHERE id = ?").get(id) as
        { payload_hash: string; response_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.payload_hash !== hash) throw new DomainError(API_ERRORS.resultConflict);
        return JSON.parse(existing.response_json) as T;
      }
      const response = apply();
      sqlite
        .prepare(
          "INSERT INTO runner_results (id, host_id, payload_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, hostId, hash, JSON.stringify(response ?? null), this.clock());
      return response;
    })();
  }
}
