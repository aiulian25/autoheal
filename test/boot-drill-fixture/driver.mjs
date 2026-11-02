// The compiled runner code on a disposable engine: real volumes, helper, age encryption and booted containers.
// A stand-in takes the control plane's place, so whether a mark is set is not shown here. Started by run.sh.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
const ROOT = new URL("../../", import.meta.url).pathname;
const { ApplicationBackups, imageOnHost } = await import(`${ROOT}dist/server/runner/application-backups.js`);
const { DockerClient } = await import(`${ROOT}dist/server/runner/docker-client.js`);
const { RemedyGuard } = await import(`${ROOT}dist/server/runner/remedy-guard.js`);
const age = await import(pathToFileURL(createRequire(ROOT).resolve("age-encryption")).href);
const SOCKET = process.argv[2];
const HELPER_IMAGE = process.env.HELPER_IMAGE;
const REAL_IMAGE = process.env.REAL_IMAGE ?? "";
const LIVE_SECRET = "live-secret-must-not-reach-the-drill";
const TEST_TOKEN = "test-token-to-be-masked";
const BOOT_PREFIX = "autoheal-helper-boot-drill-";

const inner = (...args) =>
  execFileSync("docker", args, {
    env: { ...process.env, DOCKER_HOST: `unix://${SOCKET}` },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const real = new DockerClient(SOCKET);
const hooks = { afterStart: null, removeFails: false };
const docker = new Proxy(real, {
  get(target, name) {
    const value = target[name];
    if (name === "start")
      return async (id) => {
        const r = await target.start(id);
        if (String(id).startsWith(BOOT_PREFIX)) await hooks.afterStart?.(id);
        return r;
      };
    if (name === "remove")
      return async (id, ...rest) => {
        if (hooks.removeFails && String(id).startsWith(BOOT_PREFIX)) throw new Error("simulated: cannot remove");
        return target.remove(id, ...rest);
      };
    if (name === "removeVolume")
      return async (id) => {
        if (hooks.removeFails) throw new Error("simulated: cannot remove volume");
        return target.removeVolume(id);
      };
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const results = [];
const store = new Map();
const client = {
  authorizeApplicationBackup: async () => true,
  uploadApplicationBackup: async (_task, artifact, stream) => {
    const parts = [];
    for await (const part of stream) parts.push(part);
    store.set(artifact, Buffer.concat(parts));
  },
  downloadApplicationBackup: async (_task, artifact) => Readable.from([store.get(artifact)]),
  reportApplicationBackup: async (result) => {
    results.push(result);
  },
};
const runtime = async () => {
  const app = new ApplicationBackups({
    docker,
    guard: new RemedyGuard(new Set()),
    selfContainerName: "none",
    helperImage: imageOnHost(docker, HELPER_IMAGE),
    protectedContainers: new Set(),
    dryRun: () => false,
    client,
  });
  await app.initialize();
  return app;
};
let passed = 0,
  failed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail ? ` | ${String(detail).replace(/\s+/g, " ").slice(0, 260)}` : ""}`,
  );
};
const identity = await age.generateX25519Identity();
const recipient = await age.identityToRecipient(identity);
const definition = (containerName, readySeconds = 5) => ({
  version: 1,
  name: containerName,
  containerName,
  consistency: "coordinated-clean-stop",
  exclusiveDockerWriters: true,
  sqlite: null,
  intervalHours: null,
  retain: 3,
  bootDrill: { readySeconds, environment: [{ name: "APP_TOKEN", value: TEST_TOKEN }] },
});
const seed = (volume, image, { records = "alpha,beta", owner = "0:0" } = {}) => {
  inner("volume", "create", volume);
  const sum = createHash("md5").update(`${records}\n`).digest("hex");
  inner(
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${volume}:/data`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    `printf 'format=1\n%s\n%s\n' '${records}' '${sum}' > /data/state; chown -R ${owner} /data`,
  );
};
const live = (name, image, { user = null, tag = name } = {}) => {
  const volume = `${tag}-data`;
  seed(volume, image, { owner: user ? `${user}:${user}` : "0:0" });
  inner(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "-e",
    `LIVE_SECRET=${LIVE_SECRET}`,
    "-e",
    "APP_TOKEN=live-token",
    "-v",
    `${volume}:/data`,
    ...(user ? ["--user", user] : []),
    image,
  );
  return volume;
};
const contentOf = (volume) =>
  inner(
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${volume}:/data:ro`,
    "--entrypoint",
    "sh",
    "fixture-app:1",
    "-c",
    "ls -a /data; cat /data/state | md5sum",
  );
const started = (name) => inner("inspect", "-f", "{{.Id}} {{.State.Running}} {{.State.StartedAt}}", name);
const resources = () => ({
  containers: inner("ps", "-a", "--format", "{{.Names}}").split("\n").sort().join(),
  volumes: inner("volume", "ls", "-q").split("\n").sort().join(),
});
const capture = async (name) => {
  const artifactId = randomUUID();
  const app = await runtime();
  const base = {
    id: randomUUID(),
    planId: randomUUID(),
    hostId: randomUUID(),
    artifactId,
    recipient,
    definition: definition(name),
    expiresAt: Date.now() + 600000,
  };
  await app.run({ ...base, operation: "capture" });
  const result = results.at(-1);
  if (!result.ok) throw new Error(`capture failed: ${result.message}`);
  return { base, imageId: result.imageId, artifactId };
};
const drill = async (name, base, imageId, id = randomUUID()) => {
  const app = await runtime();
  await app.run({ ...base, id, operation: "boot-drill", identity, imageId });
  return results.at(-1);
};
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
// Every drill: nothing live or stored changes, nothing is left.
const untouched = (label, name, volume, artifactId, before) => {
  check(`${label}: live container not restarted`, started(name) === before.started);
  check(`${label}: live data unchanged`, contentOf(volume) === before.content);
  check(`${label}: stored backup unchanged`, sha(store.get(artifactId)) === before.sha);
  const now = resources();
  check(
    `${label}: all drill resources removed`,
    now.containers === before.resources.containers && now.volumes === before.resources.volumes,
    now.containers === before.resources.containers ? "" : now.containers,
  );
};
const snapshot = (name, volume, artifactId) => ({
  started: started(name),
  content: contentOf(volume),
  sha: sha(store.get(artifactId)),
  resources: resources(),
});

// A: known good, staying up; what the booted container could actually reach.
{
  const volume = live("good", "fixture-app:1");
  const { base, imageId, artifactId } = await capture("good");
  check(
    "capture recorded the application's image",
    imageId === inner("image", "inspect", "-f", "{{.Id}}", "fixture-app:1"),
    imageId,
  );
  const before = snapshot("good", volume, artifactId);
  const seen = {};
  hooks.afterStart = async (name) => {
    await new Promise((done) => setTimeout(done, 1500));
    const look = (...args) => {
      try {
        return inner("exec", name, "sh", "-c", ...args);
      } catch (error) {
        return `failed: ${error.stderr ?? error.message}`;
      }
    };
    seen.interfaces = look("ls /sys/class/net | tr '\\n' ' '");
    seen.liveSecret = look("env | grep -c LIVE_SECRET || true");
    seen.token = look("echo $APP_TOKEN");
    seen.volumeHasFormat = look("sed -n 1p /data/state");
    seen.definition = JSON.parse(inner("inspect", "-f", "{{json .HostConfig}}", name));
    seen.networks = JSON.parse(inner("inspect", "-f", "{{json .NetworkSettings.Networks}}", name));
    seen.mounts = JSON.parse(inner("inspect", "-f", "{{json .Mounts}}", name));
  };
  const result = await drill("good", base, imageId);
  hooks.afterStart = null;
  check(
    "known-good started, and no more is claimed without a health check",
    result.ok === true && result.boot?.readiness === "stayed-running" && /does not show it works/.test(result.message),
    result.message,
  );
  check("no network but loopback", seen.interfaces.trim() === "lo", seen.interfaces);
  check(
    "network mode none, no ports",
    seen.definition.NetworkMode === "none" &&
      Object.keys(seen.definition.PortBindings ?? {}).length === 0 &&
      Object.values(seen.networks).every((n) => !n.IPAddress),
  );
  check(
    "no host binds, only the clone volume",
    (seen.definition.Binds ?? []).length === 0 &&
      seen.mounts.length === 1 &&
      seen.mounts[0].Type === "volume" &&
      seen.mounts[0].Name !== volume,
    seen.mounts.map((m) => `${m.Type}:${m.Name}`).join(),
  );
  check(
    "not privileged, capped, no new privileges",
    seen.definition.Privileged === false &&
      seen.definition.CapDrop?.includes("ALL") &&
      seen.definition.Memory > 0 &&
      seen.definition.NanoCpus > 0 &&
      seen.definition.PidsLimit > 0 &&
      seen.definition.SecurityOpt?.some((o) => o.startsWith("no-new-privileges")),
    `caps=${seen.definition.CapAdd}`,
  );
  check("live secret absent, test value present", seen.liveSecret.trim() === "0" && seen.token.trim() === TEST_TOKEN);
  check("really reading restored data", seen.volumeHasFormat.trim() === "format=1", seen.volumeHasFormat);
  untouched("good", "good", volume, artifactId, before);
  check(
    "the drill's writes stayed on the clone",
    !contentOf(volume).includes("booted") || before.content.includes("booted"),
  );
  inner("rm", "-f", "good");
}
// B: an image's own health check.
{
  const volume = live("healthy", "fixture-app:health");
  const { base, imageId, artifactId } = await capture("healthy");
  const before = snapshot("healthy", volume, artifactId);
  const result = await drill("healthy", base, imageId);
  check(
    "health check passing is the only full pass",
    result.ok === true && result.boot?.readiness === "healthy" && !/does not show/.test(result.message),
    result.message,
  );
  untouched("healthy", "healthy", volume, artifactId, before);
  inner("rm", "-f", "healthy");
}
// C: a live container with a non-root user, data owned by it.
{
  const volume = live("nonroot", "fixture-app:1", { user: "1000" });
  const { base, imageId, artifactId } = await capture("nonroot");
  const before = snapshot("nonroot", volume, artifactId);
  const result = await drill("nonroot", base, imageId);
  check(
    "non-root application boots on restored data it owns",
    result.ok === true,
    `${result.message} logs=${result.boot?.logs ?? ""}`,
  );
  untouched("nonroot", "nonroot", volume, artifactId, before);
  inner("rm", "-f", "nonroot");
}
// D: corrupt application data. The copy is faithful, so only booting it can tell.
{
  const volume = live("corrupt", "fixture-app:1");
  inner("exec", "corrupt", "sh", "-c", "sed -i 2s/alpha/XXXXX/ /data/state");
  const { base, imageId, artifactId } = await capture("corrupt");
  const before = snapshot("corrupt", volume, artifactId);
  const result = await drill("corrupt", base, imageId);
  check(
    "corrupt data fails clearly",
    result.ok === false && result.boot?.readiness === null && /stopped|exit|not/i.test(result.boot?.problem ?? ""),
    result.message,
  );
  check("copy integrity still passes while boot fails", result.integrity === "metadata-verified", result.integrity);
  check("its logs say why", (result.boot?.logs ?? "").includes("database corrupt"), result.boot?.logs);
  check("test value masked in the logs", !(result.boot?.logs ?? "").includes(TEST_TOKEN));
  check("no live secret in the logs", !JSON.stringify(result).includes(LIVE_SECRET));
  untouched("corrupt", "corrupt", volume, artifactId, before);
  // E: a backup that a later version cannot use.
  const incompatible = inner("image", "inspect", "-f", "{{.Id}}", "fixture-app:2");
  const clean = live("older", "fixture-app:1");
  const older = await capture("older");
  const beforeOlder = snapshot("older", clean, older.artifactId);
  const refused = await drill("older", older.base, incompatible);
  check(
    "incompatible image fails clearly",
    refused.ok === false && (refused.boot?.logs ?? "").includes("this version needs format=2"),
    refused.boot?.logs,
  );
  untouched("incompatible", "older", clean, older.artifactId, beforeOlder);
  // G: the backed-up image is gone.
  const gone = await drill("older", older.base, `sha256:${"0".repeat(64)}`);
  check(
    "missing image fails clearly, nothing started",
    gone.ok === false && /image/i.test(gone.boot?.problem ?? ""),
    gone.boot?.problem,
  );
  untouched("missing image", "older", clean, older.artifactId, beforeOlder);
  // H: a damaged backup never starts anything.
  const damaged = Buffer.from(store.get(older.artifactId));
  const good = store.get(older.artifactId);
  damaged[Math.floor(damaged.length / 3)] ^= 0xff;
  damaged[Math.floor(damaged.length / 2)] ^= 0xff;
  let startedAny = false;
  hooks.afterStart = async () => {
    startedAny = true;
  };
  store.set(older.artifactId, damaged);
  const broken = await drill("older", older.base, older.imageId);
  store.set(older.artifactId, good);
  hooks.afterStart = null;
  check("damaged backup fails, application never started", broken.ok === false && !startedAny, broken.boot?.problem);
  untouched("damaged backup", "older", clean, older.artifactId, beforeOlder);
  // I: cleanup failure is said, and the next start clears it.
  hooks.removeFails = true;
  const stuck = await drill("older", older.base, older.imageId);
  hooks.removeFails = false;
  check(
    "cleanup failure is named",
    (stuck.boot?.left ?? []).some((name) => name.startsWith(BOOT_PREFIX)) &&
      stuck.boot.left.some((name) => name.startsWith("autoheal-application-drill-")) &&
      stuck.boot.left.some((name) => name.startsWith("autoheal-application-download-")),
    (stuck.boot?.left ?? []).join(),
  );
  check("really still there before the sweep", resources().containers !== beforeOlder.resources.containers);
  await runtime();
  const after = resources();
  check(
    "sweep at runner start removes container, clones and copy",
    !after.containers.includes(BOOT_PREFIX) &&
      !after.volumes.includes("autoheal-application-drill-") &&
      !after.volumes.includes("autoheal-application-download-"),
    after.volumes,
  );
  inner("rm", "-f", "corrupt", "older");
}
// F: never healthy.
{
  const volume = live("sick", "fixture-app:unhealthy");
  const { base, imageId, artifactId } = await capture("sick");
  const before = snapshot("sick", volume, artifactId);
  const result = await drill("sick", base, imageId);
  check(
    "unhealthy application fails clearly",
    result.ok === false && /health/i.test(result.boot?.problem ?? ""),
    result.boot?.problem,
  );
  untouched("unhealthy", "sick", volume, artifactId, before);
  inner("rm", "-f", "sick");
}
if (REAL_IMAGE !== "") {
  // A real application, as published: its own init system, database and health check.
  // This image has no health check of its own: its API answering is what ready means here.
  const answering = (name) => {
    try {
      return (
        inner("exec", name, "sh", "-c", 'curl -s -m 2 http://127.0.0.1:81/api/ | grep -c \'"status":"OK"\'') === "1"
      );
    } catch {
      return false;
    }
  };
  const waitHealthy = async (name, seconds) => {
    for (let i = 0; i < seconds; i += 2) {
      if (answering(name)) return true;
      await new Promise((done) => setTimeout(done, 2000));
    }
    return false;
  };
  inner("volume", "create", "real-data");
  inner("volume", "create", "real-certificates");
  inner(
    "run",
    "-d",
    "--name",
    "real",
    "--network",
    "none",
    "-e",
    `LIVE_SECRET=${LIVE_SECRET}`,
    "-v",
    "real-data:/data",
    "-v",
    "real-certificates:/etc/letsencrypt",
    REAL_IMAGE,
  );
  check("live application answers on the disposable engine", await waitHealthy("real", 120));
  inner("exec", "real", "sh", "-c", "echo restored-marker > /data/marker; sync");
  const first = await capture("real");
  check("captured: it stopped cleanly and came back", started("real").includes("true"), results.at(-1).message);
  await waitHealthy("real", 120);
  const realContent = () =>
    inner("exec", "real", "sh", "-c", "cat /data/marker; ls /data | sort | tr '\\n' ' '; md5sum /data/database.sqlite");
  const before = {
    started: started("real"),
    content: realContent(),
    sha: sha(store.get(first.artifactId)),
    resources: resources(),
  };
  const seen = {};
  hooks.afterStart = async (name) => {
    await new Promise((done) => setTimeout(done, 3000));
    const look = (command) => {
      try {
        return inner("exec", name, "sh", "-c", command);
      } catch (error) {
        return `failed: ${error.stderr ?? error.message}`;
      }
    };
    seen.answering = await waitHealthy(name, 3);
    for (let i = 0; i < 40 && !seen.answering; i++) seen.answering = await waitHealthy(name, 2);
    seen.marker = look("cat /data/marker");
    seen.interfaces = look("ls /sys/class/net | tr '\\n' ' '");
    seen.liveSecret = look("env | grep -c LIVE_SECRET || true");
  };
  const startedAt = Date.now();
  const good = await drill("real", first.base, first.imageId);
  hooks.afterStart = null;
  check(
    "real application started from restored data",
    good.ok === true,
    `${good.message} seconds=${Math.round((Date.now() - startedAt) / 1000)}`,
  );
  check(
    "no health check of its own, so not proven, and said so",
    good.boot?.readiness === "stayed-running" && /does not show it works/.test(good.message),
    good.boot?.readiness,
  );
  check("the restored copy's API was answering inside the drill", seen.answering === true);
  check("it was reading the restored copy", seen.marker?.trim() === "restored-marker", seen.marker);
  check(
    "no network but loopback, no live secret",
    seen.interfaces?.trim() === "lo" && seen.liveSecret?.trim() === "0",
    `${seen.interfaces} ${seen.liveSecret}`,
  );
  check(
    "live application not restarted, data unchanged",
    started("real") === before.started && realContent() === before.content,
  );
  check("stored backup unchanged", sha(store.get(first.artifactId)) === before.sha);
  check(
    "all drill resources removed",
    resources().containers === before.resources.containers && resources().volumes === before.resources.volumes,
  );

  inner("exec", "real", "sh", "-c", "head -c 8192 /dev/urandom > /data/database.sqlite; sync");
  const second = await capture("real");
  check("corrupt database still captured, as a copy cannot tell", results.at(-1).ok === true, results.at(-1).message);
  const beforeBad = { resources: resources(), sha: sha(store.get(second.artifactId)) };
  const badAt = Date.now();
  const badSeen = {};
  hooks.afterStart = async (name) => {
    badSeen.answering = await waitHealthy(name, 45);
    badSeen.logs = (() => {
      try {
        return inner("logs", "--tail", "4", name);
      } catch {
        return "gone";
      }
    })();
  };
  const bad = await drill("real", second.base, second.imageId);
  hooks.afterStart = null;
  check("corrupt database never answered inside the drill", badSeen.answering === false);
  check(
    "corrupt database is not reported as a pass",
    bad.boot?.readiness !== "healthy" && /does not show|did not start/.test(bad.message),
    bad.message,
  );
  check(
    "its last lines are kept for a person to judge",
    (bad.boot?.logs ?? "").length > 0,
    (bad.boot?.logs ?? "").slice(-300),
  );
  check(
    "corrupt run: stored backup unchanged, resources removed",
    sha(store.get(second.artifactId)) === beforeBad.sha &&
      resources().volumes === beforeBad.resources.volumes &&
      resources().containers === beforeBad.resources.containers,
  );
  inner("rm", "-f", "real");
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
