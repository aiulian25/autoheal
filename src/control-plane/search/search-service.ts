import { HOST_CHANGES_ANCHOR, HOST_SECTIONS, HOST_STATUS_ACTIVE, REPORT_LIMITS } from "../../shared/constants.js";
import { redactSecrets } from "../../shared/redaction.js";
import { SEARCH_LIMITS, searchRequestSchema, type SearchResponse, type SearchResult } from "../../shared/search.js";
import type { DatabaseHandle } from "../database/connection.js";
interface Row {
  id: string;
  title: string;
  hostId: string | null;
  at: number | null;
  status?: string;
  number?: number;
}
interface ContainerName {
  name: string;
  hostId: string;
  at: number | null;
}
const text = (value: string) => redactSecrets(value).slice(0, 200);
const prefix = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`) + "%";
// A container's row on its host's page, opened: its stats, its actions and its timeline.
const containerLink = (hostId: string, name: string) =>
  `/hosts/${encodeURIComponent(hostId)}?container=${encodeURIComponent(name)}#${HOST_SECTIONS.containers}`;
const containerKey = (hostId: string | null, name: string) => JSON.stringify([hostId, name]);
/** Indexed display-name prefixes; never searches descriptions, logs, settings, credentials or account tables. */
export class SearchService {
  private readonly cached = new Map<string, { at: number; values: ContainerName[]; partial: boolean }>();
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly clock = Date.now,
  ) {}
  reset() {
    this.cached.clear();
  }
  private containers(hostId?: string) {
    const key = hostId ?? "fleet";
    const now = this.clock();
    const cached = this.cached.get(key);
    if (cached && now >= cached.at && now - cached.at < SEARCH_LIMITS.cacheMilliseconds) return cached;
    const values: ContainerName[] = [];
    let partial = false;
    let hosts = 0;
    // Iterate rather than loading up to128 large inventory JSON records into memory together.
    const rows = this.handle.sqlite
      .prepare<{ hostId?: string; active: string; limit: number }, { id: string; at: number | null; json: string }>(
        `SELECT id, last_heartbeat_at AS at, containers_json AS json FROM hosts WHERE status=@active ${hostId ? "AND id=@hostId" : ""} ORDER BY last_heartbeat_at DESC LIMIT @limit`,
      )
      .iterate({ ...(hostId ? { hostId } : {}), active: HOST_STATUS_ACTIVE, limit: SEARCH_LIMITS.hosts + 1 });
    for (const row of rows) {
      if (hosts++ >= SEARCH_LIMITS.hosts || values.length >= SEARCH_LIMITS.containers) {
        partial = true;
        break;
      }
      if (Buffer.byteLength(row.json) > SEARCH_LIMITS.containersJsonBytes) {
        partial = true;
        continue;
      }
      let containers: unknown;
      try {
        containers = JSON.parse(row.json);
      } catch {
        partial = true;
        continue;
      }
      if (!Array.isArray(containers)) {
        partial = true;
        continue;
      }
      if (containers.length > REPORT_LIMITS.containers) partial = true;
      for (const container of containers.slice(0, REPORT_LIMITS.containers)) {
        if (values.length >= SEARCH_LIMITS.containers) {
          partial = true;
          break;
        }
        if (typeof container?.name === "string")
          values.push({ name: container.name.slice(0, REPORT_LIMITS.nameCharacters), hostId: row.id, at: row.at });
      }
    }
    const view = { at: now, values, partial };
    this.cached.delete(key);
    if (this.cached.size >= SEARCH_LIMITS.cacheEntries) this.cached.delete(this.cached.keys().next().value!);
    this.cached.set(key, view);
    return view;
  }
  search(request: { q: string; hostId?: string }): SearchResponse {
    const { q, hostId } = searchRequestSchema.parse(request);
    const started = performance.now();
    const results: SearchResult[] = [];
    let partial = false;
    const parameters = { prefix: prefix(q), limit: SEARCH_LIMITS.perKind + 1, ...(hostId ? { hostId } : {}) };
    const scope = hostId ? "AND host_id=@hostId" : "";
    const get = (sql: string, scoped = true) =>
      this.handle.sqlite
        .prepare<Record<string, string | number>, Row>(sql)
        .all(scoped ? parameters : { prefix: parameters.prefix, limit: parameters.limit });
    const add = (
      kind: SearchResult["kind"],
      rows: Row[],
      path: (row: Row) => string,
      snippet: (row: Row) => string,
    ) => {
      if (rows.length > SEARCH_LIMITS.perKind) partial = true;
      for (const row of rows.slice(0, SEARCH_LIMITS.perKind))
        results.push({
          kind,
          id: String(row.id),
          hostId: row.hostId,
          title: text(row.title),
          snippet: text(snippet(row)),
          at: row.at,
          href: path(row),
        });
    };
    add(
      "host",
      get(
        `SELECT id,label AS title,id AS hostId,last_heartbeat_at AS at FROM hosts WHERE label LIKE @prefix ESCAPE '\\' ${hostId ? "AND id=@hostId" : ""} ORDER BY label COLLATE NOCASE LIMIT @limit`,
      ),
      (row) => `/hosts/${encodeURIComponent(row.id)}`,
      () => "Host inventory",
    );
    const inventory = this.containers(hostId);
    partial ||= inventory.partial;
    const names = inventory.values
      .filter(({ name }) => name.toLowerCase().startsWith(q.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    add(
      "container",
      names.slice(0, SEARCH_LIMITS.perKind + 1).map(({ name, hostId, at }) => ({ id: name, title: name, hostId, at })),
      (row) => containerLink(row.hostId!, row.id),
      () => "Container inventory",
    );
    const taskNumber = /^#(\d{1,9})$/.exec(q)?.[1];
    const taskRows = taskNumber
      ? this.handle.sqlite
          .prepare<Record<string, string | number>, Row>(
            `SELECT id,title,host_id AS hostId,updated_at AS at,status,number FROM tasks WHERE number=@number ${scope} LIMIT @limit`,
          )
          .all({ number: Number(taskNumber), limit: 1, ...(hostId ? { hostId } : {}) })
      : get(
          `SELECT id,title,host_id AS hostId,updated_at AS at,status,number FROM tasks WHERE title LIKE @prefix ESCAPE '\\' ${scope} ORDER BY title COLLATE NOCASE LIMIT @limit`,
        );
    add(
      "task",
      taskRows,
      (row) => `/tasks/${encodeURIComponent(row.id)}`,
      (row) => `Task #${row.number} · ${row.status}`,
    );
    add(
      "incident",
      get(
        `SELECT id,container_name AS title,host_id AS hostId,detected_at AS at,status FROM incidents WHERE container_name LIKE @prefix ESCAPE '\\' ${scope} ORDER BY container_name COLLATE NOCASE LIMIT @limit`,
      ),
      (row) => `/incidents/${encodeURIComponent(row.id)}`,
      (row) => `Incident · ${row.status}`,
    );
    add(
      "runbook",
      get(
        "SELECT id,title,NULL AS hostId,created_at AS at FROM runbooks WHERE archived_at IS NULL AND title LIKE @prefix ESCAPE '\\' ORDER BY title COLLATE NOCASE LIMIT @limit",
        false,
      ),
      (row) => `/runbooks/${encodeURIComponent(row.id)}`,
      () => "Runbook title · global scope",
    );
    // A change shows in its container's timeline. A container no longer on its host has no row to open, so its
    // changes lead to the host's own list of them.
    const onHost = new Set(inventory.values.map(({ hostId, name }) => containerKey(hostId, name)));
    const changeLink = (row: Row) => {
      if (onHost.has(containerKey(row.hostId, row.title))) return containerLink(row.hostId!, row.title);
      return `/hosts/${encodeURIComponent(row.hostId!)}#${HOST_CHANGES_ANCHOR}`;
    };
    add(
      "change",
      get(
        `SELECT CAST(id AS TEXT) AS id,container_name AS title,host_id AS hostId,at,kind AS status FROM host_changes WHERE container_name LIKE @prefix ESCAPE '\\' ${scope} ORDER BY container_name COLLATE NOCASE,at DESC LIMIT @limit`,
      ),
      changeLink,
      (row) => `Host change · ${row.status}`,
    );
    return { query: q, results, partial, elapsedMilliseconds: Math.round((performance.now() - started) * 100) / 100 };
  }
}
