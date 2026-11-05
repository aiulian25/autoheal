import { randomUUID } from "node:crypto";
import { PassThrough, Readable, Writable } from "node:stream";
import { z } from "zod";
import {
  COMMAND_BACKUP_COPY,
  COMPOSE_PROJECT_LABEL,
  HOST_HELPER,
  CHECKPOINT,
  JOB_ACTION,
  COMPOSE_DEPENDS_ON_LABEL,
  COMPOSE_SERVICE_LABEL,
  STOP_GRACE_SECONDS,
  UPDATE_PHASE,
  sizeText,
  type UpdatePhase,
} from "../shared/constants.js";
import {
  BACKUP_ASK,
  BACKUP_LEFT_OUT,
  BACKUP_METHOD,
  BACKUP_TEXT,
  BACKUP_WHY,
  CONTAINER_BACKUP,
  COPY_COMMAND,
  backupFolderName,
  backupManifestSchema,
  isHostFolder,
  type BackupAnswer,
  type BackupJobDetails,
  type BackupManifest,
  type BackupMember,
  type BackupPreview,
  type BackupRequest,
  type BackupTarget,
} from "../shared/container-backups.js";
import { describeError } from "../shared/errors.js";
import type { UpdateProgress } from "../shared/protocol.js";
import { STACK_ASK, type StackFile } from "../shared/stacks.js";
import { HelperImageMissing, type HelperImage } from "./application-backups.js";
import { manifestSeal, manifestSealMatches } from "./backup-manifest-seal.js";
import type { DockerClient } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";
import { containerResources } from "./operation-coordinator.js";
import type { RemedyGuard } from "./remedy-guard.js";
import type { Stacks } from "./stacks.js";
import { dataMountsOf, type DataMount } from "./volume-checkpoints.js";

const NODE = "/nodejs/bin/node";
const MAIN = "/app/dist/server/main.js";
// It only passes data through: most of what it holds is the stream, not the heap.
const HELPER_HEAP = "--max-old-space-size=96";
const DATA_ROOT = "/backup-data";
const BACKUPS_ROOT = "/backups";
const COPY_ROOT = "/backup-copy";
const HEALTHY = "healthy";
const UNHEALTHY = "unhealthy";
const EXITED = "exited";

/** A database's own tool. Only what has been proven by a real dump and restore is listed here. */
interface DumpRecipe {
  engine: string;
  dump: string[];
  databases: string[];
  ready: string[];
  feed: string[];
  // What its dump always says on the way in, and is no fault.
  harmless: RegExp;
}

const POSTGRES_USER = 'U="${POSTGRES_USER:-$(cat "${POSTGRES_USER_FILE:-/dev/null}" 2>/dev/null)}"; U="${U:-postgres}"';
const shell = (line: string) => ["sh", "-c", `${POSTGRES_USER}; ${line}`];
const POSTGRES: DumpRecipe = {
  engine: "PostgreSQL",
  dump: shell('exec pg_dumpall -U "$U"'),
  databases: shell(
    `exec psql -X -At -U "$U" -d postgres -c "select datname from pg_database where not datistemplate order by 1"`,
  ),
  // Over TCP: while its first start runs its set-up scripts, it listens only on its socket.
  ready: shell('exec pg_isready -q -h 127.0.0.1 -U "$U"'),
  feed: shell('exec psql -X -q -U "$U" -d postgres'),
  // The image's own settings already made its first role and database, which the dump makes again.
  harmless: /(role|database) "[^"]+" already exists/,
};
const DUMP_IMAGES = /^(?:[^/]+\/)*(postgres|pgvector|timescaledb|postgis)(?::|@|$)/;

const recipeOf = (details: ContainerDetails): DumpRecipe | null =>
  DUMP_IMAGES.test(details.Config.Image ?? "") ? POSTGRES : null;

export interface ContainerBackupsDependencies {
  docker: Pick<
    DockerClient,
    | "inspect"
    | "containerSummaries"
    | "create"
    | "start"
    | "stop"
    | "remove"
    | "setRestartPolicy"
    | "streamCommand"
    | "volumes"
    | "createVolume"
    | "removeVolume"
  >;
  stacks: Pick<Stacks, "answer" | "run"> | null;
  guard: Pick<RemedyGuard, "hold" | "release" | "persisted" | "operations">;
  settings: { protectedContainers: ReadonlySet<string>; selfContainerName: string; dryRun: boolean };
  helperImage: HelperImage;
  // The dashboard alone holds the passphrase: it opens a backup's key for the job that needs it, and keeps nothing.
  openKey: (jobId: string, sealedKey: string) => Promise<string>;
  reportProgress: (jobId: string, progress: UpdateProgress) => Promise<unknown>;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

interface Container {
  name: string;
  details: ContainerDetails;
}

interface Plan {
  target: BackupTarget;
  members: Container[];
  dumps: { member: Container; recipe: DumpRecipe }[];
  mounts: (DataMount & { member: string; bytes: number | null; leftOut: BackupPreview["mounts"][number]["leftOut"] })[];
  stops: Container[];
  freeBytes: number | null;
}

class Refused extends Error {}

const journalSchema = z.object({
  id: z.string(),
  revision: z.number(),
  kind: z.enum(["backup", "restore"]),
  // Writing means data is half-way: nothing there may start by itself. Incomplete means the data is whole but
  // something the restore was asked for did not happen, so it is not over and nobody should act on it alone.
  phase: z.enum(["stopped", "writing", "incomplete"]),
  stopped: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      policy: z.object({ Name: z.string(), MaximumRetryCount: z.number() }).nullable(),
    }),
  ),
});
type JournalRecord = z.infer<typeof journalSchema>;
type Stopped = JournalRecord["stopped"];

const nameOf = (details: ContainerDetails) => details.Name.replace(/^\//, "");
const reportSchema = z.looseObject({ ok: z.boolean(), message: z.string().optional() });
const startOrderDepends = (details: ContainerDetails) =>
  (details.Config.Labels?.[COMPOSE_DEPENDS_ON_LABEL] ?? "")
    .split(",")
    .map((part) => part.split(":")[0] ?? "")
    .filter((service) => service !== "");

/** What is depended on comes first. A loop cannot be ordered, and keeps its order. */
function startOrder(containers: readonly Container[]) {
  const serviceOf = (one: Container) => one.details.Config.Labels?.[COMPOSE_SERVICE_LABEL];
  const placed: Container[] = [];
  let waiting = [...containers];
  while (waiting.length > 0) {
    const ready = waiting.filter(({ details }) =>
      startOrderDepends(details).every(
        (service) => !waiting.some((other) => other.details !== details && serviceOf(other) === service),
      ),
    );
    const next = ready.length === 0 ? waiting : ready;
    placed.push(...next);
    waiting = waiting.filter((one) => !next.includes(one));
  }
  return placed;
}

const withSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);
const overlaps = (one: string, other: string) =>
  one === other || one.startsWith(withSlash(other)) || other.startsWith(withSlash(one));

const uniqueBySource = <Mount extends DataMount>(mounts: readonly Mount[]) => [
  ...new Map(mounts.map((mount) => [`${mount.type}:${mount.source}`, mount])).values(),
];

// Written to only where the container keeps this very data now: the manifest alone never grants a destination.
const stillMounted = ({ type, source, target }: BackupMember["mounts"][number], details: ContainerDetails) =>
  !isHostFolder(source) &&
  dataMountsOf(details).some((live) => live.type === type && live.source === source && live.target === target);

const backupId = (at: number) => new Date(at).toISOString().replace(/[-:]|\.\d{3}/g, "");

// A restore names its own safety copy when going back from it means something.
export interface BackupJobResult {
  succeeded: boolean;
  outcome: string;
  recoveryBackupId?: string;
}

/**
 * Backs up a container or a stack into a plain folder on its host, and puts one back. What a database's own tool can
 * do while it runs, that tool does; everything else stops, is copied by a helper, and starts again. It always starts
 * again, unless a restore has half-written its data: then it stays stopped, and says so.
 */
export class ContainerBackups {
  private readonly clock: () => number;
  private readonly sleep: (milliseconds: number) => Promise<unknown>;
  private readonly blocked = new Map<string, JournalRecord>();
  private busy = false;

  constructor(private readonly dependencies: ContainerBackupsDependencies) {
    this.clock = dependencies.clock ?? Date.now;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  }

  // --- what a crash left behind ------------------------------------------------------------------

  private journalName = (record: Pick<JournalRecord, "id" | "revision">) =>
    `${CONTAINER_BACKUP.journalPrefix}${record.id.slice(0, 36)}-${record.revision}`;

  private async journal(record: Omit<JournalRecord, "revision"> & { revision?: number }) {
    const saved: JournalRecord = { ...record, revision: (record.revision ?? -1) + 1 };
    await this.dependencies.docker.createVolume(this.journalName(saved), {
      [CONTAINER_BACKUP.journalLabel]: "1",
      [CONTAINER_BACKUP.journalRecord]: JSON.stringify(saved),
    });
    if (saved.revision > 0) {
      await this.dependencies.docker
        .removeVolume(this.journalName({ id: saved.id, revision: saved.revision - 1 }))
        .catch(() => undefined);
    }
    return saved;
  }

  private async closeJournal(record: JournalRecord) {
    await this.dependencies.docker.removeVolume(this.journalName(record)).catch(() => undefined);
  }

  /** On starting: whatever a backup stopped starts again. What a restore was half-way through stays stopped. */
  async recover() {
    const { docker } = this.dependencies;
    for (const summary of await docker.containerSummaries()) {
      if (summary.Labels?.[CONTAINER_BACKUP.helperLabel] !== undefined)
        await docker.remove(summary.Id).catch(() => undefined);
    }
    for (const volume of await docker.volumes(CONTAINER_BACKUP.journalLabel)) {
      const parsed = journalSchema.safeParse(JSON.parse(volume.Labels?.[CONTAINER_BACKUP.journalRecord] ?? "null"));
      if (!parsed.success) continue;
      const record = parsed.data;
      // Half-written data, or a restore that could not finish what it was asked: both wait for a person, and both
      // are still here to be found after this runner went down.
      if (record.phase === "writing" || record.phase === "incomplete") {
        for (const { name } of record.stopped) this.blocked.set(name, record);
        continue;
      }
      await this.settle(record);
    }
  }

  isBlocked(name: string) {
    return this.blocked.has(name);
  }

  // --- what is there ----------------------------------------------------------------------------

  private async containers() {
    const { docker } = this.dependencies;
    const found: Container[] = [];
    for (const summary of await docker.containerSummaries()) {
      if (summary.Labels?.[HOST_HELPER.label] === HOST_HELPER.labelValue) continue;
      const details = await docker.inspect(summary.Id);
      if (details !== null) found.push({ name: nameOf(details), details });
    }
    return found;
  }

  private membersIn(all: readonly Container[], { container, stack }: BackupTarget) {
    if (stack !== null) return all.filter(({ details }) => details.Config.Labels?.[COMPOSE_PROJECT_LABEL] === stack);
    return all.filter(({ name }) => name === container);
  }

  private refusalFor(containers: readonly Container[]): string | null {
    const { protectedContainers, selfContainerName } = this.dependencies.settings;
    for (const { name } of containers) {
      if (name === selfContainerName) return BACKUP_TEXT.self;
      if (protectedContainers.has(name)) return BACKUP_TEXT.protected(name);
    }
    return null;
  }

  private withHelper<Result>(
    mounts: readonly DataMount[],
    {
      directory,
      copyDirectory = null,
      writable = false,
    }: { directory: string; copyDirectory?: string | null; writable?: boolean },
    work: (helper: string) => Promise<Result>,
  ): Promise<Result> {
    const { docker, helperImage } = this.dependencies;
    return helperImage().then(async (image) => {
      const helper = `${CONTAINER_BACKUP.containerPrefix}${randomUUID()}`;
      await docker.create(helper, {
        Image: image,
        Cmd: [COMMAND_BACKUP_COPY, COPY_COMMAND.wait],
        User: HOST_HELPER.user,
        Labels: { [HOST_HELPER.label]: HOST_HELPER.labelValue, [CONTAINER_BACKUP.helperLabel]: "1" },
        NetworkDisabled: true,
        Healthcheck: { Test: [HOST_HELPER.noHealthcheck] },
        HostConfig: {
          Mounts: mounts.map((mount, index) => ({
            Type: mount.type,
            Source: mount.source,
            Target: `${DATA_ROOT}/${index}`,
            ReadOnly: !writable,
            ...(mount.type === "volume" ? { VolumeOptions: { NoCopy: true } } : {}),
          })),
          // Binds make a missing folder: a first backup needs its home.
          Binds: [`${directory}:${BACKUPS_ROOT}`, ...(copyDirectory === null ? [] : [`${copyDirectory}:${COPY_ROOT}`])],
          ReadonlyRootfs: true,
          CapDrop: [HOST_HELPER.allCapabilities],
          CapAdd: [...CHECKPOINT.capabilities],
          SecurityOpt: [HOST_HELPER.noNewPrivileges, HOST_HELPER.noSelinuxLabel],
          NetworkMode: HOST_HELPER.network,
          Memory: CONTAINER_BACKUP.memoryBytes,
          PidsLimit: HOST_HELPER.pidsLimit,
        },
      });
      try {
        await docker.start(helper);
        return await work(helper);
      } finally {
        await docker.remove(helper).catch(() => undefined);
      }
    });
  }

  private command = (what: string, ...args: string[]) => [NODE, HELPER_HEAP, MAIN, COMMAND_BACKUP_COPY, what, ...args];

  /** Asks the helper one thing, with its input on stdin. Its last line says how it went. */
  private async ask<Answer extends object>(
    helper: string,
    what: string,
    input: object | Readable | null,
    { args = [], onLine }: { args?: string[]; onLine?: (line: Record<string, unknown>) => void } = {},
  ): Promise<Answer> {
    let last = "";
    let partial = "";
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        const lines = `${partial}${chunk.toString()}`.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines.filter((each) => each !== "")) {
          last = line;
          const parsed = safeJson(line);
          if (parsed !== null) onLine?.(parsed);
        }
        done();
      },
    });
    const stdin =
      input === null
        ? undefined
        : input instanceof Readable
          ? input
          : Readable.from([Buffer.from(JSON.stringify(input))]);
    const { stderr } = await this.dependencies.docker.streamCommand(helper, this.command(what, ...args), {
      ...(stdin === undefined ? {} : { input: stdin }),
      output,
      timeoutMilliseconds: CONTAINER_BACKUP.copyMilliseconds,
    });
    const report = reportSchema.safeParse(safeJson(last || partial));
    if (!report.success) throw new Error(stderr || BACKUP_TEXT.helperDied);
    if (!report.data.ok) throw new Error(report.data.message ?? `The helper failed at ${what}.`);
    return report.data as unknown as Answer;
  }

  // --- what a backup would do ---------------------------------------------------------------------

  /**
   * All a job on these members could touch: them, and every container that can write where they keep their data, in
   * or above or below it, running or not, as a stopped one can be started. Worked out before anything is known of what
   * will be left out, so it holds at least what the job then stops.
   */
  private scopeOf(all: readonly Container[], target: BackupTarget): Container[] {
    const members = this.membersIn(all, target);
    const sources = members
      .flatMap(({ details }) => dataMountsOf(details))
      .map(({ source }) => source)
      .filter((source) => source !== "" && !isHostFolder(source));
    return all.filter(
      (container) =>
        members.includes(container) ||
        dataMountsOf(container.details).some(({ source }) => sources.some((held) => overlaps(held, source))),
    );
  }

  private async plan(
    all: readonly Container[],
    target: BackupTarget,
    directory: string,
    include: readonly string[],
  ): Promise<Plan> {
    const members = this.membersIn(all, target);
    if (members.length === 0) throw new Refused(BACKUP_TEXT.notThere(target.stack ?? target.container ?? ""));
    const refusal = this.refusalFor(members);
    if (refusal !== null) throw new Refused(refusal);
    const stuck = members.filter(({ name }) => this.blocked.has(name));
    if (stuck.length > 0) throw new Refused(BACKUP_TEXT.blocked(stuck.map(({ name }) => name).join(", ")));
    const dumps = members.flatMap((member) => {
      const recipe = recipeOf(member.details);
      return recipe !== null && member.details.State.Running === true ? [{ member, recipe }] : [];
    });
    const dumped = new Set(dumps.map(({ member }) => member.name));
    const candidates = uniqueBySource(
      members
        .filter(({ name }) => !dumped.has(name))
        .flatMap(({ name, details }) =>
          dataMountsOf(details)
            .filter(({ source }) => source !== "" && !isHostFolder(source))
            .map((mount) => ({ ...mount, member: name })),
        ),
    );
    if (candidates.length === 0 && dumps.length === 0) throw new Refused(BACKUP_TEXT.nothing);
    const { sizes, freeBytes } = await this.withHelper(candidates, { directory }, (helper) =>
      this.ask<{ sizes: (number | null)[]; freeBytes: number }>(helper, COPY_COMMAND.measure, null, {
        args: [String(candidates.length), String(CONTAINER_BACKUP.measureMilliseconds)],
      }),
    );
    const leftOutWhy = (bytes: number | null): Plan["mounts"][number]["leftOut"] => {
      if (bytes === null) return BACKUP_LEFT_OUT.unmeasured;
      if (bytes > freeBytes) return BACKUP_LEFT_OUT.noRoom;
      return bytes > CONTAINER_BACKUP.largeBytes ? BACKUP_LEFT_OUT.large : null;
    };
    const mounts = candidates.map((mount, index) => {
      const bytes = sizes[index] ?? null;
      const why = leftOutWhy(bytes);
      return { ...mount, bytes, leftOut: include.includes(mount.source) ? null : why };
    });
    const copied = mounts.filter(({ leftOut }) => leftOut === null);
    // What shares a copied folder has to stop too. Sharing a folder that was left out does not matter.
    const stops = all.filter(({ name, details }) => {
      if (dumped.has(name)) return false;
      if (details.State.Running !== true) return false;
      if (target.stack !== null && members.some((member) => member.name === name)) return true;
      return dataMountsOf(details).some(({ source }) => copied.some((mount) => overlaps(mount.source, source)));
    });
    const refused = this.refusalFor(stops);
    if (refused !== null) throw new Refused(refused);
    return { target, members, dumps, mounts, stops, freeBytes };
  }

  private async preview(request: BackupRequest): Promise<BackupPreview> {
    const plan = await this.plan(await this.containers(), request.target, request.directory, []);
    return {
      mounts: plan.mounts.map(({ member, source, target, bytes, leftOut }) => ({
        member,
        source,
        target,
        bytes,
        leftOut,
      })),
      dumps: plan.dumps.map(({ member, recipe }) => ({ member: member.name, engine: recipe.engine })),
      stops: plan.stops.map(({ name }) => name),
      savesSettings: plan.members.some(({ details }) => details.Config.Labels?.[COMPOSE_PROJECT_LABEL] !== undefined),
      directory: request.directory,
      freeBytes: plan.freeBytes,
    };
  }

  private foldersFor(target: BackupTarget, all: readonly Container[]) {
    const project = this.membersIn(all, target)[0]?.details.Config.Labels?.[COMPOSE_PROJECT_LABEL];
    const stackFolder = project === undefined ? [] : [backupFolderName({ container: null, stack: project })];
    return [...new Set([backupFolderName(target), ...stackFolder])];
  }

  private async list(request: BackupRequest): Promise<BackupAnswer> {
    const all = await this.containers();
    const { manifests, unreadable, unreadableCount } = await this.withHelper(
      [],
      { directory: request.directory },
      (helper) =>
        this.ask<
          { manifests: { manifest: BackupManifest; sizeBytes: number }[] } & Pick<
            BackupAnswer,
            "unreadable" | "unreadableCount"
          >
        >(helper, COPY_COMMAND.list, { folders: this.foldersFor(request.target, all) }),
    );
    const images = new Map(all.map(({ name, details }) => [name, details.Image ?? null]));
    const backups = manifests
      .map(({ manifest, sizeBytes }) => ({
        id: manifest.id,
        createdAt: manifest.createdAt,
        why: manifest.why,
        bytes: sizeBytes,
        fromStack: manifest.target.stack !== null && request.target.stack === null,
        members: manifest.members.map(({ name, image, imageId, method }) => ({
          name,
          image,
          method,
          sameImage: imageId === null || images.get(name) === imageId,
        })),
        hasSettings: manifest.hasSettings,
        leftOut: manifest.leftOut,
        unsealed: manifest.format !== CONTAINER_BACKUP.format,
      }))
      .toSorted((one, other) => other.createdAt - one.createdAt);
    return { refusal: null, backups, unreadable, unreadableCount };
  }

  async answer(request: BackupRequest): Promise<BackupAnswer> {
    try {
      if (request.kind === BACKUP_ASK.list) return await this.list(request);
      return { refusal: null, preview: await this.preview(request) };
    } catch (error) {
      if (error instanceof Refused || error instanceof HelperImageMissing) return { refusal: error.message };
      return { refusal: describeError(error) };
    }
  }

  // --- stopping and starting --------------------------------------------------------------------

  // Each is noted before anything is done to it, through the caller's own record, so a failure at any step leaves the
  // caller knowing exactly what to put back.
  private async stopAll(
    containers: readonly Container[],
    turnOffRestart: boolean,
    note: (one: Stopped[number]) => Promise<void>,
  ) {
    const { docker, guard } = this.dependencies;
    // Last started, first stopped: an app stops before the database it needs.
    for (const { name, details } of startOrder(containers).toReversed()) {
      guard.hold(name);
      if (details.State.Running !== true) continue;
      const policy = details.HostConfig?.RestartPolicy;
      const kept =
        turnOffRestart && policy !== undefined
          ? { Name: policy.Name ?? "no", MaximumRetryCount: policy.MaximumRetryCount ?? 0 }
          : null;
      await note({ id: details.Id ?? name, name, policy: kept });
      if (kept !== null) await docker.setRestartPolicy(name, { Name: "no", MaximumRetryCount: 0 });
      await docker.stop(name, details.Config.StopTimeout ?? STOP_GRACE_SECONDS);
    }
    await guard.persisted();
  }

  // The very container that was stopped: its policy back, started, and seen running. A policy that will not go back
  // does not keep it down, but it stays on record.
  private async putBack({ id, name, policy }: Stopped[number]) {
    const { docker } = this.dependencies;
    const before = await docker.inspect(name).catch(() => null);
    if (before === null || (before.Id ?? name) !== id) return false;
    const policyBack =
      policy === null ||
      (await docker.setRestartPolicy(name, policy).then(
        () => true,
        () => false,
      ));
    const started = await docker.start(name).then(
      () => true,
      () => false,
    );
    if (!started || !policyBack) return false;
    return (await docker.inspect(name).catch(() => null))?.State.Running === true;
  }

  // Started in the order they were not stopped. Each failure is noted, and the rest still start.
  private async restartAll(stopped: Stopped) {
    const failed: string[] = [];
    for (const one of stopped.toReversed()) {
      if (!(await this.putBack(one))) failed.push(one.name);
    }
    return failed;
  }

  // Puts back what a record holds, and closes it only if all of it went back: what did not stays on record, for the
  // next start of this runner to try again. A record that cannot be rewritten stands as it was, and says more than is
  // left, which only starts what is already running.
  private async settle(record: JournalRecord, taken: ReadonlySet<string> = new Set(), close = true) {
    const failed = await this.restartAll(record.stopped.filter(({ name }) => !taken.has(name)));
    // Not closed yet where the caller has more to check: what it does with the record is its own to write.
    if (!close) return failed;
    if (failed.length === 0) {
      await this.closeJournal(record);
      return failed;
    }
    const left = record.stopped.filter(({ name }) => failed.includes(name));
    await this.journal({ ...record, stopped: left }).catch(() => undefined);
    return failed;
  }

  private release(names: readonly string[]) {
    for (const name of names) this.dependencies.guard.release(name);
  }

  // --- copying ------------------------------------------------------------------------------------

  private progress(jobId: string, phase: UpdatePhase, downloaded = 0, total: number | null = null) {
    void this.dependencies
      .reportProgress(jobId, { phase, layers: [], downloaded, total, bytesPerSecond: null, log: [] })
      .catch(() => undefined);
  }

  private async dumpDatabases(
    helper: string,
    details: BackupJobDetails["key"],
    folder: string,
    { member, recipe }: Plan["dumps"][number],
    file: string,
  ) {
    const { docker } = this.dependencies;
    const names = await collect((output) =>
      docker.streamCommand(member.name, recipe.databases, {
        output,
        timeoutMilliseconds: CONTAINER_BACKUP.startMilliseconds,
      }),
    );
    if (names.exitCode !== 0) throw new Error(BACKUP_TEXT.dumpFailed(names.stderr));
    const between = new PassThrough();
    const dumping = docker
      .streamCommand(member.name, recipe.dump, {
        output: between,
        timeoutMilliseconds: CONTAINER_BACKUP.copyMilliseconds,
      })
      .finally(() => between.end());
    const stored = await this.ask<StoredFile>(helper, COPY_COMMAND.store, between, {
      args: [folder, file, details.recipient],
    });
    const { exitCode, stderr } = await dumping;
    if (exitCode !== 0) throw new Error(BACKUP_TEXT.dumpFailed(stderr));
    if (stored.sourceBytes === 0) throw new Error(BACKUP_TEXT.dumpEmpty);
    return { stored, databases: names.text.split("\n").filter((name) => name !== "") };
  }

  // A stack's Compose files and .env; for a container on its own, what Docker holds of how it was made.
  private async settingsOf(members: readonly Container[]) {
    const projects = [
      ...new Set(members.flatMap(({ details }) => details.Config.Labels?.[COMPOSE_PROJECT_LABEL] ?? [])),
    ];
    const files: StackFile[] = [];
    for (const project of projects) {
      const answer = await this.dependencies.stacks
        ?.answer({ kind: STACK_ASK.read, id: randomUUID(), project })
        .catch(() => null);
      files.push(...(answer?.files?.files ?? []).filter(({ text }) => text !== null));
    }
    if (files.length === 0 && projects.length > 0) return null;
    return {
      projects,
      files: files.map(({ path, kind, text }) => ({ path, kind, text })),
      containers:
        projects.length > 0
          ? []
          : members.map(({ name, details }) => ({ name, config: details.Config, host: details.HostConfig })),
    };
  }

  /** Everything that gets sealed into a folder, once what must be stopped has stopped. */
  private async write(
    jobId: string,
    helper: string,
    folder: string,
    plan: Plan,
    key: BackupJobDetails["key"],
    why: BackupManifest["why"],
    id: string,
  ) {
    const manifestMembers = new Map<string, BackupMember>(
      plan.members.map(({ name, details }) => [
        name,
        {
          name,
          image: details.Config.Image ?? "",
          imageId: details.Image ?? null,
          method: BACKUP_METHOD.files,
          mounts: [],
          dump: null,
        },
      ]),
    );
    const files: BackupManifest["files"] = [];
    const settings = await this.settingsOf(plan.members);
    if (settings !== null) {
      const stored = await this.ask<StoredFile>(
        helper,
        COPY_COMMAND.store,
        Readable.from([Buffer.from(JSON.stringify(settings))]),
        {
          args: [folder, CONTAINER_BACKUP.settingsFile, key.recipient],
        },
      );
      files.push({ file: CONTAINER_BACKUP.settingsFile, bytes: stored.bytes, sha256: stored.sha256, isTar: false });
    }
    for (const [index, dump] of plan.dumps.entries()) {
      this.progress(jobId, UPDATE_PHASE.copying);
      const file = `dump-${index}.sql.age`;
      const { stored, databases } = await this.dumpDatabases(helper, key, folder, dump, file);
      files.push({ file, bytes: stored.bytes, sha256: stored.sha256, isTar: false });
      const member = manifestMembers.get(dump.member.name)!;
      member.method = BACKUP_METHOD.dump;
      member.dump = { file, databases };
    }
    const copied = plan.mounts.filter(({ leftOut }) => leftOut === null);
    const total = copied.reduce((sum, { bytes }) => sum + (bytes ?? 0), 0);
    let done = 0;
    for (const [position, mount] of copied.entries()) {
      const file = `data-${position}.tar.age`;
      const index = plan.mounts.indexOf(mount);
      const taken = await this.ask<StoredFile & { singleFile: boolean }>(
        helper,
        COPY_COMMAND.capture,
        { folder, file, index, recipient: key.recipient },
        {
          onLine: ({ copied: soFar }) => {
            if (typeof soFar === "number") this.progress(jobId, UPDATE_PHASE.copying, done + soFar, total);
          },
        },
      );
      done += taken.sourceBytes;
      files.push({ file, bytes: taken.bytes, sha256: taken.sha256, isTar: true });
      manifestMembers.get(mount.member)!.mounts.push({
        type: mount.type,
        source: mount.source,
        target: mount.target,
        file,
        singleFile: taken.singleFile,
        sourceBytes: taken.sourceBytes,
      });
    }
    return backupManifestSchema.parse({
      format: CONTAINER_BACKUP.format,
      id,
      createdAt: this.clock(),
      target: plan.target,
      why,
      members: [...manifestMembers.values()],
      hasSettings: settings !== null,
      leftOut: plan.mounts.filter(({ leftOut }) => leftOut !== null).map(({ source }) => source),
      files,
    });
  }

  /** Reads it back before it counts, and only then lets it become one of the list. */
  private async seal(
    jobId: string,
    helper: string,
    manifest: BackupManifest,
    folder: string,
    key: BackupJobDetails["key"],
    copy: boolean,
    protect: string | null = null,
  ) {
    this.progress(jobId, UPDATE_PHASE.verifyingCopy);
    const identity = await this.dependencies.openKey(jobId, key.sealedKey);
    await this.ask(helper, COPY_COMMAND.verify, { folder, identity, files: manifest.files });
    const { copyError } = await this.ask<{ copyError: string | null }>(helper, COPY_COMMAND.finish, {
      parent: backupFolderName(manifest.target),
      unfinished: folder,
      manifest: { ...manifest, seal: manifestSeal(manifest, identity) },
      key: key.sealedKey,
      name: manifest.target.stack ?? manifest.target.container ?? "",
      copy,
      protect,
    });
    return copyError;
  }

  // --- the two jobs -------------------------------------------------------------------------------

  private async backUp(jobId: string, details: BackupJobDetails, all: readonly Container[]) {
    const plan = await this.plan(all, details.target, details.directory, details.include);
    const needed = plan.mounts.reduce((sum, { bytes, leftOut }) => sum + (leftOut === null ? (bytes ?? 0) : 0), 0);
    if (plan.freeBytes !== null && needed > plan.freeBytes) {
      throw new Refused(BACKUP_TEXT.noRoom(sizeText(needed), sizeText(plan.freeBytes)));
    }
    if (plan.dumps.length === 0 && plan.mounts.every(({ leftOut }) => leftOut !== null)) {
      throw new Refused(BACKUP_TEXT.nothing);
    }
    const id = backupId(this.clock());
    const folder = `${backupFolderName(details.target)}/${CONTAINER_BACKUP.unfinishedPrefix}${id}`;
    const mounts = plan.mounts;
    return this.withHelper(mounts, details, async (helper) => {
      let record = await this.journal({ id: jobId, kind: "backup", phase: "stopped", stopped: [] });
      let manifest: BackupManifest;
      try {
        await this.stopAll(plan.stops, false, async (one) => {
          record = await this.journal({ ...record, stopped: [...record.stopped, one] });
        });
        this.progress(jobId, UPDATE_PHASE.copying);
        manifest = await this.write(jobId, helper, folder, plan, details.key, BACKUP_WHY.asked, id);
      } catch (error) {
        const failed = await this.settle(record);
        this.release(plan.stops.map(({ name }) => name));
        await this.ask(helper, COPY_COMMAND.discard, { folder }).catch(() => undefined);
        const reason = describeError(error);
        return {
          succeeded: false,
          outcome:
            failed.length === 0
              ? BACKUP_TEXT.failedRunning(reason)
              : BACKUP_TEXT.failedStopped(reason, failed.join(", ")),
        };
      }
      const failed = await this.settle(record);
      this.release(plan.stops.map(({ name }) => name));
      const copyError = await this.seal(
        jobId,
        helper,
        manifest,
        folder,
        details.key,
        details.copyDirectory !== null,
      ).catch(async (error: unknown) => {
        await this.ask(helper, COPY_COMMAND.discard, { folder }).catch(() => undefined);
        throw error;
      });
      const size = sizeText(manifest.files.reduce((sum, { bytes }) => sum + bytes, 0));
      const notes = [
        BACKUP_TEXT.backedUp(size),
        ...(failed.length === 0 ? [] : [BACKUP_TEXT.notStarted(failed.join(", "))]),
        ...(copyError === null ? [] : [BACKUP_TEXT.copyFailed(copyError)]),
      ];
      return { succeeded: failed.length === 0, outcome: notes.join(" ") };
    });
  }

  private async waitUp(name: string) {
    const { docker } = this.dependencies;
    const giveUpAt = this.clock() + CONTAINER_BACKUP.startMilliseconds;
    while (this.clock() < giveUpAt) {
      const state = (await docker.inspect(name))?.State;
      const health = state?.Health?.Status;
      if (state?.Running === true && (health === undefined || health === HEALTHY)) return true;
      if (health === UNHEALTHY || (state?.Running !== true && state?.Status === EXITED)) return false;
      await this.sleep(CONTAINER_BACKUP.pollMilliseconds);
    }
    return false;
  }

  private async waitDatabaseReady(name: string, recipe: DumpRecipe) {
    const { docker } = this.dependencies;
    const giveUpAt = this.clock() + CONTAINER_BACKUP.startMilliseconds;
    while (this.clock() < giveUpAt) {
      const { exitCode } = await collect((output) =>
        docker.streamCommand(name, recipe.ready, { output, timeoutMilliseconds: CONTAINER_BACKUP.startMilliseconds }),
      ).catch(() => ({ exitCode: 1 }));
      if (exitCode === 0) return;
      await this.sleep(CONTAINER_BACKUP.pollMilliseconds);
    }
    throw new Error(BACKUP_TEXT.notReady(name));
  }

  /** Starts it empty with its own settings, as its image does, then feeds it the dump. */
  private async feedDump(
    helper: string,
    member: BackupMember,
    recipe: DumpRecipe,
    folder: string,
    identity: string,
    indexes: number[],
  ) {
    const { docker } = this.dependencies;
    await this.ask(helper, COPY_COMMAND.empty, { indexes });
    await docker.start(member.name);
    await this.waitDatabaseReady(member.name, recipe);
    const between = new PassThrough();
    const revealing = docker.streamCommand(helper, this.command(COPY_COMMAND.reveal), {
      input: Readable.from([Buffer.from(JSON.stringify({ folder, file: member.dump!.file, identity }))]),
      output: between,
      timeoutMilliseconds: CONTAINER_BACKUP.copyMilliseconds,
    });
    const fed = await collect((output) =>
      docker.streamCommand(member.name, recipe.feed, {
        input: between,
        output,
        timeoutMilliseconds: CONTAINER_BACKUP.copyMilliseconds,
      }),
    );
    await revealing;
    const faults = fed.stderr.split("\n").filter((line) => /ERROR|FATAL/.test(line) && !recipe.harmless.test(line));
    if (fed.exitCode !== 0 || faults.length > 0) throw new Error(BACKUP_TEXT.feedFailed(faults[0] ?? fed.stderr));
    const now = await collect((output) =>
      docker.streamCommand(member.name, recipe.databases, {
        output,
        timeoutMilliseconds: CONTAINER_BACKUP.startMilliseconds,
      }),
    );
    const found = new Set(now.text.split("\n"));
    const missing = member.dump!.databases.filter((name) => !found.has(name));
    if (missing.length > 0) throw new Error(BACKUP_TEXT.feedMissing(missing.join(", ")));
  }

  /**
   * The Compose files, if they differ. Files changed since are kept beside them, as any save keeps them.
   *
   * A project's files are put back only where this restore covers every container the host has in that project: the
   * files say what each of its services is, and the stack is brought up from them afterwards, so applying them to a
   * stack whose other services are not part of this restore would recreate them from settings nobody reviewed, on
   * data this job never held. Where that is so the files are left alone and the others are named.
   */
  private async restoreSettings(
    helper: string,
    folder: string,
    identity: string,
    manifest: BackupManifest,
    all: readonly Container[],
    restoring: ReadonlySet<string>,
  ) {
    const { stacks, docker } = this.dependencies;
    if (!manifest.hasSettings || stacks === null) return { changed: [] as string[], note: null, refusal: null };
    const opened = await collect((output) =>
      docker.streamCommand(helper, this.command(COPY_COMMAND.reveal), {
        input: Readable.from([Buffer.from(JSON.stringify({ folder, file: CONTAINER_BACKUP.settingsFile, identity }))]),
        output,
        timeoutMilliseconds: CONTAINER_BACKUP.startMilliseconds,
      }),
    );
    const saved = savedSettingsSchema.parse(JSON.parse(opened.text));
    const changed: string[] = [];
    const wider: string[] = [];
    // Said rather than assumed: nothing here puts a container's own settings back, so its image is still the one it
    // ran before this restore, which may be newer than the data now under it.
    const ownSettings = saved.containers.map(({ name }) => name).filter((name) => restoring.has(name));
    if (ownSettings.length > 0) wider.push(BACKUP_TEXT.ownSettingsNotRestored(ownSettings.join(", ")));
    for (const project of saved.projects) {
      const others = all
        .filter((container) => projectOf(container) === project && !restoring.has(container.name))
        .map(({ name }) => name);
      if (others.length > 0) {
        wider.push(BACKUP_TEXT.settingsWiderThanRestore(project, others.join(", ")));
        continue;
      }
      const current = await stacks.answer({ kind: STACK_ASK.read, id: randomUUID(), project });
      const edited = saved.files.flatMap(({ path, text }) => {
        const now = current.files?.files.find((file) => file.path === path);
        if (now === undefined || now.text === text) return [];
        return [{ path, text, hash: now.hash }];
      });
      if (edited.length === 0) continue;
      const answer = await stacks.answer({ kind: STACK_ASK.save, id: randomUUID(), project, files: edited });
      if (answer.error !== null) {
        return { changed, note: null, refusal: BACKUP_TEXT.settingsNotRestored(answer.error) };
      }
      changed.push(project);
    }
    return { changed, note: wider.length === 0 ? null : wider.join(" "), refusal: null };
  }

  private async restore(
    jobId: string,
    details: BackupJobDetails,
    all: readonly Container[],
    held: ReadonlySet<string>,
  ) {
    const { dependencies } = this;
    const restoreId = details.restoreId!;
    const folders = this.foldersFor(details.target, all);
    const found = await this.withHelper([], details, async (helper) => {
      for (const parent of folders) {
        const read = await this.ask<{ manifest: BackupManifest; key: string }>(helper, COPY_COMMAND.read, {
          folder: `${parent}/${restoreId}`,
        }).catch(() => null);
        if (read !== null) return { ...read, folder: `${parent}/${restoreId}` };
      }
      return null;
    });
    if (found === null) throw new Refused(BACKUP_TEXT.gone);
    const { manifest, folder } = found;
    if (manifest.format !== CONTAINER_BACKUP.format) throw new Refused(BACKUP_TEXT.notSealed);
    const identity = await dependencies.openKey(jobId, found.key);
    // A sound manifest moved from another backup is still not this one.
    const isThisBackup = manifest.id === restoreId && folder === `${backupFolderName(manifest.target)}/${restoreId}`;
    if (!manifestSealMatches(manifest, identity) || !isThisBackup) throw new Refused(BACKUP_TEXT.sealBroken);
    // A member restored from its stack's backup comes back alone.
    const wanted = manifest.members.filter(
      ({ name }) => details.target.container === null || name === details.target.container,
    );
    const members = wanted.map((member) => {
      const current = all.find(({ name }) => name === member.name);
      if (current === undefined) throw new Refused(BACKUP_TEXT.notThere(member.name));
      return { member, current };
    });
    // What the backup names is only known now: a member that has left the stack is not what this job holds.
    const notHeld = members.find(({ current }) => !held.has(current.name));
    if (notHeld !== undefined) throw new Refused(BACKUP_TEXT.notHeld(notHeld.current.name));
    const refusal = this.refusalFor(members.map(({ current }) => current));
    if (refusal !== null) throw new Refused(refusal);
    for (const { member, current } of members) {
      const changed = member.mounts.find((mount) => !stillMounted(mount, current.details));
      if (changed !== undefined) throw new Refused(BACKUP_TEXT.mountChanged(member.name, changed.target));
    }
    const files = manifest.files.filter(
      ({ file }) =>
        file === CONTAINER_BACKUP.settingsFile ||
        wanted.some(({ mounts, dump }) => dump?.file === file || mounts.some((mount) => mount.file === file)),
    );
    this.progress(jobId, UPDATE_PHASE.verifyingCopy);
    await this.withHelper([], details, (helper) => this.ask(helper, COPY_COMMAND.verify, { folder, identity, files }));

    // What it put back, and whatever else writes there, all stop.
    const backupMounts = wanted.flatMap(({ mounts }) => mounts);
    const currentMounts = (one: Container) => dataMountsOf(one.details).filter(({ source }) => !isHostFolder(source));
    const dumpMounts = uniqueBySource(
      members.filter(({ member }) => member.dump !== null).flatMap(({ current }) => currentMounts(current)),
    );
    const mounts: DataMount[] = uniqueBySource([
      ...backupMounts.map(({ type, source, target }) => ({ type: type as DataMount["type"], source, target })),
      ...dumpMounts,
    ]);
    const stopping = all.filter(
      ({ name, details: container }) =>
        members.some(({ member }) => member.name === name) ||
        dataMountsOf(container).some(({ source }) => mounts.some((mount) => overlaps(mount.source, source))),
    );
    const refused = this.refusalFor(stopping);
    if (refused !== null) throw new Refused(refused);
    const outside = stopping.find(({ name }) => !held.has(name));
    if (outside !== undefined) throw new Refused(BACKUP_TEXT.notHeld(outside.name));

    return this.withHelper(mounts, { ...details, writable: true }, async (helper) => {
      const names = stopping.map(({ name }) => name);
      // A restore that stopped half-way left these stopped, on data that is not whole. This one takes over what to put
      // back, and the block with it: only a finished restore lifts it, not a new attempt that has yet to write. The new
      // record is durable before the old one goes.
      const earlier = [...new Set(names.flatMap((name) => this.blocked.get(name) ?? []))];
      const halfWritten = earlier.length > 0;
      let record = await this.journal({
        id: jobId,
        kind: "restore",
        phase: halfWritten ? "writing" : "stopped",
        stopped: earlier.flatMap(({ stopped }) => stopped),
      });
      for (const old of earlier) await this.closeJournal(old);
      // `taken`: containers something else is responsible for starting, so this must not start them as they were.
      const startRest = async (taken: ReadonlySet<string> = new Set(), close = true) => {
        const failed = await this.settle(record, taken, close);
        this.release(names);
        return failed;
      };
      let written = halfWritten;
      const safetyId = backupId(this.clock() + 1000);
      // Set once there is one to go back to: this restore's own copy, for its result to name.
      let recovery: { recoveryBackupId?: string } = {};
      try {
        await this.stopAll(stopping, true, async (one) => {
          record = await this.journal({ ...record, stopped: [...record.stopped, one] });
        });
        // The safety copy is of everything about to change, as files: its server is stopped, so that is exact.
        const safetyFolder = `${backupFolderName(details.target)}/${CONTAINER_BACKUP.unfinishedPrefix}${safetyId}`;
        const takeSafetyCopy = async () => {
          const copy = await this.write(
            jobId,
            helper,
            safetyFolder,
            {
              target: details.target,
              members: members.map(({ current }) => current),
              dumps: [],
              mounts: mounts.map((mount) => ({
                ...mount,
                member:
                  members.find(({ current }) =>
                    dataMountsOf(current.details).some(
                      ({ source, target }) => source === mount.source && target === mount.target,
                    ),
                  )?.member.name ?? wanted[0]!.name,
                bytes: null,
                leftOut: null,
              })),
              stops: [],
              freeBytes: null,
            },
            details.key,
            BACKUP_WHY.safety,
            safetyId,
          );
          // The backup being restored is kept, however old: it is still needed.
          await this.seal(jobId, helper, copy, safetyFolder, details.key, false, restoreId);
          return copy;
        };
        // A copy of half-written data could only ever put half-written data back. The first attempt's copy stands.
        const safety = halfWritten ? null : await takeSafetyCopy();
        if (safety !== null) recovery = { recoveryBackupId: safety.id };

        record = await this.journal({ ...record, phase: "writing" });
        written = true;
        this.progress(jobId, UPDATE_PHASE.restoring);
        for (const { member } of members) {
          for (const mount of member.mounts) {
            const index = mounts.findIndex(({ source, type }) => source === mount.source && type === mount.type);
            await this.ask(helper, COPY_COMMAND.restore, {
              folder,
              file: mount.file,
              index,
              identity,
              singleFile: mount.singleFile,
            });
          }
        }
        const restoring = new Set(members.map(({ current }) => current.name));
        const settings = await this.restoreSettings(helper, folder, identity, manifest, all, restoring);
        // Databases first, in what depends on them's place: their dumps go in before anything needs them.
        for (const { member, current } of members) {
          if (member.dump === null) continue;
          const recipe = recipeOf(current.details);
          if (recipe === null) throw new Error(BACKUP_TEXT.dumpFailed(member.image));
          const indexes = currentMounts(current).map(({ source, type }) =>
            mounts.findIndex((mount) => mount.source === source && mount.type === type),
          );
          try {
            await this.feedDump(helper, member, recipe, folder, identity, indexes);
          } catch (error) {
            // Nothing whole to go back to: the outer catch leaves it stopped.
            if (safety === null) throw error;
            // If this fails too, the outer catch leaves them stopped: nothing is known to be whole.
            await this.putBackSafety(helper, stopping, safety, safetyFolder, details.key, jobId, mounts);
            record = await this.journal({ ...record, phase: "stopped" });
            const failed = await startRest();
            const reason = describeError(error);
            return {
              succeeded: false,
              outcome: failed.length === 0 ? reason : `${reason} ${BACKUP_TEXT.restoredNotUp(failed.join(", "))}`,
            };
          }
        }
        // Its data is whole again. A database already started is started again harmlessly, and gets its policy back.
        record = await this.journal({ ...record, phase: "stopped" });
        for (const name of names) this.blocked.delete(name);
        // The backup's own Compose files are back in place, so the stack comes up from them first and its containers
        // are made again at the settings this data belongs with. What those projects own is never started as it is:
        // the image running now may be newer than the data, and starting it on these bytes could change them for
        // good. One that Compose could not bring up is left stopped, and reported below as not back.
        const byCompose = new Set(
          stopping.filter((one) => settings.changed.includes(projectOf(one) ?? "")).map(({ name }) => name),
        );
        // Every part that was asked for has to say it worked. A refusal is not a remark on the side: the data is
        // back, but what was wanted is not what is there, so this restore is not finished.
        const refusals: string[] = settings.refusal === null ? [] : [settings.refusal];
        for (const project of settings.changed) {
          const up = await dependencies.stacks?.run(JOB_ACTION.stackUp, { project, removeData: false });
          if (up?.succeeded !== true) refusals.push(BACKUP_TEXT.stackNotUp(project, up?.outcome ?? ""));
        }
        // Nothing is written off as done until what came back has been looked at.
        const failed = await startRest(byCompose, false);
        const down: string[] = [...failed];
        for (const { member } of members) {
          if (!(await this.waitUp(member.name)) && !down.includes(member.name)) down.push(member.name);
        }
        const complete = down.length === 0 && refusals.length === 0;
        if (complete) {
          await this.closeJournal(record);
        } else {
          // It stays on record, and its containers stay Autoheal's to leave alone: a restart still finds this, and
          // a person or the next restore takes it up from here.
          record = await this.journal({ ...record, phase: "incomplete" }).catch(() => record);
          for (const name of names) this.blocked.set(name, record);
        }
        const when = new Date(manifest.createdAt).toISOString().replace("T", " ").slice(0, 16);
        const notes = [
          complete ? BACKUP_TEXT.restored(when) : BACKUP_TEXT.restoredNotFinished(when),
          ...(down.length === 0 ? [] : [BACKUP_TEXT.restoredNotUp(down.join(", "))]),
          ...refusals,
          ...(settings.note === null ? [] : [settings.note]),
        ];
        return { succeeded: complete, outcome: notes.join(" "), ...recovery };
      } catch (error) {
        const reason = describeError(error);
        if (!written) {
          await this.ask(helper, COPY_COMMAND.discard, {
            folder: `${backupFolderName(details.target)}/${CONTAINER_BACKUP.unfinishedPrefix}${safetyId}`,
          }).catch(() => undefined);
          const failed = await startRest();
          const notes = [
            BACKUP_TEXT.restoreRefused(reason),
            ...(failed.length === 0 ? [] : [BACKUP_TEXT.notStarted(failed.join(", "))]),
          ];
          return { succeeded: false, outcome: notes.join(" ") };
        }
        // Some may have been started for their dumps: blocked, nothing should still be running on this data.
        const uncertain = await this.quiesce(stopping);
        this.release(names);
        for (const name of names) this.blocked.set(name, record);
        const notes = [
          BACKUP_TEXT.restoreFailedStopped(reason, names.join(", ")),
          ...(uncertain.length === 0 ? [] : [BACKUP_TEXT.stillRunning(uncertain.join(", "))]),
        ];
        return { succeeded: false, outcome: notes.join(" "), ...recovery };
      }
    });
  }

  // Every writer stopped and seen to be: the very container the job holds, not running. Returns those it cannot say
  // that of. Stops only what runs, with each one's own grace. A gone container writes nothing.
  private async quiesce(writers: readonly Container[]) {
    const { docker } = this.dependencies;
    const uncertain: string[] = [];
    for (const { name, details } of startOrder(writers).toReversed()) {
      const before = await docker.inspect(name).catch(() => undefined);
      if (before?.State.Running === true && before.Id === details.Id) {
        await docker.stop(name, details.Config.StopTimeout ?? STOP_GRACE_SECONDS).catch(() => undefined);
      }
      const now = await docker.inspect(name).catch(() => undefined);
      const quiet = now === null || (now !== undefined && now.Id === details.Id && now.State.Running !== true);
      if (!quiet) uncertain.push(name);
    }
    return uncertain;
  }

  // A database whose dump would not load goes back to how it was: the copy taken a moment ago, as files. It writes to
  // what any of the writers uses, and some may have been started for their own dumps by now, so all of them stop first.
  private async putBackSafety(
    helper: string,
    writers: readonly Container[],
    safety: BackupManifest,
    safetyFolder: string,
    key: BackupJobDetails["key"],
    jobId: string,
    mounts: readonly DataMount[],
  ) {
    if ((await this.quiesce(writers)).length > 0) throw new Error(BACKUP_TEXT.notQuiet);
    const identity = await this.dependencies.openKey(jobId, key.sealedKey);
    const parent = safetyFolder.split("/")[0]!;
    for (const member of safety.members) {
      for (const mount of member.mounts) {
        const index = mounts.findIndex(({ source, type }) => source === mount.source && type === mount.type);
        await this.ask(helper, COPY_COMMAND.restore, {
          folder: `${parent}/${safety.id}`,
          file: mount.file,
          index,
          identity,
          singleFile: mount.singleFile,
        });
      }
    }
  }

  /** A job from the dashboard. One at a time on a host, and each holds what it stops from everything else. */
  async run(jobId: string, action: string, details: BackupJobDetails): Promise<BackupJobResult> {
    if (this.dependencies.settings.dryRun) return { succeeded: false, outcome: BACKUP_TEXT.dryRun };
    if (this.busy) return { succeeded: false, outcome: BACKUP_TEXT.otherRun };
    this.busy = true;
    try {
      return await this.dependencies.guard.operations.containers(
        async () => {
          const all = await this.containers();
          const scope = this.scopeOf(all, details.target);
          const resources = scope.flatMap(({ name, details: one }) => containerResources(name, one));
          return { all, held: new Set(scope.map(({ name }) => name)), resources: [...new Set(resources)] };
        },
        // What was seen with the lease held is the plan: the whole job runs from it, not from a later look.
        ({ all, held }) =>
          action === JOB_ACTION.restoreContainer
            ? this.restore(jobId, details, all, held)
            : this.backUp(jobId, details, all),
      );
    } catch (error) {
      if (error instanceof Refused || error instanceof HelperImageMissing)
        return { succeeded: false, outcome: error.message };
      return { succeeded: false, outcome: BACKUP_TEXT.restoreRefused(describeError(error)) };
    } finally {
      this.busy = false;
    }
  }
}

type StoredFile = { bytes: number; sha256: string; sourceBytes: number };

/** The Compose project a container belongs to, or undefined where it is not part of one. */
const projectOf = (container: Container) => container.details.Config.Labels?.[COMPOSE_PROJECT_LABEL];

const savedSettingsSchema = z.object({
  projects: z.array(z.string()),
  files: z.array(z.object({ path: z.string(), text: z.string() })),
  // A container of no stack: its settings were saved, but there is no file of its own to put them back into.
  containers: z.array(z.object({ name: z.string() })).default([]),
});

function safeJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A short command's whole output, for when it is small enough to hold. */
async function collect(
  run: (output: Writable) => Promise<{ exitCode: number | null; stderr: string }>,
): Promise<{ exitCode: number | null; stderr: string; text: string }> {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  const { exitCode, stderr } = await run(output);
  return { exitCode, stderr, text: Buffer.concat(chunks).toString("utf8").trim() };
}
