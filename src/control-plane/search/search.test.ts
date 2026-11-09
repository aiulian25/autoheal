import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import { SEARCH_LIMITS, type SearchResponse } from "../../shared/search.js";
import {
  HOST_CHANGE,
  HOST_CHANGE_KINDS,
  HOST_CHANGES_ANCHOR,
  HOST_SECTIONS,
  INCIDENT_STATUS,
} from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { heartbeatWith, containerSnapshot } from "../../../test/support/inventory.js";
import { hostChanges, runbooks, tasks, users } from "../database/schema.js";
import { randomUUID } from "node:crypto";
const SECRET = "HiddenCredentialNotSearchable123";
describe("bounded infrastructure search", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let host: EnrolledHostView;
  const path = (q: string, hostId?: string) =>
    API_ROUTES.search + "?" + new URLSearchParams({ q, ...(hostId ? { hostId } : {}) });
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    host = (await admin.post(API_ROUTES.hosts, { label: "Atlas" })).json<EnrolledHostView>();
    const token = runnerTokenOf(host);
    await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: { authorization: `Bearer ${token}` },
      payload: heartbeatWith({
        containers: [
          containerSnapshot({ name: "Atlas-db" }),
          containerSnapshot({ name: "Atlas_literal" }),
          containerSnapshot({ name: "AtlasXliteral" }),
        ],
      }),
    });
    const row = plane.services.hostsService.authenticate(token)!;
    plane.services.incidentsService.create(
      row,
      {
        detectedAt: plane.clock.now,
        report: {
          containerName: "Atlas-db",
          image: "example/db",
          trigger: "die",
          stateSummary: "status=exited",
          healthOutputs: [SECRET],
          knownContainers: ["Atlas-db"],
          protectedContainers: [],
          logs: SECRET,
        },
      },
      INCIDENT_STATUS.resolved,
    );
    const handle = plane.services.databaseHandle;
    const user = handle.database.select().from(users).get()!;
    handle.database
      .insert(tasks)
      .values({
        id: randomUUID(),
        number: 42,
        title: "Atlas repair",
        description: SECRET,
        status: "todo",
        priority: "medium",
        source: "manual",
        hostId: row.id,
        createdAt: plane.clock.now,
        updatedAt: plane.clock.now,
        lastSeenAt: plane.clock.now,
      })
      .run();
    const bookId = randomUUID();
    handle.database
      .insert(runbooks)
      .values({ id: bookId, scope: "global", title: "Atlas recovery", createdBy: user.id, createdAt: plane.clock.now })
      .run();
    handle.sqlite
      .prepare(
        "INSERT INTO runbook_versions (id,runbook_id,version,body,content_hash,created_by,created_at) VALUES (?,?,1,?,'fingerprint',?,?)",
      )
      .run(randomUUID(), bookId, SECRET, user.id, plane.clock.now);
    handle.database
      .insert(hostChanges)
      .values([
        {
          hostId: row.id,
          containerName: "Atlas-db",
          kind: HOST_CHANGE_KINDS[0],
          at: plane.clock.now,
          detailsJson: JSON.stringify({ environment: SECRET }),
        },
        // A container no longer on the host: only the host's own list of changes still shows it.
        {
          hostId: row.id,
          containerName: "Atlas-gone",
          kind: HOST_CHANGE.removed,
          at: plane.clock.now,
          detailsJson: JSON.stringify({ image: "example/gone" }),
        },
      ])
      .run();
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  it("finds every supported entity for existing viewers with safe metadata and valid deep links", async () => {
    const viewer = (await fullySignedInUser(plane, admin, "observer", "viewer")).client;
    const response = await viewer.get(path("Atlas"));
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const result = response.json<SearchResponse>();
    expect(new Set(result.results.map((item) => item.kind))).toEqual(
      new Set(["host", "container", "task", "incident", "runbook", "change"]),
    );
    expect(result.results.every((item) => item.href.startsWith("/") && !item.href.startsWith("//"))).toBe(true);
    // A container leads to its host's page, opened under its row, in the section its row is in.
    expect(result.results.find((item) => item.kind === "container" && item.title === "Atlas-db")!.href).toMatch(
      /\?container=Atlas-db#containers$/,
    );
    // A change leads to where it is listed: its container's timeline, under its row, or the host's own list of
    // changes for a container no longer there.
    const changeLink = (title: string) =>
      result.results.find((item) => item.kind === "change" && item.title === title)!.href;
    expect(changeLink("Atlas-db")).toBe(`/hosts/${host.host.id}?container=Atlas-db#${HOST_SECTIONS.containers}`);
    expect(changeLink("Atlas-gone")).toBe(`/hosts/${host.host.id}#${HOST_CHANGES_ANCHOR}`);
    expect(result.results.length).toBeLessThanOrEqual(SEARCH_LIMITS.results);
    expect(response.body).not.toContain(SECRET);
    expect((await viewer.get(path(SECRET))).json<SearchResponse>().results).toEqual([]);
    expect((await viewer.get(path("#42"))).json<SearchResponse>().results).toEqual([
      expect.objectContaining({ kind: "task", title: "Atlas repair" }),
    ]);
    expect((await plane.client().get(path("Atlas"))).statusCode).toBe(401);
  });
  it("escapes wildcard/SQL input, bounds validation and scopes host evidence before results", async () => {
    expect((await admin.get(path("Atlas_"))).json<SearchResponse>().results.map((item) => item.title)).toEqual([
      "Atlas_literal",
    ]);
    expect((await admin.get(path("' OR 1=1 --"))).json<SearchResponse>().results).toEqual([]);
    expect((await admin.get(path("a"))).statusCode).toBe(400);
    expect((await admin.get(path("a".repeat(81)))).statusCode).toBe(400);
    const other = randomUUID();
    const scoped = (await admin.get(path("Atlas", other))).json<SearchResponse>();
    expect(scoped.results.every((item) => item.kind === "runbook")).toBe(true);
  });
  it("uses indexed prefix reads and meets a bounded warmed latency budget with many historical tasks", () => {
    const db = plane.services.databaseHandle.sqlite;
    const insert = db.prepare(
      "INSERT INTO tasks (id,number,title,status,priority,source,created_at,updated_at,last_seen_at) VALUES (?,?,'Atlas benchmark','todo','low','manual',1,1,1)",
    );
    db.transaction(() => {
      for (let index = 0; index < 10_000; index++) insert.run(randomUUID(), 1000 + index);
    })();
    plane.services.search.search({ q: "Atlas" });
    const result = plane.services.search.search({ q: "Atlas" });
    expect(result.partial).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(SEARCH_LIMITS.results);
    expect(result.elapsedMilliseconds).toBeLessThan(100);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE title LIKE 'Atlas%' ESCAPE '\\' ORDER BY title COLLATE NOCASE LIMIT 6",
      )
      .all() as { detail: string }[];
    expect(plan.some(({ detail }) => detail.includes("search_tasks_title"))).toBe(true);
  });
});
