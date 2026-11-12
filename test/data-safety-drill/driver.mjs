// The compiled runner code on a disposable engine: real volumes, the real copy helper, Compose itself. Started by
// run.sh, and by itself once more for a restore that is cut off the way a runner that dies is.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = new URL("../../", import.meta.url).pathname;
const { DockerClient } = await import(`${ROOT}dist/server/runner/docker-client.js`);
const { imageOnHost } = await import(`${ROOT}dist/server/runner/application-backups.js`);
const { ContainerUpdater } = await import(`${ROOT}dist/server/runner/container-updater.js`);
const { VolumeCheckpoints } = await import(`${ROOT}dist/server/runner/volume-checkpoints.js`);
const { ContainerBackups } = await import(`${ROOT}dist/server/runner/container-backups.js`);
const { Stacks } = await import(`${ROOT}dist/server/runner/stacks.js`);
const { RemedyGuard } = await import(`${ROOT}dist/server/runner/remedy-guard.js`);
const { JOB_ACTION } = await import(`${ROOT}dist/server/shared/constants.js`);
const { CONTAINER_BACKUP } = await import(`${ROOT}dist/server/shared/container-backups.js`);
const age = await import(pathToFileURL(createRequire(ROOT).resolve("age-encryption")).href);
const [SOCKET, RUN_FOLDER, MODE = "drill", ...MODE_ARGUMENTS] = process.argv.slice(2);
const HELPER_IMAGE = process.env.HELPER_IMAGE;
const INNER = { ...process.env, DOCKER_HOST: `unix://${SOCKET}` };
const STACK = "drillstack";
const STACK_FOLDER = join(RUN_FOLDER, STACK);
const APP = `${STACK}-app-1`;
const APP_DATA = `${STACK}_data`;
const BACKUPS = "/srv/autoheal-backups";
const HOST_ID = "6f1c0d5e-8a3b-4c2d-9e7f-1a2b3c4d5e6f";
const LIMIT_TOO_SMALL = 1;
const LIMIT_ROOMY = 1024 * 1024 * 1024;
const MARKER_SECONDS = 300;

const inner = (...args) =>
  execFileSync("docker", args, { env: INNER, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail ? ` | ${String(detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
  );
};
const note = (name, detail) => console.log(`note ${name} | ${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);

// A volume seen through a container whose image has nothing where it is mounted, so that look changes nothing.
const look = (volume, ...command) =>
  inner(
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${volume}:/look:ro`,
    "--entrypoint",
    command[0],
    "drill-plain:1",
    ...command.slice(1),
  );
const holds = (volume) => look(volume, "sh", "-c", "ls -A /look | tr '\\n' ' '").trim();
const openedBy = (volume) => look(volume, "sh", "-c", "cat /look/opened-by 2>/dev/null || true");
const stateOf = (volume) => look(volume, "sh", "-c", "cat /look/state 2>/dev/null || true");
const imageId = (reference) => inner("image", "inspect", "-f", "{{.Id}}", reference);
const running = (name) => inner("inspect", "-f", "{{.State.Running}}", name) === "true";
const exists = (name) => inner("ps", "-aq", "--filter", `name=^${name}$`) !== "";
const until = async (what, done, seconds = 60) => {
  for (let second = 0; second < seconds; second += 1) {
    if (done()) return true;
    await sleep(1000);
  }
  console.log(`gave up waiting for ${what}`);
  return false;
};

const real = new DockerClient(SOCKET);
// What happens to the engine around the runner's own calls: a pull that moves the tag, and the tag moved again just
// before Docker makes the updated container itself (not a helper of the copy).
const hooks = { pulledTo: null, movedOnCreate: null, seenAfterCreate: null, watched: null, updating: null };
const docker = new Proxy(real, {
  get(target, name) {
    const value = target[name];
    if (name === "pull")
      return async (reference) => {
        if (hooks.pulledTo !== null) inner("tag", hooks.pulledTo, reference);
      };
    if (name === "create")
      return async (containerName, body) => {
        const updated = containerName === hooks.updating;
        if (updated && hooks.movedOnCreate !== null) inner("tag", hooks.movedOnCreate, body.Image);
        const id = await target.create(containerName, body);
        if (updated && hooks.watched !== null) hooks.seenAfterCreate = holds(hooks.watched);
        return id;
      };
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const helperImage = imageOnHost(docker, HELPER_IMAGE);
const updaterWith = (limitBytes) =>
  new ContainerUpdater(docker, sleep, Date.now, new VolumeCheckpoints({ docker, helperImage, limitBytes }));

const hostScript = (script, timeoutMilliseconds) =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", script], { env: INNER });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMilliseconds);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });
const stacks = new Stacks({
  docker,
  hostScript,
  imageExists: async () => true,
  settings: {
    containerAccess: true,
    hostDeploy: true,
    dryRun: false,
    protectedContainers: new Set(),
    selfContainerName: "none",
  },
  wait: sleep,
  clock: Date.now,
});
// The cut-off restore's process is given the same key, as a runner is given its dashboard's.
const identity = process.env.DRILL_BACKUP_IDENTITY ?? (await age.generateX25519Identity());
const recipient = await age.identityToRecipient(identity);
const backupJob = (restoreId) => ({
  target: { container: null, stack: STACK },
  directory: BACKUPS,
  copyDirectory: null,
  include: [],
  key: { recipient, sealedKey: "sealed-for-the-data-safety-drill-only".padEnd(48, "-") },
  restoreId,
  hostId: HOST_ID,
});
// A runner as it comes up: it looks first at what a runner before it left.
const runner = async (withStacks = stacks) => {
  const backups = new ContainerBackups({
    docker,
    stacks: withStacks,
    guard: new RemedyGuard(new Set()),
    settings: { protectedContainers: new Set(), selfContainerName: "none", dryRun: false },
    helperImage,
    openKey: async () => identity,
    reportProgress: async () => undefined,
  });
  await backups.recover();
  return backups;
};
const backupsOfStack = () =>
  look(BACKUPS, "sh", "-c", `ls /look/_host_${HOST_ID}/_stack_${STACK} 2>/dev/null || true`)
    .split("\n")
    .filter((id) => /^\d{8}T\d{6}Z$/.test(id));
const journals = () =>
  inner("volume", "ls", "-q", "--filter", `label=${CONTAINER_BACKUP.journalLabel}`)
    .split("\n")
    .filter(Boolean)
    .map((volume) =>
      JSON.parse(inner("volume", "inspect", "-f", `{{index .Labels "${CONTAINER_BACKUP.journalRecord}"}}`, volume)),
    );
const composeFile = (image) =>
  `services:\n  app:\n    image: ${image}\n    network_mode: none\n    volumes:\n      - data:/data\nvolumes:\n  data:\n`;
const compose = (...args) =>
  execFileSync("docker", ["compose", ...args], { cwd: STACK_FOLDER, env: INNER, stdio: ["ignore", "ignore", "pipe"] });

// A restore cut off once its data is back and its files are written, as Compose is about to bring the stack up.
if (MODE === "restore-until-compose") {
  const [restoreId, marker] = MODE_ARGUMENTS;
  const stalled = {
    answer: (request) => stacks.answer(request),
    run: async (action, details) => {
      if (action !== JOB_ACTION.stackUp) return stacks.run(action, details);
      writeFileSync(marker, "");
      return new Promise(() => undefined);
    },
  };
  const ended = await (await runner(stalled)).run(randomUUID(), JOB_ACTION.restoreContainer, backupJob(restoreId));
  console.log(`the cut-off restore ended before Compose: ${ended.outcome}`);
  process.exit(1);
}

// 1. Docker fills an empty named volume with the image's files when it makes a container, before any start.
{
  inner("volume", "create", "copy-up");
  inner("create", "--name", "made-only", "--network", "none", "-v", "copy-up:/cache", "drill-plain:other");
  check(
    "an empty volume holds the image's files once a container is made, never started",
    holds("copy-up") === "from-other",
  );
  inner("rm", "made-only");
  check("and keeps them once that container is removed", holds("copy-up") === "from-other");
}

// 2. FIX-024: the tag moves to another image just before Docker makes the new container.
{
  inner("volume", "create", "cache-data");
  inner("tag", "drill-plain:1", "drill-plain:current");
  inner("run", "-d", "--name", "cached", "--network", "none", "-v", "cache-data:/cache", "drill-plain:current");
  hooks.pulledTo = "drill-plain:2";
  hooks.movedOnCreate = "drill-plain:other";
  hooks.watched = "cache-data";
  hooks.updating = "cached";
  const result = await updaterWith(LIMIT_ROOMY).update("cached");
  hooks.movedOnCreate = null;
  check(
    "FIX-024: Docker filled the empty volume when it made the container from the other image",
    hooks.seenAfterCreate === "from-other",
    hooks.seenAfterCreate,
  );
  check(
    "FIX-024: the update says the tag moved and the old one is back",
    !result.succeeded && result.outcome.includes("moved to another image"),
    result.outcome,
  );
  check(
    "FIX-024: the copy kept first went back before the old one started: the volume is empty again",
    holds("cache-data") === "",
    holds("cache-data"),
  );
  check(
    "FIX-024: the old container runs again, on its own image",
    running("cached") && inner("inspect", "-f", "{{.Image}}", "cached") === imageId("drill-plain:1"),
  );

  // The same with no copy kept, as a person's update on a host that keeps none: nothing can undo what Docker put there.
  inner("rm", "-f", "cached");
  inner("volume", "rm", "cache-data");
  inner("volume", "create", "cache-data");
  inner("tag", "drill-plain:1", "drill-plain:current");
  inner("run", "-d", "--name", "cached", "--network", "none", "-v", "cache-data:/cache", "drill-plain:current");
  hooks.movedOnCreate = "drill-plain:other";
  const unkept = await updaterWith(0).update("cached", false, undefined, { allowWithoutCheckpoint: true });
  hooks.movedOnCreate = null;
  hooks.watched = null;
  hooks.updating = null;
  check(
    "FIX-024: with no copy kept, the old container comes back stopped, on its own image",
    exists("cached") &&
      !running("cached") &&
      inner("inspect", "-f", "{{.Image}}", "cached") === imageId("drill-plain:1"),
  );
  check(
    "FIX-024: and the update says why, before anyone starts it on the other image's files",
    !unkept.succeeded && unkept.outcome.includes("Look at its volumes before starting it"),
    unkept.outcome,
  );
  note("FIX-024 with no copy kept", `the volume holds: [${holds("cache-data")}]`);
}

// 3. FIX-004: an automatic update whose data is too big to copy, whose new version moves the data on, then fails.
{
  inner("volume", "create", "big-data");
  inner("tag", "drill-app:1", "drill-app:current");
  inner("run", "-d", "--name", "big", "--network", "none", "-v", "big-data:/data", "drill-app:current");
  await until("the first version to start", () => openedBy("big-data") === "1:none");
  hooks.pulledTo = "drill-app:2-sick";
  const tooBig = updaterWith(LIMIT_TOO_SMALL);
  const result = await tooBig.update("big", true);
  check(
    "FIX-004: the new version moved the data on to format 2",
    stateOf("big-data") === "format=2",
    stateOf("big-data"),
  );
  check(
    "FIX-004: only the new version opened the data after it",
    openedBy("big-data") === "1:none\n2:format=1",
    openedBy("big-data"),
  );
  check(
    "FIX-004: the old container is kept aside, stopped, on its own image",
    exists("big-autoheal-old") &&
      !running("big-autoheal-old") &&
      inner("inspect", "-f", "{{.Image}}", "big-autoheal-old") === imageId("drill-app:1"),
  );
  check(
    "FIX-004: the update says the old one is kept and its data was not",
    !result.succeeded && result.outcome.includes("kept as big-autoheal-old") && result.outcome.includes("not kept"),
    result.outcome,
  );
  const rolledBack = await tooBig.rollBack("big");
  check(
    "FIX-004: a roll back by hand refuses too",
    !rolledBack.succeeded && rolledBack.outcome.startsWith("Refused to roll back big"),
    rolledBack.outcome,
  );
  check(
    "FIX-004: and still nothing old opened the data",
    openedBy("big-data") === "1:none\n2:format=1" && !running("big-autoheal-old"),
  );

  // With room for a copy, the same failure is undone: the data goes back before the old version opens it.
  inner("volume", "create", "kept-data");
  inner("tag", "drill-app:1", "drill-app:current");
  inner("run", "-d", "--name", "kept", "--network", "none", "-v", "kept-data:/data", "drill-app:current");
  await until("the first version to start", () => openedBy("kept-data") === "1:none");
  const undone = await updaterWith(LIMIT_ROOMY).update("kept", true);
  check(
    "FIX-004: with a copy, the failed update is undone",
    !undone.succeeded && running("kept") && inner("inspect", "-f", "{{.Image}}", "kept") === imageId("drill-app:1"),
    undone.outcome,
  );
  check(
    "FIX-004: the old version opened its own data, put back first",
    openedBy("kept-data") === "1:none\n1:format=1" && stateOf("kept-data") === "format=1",
    openedBy("kept-data"),
  );
  hooks.pulledTo = null;
}

// 4. FIX-003: a stack backed up under version 1 and restored after version 2 moved its data on.
{
  mkdirSync(STACK_FOLDER);
  writeFileSync(join(STACK_FOLDER, "docker-compose.yml"), composeFile("drill-app:1"));
  compose("up", "-d");
  await until("the stack's first version", () => openedBy(APP_DATA) === "1:none");
  const backedUp = await (await runner()).run(randomUUID(), JOB_ACTION.backupContainer, backupJob(null));
  const [first] = backupsOfStack();
  check("FIX-003: the stack is backed up under version 1", backedUp.succeeded && first !== undefined, backedUp.outcome);
  const inBackup = "1:none";
  await until("the stack to start again after its backup", () => running(APP));
  writeFileSync(join(STACK_FOLDER, "docker-compose.yml"), composeFile("drill-app:2"));
  compose("up", "-d");
  await until("version 2 to move the data on", () => stateOf(APP_DATA) === "format=2");
  const beforeRestore = openedBy(APP_DATA);
  note("FIX-003 before the restores", `the data was opened by: ${beforeRestore.replace(/\n/g, ", ")}`);

  // a. The files cannot be written: the data goes back, but nothing may start under the files of version 2.
  chmodSync(join(STACK_FOLDER, "docker-compose.yml"), 0o444);
  chmodSync(STACK_FOLDER, 0o555);
  const refusing = await runner();
  const refused = await refusing.run(randomUUID(), JOB_ACTION.restoreContainer, backupJob(first));
  chmodSync(STACK_FOLDER, 0o755);
  chmodSync(join(STACK_FOLDER, "docker-compose.yml"), 0o644);
  check(
    "FIX-003: a restore whose files cannot go back does not finish",
    !refused.succeeded && refused.outcome.includes("stay stopped"),
    refused.outcome,
  );
  check("FIX-003: its container stays stopped", !running(APP));
  check(
    "FIX-003: the data is the backup's, and nothing opened it since",
    openedBy(APP_DATA) === inBackup && stateOf(APP_DATA) === "format=1",
    openedBy(APP_DATA),
  );
  check(
    "FIX-003: it stays blocked, for this runner and the next",
    refusing.isBlocked(APP) && (await runner()).isBlocked(APP),
  );
  check("FIX-003: and the next runner starts nothing", !running(APP) && openedBy(APP_DATA) === inBackup);

  // b. Its own safety copy puts it back as it was before the restore.
  const safety = refused.recoveryBackupId;
  check("FIX-003: the restore kept a safety copy first", typeof safety === "string", safety);
  const backAgain = await (await runner()).run(randomUUID(), JOB_ACTION.restoreContainer, backupJob(safety));
  check(
    "FIX-003: the safety copy puts the data back as it was, and version 2 runs on it",
    backAgain.succeeded && running(APP) && stateOf(APP_DATA) === "format=2",
    backAgain.outcome,
  );
  check(
    "FIX-003: version 2 opened only its own format",
    openedBy(APP_DATA) === `${beforeRestore}\n2:format=2`,
    openedBy(APP_DATA),
  );
  check("FIX-003: and nothing is blocked any more", !(await runner()).isBlocked(APP));

  // c. A runner dies after the files went back, just before Compose brings the stack up.
  const marker = join(RUN_FOLDER, "at-compose");
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), SOCKET, RUN_FOLDER, "restore-until-compose", first, marker],
    {
      env: { ...process.env, DRILL_BACKUP_IDENTITY: identity },
      stdio: "inherit",
    },
  );
  const exited = new Promise((done) => child.once("exit", done));
  await until(
    "the cut-off restore to reach Compose",
    () => existsSync(marker) || child.exitCode !== null,
    MARKER_SECONDS,
  );
  child.kill("SIGKILL");
  await exited;
  check("FIX-003: the cut-off restore reached Compose", existsSync(marker));
  check(
    "FIX-003: it left its record as activating",
    journals().some(({ phase }) => phase === "activating"),
    JSON.stringify(journals().map(({ phase }) => phase)),
  );
  const afterCrash = await runner();
  check("FIX-003: the next runner keeps it blocked and starts nothing", afterCrash.isBlocked(APP) && !running(APP));
  check(
    "FIX-003: the data is the backup's, unopened",
    openedBy(APP_DATA) === inBackup && stateOf(APP_DATA) === "format=1",
    openedBy(APP_DATA),
  );

  // d. Restored again, it comes up under the files its data belongs with.
  const retried = await afterCrash.run(randomUUID(), JOB_ACTION.restoreContainer, backupJob(first));
  check("FIX-003: restored again, it finishes", retried.succeeded, retried.outcome);
  check(
    "FIX-003: version 1 runs, made again from the backup's files",
    running(APP) && inner("inspect", "-f", "{{.Image}}", APP) === imageId("drill-app:1"),
    inner("inspect", "-f", "{{.Config.Image}}", APP),
  );
  check(
    "FIX-003: only version 1 opened the restored data",
    openedBy(APP_DATA) === `${inBackup}\n1:format=1` && stateOf(APP_DATA) === "format=1",
    openedBy(APP_DATA),
  );
  check(
    "FIX-003: nothing is blocked, and no record is left",
    !(await runner()).isBlocked(APP) && journals().length === 0,
    JSON.stringify(journals()),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
