import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { EVERY_RUNNER_CAPABILITY, containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { HTTP_HEADERS } from "../../shared/constants.js";
import { RUNNER_ROUTES, type WorkResponse } from "../../shared/protocol.js";
import type { StackDrift, StackDriftReport, StackDriftView } from "../../shared/stacks.js";

const REVISION = "c".repeat(64);
const drift = (project: string, names = ["MODE"]): StackDrift => ({
  project,
  files: ["compose.yaml"],
  unreadable: false,
  revision: REVISION,
  services: [
    {
      service: "wiki",
      container: "wiki-1",
      kind: "source",
      fields: [{ field: "environment", names }],
    },
  ],
});

describe("how a host's stacks differ from their files", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;

  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    plane.runnerApp.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${token}`, [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY },
    });
  async function report(stackDrift?: StackDriftReport) {
    const containers = [containerSnapshot({ name: "wiki-1", composeProject: "wiki" })];
    const response = await runner("POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({ dryRun: false, containers }),
      ...(stackDrift === undefined ? {} : { stackDrift }),
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  const path = () => apiPath(API_ROUTES.stackDrift, { hostId });
  const shown = async () => (await admin.get(path())).json<StackDriftView[]>();

  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
  });

  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });

  it("shows nothing until a host says something, and nothing for a stack it says nothing of", async () => {
    await report();
    expect(await shown()).toEqual([]);
    await report({ checkedAt: 100, stacks: [] });
    expect(await shown()).toEqual([]);
  });

  it("keeps when it was first seen, updates what it says, and drops a stack that caught up", async () => {
    await report({ checkedAt: 100, stacks: [drift("wiki"), drift("blog")] });
    expect((await shown()).map(({ project, firstSeenAt }) => [project, firstSeenAt]).sort()).toEqual([
      ["blog", 100],
      ["wiki", 100],
    ]);

    await report({ checkedAt: 200, stacks: [drift("wiki", ["MODE", "EXTRA"])] });
    const [wiki, ...others] = await shown();
    expect(others).toEqual([]);
    expect(wiki).toMatchObject({ project: "wiki", firstSeenAt: 100, lastObservedAt: 200 });
    expect(wiki!.services[0]!.fields[0]!.names).toEqual(["MODE", "EXTRA"]);

    await report({ checkedAt: 300, stacks: [] });
    expect(await shown()).toEqual([]);
  });

  it("leaves what it knows alone when a heartbeat carries the same report again, or none", async () => {
    await report({ checkedAt: 100, stacks: [drift("wiki")] });
    await report({ checkedAt: 100, stacks: [] });
    expect((await shown()).map(({ project }) => project)).toEqual(["wiki"]);
    await report();
    expect((await shown()).map(({ project }) => project)).toEqual(["wiki"]);
  });

  it("refuses a report carrying anything but names and a keyed revision", async () => {
    const leaking = { ...drift("wiki"), value: "secret" };
    await report({ checkedAt: 100, stacks: [leaking] });
    expect(JSON.stringify(await shown())).not.toContain("secret");
    const badRevision = await runner("POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({ dryRun: false, containers: [] }),
      stackDrift: { checkedAt: 200, stacks: [{ ...drift("wiki"), revision: "not-a-revision" }] },
    });
    expect(badRevision.statusCode).toBe(400);
  });

  it("is for those who run the host, not a viewer", async () => {
    await report({ checkedAt: 100, stacks: [drift("wiki")] });
    const viewer = await fullySignedInUser(plane, admin, "operator", "viewer");
    expect((await viewer.client.get(path())).statusCode).toBe(403);
  });

  it("hands a reviewed recreate to the runner with what was reviewed, and refuses a malformed one", async () => {
    await report();
    const actions = apiPath(API_ROUTES.hostActions, { hostId });
    const asked = { project: "wiki", removeData: false };
    const malformed = await admin.post(actions, {
      action: "stack_up",
      stack: { ...asked, reconcile: { revision: "stale" } },
    });
    expect(malformed.statusCode).toBe(400);

    const started = await admin.post(actions, {
      action: "stack_up",
      stack: { ...asked, reconcile: { revision: REVISION } },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { jobs } = (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>();
    expect(jobs).toEqual([
      expect.objectContaining({
        action: "stack_up",
        stack: expect.objectContaining({ project: "wiki", reconcile: { revision: REVISION } }),
      }),
    ]);
  });
});
