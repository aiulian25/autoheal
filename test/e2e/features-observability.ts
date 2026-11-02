import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import type { DiagnosticBundle } from "../../src/shared/diagnostics.js";
import { E2E_IMAGE, E2E_LABEL, VICTIM } from "./global-setup.js";
import type { FeatureUIContext } from "./feature-context.js";

const REPORT_WAIT = 90_000;

/** Real user-created scope, acknowledged by the actual isolated runner, then extended and ended. */
export async function verifyMaintenance({ page, openHost }: FeatureUIContext) {
  await openHost("e2e-host");
  await page.getByRole("link", { name: "What Autoheal may do", exact: true }).click();
  const maintenance = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Maintenance windows" }) });
  await maintenance.locator("summary").click();
  await maintenance.getByLabel("Container name (blank for whole host)").fill(VICTIM);
  await maintenance.getByLabel("Reason", { exact: true }).fill("Isolated browser maintenance verification");
  await maintenance.getByLabel("Duration", { exact: true }).selectOption("15");
  await expect(maintenance.getByRole("button", { name: "Start maintenance", exact: true })).toBeEnabled({
    timeout: REPORT_WAIT,
  });
  await maintenance.getByRole("button", { name: "Start maintenance", exact: true }).click();
  const window = maintenance
    .locator(".notice.warning")
    .filter({ hasText: "Isolated browser maintenance verification" });
  await expect(window).toBeVisible();
  await expect(window).toContainText(VICTIM);
  await expect(maintenance.getByText("Maintenance · runner confirmed", { exact: true })).toBeVisible({
    timeout: REPORT_WAIT,
  });
  const before = Date.parse((await window.locator("time").getAttribute("dateTime"))!);
  await window.getByRole("button", { name: "Extend 30 minutes", exact: true }).click();
  await expect
    .poll(async () => Date.parse((await window.locator("time").getAttribute("dateTime"))!), { timeout: REPORT_WAIT })
    .toBe(before + 30 * 60_000);
  await expect(maintenance.getByText("Maintenance · runner confirmed", { exact: true })).toBeVisible({
    timeout: REPORT_WAIT,
  });
  await window.getByRole("button", { name: "End maintenance", exact: true }).click();
  await expect(window).toHaveCount(0);
  await expect(maintenance.locator("summary")).not.toContainText("Maintenance ·");
}

/** Download the actual browser-generated file, rather than just asserting that a button was clickable. */
export async function verifyDiagnostics({ page }: FeatureUIContext) {
  await page.goto("/incidents");
  await page.getByRole("link", { name: VICTIM, exact: true }).first().click();
  const diagnostics = page.locator("details.diagnostics-preview");
  await diagnostics.locator("summary").click();
  await expect(diagnostics.getByRole("button", { name: "Download reviewed bundle" })).toHaveCount(0);
  await diagnostics.getByRole("button", { name: "Preview diagnostics", exact: true }).click();
  const preview = diagnostics.getByRole("region", { name: "Diagnostic bundle preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/Evidence SHA-256:/)).toBeVisible();
  const downloading = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Download reviewed bundle", exact: true }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toMatch(/^autoheal-diagnostics-[\w-]+\.json$/u);
  const path = await downloaded.path();
  expect(path).not.toBeNull();
  const content = readFileSync(path!, "utf8");
  const bundle = JSON.parse(content) as DiagnosticBundle;
  expect(bundle).toMatchObject({ format: "autoheal-diagnostics", version: 1 });
  expect(bundle.manifest.sections).toEqual(["trace", "facts", "usage"]);
  expect(bundle.manifest.sha256).toBe(createHash("sha256").update(JSON.stringify(bundle.evidence)).digest("hex"));
  expect(bundle.evidence.facts).toMatchObject({ host: "host-1", container: "container-1" });
  expect(content).not.toContain(VICTIM);
  expect(content).not.toContain("e2e-host");
  expect(content).not.toContain("It keeps failing on a missing setting");
  await expect(diagnostics.getByRole("status")).toHaveText(
    "Diagnostics downloaded. Create a new preview to download again.",
  );
  await expect(preview.getByRole("button", { name: "Download reviewed bundle", exact: true })).toBeDisabled();
  await diagnostics.getByLabel("Anonymized host/container facts", { exact: true }).uncheck();
  await expect(preview).toHaveCount(0);
  await expect(diagnostics.getByRole("status")).toHaveCount(0);
  await diagnostics.getByLabel("Captured numeric usage", { exact: true }).uncheck();
  await diagnostics.getByRole("button", { name: "Preview diagnostics", exact: true }).click();
  await expect(preview).toBeVisible();
  const traceOnly = JSON.parse((await preview.locator("pre").textContent())!) as DiagnosticBundle;
  expect(traceOnly.manifest.sections).toEqual(["trace"]);
  expect(traceOnly.evidence.facts).toBeUndefined();
  expect(traceOnly.evidence.usage).toBeUndefined();
}

/** These containers and their one volume exist only in the disposable nested engine. */
export async function verifyTopology({ page, docker, openHost }: FeatureUIContext) {
  const provider = "autoheal-e2e-topology-provider";
  const sidecar = "autoheal-e2e-topology-sidecar";
  const consumer = "autoheal-e2e-topology-consumer";
  const volume = "autoheal-e2e-topology-volume";
  const project = "autoheal-e2e-topology-project";
  const created: string[] = [];
  docker("volume", "create", "--label", E2E_LABEL, volume);
  const start = (name: string, options: string[]) => {
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      E2E_LABEL,
      "--no-healthcheck",
      ...options,
      "--entrypoint",
      "/nodejs/bin/node",
      E2E_IMAGE,
      "-e",
      "setInterval(()=>{},1000)",
    );
    created.push(name);
  };
  try {
    start(provider, [
      "--network",
      "none",
      "--label",
      `com.docker.compose.project=${project}`,
      "--mount",
      `type=volume,src=${volume},dst=/data`,
    ]);
    start(sidecar, [
      "--network",
      `container:${provider}`,
      "--label",
      `com.docker.compose.project=${project}`,
      "--mount",
      `type=volume,src=${volume},dst=/data`,
    ]);
    start(consumer, ["--network", "none", "--label", `autoheal.depends-on=${provider}`]);
    await openHost("e2e-host");
    await page.getByRole("link", { name: "Dependencies", exact: true }).click();
    const graph = page.getByRole("region", { name: "Dependencies and shared resources", exact: true });
    await expect(graph).toBeVisible();
    const list = graph.locator("details").filter({ has: page.locator("summary", { hasText: "Accessible link list" }) });
    for (const heading of [
      "Shares network namespace",
      "Same Compose project (association only)",
      "Shares writable data",
      "Declared dependency (operator label)",
    ]) {
      const relationships = list
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
      await expect(relationships).toBeVisible({ timeout: REPORT_WAIT });
      await expect(relationships).toContainText(provider);
      await expect(relationships).toContainText(
        heading === "Declared dependency (operator label)" ? consumer : sidecar,
      );
    }
    await expect(
      graph.getByRole("img", { name: "Dependency overview; the complete accessible link list follows" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Dependencies", exact: true })).toHaveAttribute("aria-current", "true");
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "true");
    await page.goBack();
    await expect(page.getByRole("link", { name: "Dependencies", exact: true })).toHaveAttribute("aria-current", "true");
  } finally {
    for (const name of created.reverse()) docker("rm", "-f", name);
    docker("volume", "rm", volume);
  }
}
