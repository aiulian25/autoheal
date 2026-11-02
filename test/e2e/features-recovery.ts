import { expect } from "@playwright/test";
import type { FeatureUIContext } from "./feature-context.js";
import {
  CONTROL_PLANE_CONTAINER,
  E2E_IMAGE,
  E2E_LABEL,
  E2E_REGISTRY_CONTAINER,
  E2E_REGISTRY_PORT,
} from "./global-setup.js";

const HOST = "e2e-host";
const WAIT = 150_000;
const node = (context: FeatureUIContext, container: string, program: string, ...args: string[]) =>
  context.docker("exec", container, "/nodejs/bin/node", "-e", program, ...args);
const safely = (context: FeatureUIContext, ...args: string[]) => {
  try {
    return context.docker(...args);
  } catch {
    return "";
  }
};

/** Real coordinated SQLite/file capture, isolated drill, and explicitly reviewed live replacement. */
export async function verifyApplicationBackups(context: FeatureUIContext) {
  const { page, docker } = context;
  const name = "autoheal-e2e-feature-application";
  const volume = "autoheal-e2e-feature-application-data";
  const planName = "Browser application recovery fixture";
  const original = "original browser fixture";
  docker("volume", "create", "--label", E2E_LABEL, volume);
  try {
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      E2E_LABEL,
      "--user",
      "65532:65532",
      "--network",
      "none",
      "--read-only",
      "--no-healthcheck",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--restart",
      "unless-stopped",
      "--stop-timeout",
      "10",
      "--mount",
      `type=volume,src=${volume},dst=/data`,
      "--entrypoint",
      "/nodejs/bin/node",
      E2E_IMAGE,
      "-e",
      `
      const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');
      if(!fs.existsSync('/data/content.txt'))fs.writeFileSync('/data/content.txt',${JSON.stringify(original)});
      const db=new DatabaseSync('/data/app.sqlite');db.exec('CREATE TABLE IF NOT EXISTS fixture (value TEXT NOT NULL)');
      if(!db.prepare('SELECT value FROM fixture').get())db.prepare('INSERT INTO fixture VALUES (?)').run(${JSON.stringify(original)});db.close();
      process.on('SIGTERM',()=>{fs.writeFileSync('/data/clean-stop.txt','flushed');process.exit(0);});setInterval(()=>{},1000);
    `,
    );
    await expect
      .poll(
        () =>
          safely(
            context,
            "exec",
            name,
            "/nodejs/bin/node",
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('/data/content.txt','utf8'))",
          ),
        { timeout: WAIT },
      )
      .toBe(original);
    await context.openHost(HOST);
    await expect(
      page
        .getByRole("button", { name: new RegExp(name) })
        .or(page.getByText(name, { exact: true }))
        .first(),
    ).toBeVisible({ timeout: WAIT });
    await page.goto("/backups#application-plans");
    const plans = page.locator("#application-plans");
    await plans.getByText("Create application plan", { exact: true }).click();
    await plans.getByLabel("Plan name", { exact: true }).fill(planName);
    await plans.getByRole("combobox").selectOption({ label: HOST });
    await plans.getByLabel("Container name", { exact: true }).fill(name);
    await plans.getByLabel("Optional SQLite mount target", { exact: true }).fill("/data");
    await plans.getByLabel("SQLite file within that mount", { exact: true }).fill("app.sqlite");
    await plans.getByRole("checkbox", { name: /only Docker containers write these local volumes/ }).check();
    await plans.getByRole("button", { name: "Save plan", exact: true }).click();
    const plan = plans
      .locator(":scope > section.card")
      .filter({ has: page.getByRole("heading", { name: planName, exact: true }) });
    await expect(plan).toBeVisible();
    await plan.getByRole("button", { name: "Capture application backup", exact: true }).click();
    await expect(plans.getByText("capture · succeeded", { exact: true })).toBeVisible({ timeout: WAIT });
    expect(
      node(context, name, "process.stdout.write(require('node:fs').readFileSync('/data/clean-stop.txt','utf8'))"),
    ).toBe("flushed");
    expect(docker("inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", name)).toBe("unless-stopped");
    await plan.getByRole("button", { name: "Run isolated restore drill", exact: true }).click();
    await expect(plan.getByText("Isolated integrity drill passed", { exact: true })).toBeVisible({ timeout: WAIT });
    expect(
      node(context, name, "process.stdout.write(require('node:fs').readFileSync('/data/content.txt','utf8'))"),
    ).toBe(original);
    node(
      context,
      name,
      "const fs=require('node:fs');fs.writeFileSync('/data/content.txt','changed after capture');const db=new(require('node:sqlite').DatabaseSync)('/data/app.sqlite');db.prepare('UPDATE fixture SET value=?').run('changed after capture');db.close();",
    );
    await plan.getByRole("button", { name: "Review live restore", exact: true }).click();
    const review = page.getByRole("region", { name: "Application restore review" });
    await expect(review.getByRole("listitem").filter({ hasText: name })).toBeVisible({ timeout: WAIT });
    const restore = review.getByRole("button", { name: "Restore reviewed application data", exact: true });
    await expect(restore).toBeDisabled();
    await review.getByRole("checkbox", { name: /approve replacing this application/ }).check();
    await restore.click();
    await expect(plans.getByText("restore · succeeded", { exact: true })).toBeVisible({ timeout: WAIT });
    expect(
      node(
        context,
        name,
        "const db=new(require('node:sqlite').DatabaseSync)('/data/app.sqlite',{readOnly:true});process.stdout.write(db.prepare('SELECT value FROM fixture').get().value);db.close();",
      ),
    ).toBe(original);
    expect(
      node(context, name, "process.stdout.write(require('node:fs').readFileSync('/data/content.txt','utf8'))"),
    ).toBe(original);
    expect(docker("inspect", "-f", "{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}", name)).toBe(
      "true unless-stopped",
    );
    await plan.getByRole("button", { name: "Pause plan", exact: true }).click();
    await expect(plan.getByText(/Paused/)).toBeVisible();
  } finally {
    safely(context, "rm", "-f", name);
    safely(context, "volume", "rm", volume);
  }
}

/** Two real immutable image updates, each with a full observation window and explicit service review. */
export async function verifyCanary(context: FeatureUIContext) {
  const { page, docker } = context;
  const canary = "autoheal-e2e-feature-canary-a",
    follower = "autoheal-e2e-feature-canary-b";
  const builder = "autoheal-e2e-feature-canary-image";
  const repository = `localhost:${E2E_REGISTRY_PORT}/autoheal-feature-canary`;
  const source = `${repository}:source`,
    target = `${repository}:target`;
  try {
    // Earlier host lifecycle tests restart the runner; rejoin its current network namespace without losing registry data.
    const network = docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", E2E_REGISTRY_CONTAINER);
    expect(network).toMatch(/^container:/);
    const runner = network.slice("container:".length);
    docker("restart", E2E_REGISTRY_CONTAINER);
    await expect
      .poll(
        () =>
          safely(
            context,
            "exec",
            runner,
            "/nodejs/bin/node",
            "-e",
            `fetch('http://127.0.0.1:${E2E_REGISTRY_PORT}/v2/').then(response=>process.stdout.write(String(response.status))).catch(()=>process.stdout.write('unavailable'))`,
          ),
        { timeout: 30_000 },
      )
      .toBe("200");
    docker("tag", "alpine:3.20", source);
    docker("push", "-q", source);
    docker("create", "--name", builder, "--label", E2E_LABEL, source, "sleep", "86400");
    docker("commit", "--change", "LABEL autoheal.feature.version=canary-target", builder, target);
    docker("push", "-q", target);
    const digest = docker("image", "inspect", "-f", "{{index .RepoDigests 0}}", target);
    expect(digest).toMatch(/@sha256:[a-f0-9]{64}$/);
    for (const name of [canary, follower])
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--label",
        E2E_LABEL,
        "--network",
        "none",
        "--read-only",
        source,
        "sleep",
        "86400",
      );
    const followerId = docker("inspect", "-f", "{{.Id}}", follower);
    await context.openHost(HOST);
    await expect(page.getByText(canary, { exact: true }).first()).toBeVisible({ timeout: WAIT });
    await expect(page.getByText(follower, { exact: true }).first()).toBeVisible({ timeout: WAIT });
    const panel = page
      .locator("details")
      .filter({ has: page.locator("summary").getByText("Staged cross-host rollout", { exact: true }) });
    await panel.locator("summary").click();
    for (const [index, name] of [canary, follower].entries()) {
      await expect(
        panel
          .getByRole("combobox")
          .nth(index)
          .getByRole("option", { name: `${HOST} · ${name}`, exact: true }),
      ).toBeAttached({ timeout: WAIT });
      await panel
        .getByRole("combobox")
        .nth(index)
        .selectOption({ label: `${HOST} · ${name}` });
      await panel.getByLabel("Reviewed immutable image (repository@sha256:…)", { exact: true }).nth(index).fill(digest);
    }
    await panel.getByLabel("Observe each cohort (minutes, 1–60)", { exact: true }).fill("1");
    await panel.getByRole("checkbox", { name: /verified external data isolation/ }).check();
    await panel.getByRole("button", { name: "Review rollout", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Confirm immutable plan", exact: true })).toBeVisible({
      timeout: WAIT,
    });
    const started = Date.now();
    await panel.getByRole("button", { name: "Start canary", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Rollout · observing", exact: true })).toBeVisible({
      timeout: WAIT,
    });
    expect(docker("inspect", "-f", "{{.Id}}", follower)).toBe(followerId);
    await expect(panel.getByRole("button", { name: "Hold rollout", exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Rollout · ready", exact: true })).toBeVisible({ timeout: WAIT });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60_000);
    const promote = panel.getByRole("button", { name: "Promote next cohort", exact: true });
    await expect(promote).toBeDisabled();
    await panel.getByRole("checkbox", { name: "I verified the service for this cohort.", exact: true }).check();
    await promote.click();
    const promoted = Date.now();
    await expect(panel.getByText(/Cohort 2\/2/)).toBeVisible({ timeout: WAIT });
    await expect(panel.getByRole("heading", { name: "Rollout · observing", exact: true })).toBeVisible({
      timeout: WAIT,
    });
    await expect(panel.getByRole("heading", { name: "Rollout · ready", exact: true })).toBeVisible({ timeout: WAIT });
    expect(Date.now() - promoted).toBeGreaterThanOrEqual(60_000);
    const accept = panel.getByRole("button", { name: "Accept final cohort", exact: true });
    await expect(accept).toBeDisabled();
    await panel.getByRole("checkbox", { name: "I verified the service for this cohort.", exact: true }).check();
    await accept.click();
    await expect(panel.getByRole("heading", { name: "Rollout · completed", exact: true })).toBeVisible();
    for (const name of [canary, follower]) expect(docker("inspect", "-f", "{{.Config.Image}}", name)).toBe(digest);
    expect(docker("inspect", "-f", "{{.Id}}", follower)).not.toBe(followerId);
  } finally {
    for (const name of [canary, follower, builder, `${canary}-autoheal-old`, `${follower}-autoheal-old`])
      safely(context, "rm", "-f", name);
  }
}

/** Seed bounded synthetic history in the isolated DB, then exercise real chart/detector/feedback code. */
export async function verifyTrends(context: FeatureUIContext) {
  const { page, docker } = context;
  // Keep these synthetic completed buckets stable during the initial chart and feedback assertions.
  const untilBoundary = 300_000 - (Date.now() % 300_000);
  if (untilBoundary < 45_000) await page.waitForTimeout(untilBoundary + 500);
  const seriesProgram =
    "const db=new(require('node:sqlite').DatabaseSync)('/data/autoheal.sqlite');const row=db.prepare('SELECT s.id,s.identity,s.host_id FROM metric_series s JOIN hosts h ON h.id=s.host_id WHERE h.label=? AND s.container_name IS NULL').get(process.argv[1]);process.stdout.write(JSON.stringify(row??null));db.close();";
  await expect
    .poll(() => node(context, CONTROL_PLANE_CONTAINER, seriesProgram, HOST), { timeout: WAIT })
    .not.toBe("null");
  const seeded = JSON.parse(
    node(
      context,
      CONTROL_PLANE_CONTAINER,
      `
    const db=new(require('node:sqlite').DatabaseSync)('/data/autoheal.sqlite');db.exec('PRAGMA busy_timeout=5000');
    const row=db.prepare('SELECT s.id,s.identity,s.host_id FROM metric_series s JOIN hosts h ON h.id=s.host_id WHERE h.label=? AND s.container_name IS NULL').get(process.argv[1]);
    const interval=300000,current=Math.floor(Date.now()/interval)*interval,first=current-27*interval;
    const insert=db.prepare('INSERT INTO metric_rollups(series_id,at,identity,excluded,cpu,memory,io,cpu_samples,memory_samples,io_samples) VALUES (?,?,?,0,?,NULL,NULL,60,0,0) ON CONFLICT(series_id,at) DO UPDATE SET identity=excluded.identity,excluded=0,cpu=excluded.cpu,cpu_samples=60');
    db.exec('BEGIN IMMEDIATE');for(let index=0;index<27;index++)insert.run(row.id,first+index*interval,row.identity,index<24?8:70);db.exec('COMMIT');db.close();
    (async()=>{
      const {DatabaseHandle}=await import('/app/dist/server/control-plane/database/connection.js');
      const {AuditLog}=await import('/app/dist/server/control-plane/audit/audit-log.js');
      const {MetricRollups}=await import('/app/dist/server/control-plane/inventory/metric-rollups.js');
      const {TasksService}=await import('/app/dist/server/control-plane/tasks/tasks-service.js');
      const {AnomalyDetector}=await import('/app/dist/server/control-plane/tasks/anomaly-detector.js');
      const handle=new DatabaseHandle('/data/autoheal.sqlite'),audit=new AuditLog(handle,()=>{}),tasks=new TasksService(handle,audit,{containers:()=>[]});
      const rollups=new MetricRollups({databaseHandle:handle,auditLog:audit,maintenance:()=>[]});
      const detection=new AnomalyDetector({rollups,owner:()=>tasks.owner()}).detect();
      for(const finding of detection.problems.filter(finding=>finding.hostId===row.host_id))tasks.openOrJoin(finding);
      handle.close();process.stdout.write(JSON.stringify({id:row.id,first,hostId:row.host_id}));
    })().catch(error=>{console.error(error);process.exitCode=1});
  `,
      HOST,
    ),
  ) as { id: string; first: number; hostId: string };
  await context.openHost(HOST);
  await page.reload();
  const trends = page.getByRole("region", { name: "Learned resource trends" });
  await expect(trends.getByText(/Status: ready/)).toBeVisible({ timeout: WAIT });
  await trends.getByText("Retained five-minute history", { exact: true }).click();
  await expect(trends.getByRole("listitem").filter({ hasText: "Observation threshold" }).first()).toBeVisible();
  expect(await trends.locator("line[stroke-dasharray]").count()).toBeGreaterThanOrEqual(2);
  await page.goto("/");
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: `${HOST}: unusually high CPU use`, exact: true }) });
  await expect(card.getByText(/1440 samples/)).toBeVisible({ timeout: WAIT });
  await card.getByRole("button", { name: "Expected", exact: true }).click();
  await expect(card.getByRole("status").filter({ hasText: "Last review: expected" })).toBeVisible();
  docker("restart", CONTROL_PLANE_CONTAINER);
  await expect
    .poll(
      () => {
        try {
          docker("exec", CONTROL_PLANE_CONTAINER, "/nodejs/bin/node", "/app/dist/server/main.js", "healthcheck");
          return true;
        } catch {
          return false;
        }
      },
      { timeout: WAIT },
    )
    .toBe(true);
  const persisted = JSON.parse(
    node(
      context,
      CONTROL_PLANE_CONTAINER,
      "const db=new(require('node:sqlite').DatabaseSync)('/data/autoheal.sqlite');process.stdout.write(JSON.stringify({point:db.prepare('SELECT cpu,cpu_samples FROM metric_rollups WHERE series_id=? AND at=?').get(process.argv[1],Number(process.argv[2])),feedback:db.prepare('SELECT feedback FROM metric_anomalies WHERE series_id=? AND metric=?').get(process.argv[1],'cpu')}));db.close();",
      seeded.id,
      String(seeded.first),
    ),
  );
  expect(persisted).toMatchObject({ point: { cpu: 8, cpu_samples: 60 }, feedback: { feedback: "expected" } });
  await context.openHost(HOST);
  await page.reload();
  const restored = page.getByRole("region", { name: "Learned resource trends" });
  await restored.getByText("Retained five-minute history", { exact: true }).click();
  await expect(restored.locator("polyline.chart-line").first()).toBeVisible({ timeout: WAIT });
  await page.goto("/");
  await expect(
    page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: `${HOST}: unusually high CPU use`, exact: true }) })
      .getByRole("status")
      .filter({ hasText: "Last review: expected" }),
  ).toBeVisible({ timeout: WAIT });
}
