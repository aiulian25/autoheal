import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { FakeOllama, answer } from "../fakes/fake-ollama.js";
import { E2E_PORT } from "../../playwright.config.js";

export const E2E_LABEL = "com.autoheal.e2e=1";
export const E2E_NETWORK = "autoheal-e2e";
const E2E_VOLUME = "autoheal-e2e-data";
const E2E_SAFETY_OWNER = "autoheal-e2e-safety-owner";
const E2E_SAFETY_LABELS = [
  "autoheal.guard.state",
  "autoheal.shutdown.journal",
  "autoheal.result.journal",
  "autoheal.rollback.journal",
  "autoheal.application-backup.journal",
] as const;
export const E2E_IMAGE = process.env.E2E_IMAGE ?? "autoheal:smoke";
// Where the engine publishes the dashboard: its own loopback, unless the engine runs in a sandbox that forwards to it.
const E2E_PUBLISH_ADDRESS = process.env.E2E_PUBLISH_ADDRESS ?? "127.0.0.1";
export const VICTIM = "autoheal-e2e-victim";
// A Debian host and a Fedora host with systemd and offline repositories, for the OS updates tests.
export const FIXTURE_HOST = "autoheal-e2e-fixture-host";
export const FIXTURE_HOST_IMAGE = "autoheal-fixture-host:e2e";
export const FEDORA_HOST = "autoheal-e2e-fixture-fedora";
export const FEDORA_HOST_IMAGE = "autoheal-fixture-host-fedora:e2e";
export const CONTROL_PLANE_CONTAINER = "autoheal-e2e-control-plane";
export const RUNBOOK_MARKER = "E2E-RULE";
export const E2E_SESSION_DIRECTORY = join(tmpdir(), "autoheal-e2e-browser-session");
export const E2E_SESSION_STATE = join(E2E_SESSION_DIRECTORY, "state.json");
export const E2E_SESSION_METADATA = join(E2E_SESSION_DIRECTORY, "metadata.json");
// A throwaway registry inside the runner's network namespace: the runner reaches it as localhost,
// and so does Docker on this machine, through the port the runner publishes.
export const E2E_REGISTRY_PORT = 18500;
export const E2E_REGISTRY_CONTAINER = "autoheal-e2e-registry";
export const E2E_APP = "autoheal-e2e-app";
export const E2E_APP_IMAGE = `localhost:${E2E_REGISTRY_PORT}/${E2E_APP}:stable`;
export const E2E_APP_NEXT_IMAGE = `localhost:${E2E_REGISTRY_PORT}/${E2E_APP}:next`;
// Where its images say its code lives: a GitHub repository, whose releases page the dashboard links.
export const E2E_APP_SOURCE = "https://github.com/example/autoheal-e2e-app";
// How much of what the control plane said is shown when setup fails: why it did is near the end.
const FAILED_SETUP_LOG_LINES = 25;

// stderr is captured, not shown: early health probes fail on purpose.
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const safetyVolumes = () => [
  ...new Set(
    E2E_SAFETY_LABELS.flatMap((label) =>
      docker("volume", "ls", "-q", "--filter", `label=${label}`).split("\n").filter(Boolean),
    ),
  ),
];

/** Stateful runner fixtures must never share production's engine safety journals. */
function assertDisposableEngine() {
  const containers = docker("ps", "-a", "--format", '{{.Names}}\t{{.Image}}\t{{.Label "com.autoheal.e2e"}}');
  const foreign = containers.split("\n").filter((line) => {
    if (!line) return false;
    const [, image, label] = line.split("\t");
    return label !== "1" && !image?.startsWith("moby/buildkit:");
  });
  if (foreign.length)
    throw new Error("Browser tests require a disposable Docker engine without existing application containers.");
  const owner = docker(
    "volume",
    "ls",
    "-q",
    "--filter",
    `name=^${E2E_SAFETY_OWNER}$`,
    "--filter",
    `label=${E2E_LABEL}`,
  );
  if (safetyVolumes().length && !owner)
    throw new Error("Unowned runner safety state exists; use a fresh disposable engine. Nothing was removed.");
  return !!owner;
}

function removeEverything() {
  const ownsSafety = assertDisposableEngine();
  const containers = docker("ps", "-aq", "--filter", `label=${E2E_LABEL}`);
  if (containers) {
    docker("rm", "-f", ...containers.split("\n"));
  }
  // The update scenario builds its own small images; they carry the same label.
  const images = docker("images", "-q", "--filter", `label=${E2E_LABEL}`);
  if (images) {
    docker("rmi", "-f", ...new Set(images.split("\n")));
  }
  for (const [kind, name] of [
    ["network", E2E_NETWORK],
    ["volume", E2E_VOLUME],
  ] as const) {
    // Looked for first, so a removal the engine refuses is seen, not taken for one with nothing to remove.
    if (docker(kind, "ls", "--format", "{{.Name}}").split("\n").includes(name)) docker(kind, "rm", name);
  }
  if (ownsSafety) {
    // Every fixture host/runner has been removed above, so no delegated host unit can still execute.
    // This destroys this test engine's state together with its test database; it is not recovery repair.
    const records = safetyVolumes();
    if (records.length) docker("volume", "rm", ...records);
    docker("volume", "rm", E2E_SAFETY_OWNER);
  }
}

async function waitFor(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Shown before a failed setup's clean-up removes the control plane: why it did not start is in what it said. */
function showControlPlaneLogs() {
  const said = spawnSync("docker", ["logs", "--tail", String(FAILED_SETUP_LOG_LINES), CONTROL_PLANE_CONTAINER], {
    encoding: "utf8",
  });
  if (said.status !== 0) return;
  console.error(`${CONTROL_PLANE_CONTAINER} said:\n${said.stdout}${said.stderr}`);
}

export default async function globalSetup() {
  removeEverything();
  // Started first, so the clean-up has it before anything else is made.
  const ollama = await FakeOllama.start("plain", "0.0.0.0");
  let closing: Promise<void> | null = null;
  const teardown = async () => {
    try {
      removeEverything();
    } finally {
      closing ??= ollama.close();
      await closing;
      rmSync(E2E_SESSION_DIRECTORY, { recursive: true, force: true });
    }
  };
  try {
    await startStack(ollama);
  } catch (failure) {
    showControlPlaneLogs();
    await teardown().catch((leftBehind: unknown) => console.error("LEFT BEHIND:", leftBehind));
    throw failure;
  }
  return teardown;
}

/**
 * A fresh stack from the real image, set up the way the README says: the control plane gets its
 * address and a plain-http Ollama, nothing else; it makes its own certificate and passphrase.
 */
async function startStack(ollama: FakeOllama) {
  rmSync(E2E_SESSION_DIRECTORY, { recursive: true, force: true });
  mkdirSync(E2E_SESSION_DIRECTORY, { mode: 0o700 });
  docker("volume", "create", "--label", E2E_LABEL, E2E_SAFETY_OWNER);
  // A mature synthetic safety snapshot lets recovery scenarios run without waiting an hour.
  // Fresh-install holds remain covered by GuardState tests; this fixture never changes production state.
  const state = {
    version: 1,
    revision: 0,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    savedAt: Date.now() / 1000,
    uptime: uptime(),
    uncertainAt: null,
    entries: [],
  };
  docker(
    "volume",
    "create",
    "--label",
    "autoheal.guard.state=1",
    "--label",
    `autoheal.guard.record=${JSON.stringify(state)}`,
    "autoheal-guard-0",
  );
  // Every container that exists now is off limits to the test runner, whatever the fake model says.
  process.env.E2E_EXISTING_CONTAINERS = docker("ps", "-a", "--format", "{{.Names}}")
    .split("\n")
    .filter(Boolean)
    .join(",");

  ollama.handler = (request) => {
    const isVictim = request.messages[1]!.content.includes(`Failed container: ${VICTIM}`);
    const ruleApplies = request.messages[0]!.content.includes(RUNBOOK_MARKER);
    return isVictim && ruleApplies
      ? answer({ action: "restart", target: VICTIM, diagnosis: "The runbook says a restart fixes this." })
      : answer({
          action: "escalate",
          target: VICTIM,
          diagnosis: "It keeps failing on a missing setting; check its configuration.",
        });
  };
  process.env.E2E_OLLAMA_URL = `http://ollama:${ollama.listeningPort}`;

  docker("network", "create", E2E_NETWORK);
  docker("volume", "create", E2E_VOLUME);
  docker(
    "run",
    "-d",
    "--name",
    CONTROL_PLANE_CONTAINER,
    "--label",
    E2E_LABEL,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:size=64m",
    "--network",
    E2E_NETWORK,
    "--network-alias",
    "control-plane",
    "--add-host",
    "ollama:host-gateway",
    "-p",
    `${E2E_PUBLISH_ADDRESS}:${E2E_PORT}:8443`,
    "-v",
    `${E2E_VOLUME}:/data`,
    "-e",
    `PUBLIC_BASE_URL=https://localhost:${E2E_PORT}`,
    "-e",
    `OLLAMA_URL=${process.env.E2E_OLLAMA_URL}`,
    E2E_IMAGE,
  );
  await waitFor(() => {
    try {
      docker("exec", CONTROL_PLANE_CONTAINER, "/nodejs/bin/node", "/app/dist/server/main.js", "healthcheck");
      return true;
    } catch {
      return false;
    }
  }, "the control plane to become healthy");
  const firstRun = /one-time password (\S+)/.exec(docker("logs", CONTROL_PLANE_CONTAINER));
  if (firstRun === null) {
    throw new Error("the control plane did not print a first-run password");
  }
  process.env.E2E_ADMIN_PASSWORD = firstRun[1];
}
