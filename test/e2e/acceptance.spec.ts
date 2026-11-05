/// <reference lib="dom" />
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, hostname, machine, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_PORT } from "../../playwright.config.js";
import { DockerClient } from "../../src/runner/docker-client.js";
import { ShutdownJournal } from "../../src/runner/shutdown-journal.js";
import { totpStep } from "../../src/control-plane/auth/totp.js";
import { API_ROUTES, TASK_FILTERS, TASK_QUERY, type HostPackagesView, type HostView } from "../../src/shared/api.js";
import { BRAND_ASSETS, HTTP_STATUS, OLD_CONTAINER_SUFFIX, REGISTRY } from "../../src/shared/constants.js";
import type { FeatureUIContext } from "./feature-context.js";
import { completeFirstSignIn, freshCode, signIn, usedSteps } from "./sign-in.js";
import { sidewaysOverflow } from "./layout.js";
import { verifyMaintenance, verifyDiagnostics, verifyTopology } from "./features-observability.js";
import { verifyNotifications, verifySearch, verifyPermissions, verifyRehearsal } from "./features-operations.js";
import { verifyApplicationBackups, verifyTrends, verifyCanary } from "./features-recovery.js";
import {
  CONTROL_PLANE_CONTAINER,
  E2E_APP,
  E2E_APP_IMAGE,
  E2E_APP_NEXT_IMAGE,
  E2E_APP_SOURCE,
  E2E_IMAGE,
  E2E_LABEL,
  E2E_NETWORK,
  E2E_REGISTRY_CONTAINER,
  E2E_REGISTRY_PORT,
  E2E_SESSION_STATE,
  E2E_SESSION_METADATA,
  FEDORA_HOST,
  FEDORA_HOST_IMAGE,
  FIXTURE_HOST,
  FIXTURE_HOST_IMAGE,
  RUNBOOK_MARKER,
  VICTIM,
} from "./global-setup.js";

// Neither may contain its username: the password policy refuses that.
const ADMIN_PASSWORD = "orbiting-tangerine-lantern-42";
const VIEWER_PASSWORD = "quiet-harbour-lantern-57";
const RUNNER = "autoheal-e2e-runner";
const PACKAGE_RUNNER = "autoheal-e2e-package-runner";
const FEDORA_RUNNER = "autoheal-e2e-fedora-runner";
// What the fixture's fake pvesh says about running backups: Proxmox VE's own JSON.
const BACKUPS_FILE = "/etc/autoheal-fake-backups.json";
const FAKE_PVESH = `printf '#!/bin/sh\\ncat ${BACKUPS_FILE}\\n' > /usr/local/bin/pvesh && chmod 755 /usr/local/bin/pvesh`;
const SLOW = 150_000;
const DIAGNOSIS = "It keeps failing on a missing setting; check its configuration.";
// The home's menu entry is followed by a count when something needs you.
const ATTENTION_LINK = /^Attention/;
// Two throwaway containers the host page's ticks act on at once.
const BULK_PREFIX = "autoheal-e2e-bulk-";
// A container to open a shell in, and one to browse the files of, from their rows on the host's page.
const SHELL_CONTAINER = "autoheal-e2e-shell";
const FILES_CONTAINER = "autoheal-e2e-files";
// One whose settings are changed from its row, and the host port the change publishes it on.
const SETTINGS_CONTAINER = "autoheal-e2e-settings";
const SETTINGS_PORT = 18600;
// A select inside its label is named by the label and its current value: "Status To do".
const STATUS_FIELD = /^Status/;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
// expect.poll gives up at the first throw: what is not there yet reads as empty, and is asked again.
const dockerOrEmpty = (...args: string[]) => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// Every API answer refusing too many requests: a page left on "Loading…" after one waits for the server's word.
const rateLimited: string[] = [];

async function newTrackedPage(
  browser: Browser,
  restoreAdmin = false,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(
    restoreAdmin && existsSync(E2E_SESSION_STATE) ? { storageState: E2E_SESSION_STATE } : {},
  );
  context.on("response", (response) => {
    if (response.status() === HTTP_STATUS.tooManyRequests) {
      rateLimited.push(`${new Date().toISOString()} ${new URL(response.url()).pathname}`);
    }
  });
  await context.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = violations;
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  return { context, page: await context.newPage() };
}

const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as { cspViolations?: string[] }).cspViolations ?? []);

interface FixtureHost {
  image: string;
  // The temporary directory with what its runner mounts: its D-Bus, its units' logs, and its root.
  shared: string;
  root: string;
}

/**
 * A fixture host: systemd and its D-Bus in a container, with offline repositories (test/fixtures). Its
 * runner sees it as its host: its D-Bus socket, the logs its units write, and the files given here.
 */
async function startFixtureHost(
  name: string,
  image: string,
  definition: string,
  files: Record<string, string>,
): Promise<FixtureHost> {
  docker("build", "-q", "-t", image, definition);
  const shared = mkdtempSync(join(tmpdir(), "autoheal-e2e-fixture-"));
  const root = join(shared, "root");
  for (const directory of ["dbus", "logs", "root/run/systemd/system", "root/run/dbus", "root/var/log/autoheal"]) {
    mkdirSync(join(shared, directory), { recursive: true, mode: 0o755 });
  }
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true, mode: 0o755 });
    writeFileSync(join(root, file), content);
  }
  const engine = new DockerClient("/var/run/docker.sock");
  await engine.create(name, {
    Image: image,
    Tty: true,
    Labels: { [E2E_LABEL.split("=")[0]!]: "1" },
    HostConfig: {
      Privileged: true,
      CgroupnsMode: "private",
      // Protect non-namespaced host tunables even though systemd fixtures need privileged cgroups.
      ReadonlyPaths: ["/proc/sys"],
      Tmpfs: { "/run": "rw", "/run/lock": "rw", "/tmp": "rw" },
      Mounts: [
        { Type: "bind", Source: join(shared, "dbus"), Target: "/run/dbus" },
        { Type: "bind", Source: join(shared, "logs"), Target: "/var/log/autoheal" },
      ],
    },
  });
  await engine.start(name);
  // "starting" exits 1 like "degraded" does: what it prints is the answer, not how it exits.
  const systemState = () =>
    spawnSync("docker", ["exec", name, "systemctl", "is-system-running"], { encoding: "utf8" }).stdout.trim();
  await expect.poll(systemState, { timeout: 60_000 }).toMatch(/^(running|degraded)$/);
  return { image, shared, root };
}

/** The fixture's directory; what its root wrote goes through a root container, as it is not this user's. */
function removeFixtureFiles(fixture: FixtureHost) {
  docker("run", "--rm", "-v", `${fixture.shared}:/shared`, fixture.image, "rm", "-rf", "/shared/dbus", "/shared/logs");
  rmSync(fixture.shared, { recursive: true, force: true });
}

// The menu's own entries; a page's tabs and links may share their names.
const rail = (page: Page, name: string | RegExp) =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name });

/**
 * Reload until the expectation holds: the dashboard also refreshes on its own every 15 s. The expectation waits
 * as any does, so a page still loading its data is not taken for one without what is looked for.
 */
async function reloadUntil(page: Page, expectation: () => Promise<void>, timeout = SLOW) {
  await expect(async () => {
    await page.reload();
    await expectation();
  }).toPass({ timeout, intervals: [2_000] });
}

// A package on a host's packages card: its row, found by the button its name is.
const packageRow = (card: Locator, name: string) =>
  card.locator("li", { has: card.page().getByRole("button", { name, exact: true }) });

// Every tick in this list off but the one named: the others are not this test's to apply.
async function tickOnly(list: Locator, name: string) {
  for (const tick of await list.getByRole("checkbox").all()) {
    await tick.setChecked((await tick.getAttribute("aria-label")) === name);
  }
}

test.describe("Autoheal, end to end on the real image", () => {
  let admin: Page;
  let adminContext: BrowserContext;
  let adminSecret: string;

  test.beforeAll(async ({ browser }) => {
    ({ context: adminContext, page: admin } = await newTrackedPage(browser, true));
    if (existsSync(E2E_SESSION_METADATA)) {
      adminSecret = JSON.parse(readFileSync(E2E_SESSION_METADATA, "utf8")).secret;
      usedSteps.set(adminSecret, totpStep(Date.now()));
      await admin.goto("/");
    }
  });

  test.afterEach(async ({}, testInfo) => {
    if (adminSecret) {
      await adminContext.storageState({ path: E2E_SESSION_STATE });
      writeFileSync(E2E_SESSION_METADATA, JSON.stringify({ secret: adminSecret }), { mode: 0o600 });
    }
    if (testInfo.status !== testInfo.expectedStatus && rateLimited.length > 0) {
      console.log(`Refused for too many requests: ${rateLimited.join("; ")}`);
    }
    expect(await cspViolations(admin)).toEqual([]);
  });

  test.afterAll(async () => {
    await adminContext.close();
  });

  /** The add-a-host card's first step, filled in: the install command it then shows, with its join code. */
  async function makeInstallCommand(label: string): Promise<string> {
    await rail(admin, "Fleet").click();
    await expect(admin).toHaveURL(/\/hosts$/);
    const add = admin.locator("#add-host");
    await add.getByLabel("Name").fill(label);
    await add.getByLabel("How it reaches this dashboard").fill("https://control-plane:9443");
    await add.getByRole("button", { name: "Make the command" }).click();
    const command = (await add.locator("pre.secret").textContent())!;
    expect(command).toContain("docker compose up -d");
    await expect(add.getByText(`Waiting for ${label} to connect…`)).toBeVisible();
    return /AUTOHEAL_JOIN=(ahj_\S+)/.exec(command)![1]!;
  }

  // Anywhere on a host's card opens it, not only its Open link.
  const openHost = async (label: string) => {
    await rail(admin, "Fleet").click();
    await admin.getByRole("article", { name: label, exact: true }).click();
    await expect(admin.getByRole("heading", { name: label, exact: true, level: 1 })).toBeVisible();
  };

  async function settleFixtureRunner(label: string, runnerName: string) {
    const hosts = (await (await admin.request.get(API_ROUTES.hosts)).json()) as HostView[];
    const host = hosts.find((value) => value.label === label)!;
    await expect
      .poll(
        async () => {
          const response = await admin.request.get(API_ROUTES.hostPackages.replace(":hostId", host.id));
          return ((await response.json()) as HostPackagesView).running;
        },
        { timeout: SLOW },
      )
      .toBeNull();
    const journal = new ShutdownJournal(new DockerClient("/var/run/docker.sock"));
    const pendingHostJobs = async () =>
      (await journal.pending()).filter((record) => record.operation.startsWith("host:")).length;
    await expect.poll(pendingHostJobs, { timeout: SLOW }).toBe(0);
    docker("stop", runnerName);
    await expect.poll(pendingHostJobs, { timeout: SLOW }).toBe(0);
    expect(docker("inspect", "-f", "{{.State.ExitCode}}", runnerName)).toBe("0");
  }

  test.describe.serial("existing workflows", () => {
    test("first-run admin: one-time password, new password, TOTP, recovery codes, the backup passphrase once", async () => {
      // The logo wherever the name is: the browser tab, a phone's home screen, the sign-in screen.
      await admin.goto("/");
      await expect(admin.getByRole("img", { name: "Autoheal" })).toBeVisible();
      await expect(admin.locator('link[rel="icon"]').first()).toHaveAttribute("href", "/brand/favicon-32.png");
      for (const [path, type] of [
        [BRAND_ASSETS.logo, "image/png"],
        [BRAND_ASSETS.mark, "image/png"],
        ["/manifest.webmanifest", "application/manifest+json"],
      ] as const) {
        expect((await admin.request.get(path)).headers()["content-type"], path).toContain(type);
      }
      const firstSignIn = await completeFirstSignIn(admin, "admin", process.env.E2E_ADMIN_PASSWORD!, ADMIN_PASSWORD);
      adminSecret = firstSignIn.secret;
      expect(firstSignIn.passphrase).toMatch(/^[A-Za-z0-9_-]{44}$/);
      expect(
        docker("exec", CONTROL_PLANE_CONTAINER, "/nodejs/bin/node", "/app/dist/server/main.js", "backup-passphrase"),
      ).toBe(firstSignIn.passphrase);
      await rail(admin, "Settings").click();
      const sections = admin.getByRole("navigation", { name: "Settings sections" });
      await expect(sections.getByRole("link", { name: "People and keys" })).toBeVisible();
      await sections.getByRole("link", { name: "Your account" }).click();
      await expect(admin.getByText("Recovery codes: 10 of 10 left.")).toBeVisible();
      await expect(admin.getByRole("cell", { name: /^This browser · Chrome on Linux$/ })).toBeVisible();

      // The look: shown at once when chosen, there again before the next page paints, then the device's own.
      const looks = admin.getByRole("radiogroup", { name: "Appearance" });
      const page = admin.locator("html");
      await looks.getByRole("radio", { name: "Dark", exact: true }).check();
      await expect(page).toHaveAttribute("data-theme", "dark");
      await admin.reload();
      await expect(page).toHaveAttribute("data-theme", "dark");
      await looks.getByRole("radio", { name: /^As this device is set/ }).check();
      await expect(page).not.toHaveAttribute("data-theme");
    });

    // Chrome's own virtual authenticator stands in for a phone: it verifies "the person" by itself.
    test("the admin adds a passkey after a code, and signs in with it alone", async () => {
      const devtools = await adminContext.newCDPSession(admin);
      await devtools.send("WebAuthn.enable");
      const { authenticatorId } = await devtools.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      const passkeys = admin.getByRole("region", { name: "Passkeys" });
      await expect(passkeys.getByText("No passkeys yet.")).toBeVisible();
      await passkeys.getByRole("button", { name: "Add a passkey" }).click();
      await passkeys.getByLabel("Current code, or a recovery code").fill(await freshCode(adminSecret));
      await passkeys.getByRole("button", { name: "Continue" }).click();
      await expect(passkeys.getByText(/^Added .*\. Next time, choose Passkey on the sign-in page\.$/)).toBeVisible();
      await expect(passkeys.getByText(/not used yet/)).toBeVisible();

      await admin.getByRole("button", { name: "Sign out" }).click();
      await expect(admin).toHaveURL(/\/login$/);
      await admin.getByRole("button", { name: "Passkey" }).click();
      await expect(rail(admin, ATTENTION_LINK)).toBeVisible();
      await admin.goto("/account");
      await expect(admin.getByRole("region", { name: "Passkeys" }).getByText(/last used/)).toBeVisible();
      await devtools.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await devtools.detach();
    });

    test("the admin adds this machine as a host and its runner joins with the code from the install command", async () => {
      const joinCode = await makeInstallCommand("e2e-host");

      // The fixture hosts and their runners come later: they are other hosts, whose reboots are no incident here.
      const protectedContainers = [
        process.env.E2E_EXISTING_CONTAINERS,
        CONTROL_PLANE_CONTAINER,
        RUNNER,
        FIXTURE_HOST,
        PACKAGE_RUNNER,
        FEDORA_HOST,
        FEDORA_RUNNER,
      ]
        .filter(Boolean)
        .join(",");
      docker(
        "run",
        "-d",
        "--name",
        RUNNER,
        "--label",
        E2E_LABEL,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--tmpfs",
        "/tmp:size=8m",
        "--network",
        E2E_NETWORK,
        "--add-host",
        "ollama:host-gateway",
        // The update scenario's registry joins this container's network; Docker reaches it here.
        "-p",
        `127.0.0.1:${E2E_REGISTRY_PORT}:${E2E_REGISTRY_PORT}`,
        "--group-add",
        String(statSync("/var/run/docker.sock").gid),
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        "/:/host/root:ro",
        // No CA file and no Ollama address: the join code names the control plane's key, and the
        // control plane says where Ollama is.
        "-e",
        `AUTOHEAL_JOIN=${joinCode}`,
        "-e",
        `AUTOHEAL_CONTAINER_NAME=${RUNNER}`,
        "-e",
        "DRY_RUN=0",
        // No CONTAINER_ACCESS: shells, files and settings are open to its admins unless a host's .env says off.
        "-e",
        `PROTECTED_CONTAINERS=${protectedContainers}`,
        E2E_IMAGE,
        "runner",
      );
      await expect(admin.getByText("e2e-host is connected.")).toBeVisible({ timeout: SLOW });
      await expect(admin.getByRole("article", { name: "e2e-host" })).toContainText("online");
    });

    test("a failing container waits on Attention, is restarted from there, and is back when the restart does not hold", async () => {
      docker("run", "-d", "--name", VICTIM, "--label", E2E_LABEL, E2E_IMAGE, "check-config", "runner");
      const startedBefore = docker("inspect", "-f", "{{.State.StartedAt}}", VICTIM);

      // Ollama handed it over: Attention shows it under Decide, and the board in Needs you.
      await rail(admin, ATTENTION_LINK).click();
      const card = admin.getByRole("article", { name: VICTIM });
      await reloadUntil(admin, () => expect(card).toBeVisible());
      await expect(card).toContainText("Escalated");
      await expect(card).toContainText("Ollama did not find a safe fix and handed it to you.");
      await admin.getByRole("link", { name: /^See all \d+ board items?$/ }).click();
      await expect(admin.getByRole("region", { name: "Needs you" })).toContainText(VICTIM);
      await rail(admin, ATTENTION_LINK).click();
      await card.getByRole("button", { name: "Restart it" }).click();

      await rail(admin, "Activity").click();
      await admin.getByRole("link", { name: VICTIM }).first().click();
      await expect(admin.getByText(DIAGNOSIS, { exact: true })).toBeVisible();
      const steps = admin.getByRole("region", { name: "What happened, step by step" });
      await expect(steps).toContainText("admin chose: restart");
      // What the model thought before it answered, as Ollama streamed it, folded until asked for.
      await steps.getByRole("button", { name: "See how the model reasoned" }).click();
      await expect(steps.getByText("The logs show…", { exact: true })).toBeVisible();
      // The victim fails again at once: the runner restarted it, watched it stop again, and handed it back.
      const didNotHold = `Restarted ${VICTIM}, but it stopped again (exit 1); escalating.`;
      await reloadUntil(admin, () => expect(steps).toContainText(didNotHold));
      await expect(admin.locator(".incident-state")).toContainText("Escalated");
      // The report: every log line the runner sent, and each step on record.
      await steps.getByRole("button", { name: "Read the whole report" }).click();
      await expect(steps.locator("pre.log", { hasText: "OLLAMA_URL: set AUTOHEAL_JOIN" }).first()).toBeVisible();
      for (const step of [
        "reported",
        "prompt built",
        "model answered",
        "decided",
        "outcome reported",
        "work completed",
      ]) {
        await expect(steps.locator("ul.record strong", { hasText: new RegExp(`^${step}$`) }).first()).toBeVisible();
      }
      expect(docker("inspect", "-f", "{{.State.StartedAt}}", VICTIM)).not.toBe(startedBefore);
    });

    test("the containers and the host's one page show what the runner sees", async () => {
      await admin.goto("/containers");
      await admin.getByLabel("Search name, image, compose project or host").fill(VICTIM);
      const row = admin.getByRole("row", { name: new RegExp(VICTIM) });
      await expect(row).toContainText("crashed");
      await expect(row).toContainText("e2e-host");
      await admin.getByLabel("Only what needs attention").check();
      await expect(admin).toHaveURL(/problems=true/);
      await expect(row).toBeVisible();

      await row.getByRole("link", { name: "e2e-host" }).click();
      await expect(admin.getByRole("heading", { name: "e2e-host", exact: true, level: 1 })).toBeVisible();
      // The host at a glance, as the runner reads it from this machine.
      const system = admin.getByRole("region", { name: "System information" });
      await expect(system).toContainText(hostname());
      await expect(system).toContainText(`Linux ${release()} · ${machine()}`);
      await expect(system).toContainText(cpus()[0]!.model);
      // Its address on its way out, and its cores' temperatures.
      await expect(system).toContainText(new RegExp(`${hostname()} \\(\\d+\\.\\d+\\.\\d+\\.\\d+\\)`));
      await expect(system).toContainText(/Core 1 · \d+/);
      const incidents = admin.locator("section", { has: admin.getByRole("heading", { name: "Recent incidents" }) });
      await expect(incidents.getByRole("link", { name: VICTIM }).first()).toBeVisible();

      // Live stats, every 5 s since the runner started: the host's dials, then one container's own.
      await expect(admin.getByRole("img", { name: /^CPU: [\d.]+% busy$/ })).toBeVisible();
      await expect(admin.getByRole("img", { name: /^Memory: [\d.]+% used$/ })).toBeVisible();
      // This machine has more containers than the list shows at first: found by name.
      const find = admin.getByRole("searchbox", { name: "Find" });
      await find.fill(CONTROL_PLANE_CONTAINER);
      await admin.getByRole("button", { name: CONTROL_PLANE_CONTAINER, exact: true }).click();
      await expect(admin).toHaveURL(new RegExp(`container=${CONTROL_PLANE_CONTAINER}`));
      const inspector = admin.getByRole("region", { name: CONTROL_PLANE_CONTAINER });
      await expect(inspector.getByRole("img", { name: /^CPU: [\d.]+% of host$/ })).toBeVisible();
      await expect(inspector.getByRole("img", { name: /^Memory: [\d.]+% of host$/ })).toBeVisible();
      // Protected on its host: from here, only its logs, and why.
      await expect(inspector.getByText(/^Protected on e2e-host: Autoheal never changes it/)).toBeVisible();
      await expect(inspector.getByRole("button", { name: "Restart" })).toHaveCount(0);
      await expect(inspector.getByRole("button", { name: "Logs" })).toBeVisible();
      expect(await cspViolations(admin)).toEqual([]);
      // A second click on the same container closes its stats.
      await admin.getByRole("button", { name: CONTROL_PLANE_CONTAINER, exact: true }).click();
      await expect(inspector).toHaveCount(0);
      const controlPlaneRow = admin.getByRole("row", { name: new RegExp(CONTROL_PLANE_CONTAINER) });
      await expect(controlPlaneRow).toContainText("Protected in this host's .env");
      // The port it publishes on this machine, as the runner reads it from Docker.
      await expect(controlPlaneRow.locator(".port")).toHaveText(String(E2E_PORT));

      // What Autoheal may do here: a host added now asks first, until someone answers for a container.
      const control = admin.getByRole("region", { name: "What Autoheal may do on e2e-host" });
      const dies = control.getByRole("radiogroup", { name: "When a container dies" });
      await expect(dies.getByRole("radio", { name: "Ask me every time" })).toBeChecked();
      await find.fill(VICTIM);
      const victimFails = admin.getByRole("combobox", { name: `If ${VICTIM} fails` });
      await expect(victimFails).toHaveValue("ask");
      await victimFails.selectOption("restart");
      await expect(admin.getByText("Saved")).toBeVisible();
      await admin.reload();
      await expect(victimFails).toHaveValue("restart");

      await admin.goto("/home");
      await expect(admin.getByText(/Home Assistant is not set up yet/)).toBeVisible();
      // Its restart did not hold, so it waits for a person again.
      await rail(admin, ATTENTION_LINK).click();
      await expect(admin.getByRole("article", { name: VICTIM })).toBeVisible();
    });

    test("a failing container's incident is a task too, which the admin works by hand", async () => {
      await admin.goto("/tasks");
      const task = admin.getByRole("button", { name: new RegExp(`${VICTIM} stopped on e2e-host`) });
      await reloadUntil(admin, () => expect(task).toBeVisible());
      await task.click();
      const panel = admin.getByRole("region", { name: new RegExp(`${VICTIM} stopped on e2e-host`) });
      await expect(panel.getByRole("link", { name: "The incident" })).toBeVisible();
      await panel.getByLabel("Comment", { exact: true }).fill("The configuration is broken on purpose: a test.");
      await panel.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(panel.getByText("The configuration is broken on purpose: a test.")).toBeVisible();
      await panel.getByLabel(STATUS_FIELD).selectOption("done");
      await expect(panel.getByLabel(STATUS_FIELD)).toHaveValue("done");
    });

    test("a newer image waits under Updates on Attention, and goes in from there, one at a time", async () => {
      // Each release names its version and source as builds do, in the standard OCI labels.
      const build = (version: string, tag: string) =>
        execFileSync("docker", ["build", "-q", "-t", tag, "-"], {
          input:
            `FROM alpine:3.20\nLABEL ${E2E_LABEL} autoheal.e2e.version=${version} ` +
            `org.opencontainers.image.version=1.${version}.0 org.opencontainers.image.source=${E2E_APP_SOURCE}\n` +
            `CMD ["sleep", "86400"]\n`,
          encoding: "utf8",
        });
      docker(
        "run",
        "-d",
        "--name",
        E2E_REGISTRY_CONTAINER,
        "--label",
        E2E_LABEL,
        "--network",
        `container:${RUNNER}`,
        "-e",
        `REGISTRY_HTTP_ADDR=0.0.0.0:${E2E_REGISTRY_PORT}`,
        "registry:2",
      );
      await expect
        .poll(() =>
          fetch(`http://localhost:${E2E_REGISTRY_PORT}/v2/`).then(
            (response) => response.status,
            () => 0,
          ),
        )
        .toBe(200);
      build("1", E2E_APP_IMAGE);
      docker("push", "-q", E2E_APP_IMAGE);
      docker("run", "-d", "--name", E2E_APP, "--label", "homepage.href=https://app.e2e.test", E2E_APP_IMAGE);
      // A release: the registry's tag moves to a newer image, and this machine still has the old one.
      build("2", E2E_APP_NEXT_IMAGE);
      docker("push", "-q", E2E_APP_NEXT_IMAGE);
      const manifests = `http://localhost:${E2E_REGISTRY_PORT}/v2/${E2E_APP}/manifests`;
      const newer = await fetch(`${manifests}/next`, { headers: { accept: REGISTRY.manifestTypes.join(", ") } });
      const released = await fetch(`${manifests}/stable`, {
        method: "PUT",
        headers: { "content-type": newer.headers.get("content-type")! },
        body: await newer.arrayBuffer(),
      });
      expect(released.status).toBe(201);

      await openHost("e2e-host");
      await admin.getByRole("button", { name: "Check images" }).click();
      const images = admin.getByRole("region", { name: "Container images" });
      await expect(images.getByRole("checkbox", { name: `Update ${E2E_APP}` })).toBeVisible({ timeout: SLOW });
      // What it brings, as both images say, and where to read what changed.
      const waiting = images.getByRole("listitem").filter({ hasText: E2E_APP });
      await expect(waiting).toContainText("1.1.0 → 1.2.0");
      await expect(waiting.getByRole("link", { name: "release notes" })).toHaveAttribute(
        "href",
        `${E2E_APP_SOURCE}/releases`,
      );

      // Its task follows, and Attention lists it under Updates with the way to apply it.
      await rail(admin, ATTENTION_LINK).click();
      const tick = admin.getByRole("checkbox", { name: `Update ${E2E_APP}` });
      await reloadUntil(admin, () => expect(tick).toBeVisible());
      const group = admin.locator("details.update-group", { has: tick });
      await tickOnly(group, `Update ${E2E_APP}`);
      await group.getByRole("button", { name: "Update 1 container now" }).click();
      const impact = admin.getByRole("dialog", { name: /^Review update .*impact$/ });
      const confirm = impact.getByRole("button", { name: "Confirm reviewed operation", exact: true });
      await expect(confirm).toBeEnabled({ timeout: SLOW });
      await confirm.click();

      // The host's page says how the run went. It ends once the new container has proved itself, and only then
      // is the image it replaced kept under a name of its own.
      await openHost("e2e-host");
      await expect(images).toContainText("Updated 1 container.", { timeout: SLOW });
      const kept = `${E2E_APP_IMAGE}-autoheal-previous`;
      expect(docker("inspect", "-f", '{{index .Config.Labels "autoheal.e2e.version"}}', E2E_APP)).toBe("2");
      expect(docker("inspect", "-f", '{{index .Config.Labels "homepage.href"}}', E2E_APP)).toBe("https://app.e2e.test");
      expect(docker("image", "inspect", "-f", '{{index .Config.Labels "autoheal.e2e.version"}}', kept)).toBe("1");
      expect(docker("ps", "-aq", "--filter", `name=^${E2E_APP}-autoheal-old$`)).toBe("");
      // And the update closed its task.
      const openUpdates = await admin.evaluate(
        async (url) => ((await (await fetch(url)).json()) as unknown[]).length,
        `${API_ROUTES.tasks}?${new URLSearchParams({
          [TASK_QUERY.status]: TASK_FILTERS.open,
          [TASK_QUERY.search]: `Update ${E2E_APP}`,
        })}`,
      );
      expect(openUpdates).toBe(0);
    });

    // Only its own image: this Docker is the machine's, and the list shows every project's unused images.
    test("what an update left behind: its image listed and removed from its row, its old container never a task", async () => {
      const kept = `${E2E_APP_IMAGE}-autoheal-previous`;
      await openHost("e2e-host");
      const images = admin.getByRole("region", { name: "Old images" });
      const remove = images.getByRole("button", { name: `Remove ${kept}` });
      // The list follows the runner's reports by itself: a reload would only start its loading over.
      await expect(remove).toBeVisible({ timeout: SLOW });
      // The row's own button: a filter's locator is looked for inside each row.
      const row = images.getByRole("row").filter({ has: admin.getByRole("button", { name: `Remove ${kept}` }) });
      await expect(row.getByText("kept for going back to it by hand", { exact: false })).toBeVisible();

      admin.once("dialog", (dialog) => void dialog.accept());
      await remove.click();
      await expect(images.getByText(/^Removed 1 image \(\d+ MB\)\.$/)).toBeVisible({ timeout: SLOW });
      await expect(remove).toHaveCount(0, { timeout: SLOW });
      expect(spawnSync("docker", ["image", "inspect", kept]).status).not.toBe(0);

      // The old container the update kept aside for a while never had a task of its own, open or closed.
      const parkedTasks = (status: string) =>
        admin.evaluate(
          async (url) => ((await (await fetch(url)).json()) as unknown[]).length,
          `${API_ROUTES.tasks}?${new URLSearchParams({
            [TASK_QUERY.status]: status,
            [TASK_QUERY.search]: `${E2E_APP}${OLD_CONTAINER_SUFFIX}`,
          })}`,
        );
      expect(await parkedTasks(TASK_FILTERS.open)).toBe(0);
      expect(await parkedTasks(TASK_FILTERS.closed)).toBe(0);
    });

    test("ticks containers on the host's page and acts on them at once: a stop, then a removal, a running one too", async () => {
      const running = `${BULK_PREFIX}running`;
      const stopped = `${BULK_PREFIX}stopped`;
      docker("run", "-d", "--init", "--name", running, "--label", E2E_LABEL, "alpine:3.20", "sleep", "86400");
      docker("run", "--name", stopped, "--label", E2E_LABEL, "alpine:3.20", "true");
      await openHost("e2e-host");
      await admin.getByRole("searchbox", { name: "Find" }).fill(BULK_PREFIX);
      // The runner reports new containers within seconds.
      await expect(admin.getByRole("checkbox", { name: `Tick ${stopped}` })).toBeVisible({ timeout: SLOW });
      await admin.getByRole("checkbox", { name: "Tick every container shown" }).check();
      const bar = admin.getByRole("group", { name: "Act on the ticked containers" });
      await expect(bar).toContainText("2 ticked");

      // A row's own buttons pause it, and let it go on.
      await admin.getByRole("button", { name: `Pause ${running}` }).click();
      await expect.poll(() => docker("inspect", "-f", "{{.State.Paused}}", running), { timeout: SLOW }).toBe("true");
      await admin.getByRole("button", { name: `Unpause ${running}` }).click();
      await expect.poll(() => docker("inspect", "-f", "{{.State.Paused}}", running), { timeout: SLOW }).toBe("false");

      // A stop reaches only the running one, at once: nothing asks again.
      await bar.getByRole("button", { name: "Stop 1" }).click();
      await expect(bar).toContainText("Stop: 1 of 1 done.", { timeout: SLOW });
      expect(docker("inspect", "-f", "{{.State.Running}}", running)).toBe("false");
      // Running again, it is removed with the stopped one all the same, stopped first; nothing of them is left.
      docker("start", running);
      const remove = bar.getByRole("button", { name: "Remove 2" });
      await expect(remove).toBeVisible({ timeout: SLOW });
      await remove.click();
      await expect(bar).toContainText("Remove: 2 of 2 done.", { timeout: SLOW });
      expect(docker("ps", "-aq", "--filter", `name=^${BULK_PREFIX}`)).toBe("");
    });

    test("opens a shell in a container from its row at once, and types into it", async () => {
      docker("run", "-d", "--init", "--name", SHELL_CONTAINER, "--label", E2E_LABEL, "alpine:3.20", "sleep", "86400");
      await openHost("e2e-host");
      await admin.getByRole("searchbox", { name: "Find" }).fill(SHELL_CONTAINER);
      const open = admin.getByRole("button", { name: `Shell in ${SHELL_CONTAINER}` });
      await expect(open).toBeEnabled({ timeout: SLOW });
      await open.click();

      const shell = admin.getByRole("region", { name: `Shell in ${SHELL_CONTAINER}` });
      await expect(shell.getByRole("status")).toHaveText("Connected", { timeout: SLOW });
      // Typed as a person types, into the terminal: the shell runs it in the container.
      await shell.locator(".terminal-screen").click();
      await admin.keyboard.type("echo autoheal-$((6 * 7)) > /tmp/proof\n");
      await expect
        .poll(() => dockerOrEmpty("exec", SHELL_CONTAINER, "cat", "/tmp/proof"), { timeout: SLOW })
        .toBe("autoheal-42");
      // Its end comes back the way its output does.
      await admin.keyboard.type("exit 3\n");
      try {
        await expect(shell.getByRole("status")).toHaveText("The shell ended with exit code 3.", { timeout: SLOW });
      } catch (error) {
        // Twice the line never seemed to arrive: say whether the shell still runs, and what the runner made of it.
        console.log(`Shell's processes: ${dockerOrEmpty("exec", SHELL_CONTAINER, "ps")}`);
        console.log(`Runner's last lines: ${dockerOrEmpty("logs", "--tail", "20", RUNNER)}`);
        throw error;
      }
      await shell.getByRole("button", { name: "Close" }).click();
      await expect(shell).toHaveCount(0);
      docker("rm", "-f", SHELL_CONTAINER);
    });

    test("browses a container's files from its row: edits one keeping its owner, makes, uploads, downloads, renames, removes", async () => {
      docker(
        "run",
        "-d",
        "--init",
        "--name",
        FILES_CONTAINER,
        "--label",
        E2E_LABEL,
        "alpine:3.20",
        "sh",
        "-c",
        "mkdir -p /srv && echo hello > /srv/greeting.txt && chown 1000:1000 /srv/greeting.txt && ln -s /srv /shared && exec sleep 86400",
      );
      const inContainer = (...command: string[]) => docker("exec", FILES_CONTAINER, ...command);
      await openHost("e2e-host");
      await admin.getByRole("searchbox", { name: "Find" }).fill(FILES_CONTAINER);
      const open = admin.getByRole("button", { name: `Files of ${FILES_CONTAINER}` });
      await expect(open).toBeEnabled({ timeout: SLOW });
      // The code given for the shell a moment ago still holds for this sign-in.
      await open.click();
      const files = admin.getByRole("region", { name: `Files of ${FILES_CONTAINER}` });
      // A link to a folder is walked into, as the folder it leads to.
      await expect(files.getByText("→ /srv")).toBeVisible();
      await files.getByRole("button", { name: "shared", exact: true }).click();
      await expect(files.getByRole("button", { name: "greeting.txt", exact: true })).toBeVisible();
      await files.getByRole("button", { name: "Up" }).click();
      await files.getByRole("button", { name: "srv", exact: true }).click();
      await files.getByRole("button", { name: "greeting.txt", exact: true }).click();

      const text = files.getByRole("textbox", { name: "/srv/greeting.txt" });
      await expect(text).toHaveValue("hello\n");
      await text.fill("bonjour\n");
      await files.getByRole("button", { name: "Save" }).click();
      await expect(files.getByText("Saved")).toBeVisible();
      expect(inContainer("cat", "/srv/greeting.txt")).toBe("bonjour");
      expect(inContainer("stat", "-c", "%u:%g %a", "/srv/greeting.txt")).toBe("1000:1000 644");

      admin.once("dialog", (dialog) => void dialog.accept("notes"));
      await files.getByRole("button", { name: "New folder" }).click();
      await expect(files.getByRole("button", { name: "notes", exact: true })).toBeVisible();
      await files
        .getByLabel("Upload")
        .setInputFiles({ name: "upload.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded") });
      await expect(files.getByRole("button", { name: "upload.txt", exact: true })).toBeVisible();
      expect(inContainer("cat", "/srv/upload.txt")).toBe("uploaded");
      const downloading = admin.waitForEvent("download");
      await files.getByRole("button", { name: "Download upload.txt" }).click();
      const saved = await downloading;
      expect(saved.suggestedFilename()).toBe("upload.txt");
      expect(readFileSync((await saved.path())!, "utf8")).toBe("uploaded");

      admin.once("dialog", (dialog) => void dialog.accept("hi.txt"));
      await files.getByRole("button", { name: "Rename greeting.txt" }).click();
      await expect(files.getByRole("button", { name: "hi.txt", exact: true })).toBeVisible();
      admin.once("dialog", (dialog) => void dialog.accept());
      await files.getByRole("button", { name: "Remove hi.txt" }).click();
      await expect(files.getByRole("button", { name: "hi.txt", exact: true })).toHaveCount(0);
      expect(inContainer("ls", "/srv")).toBe("notes\nupload.txt");
      await files.getByRole("button", { name: "Close" }).first().click();
      docker("rm", "-f", FILES_CONTAINER);
    });

    test("changes a container's settings from its row by recreating it: its environment and a published port", async () => {
      docker(
        "run",
        "-d",
        "--init",
        "--name",
        SETTINGS_CONTAINER,
        "--label",
        E2E_LABEL,
        "-e",
        "GREETING=hello",
        "alpine:3.20",
        "sleep",
        "86400",
      );
      await openHost("e2e-host");
      await admin.getByRole("searchbox", { name: "Find" }).fill(SETTINGS_CONTAINER);
      const open = admin.getByRole("button", { name: `Settings of ${SETTINGS_CONTAINER}` });
      await expect(open).toBeEnabled({ timeout: SLOW });
      await open.click();

      // Its own environment, not the image's PATH, as the runner read it.
      const settings = admin.getByRole("region", { name: `Settings of ${SETTINGS_CONTAINER}` });
      const greeting = settings.getByLabel("Environment Value 1");
      await expect(greeting).toHaveValue("hello");
      await expect(settings.getByLabel("Environment Name 2")).toHaveCount(0);
      await greeting.fill("bonjour");
      await settings.getByRole("button", { name: "Add" }).nth(1).click();
      await settings.getByLabel("Host port 1").fill(String(SETTINGS_PORT));
      await settings.getByLabel("Host address 1").fill("127.0.0.1");
      admin.once("dialog", (dialog) => void dialog.accept());
      await settings.getByRole("button", { name: "Apply" }).click();

      await expect(settings.getByText(`Changed the settings of ${SETTINGS_CONTAINER}, and it is running.`)).toBeVisible(
        {
          timeout: SLOW,
        },
      );
      const environment = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", SETTINGS_CONTAINER);
      expect(environment).toContain("GREETING=bonjour");
      expect(docker("port", SETTINGS_CONTAINER)).toBe(`80/tcp -> 127.0.0.1:${SETTINGS_PORT}`);
      expect(docker("ps", "-aq", "--filter", `name=^${SETTINGS_CONTAINER}-autoheal-old$`)).toBe("");
      docker("rm", "-f", SETTINGS_CONTAINER);
    });

    /** A second runner on this Docker, joined from the dashboard, with the fixture host as its host. */
    async function joinPackageRunner(label: string, runnerName: string, fixture: FixtureHost) {
      // Runner safety journals are engine-scoped: exercise fixture hosts serially, never as concurrent runners.
      for (const other of [RUNNER, PACKAGE_RUNNER, FEDORA_RUNNER]) {
        if (other !== runnerName && dockerOrEmpty("inspect", "-f", "{{.State.Running}}", other) === "true")
          docker("stop", other);
      }
      const joinCode = await makeInstallCommand(label);
      const everythingHere = docker("ps", "-a", "--format", "{{.Names}}").split("\n").filter(Boolean);
      const dbus = join(fixture.shared, "dbus");
      docker(
        "run",
        "-d",
        "--name",
        runnerName,
        "--label",
        E2E_LABEL,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--tmpfs",
        "/tmp:size=8m",
        "--network",
        E2E_NETWORK,
        "--group-add",
        String(statSync("/var/run/docker.sock").gid),
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${fixture.root}:/host/root:ro`,
        "-v",
        `${dbus}:/host/root/run/dbus:ro`,
        "-v",
        `${join(fixture.shared, "logs")}:/host/root/var/log/autoheal:ro`,
        "-e",
        `AUTOHEAL_JOIN=${joinCode}`,
        "-e",
        `AUTOHEAL_CONTAINER_NAME=${runnerName}`,
        "-e",
        "DRY_RUN=0",
        "-e",
        "HOST_PACKAGES=apply",
        "-e",
        `HOST_DBUS_DIRECTORY=${dbus}`,
        // Another runner on this Docker: it must never heal what the first one looks after.
        "-e",
        `PROTECTED_CONTAINERS=${[...everythingHere, runnerName].join(",")}`,
        E2E_IMAGE,
        "runner",
      );
      await expect(admin.getByText(`${label} is connected.`)).toBeVisible({ timeout: SLOW });
    }

    test("a host's OS updates: checked, a security fix installed and dpkg repaired from the dashboard, then rebooted", async () => {
      test.setTimeout(10 * 60_000);
      // Tonight's window is moved away from now, so Autoheal's own nightly pass stays out of this.
      const londonHour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "numeric", hourCycle: "h23" }).format(
          new Date(),
        ),
      );
      const hourAway = (offset: number) => `${String((londonHour + offset) % 24).padStart(2, "0")}:00`;
      await rail(admin, "Settings").click();
      const window = admin.getByRole("region", { name: "Host package window" });
      await window.getByRole("checkbox", { name: /^Install security fixes on their own/ }).uncheck();
      await expect(window.getByText("Saved")).toBeVisible();
      // A time is saved once its field is left.
      await window.getByLabel("From").fill(hourAway(6));
      await window.getByLabel("From").blur();
      await window.getByLabel("To", { exact: true }).fill(hourAway(7));
      await window.getByLabel("To", { exact: true }).blur();
      await expect(async () => {
        await admin.reload();
        await expect(window.getByLabel("From")).toHaveValue(hourAway(6));
        await expect(window.getByLabel("To", { exact: true })).toHaveValue(hourAway(7));
      }).toPass({ timeout: 10_000 });

      const fixture = await startFixtureHost(FIXTURE_HOST, FIXTURE_HOST_IMAGE, "test/fixtures/host-packages", {
        "usr/bin/apt-get": "",
        "etc/timezone": "Europe/Lisbon\n",
        "etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\n',
      });
      await joinPackageRunner("fixture-host", PACKAGE_RUNNER, fixture);

      await openHost("fixture-host");
      const card = admin.getByRole("region", { name: "Host packages" });
      await expect(card).toContainText("Every update here waits for you.");

      // Its first check comes by itself, as soon as its .env allows one. Listed as drawn: a tick, the name and
      // what it is, a security fix marked; its name opens its details.
      const security = packageRow(card, "autoheal-security");
      await expect(security).toBeVisible({ timeout: SLOW });
      await expect(security).toContainText("security");
      // The system information's package updates line leads straight to them.
      await admin.getByRole("link", { name: "5 available, 1 of them security" }).click();
      await expect(admin).toHaveURL(/#updates$/);
      await expect(card).toBeInViewport();
      await security.getByRole("button", { name: "autoheal-security" }).click();
      await expect(security).toContainText("Autoheal test package");
      await expect(security).toContainText("New version 1.1");
      await expect(security.getByText("Stable-security")).toHaveClass("security-source");
      await packageRow(card, "containerd.io").getByRole("button", { name: "containerd.io" }).click();
      await expect(packageRow(card, "containerd.io")).toContainText("container runtime");
      await packageRow(card, "autoheal-vendor").getByRole("button", { name: "autoheal-vendor" }).click();
      await expect(packageRow(card, "autoheal-vendor")).toContainText("other repository");
      await expect(packageRow(card, "autoheal-vendor")).toContainText("Vendor");
      await expect(card).toContainText("Not offered yet (1)");
      // What ran here, and how long this release gets security fixes.
      await card.getByRole("button", { name: "What changed this week" }).click();
      await expect(card).toContainText(/Check packages\s*for Autoheal/);
      await expect(card).toContainText(/Debian 13 gets security fixes until .*2030\./);

      // Every update starts ticked: only the security fix this time.
      await tickOnly(card, "Select autoheal-security");
      await card.getByRole("button", { name: "Install now" }).click();
      // As a terminal shows it: what it updates, the command, and apt's output while it still runs, as the
      // fix takes a few seconds to set up.
      const terminal = card.getByRole("group", { name: "What the host is doing" });
      await expect(terminal).toContainText("Now updating autoheal-security ..");
      await expect(terminal).toContainText(
        /Installing package\(s\) with command \/usr\/bin\/apt-get .* autoheal-security \.\./,
      );
      await expect
        .poll(
          async () => {
            const shown = (await terminal.textContent()) ?? "";
            return shown.includes("autoheal-security: setting up, slowly") && !shown.includes("install complete");
          },
          { timeout: SLOW },
        )
        .toBe(true);
      await expect(terminal).toContainText(".. install complete Upgraded autoheal-security.", { timeout: SLOW });
      expect(docker("exec", FIXTURE_HOST, "dpkg-query", "-W", "-f", "${Version}", "autoheal-security")).toBe("1.1");
      // Checked again by itself: what was installed is no longer pending.
      await expect(terminal).toContainText("Re-fetching available packages .. done", { timeout: SLOW });
      await terminal.getByRole("button", { name: "Return to package list" }).click();
      await expect(packageRow(card, "autoheal-security")).toHaveCount(0);

      // A package the rules hold for a person (another repository's), dragged on Attention onto the Ollama agent:
      // installed now, whatever held it.
      await rail(admin, ATTENTION_LINK).click();
      // The first host's updates are open by themselves, the others closed; this one may be either, as this machine's
      // own containers may have updates waiting too (e2e-host is this machine).
      const fixtureUpdates = admin.locator("details.update-group").filter({ hasText: "fixture-host" });
      await reloadUntil(admin, () => expect(fixtureUpdates).toBeVisible());
      if ((await fixtureUpdates.getAttribute("open")) === null) {
        await fixtureUpdates.locator("summary").click();
      }
      const vendor = fixtureUpdates
        .getByRole("listitem")
        .filter({ has: admin.getByRole("checkbox", { name: "Update autoheal-vendor" }) });
      await expect(vendor).toBeVisible();
      await expect(admin.getByText("Drag & drop active")).toBeVisible();
      // As a hand does it: a little way first, and the agent's card, far up the page, stays in sight while it drags.
      await vendor.hover();
      await admin.mouse.down();
      const from = (await vendor.boundingBox())!;
      await admin.mouse.move(from.x + from.width / 2, from.y - 10, { steps: 5 });
      const agent = admin.getByRole("link", { name: /Ollama Agent/ });
      await expect(agent).toBeInViewport();
      const to = (await agent.boundingBox())!;
      await admin.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
      await admin.mouse.up();
      await expect(admin.getByText("Handed 1 item to Ollama.")).toBeVisible();
      await expect
        .poll(() => docker("exec", FIXTURE_HOST, "dpkg-query", "-W", "-f", "${Version}", "autoheal-vendor"), {
          timeout: SLOW,
        })
        .toBe("1.1");
      // Its run ends, and the host's next check no longer offers it.
      await expect
        .poll(
          () =>
            admin.evaluate(
              async ({ hosts, packages }) => {
                const host = ((await (await fetch(hosts)).json()) as HostView[]).find(
                  (candidate) => candidate.label === "fixture-host",
                )!;
                const view = (await (await fetch(packages.replace(":hostId", host.id))).json()) as HostPackagesView;
                return view.running === null && view.packages.every(({ name }) => name !== "autoheal-vendor");
              },
              { hosts: API_ROUTES.hosts, packages: API_ROUTES.hostPackages },
            ),
          { timeout: SLOW },
        )
        .toBe(true);
      await openHost("fixture-host");

      // What nothing needs any more, named, then removed from the card.
      await card.getByText(/^No longer needed \(1\)/).click();
      admin.once("dialog", (dialog) => void dialog.accept());
      await card.getByRole("button", { name: "Remove unused (1)" }).click();
      await expect(terminal).toContainText(".. removal complete Removed the packages nothing needed any more.", {
        timeout: SLOW,
      });
      await expect(terminal).toContainText("Re-fetching available packages .. done", { timeout: SLOW });
      await terminal.getByRole("button", { name: "Return to package list" }).click();
      const orphan = spawnSync(
        "docker",
        ["exec", FIXTURE_HOST, "dpkg-query", "-W", "-f", "${db:Status-Status}", "autoheal-orphan"],
        {
          encoding: "utf8",
        },
      );
      expect(orphan.stdout).not.toBe("installed");
      await expect(card.getByRole("button", { name: /Remove unused/ })).toHaveCount(0, { timeout: SLOW });

      // An interrupted dpkg, found by the next check and repaired from the card.
      docker("exec", FIXTURE_HOST, "dpkg", "--unpack", "/srv/old/autoheal-half-done_1.0_all.deb");
      await admin.getByRole("button", { name: "Check packages" }).click();
      await expect(card).toContainText("dpkg was left half-done", { timeout: SLOW });
      await card.getByRole("button", { name: "Repair dpkg" }).click();
      await expect(terminal).toContainText("Now finishing what dpkg left half-done ..");
      await expect(terminal).toContainText(".. repair complete Finished what dpkg had left half-done.", {
        timeout: SLOW,
      });
      expect(docker("exec", FIXTURE_HOST, "dpkg", "--audit")).toBe("");
      await terminal.getByRole("button", { name: "Return to package list" }).click();

      // A reboot the host waits for: a warning where the page starts, asked again, and the host goes down.
      writeFileSync(join(fixture.root, "run/reboot-required"), "*** System restart required ***\n");
      writeFileSync(join(fixture.root, "run/reboot-required.pkgs"), "autoheal-routine\n");
      const warning = admin.getByRole("status").filter({ hasText: "Warning! Recent package updates" });
      await reloadUntil(admin, () => expect(warning).toContainText("It waits for autoheal-routine."));
      // As a Proxmox VE node in the middle of a backup, it waits, and says why.
      const backups = (answer: string) =>
        docker("exec", FIXTURE_HOST, "sh", "-c", `printf '%s' '${answer}' > ${BACKUPS_FILE}`);
      docker("exec", FIXTURE_HOST, "sh", "-c", FAKE_PVESH);
      backups('[{"type":"vzdump","id":"101","status":"running"}]');
      admin.once("dialog", (dialog) => void dialog.accept());
      await warning.getByRole("button", { name: "Reboot now" }).click();
      await expect(warning).toContainText("Not rebooting: a Proxmox backup is running on this node.", {
        timeout: SLOW,
      });
      expect(docker("inspect", "-f", "{{.State.Running}}", FIXTURE_HOST)).toBe("true");
      backups("[]");
      admin.once("dialog", (dialog) => void dialog.accept());
      await warning.getByRole("button", { name: "Reboot now" }).click();
      await expect(warning).toContainText("Rebooting the host now.", { timeout: SLOW });
      await expect
        .poll(() => docker("inspect", "-f", "{{.State.Running}}", FIXTURE_HOST), { timeout: 60_000 })
        .toBe("false");
      expect(await cspViolations(admin)).toEqual([]);
      await settleFixtureRunner("fixture-host", PACKAGE_RUNNER);
      removeFixtureFiles(fixture);
    });

    test("a Fedora host's updates through dnf: its advisory's security fix, then what nothing needs removed", async () => {
      test.setTimeout(15 * 60_000);
      const fixture = await startFixtureHost(FEDORA_HOST, FEDORA_HOST_IMAGE, "test/fixtures/host-packages-fedora", {
        "usr/bin/dnf": "",
        "etc/timezone": "Europe/Lisbon\n",
        "etc/os-release": 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=42\n',
      });
      await joinPackageRunner("fedora-host", FEDORA_RUNNER, fixture);

      await openHost("fedora-host");
      const card = admin.getByRole("region", { name: "Host packages" });
      await expect(card).toContainText("Fedora 42 gets no security fixes any more: move to a newer release.");
      // Its first check comes by itself.
      const security = packageRow(card, "autoheal-security");
      await expect(security).toContainText("security", { timeout: SLOW });
      await expect(security).toContainText("Autoheal test package");
      await security.getByRole("button", { name: "autoheal-security" }).click();
      await expect(security.getByText("Updates")).toHaveClass("security-source");
      await packageRow(card, "autoheal-routine").getByRole("button", { name: "autoheal-routine" }).click();
      await expect(packageRow(card, "autoheal-routine")).toContainText("routine");
      await packageRow(card, "autoheal-vendor").getByRole("button", { name: "autoheal-vendor" }).click();
      await expect(packageRow(card, "autoheal-vendor")).toContainText("other repository");
      await expect(card).toContainText("No longer needed (1)");
      await expect(card.getByRole("button", { name: "Repair dpkg" })).toHaveCount(0);

      await tickOnly(card, "Select autoheal-security");
      await card.getByRole("button", { name: "Install now" }).click();
      const terminal = card.getByRole("group", { name: "What the host is doing" });
      await expect(terminal).toContainText(
        /Installing package\(s\) with command \/usr\/bin\/dnf -y upgrade autoheal-security \.\./,
      );
      await expect(terminal).toContainText(".. install complete Upgraded autoheal-security.", { timeout: SLOW });
      expect(docker("exec", FEDORA_HOST, "rpm", "-q", "--qf", "%{VERSION}", "autoheal-security")).toBe("1.1");
      await expect(terminal).toContainText("Re-fetching available packages .. done", { timeout: SLOW });
      await terminal.getByRole("button", { name: "Return to package list" }).click();
      await expect(packageRow(card, "autoheal-security")).toHaveCount(0);

      await card.getByText(/^No longer needed \(1\)/).click();
      admin.once("dialog", (dialog) => void dialog.accept());
      await card.getByRole("button", { name: "Remove unused (1)" }).click();
      await expect(terminal).toContainText("Removed the packages nothing needed any more.", { timeout: SLOW });
      await expect(terminal).toContainText("Re-fetching available packages .. done", { timeout: SLOW });
      expect(spawnSync("docker", ["exec", FEDORA_HOST, "rpm", "-q", "autoheal-orphan"]).status).not.toBe(0);
      await settleFixtureRunner("fedora-host", FEDORA_RUNNER);
      removeFixtureFiles(fixture);

      // Renamed where its name shows: another host's name is refused, then the new one is on every page.
      await admin.getByRole("button", { name: "Rename", exact: true }).click();
      const rename = admin.getByRole("form", { name: "Rename fedora-host" });
      await rename.getByRole("textbox", { name: "New name for fedora-host" }).fill("e2e-host");
      await rename.getByRole("button", { name: "Save" }).click();
      await expect(rename).toContainText("Another host already has that name.");
      await rename.getByRole("textbox", { name: "New name for fedora-host" }).fill("fedora-box");
      await rename.getByRole("button", { name: "Save" }).click();
      await expect(admin.getByRole("heading", { name: "fedora-box", exact: true, level: 1 })).toBeVisible();
      await openHost("fedora-box");
    });

    test("a viewer can follow everything but change nothing", async ({ browser }) => {
      for (const other of [PACKAGE_RUNNER, FEDORA_RUNNER]) {
        if (dockerOrEmpty("inspect", "-f", "{{.State.Running}}", other) === "true") docker("stop", other);
      }
      docker("start", RUNNER);
      await expect.poll(() => docker("inspect", "-f", "{{.State.Running}}", RUNNER), { timeout: 30_000 }).toBe("true");
      await expect
        .poll(
          async () => {
            const hosts = (await (await admin.request.get(API_ROUTES.hosts)).json()) as HostView[];
            const host = hosts.find((value) => value.label === "e2e-host");
            return host?.lastHeartbeatAt ?? 0;
          },
          { timeout: 60_000 },
        )
        .toBeGreaterThan(Date.now() - 30_000);
      await rail(admin, "Settings").click();
      await admin.getByRole("link", { name: "Manage people" }).click();
      await admin.getByLabel("Username").fill("partner");
      await admin.getByRole("button", { name: "Add user" }).click();
      const oneTimePassword = (await admin.locator(".notice span.secret").textContent())!.trim();

      const { context, page: viewer } = await newTrackedPage(browser);
      expect((await completeFirstSignIn(viewer, "partner", oneTimePassword, VIEWER_PASSWORD)).passphrase).toBeNull();
      await rail(viewer, "Settings").click();
      await expect(viewer.getByRole("navigation", { name: "Settings sections" }).getByRole("link")).toHaveText([
        "Connections",
        "Notifications",
        "Schedules",
        "System",
        "Your account",
      ]);
      await viewer.goto("/users");
      await expect(viewer.getByText("This page does not exist.")).toBeVisible();
      await rail(viewer, "Fleet").click();
      await viewer.getByRole("article", { name: "e2e-host", exact: true }).click();
      await expect(viewer.getByRole("heading", { name: "e2e-host", exact: true, level: 1 })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
      await rail(viewer, "Activity").click();
      await viewer.getByRole("link", { name: VICTIM }).first().click();
      await expect(viewer.getByText(DIAGNOSIS, { exact: true })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Restart it" })).toHaveCount(0);
      expect(await cspViolations(viewer)).toEqual([]);
      await context.close();
    });

    test("a draft runbook is replayed against past incidents and against one from its own page, then published", async () => {
      await rail(admin, "Rules and runbooks").click();
      await admin.getByLabel("Title").fill("Victim rule");
      await admin.getByLabel("Instructions").fill(`${RUNBOOK_MARKER}: a restart fixes ${VICTIM}.`);
      await admin.getByRole("button", { name: "Create draft" }).click();
      await expect(admin.getByRole("heading", { name: "Victim rule", level: 1 })).toBeVisible();

      await admin.getByRole("button", { name: "Replay recent incidents with this version" }).click();
      await expect(admin.getByText(/1 \/ 1 changed/)).toBeVisible({ timeout: SLOW });
      await expect(admin.getByRole("cell", { name: "escalate" })).toBeVisible();

      // The same draft against the victim's own incident, from that incident's page.
      await rail(admin, "Activity").click();
      await admin.getByRole("link", { name: VICTIM }).first().click();
      await admin.getByRole("button", { name: "Replay against a draft" }).click();
      await admin.getByRole("button", { name: "Replay with Victim rule, draft version 1" }).click();
      await expect(admin).toHaveURL(/\/replays\/[\w-]+$/);
      await expect(admin.getByText(/1 \/ 1 changed/)).toBeVisible({ timeout: SLOW });

      await rail(admin, "Rules and runbooks").click();
      await admin.getByRole("link", { name: "Victim rule" }).click();
      await admin.getByRole("button", { name: "Publish" }).click();
      await expect(admin.locator(".page-header")).toContainText("Published v1");
    });
  });

  const featureContext = (browser: Browser): FeatureUIContext => ({
    page: admin,
    browser,
    adminSecret,
    docker,
    openHost,
    freshCode,
    completeFirstSignIn,
  });
  for (const [name, verify] of [
    ["FEATURE-001 maintenance lifecycle and runner acknowledgement", verifyMaintenance],
    ["FEATURE-002 redacted diagnostic preview and download", verifyDiagnostics],
    ["FEATURE-009 scoped grant, real action and revocation", verifyPermissions],
    ["FEATURE-003 dependency/shared-data topology and navigation", verifyTopology],
    ["FEATURE-004 notification refusal, recovery, routing and acknowledgement", verifyNotifications],
    ["FEATURE-010 deterministic policy rehearsal and reviewed apply", verifyRehearsal],
    ["FEATURE-007 keyboard search and scoped results", verifySearch],
    ["FEATURE-005 application capture, drill and reviewed restore", verifyApplicationBackups],
    ["FEATURE-008 durable trend evidence and feedback", verifyTrends],
    ["FEATURE-006 immutable canary observation and promotion", verifyCanary],
  ] as const) {
    test(name, async ({ browser }) => {
      test.setTimeout(10 * 60_000);
      await verify(featureContext(browser));
      await admin.screenshot({
        path: test.info().outputPath(`${name.split(" ")[0]}.png`),
        fullPage: true,
        mask: [admin.locator(".secret, input[type=password], img.qr")],
      });
    });
  }

  test.describe.serial("backup restore and responsive navigation", () => {
    test("an uploaded backup is checked and previewed, a forged one refused", async () => {
      await rail(admin, "Settings").click();
      await admin.getByRole("link", { name: "See all backups" }).click();
      await admin.getByRole("button", { name: "Make a backup now" }).click();
      const download = admin.getByRole("link", { name: "Download" }).first();
      await expect(download).toBeVisible();
      const response = await admin.request.get((await download.getAttribute("href"))!);
      expect(response.status()).toBe(200);
      const copy = test.info().outputPath("copy.sqlite.age");
      const forged = test.info().outputPath("forged.sqlite.age");
      writeFileSync(copy, await response.body());
      writeFileSync(forged, "age-encryption.org/v1\nnot really\n");

      const fileInput = admin.getByLabel("Restore from a backup file (.sqlite.age)");
      await fileInput.setInputFiles(forged);
      await admin.getByRole("button", { name: "Check this file" }).click();
      await expect(admin.getByText("That file is not a backup made with this passphrase")).toBeVisible();

      await fileInput.setInputFiles(copy);
      await admin.getByRole("button", { name: "Check this file" }).click();
      await expect(admin.getByRole("heading", { name: "Before you restore" })).toBeVisible();
      await expect(admin.getByText("An uploaded file")).toBeVisible();
      await admin.getByRole("button", { name: "Cancel" }).click();
      await expect(admin.getByRole("heading", { name: "Before you restore" })).toHaveCount(0);
    });

    test("restoring a backup signs everyone out, and the admin signs in again", async () => {
      await rail(admin, "Settings").click();
      await admin.getByRole("link", { name: "See all backups" }).click();
      await admin.getByRole("button", { name: "Restore…" }).first().click();
      await expect(admin.getByText("Everyone is signed out")).toBeVisible();
      await admin.getByRole("button", { name: "Restore now" }).click();
      await expect(admin).toHaveURL(/\/login$/, { timeout: SLOW });

      await signIn(admin, "admin", ADMIN_PASSWORD, adminSecret);
      await rail(admin, "Activity").click();
      await expect(admin.getByRole("link", { name: VICTIM }).first()).toBeVisible();
      await admin.getByRole("link", { name: "Audit log", exact: true }).click();
      await expect(admin.getByRole("cell", { name: "backup.restore_completed" })).toBeVisible();
    });

    test("works on a phone without sideways scrolling", async () => {
      await admin.setViewportSize({ width: 390, height: 844 });
      const noSidewaysScrolling = async (where: string) => {
        await expect(admin.locator("h1")).toBeVisible();
        const { overflow, past } = await sidewaysOverflow(admin);
        expect(overflow, `${where}: ${past.join(", ")}`).toBeLessThanOrEqual(0);
      };
      for (const [link, path] of [
        ["Attention", "/"],
        ["Fleet", "/hosts"],
        ["Activity", "/incidents"],
        ["Rules and runbooks", "/runbooks"],
        ["Settings", "/settings"],
      ]) {
        // A menu entry may carry a count after its name.
        await rail(admin, new RegExp(`^${link}`)).click();
        await expect(admin).toHaveURL(new RegExp(`:\\d+${path}$`));
        await noSidewaysScrolling(link);
      }
      // And the pages they lead on to.
      for (const path of [
        "/board",
        "/containers",
        "/tasks",
        "/home",
        "/audit",
        "/replays",
        "/account",
        "/users",
        "/backups",
      ]) {
        await admin.goto(path);
        await noSidewaysScrolling(path);
      }
      await openHost("e2e-host");
      await noSidewaysScrolling("e2e-host");
      await rail(admin, "Activity").click();
      await admin.getByRole("link", { name: VICTIM }).first().click();
      await expect(admin.getByRole("region", { name: "What happened, step by step" })).toBeVisible();
      await noSidewaysScrolling(VICTIM);
    });
  });
});
