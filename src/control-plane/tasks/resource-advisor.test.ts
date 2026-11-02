import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeOllama } from "../../../test/fakes/fake-ollama.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type ResourceAdviceView,
  type TaskSummaryView,
} from "../../shared/api.js";
import { BYTES_PER_MEBIBYTE, MILLISECONDS_PER_DAY, RESOURCE_ADVICE } from "../../shared/constants.js";
import { TREND } from "../../shared/metric-trends.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { memoryAdvice } from "./resource-advisor.js";

const MEBIBYTES = (count: number) => count * BYTES_PER_MEBIBYTE;

describe("a memory limit from what a container used", () => {
  it("suggests the p99 of its five-minute means with headroom, rounded up, once a day of readings is in", () => {
    // A week of readings: most near 1.2 GiB, and one in two hundred near 1.9 GiB.
    const week = Array.from({ length: 2016 }, (_each, index) =>
      index % 200 === 0 ? MEBIBYTES(1900 + (index % 7)) : MEBIBYTES(1200 + (index % 50)),
    );
    const advice = memoryAdvice(week)!;
    expect(advice.buckets).toBe(2016);
    expect(advice.percentileBytes).toBe(MEBIBYTES(1249));
    const withHeadroom = advice.percentileBytes * RESOURCE_ADVICE.headroom;
    expect(advice.suggestedBytes).toBeGreaterThanOrEqual(withHeadroom);
    expect(advice.suggestedBytes).toBeLessThanOrEqual(withHeadroom * 1.1);
    expect(advice.suggestedBytes % RESOURCE_ADVICE.roundingBytes).toBe(0);

    expect(memoryAdvice(week.slice(0, RESOURCE_ADVICE.minimumBuckets - 1))).toBeNull();
  });
});

describe("the resource advisor", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  let token: string;

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    ollama.handler = () => ({ status: 500, body: {} });
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await ollama.close();
  });

  const failed = (container: string, daysAgo: number, trigger = "oom") =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.incidents,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        detectedAt: controlPlane.clock.now - daysAgo * MILLISECONDS_PER_DAY,
        report: {
          containerName: container,
          image: `${container}:16`,
          trigger,
          stateSummary: "status=exited exit_code=137 oom_killed=true",
          healthOutputs: [],
          knownContainers: [container],
          protectedContainers: [],
          logs: "",
        },
      },
    });
  const openTasks = async () => (await admin.get(API_ROUTES.tasks)).json<TaskSummaryView[]>().map((task) => task.title);
  const OOM_LOOP = "pg ran out of memory 3 times in 7 days on Alder";

  // A day of five-minute memory means for pg, as the rollups keep them.
  function rememberMemory(megabytes: number) {
    const sqlite = controlPlane.services.databaseHandle.sqlite;
    sqlite
      .prepare(
        "INSERT INTO metric_series (id, host_id, container_name, identity, last_at, state_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("pg-series", hostId, "pg", "pg-identity", controlPlane.clock.now, "{}");
    const insert = sqlite.prepare(
      "INSERT INTO metric_rollups (series_id, at, identity, excluded, cpu, memory, io, cpu_samples, memory_samples, io_samples) VALUES (?, ?, ?, ?, NULL, ?, NULL, 0, 60, 0)",
    );
    for (let bucket = 0; bucket < RESOURCE_ADVICE.minimumBuckets; bucket += 1) {
      insert.run("pg-series", controlPlane.clock.now - bucket * TREND.interval, "pg-identity", 0, MEBIBYTES(megabytes));
    }
    // Maintenance is left out, however high, and so is what came before the window.
    insert.run("pg-series", controlPlane.clock.now - 1, "pg-identity", 1, MEBIBYTES(9000));
    insert.run("pg-series", controlPlane.clock.now - 8 * MILLISECONDS_PER_DAY, "pg-identity", 0, MEBIBYTES(9000));
  }

  it("opens a task once a container ran out of memory three times in a week, with the limit its readings suggest", async () => {
    rememberMemory(800);
    // Before any pass has swept old readings away, the advice already reads only the window's.
    const before = (
      await admin.get(apiPath(API_ROUTES.containerResourceAdvice, { hostId, containerName: "pg" }))
    ).json<ResourceAdviceView>();
    expect(before.memory?.buckets).toBe(RESOURCE_ADVICE.minimumBuckets);
    for (const days of [10, 6, 3]) expect((await failed("pg", days)).statusCode).toBe(200);
    // Crashes are not running out of memory.
    for (const days of [5, 4]) expect((await failed("pg", days, "die")).statusCode).toBe(200);
    await controlPlane.services.detectorService.run();
    // Two in the week, the third ten days ago: no task yet.
    expect((await openTasks()).some((title) => title.includes("times in 7 days"))).toBe(false);

    expect((await failed("pg", 1)).statusCode).toBe(200);
    await controlPlane.services.detectorService.run();
    expect(await openTasks()).toContain(OOM_LOOP);
    const [task] = (await admin.get(API_ROUTES.tasks))
      .json<TaskSummaryView[]>()
      .filter((each) => each.title === OOM_LOOP);
    expect(task).toMatchObject({ priority: "high" });
    const detail = (await admin.get(apiPath(API_ROUTES.task, { taskId: task!.id }))).json<{ description: string }>();
    expect(detail.description).toContain("a limit of 1.1 GB (mem_limit: 1024m) leaves room");

    const advice = (
      await admin.get(apiPath(API_ROUTES.containerResourceAdvice, { hostId, containerName: "pg" }))
    ).json<ResourceAdviceView>();
    expect(advice).toEqual({
      memory: { percentileBytes: MEBIBYTES(800), suggestedBytes: MEBIBYTES(1024), buckets: 288 },
      oomKills: 3,
    });

    // A week later the kills have aged out of the window, and the task closes by itself. The session has expired by
    // then, so the open tasks are asked of the service.
    const oomLoopKey = `oom-loop:${hostId}:pg`;
    expect(controlPlane.services.tasksService.openDetectorKeys()).toContain(oomLoopKey);
    controlPlane.clock.now += 7 * MILLISECONDS_PER_DAY;
    await controlPlane.services.detectorService.run();
    expect(controlPlane.services.tasksService.openDetectorKeys()).not.toContain(oomLoopKey);
  });

  it("waits for a day of readings before suggesting a limit", async () => {
    const advice = (
      await admin.get(apiPath(API_ROUTES.containerResourceAdvice, { hostId, containerName: "pg" }))
    ).json<ResourceAdviceView>();
    expect(advice).toEqual({ memory: null, oomKills: 0 });
  });
});
