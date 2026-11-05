import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  APPLICATION_BACKUPS,
  APPLICATION_HELPER_ERRORS,
  applicationBackupTaskSchema,
  type ApplicationBackupTask,
  type ApplicationBackupResult,
  APPLICATION_BOOT_DRILL,
  APPLICATION_BOOT_READINESS,
  APPLICATION_BOOT_TEXT,
  type ApplicationBootEvidence,
} from "../shared/application-backups.js";
import { describeError } from "../shared/errors.js";
import { bootOnClones } from "./application-boot-drill.js";
import { CHECKPOINT, HOST_HELPER, STOP_GRACE_SECONDS } from "../shared/constants.js";
import type { DockerClient } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";
import type { RemedyGuard } from "./remedy-guard.js";
import { containerResources } from "./operation-coordinator.js";
import { operationFingerprint } from "./operation-impact.js";
import { sharesRollbackData, rollbackDataSources } from "./rollback-data.js";
import { dataMountsOf, type DataMount } from "./volume-checkpoints.js";
import { ApplicationBackupJournal, type ApplicationJournalRecord } from "./application-backup-journal.js";

export interface ApplicationBackupClient {
  authorizeApplicationBackup(taskId: string, attempt: number): Promise<boolean>;
  uploadApplicationBackup(taskId: string, artifactId: string, stream: Readable, attempt?: number): Promise<unknown>;
  downloadApplicationBackup(taskId: string, artifactId: string, attempt?: number): Promise<Readable>;
  reportApplicationBackup(result: ApplicationBackupResult): Promise<unknown>;
}
/** The image a helper runs; throws, saying why, when there is none. */
export type HelperImage = () => Promise<string>;

/** Autoheal's image is not on the host: a reason the person is told whole, as it says what to do. */
export class HelperImageMissing extends Error {}

/**
 * Autoheal's image as the control plane names it, on a host with no Autoheal container of its own: pulled there the
 * first time a helper needs it, one pull at a time.
 * ponytail: once there it is kept as it is, so a host can run an older helper than the control plane; a helper
 * that answers in a way the runner does not read fails its copy, and the update waits. Pull again per release if that bites.
 */
export function imageOnHost(docker: Pick<DockerClient, "inspectImage" | "pull">, reference: string): HelperImage {
  let pulling: Promise<void> | null = null;
  return async () => {
    const found = await docker.inspectImage(reference);
    if (found !== null) return found.Id;
    pulling ??= docker.pull(reference).finally(() => {
      pulling = null;
    });
    const failure = await pulling.then(
      () => null,
      (error: unknown) => describeError(error),
    );
    const pulled = await docker.inspectImage(reference);
    if (pulled === null) {
      throw new HelperImageMissing(
        APPLICATION_HELPER_ERRORS.imageMissing(reference, failure ?? APPLICATION_HELPER_ERRORS.notKeptAfterPull),
      );
    }
    return pulled.Id;
  };
}

export interface ApplicationBackupsDependencies {
  docker: DockerClient;
  guard: RemedyGuard;
  selfContainerName: string;
  // The runner's own container's image unless given: on an SSH host, Autoheal's image found on it.
  helperImage?: HelperImage;
  protectedContainers: ReadonlySet<string>;
  dryRun: () => boolean;
  client: ApplicationBackupClient;
  clock?: () => number;
  wait?: (milliseconds: number) => Promise<unknown>;
}
interface Member {
  name: string;
  details: ContainerDetails;
}
interface Discovery {
  members: Member[];
  mounts: DataMount[];
  resources: string[];
  fingerprint: string;
}
const resultSchema = z.object({
  ok: z.boolean(),
  payloadBytes: z.number().optional(),
  payloadSha256: z.string().optional(),
  integrity: z.enum(["metadata-verified", "sqlite-integrity-ok"]).optional(),
});
/** Stops the complete transitive data-writer set; this is not a database-native dump adapter. */
export class ApplicationBackups {
  readonly journal: ApplicationBackupJournal;
  private readonly clock: () => number;
  private active = false;
  private readonly helperImage: HelperImage;
  constructor(private readonly dependencies: ApplicationBackupsDependencies) {
    this.journal = new ApplicationBackupJournal(dependencies.docker);
    this.clock = dependencies.clock ?? Date.now;
    this.helperImage = dependencies.helperImage ?? (() => this.ownImage());
  }
  private async ownImage(): Promise<string> {
    const self = await this.dependencies.docker.inspect(this.dependencies.selfContainerName);
    if (!self?.Image) throw new Error(APPLICATION_HELPER_ERRORS.selfMissing);
    return self.Image;
  }
  // What a crash left of a boot drill: nothing else can be running one as the runner starts.
  private async sweepBootDrills() {
    const { docker } = this.dependencies;
    for (const { Id, Labels } of await docker.containerSummaries()) {
      if (Labels?.[APPLICATION_BOOT_DRILL.label] !== undefined) await docker.remove(Id).catch(() => undefined);
    }
    for (const { Name } of await docker.volumes(APPLICATION_BOOT_DRILL.volumeLabel)) {
      await docker.removeVolume(Name).catch(() => undefined);
    }
  }
  async initialize() {
    await this.journal.initialize();
    await this.sweepBootDrills().catch(() => undefined);
    for (const record of this.journal.records.values()) {
      if (!record.result)
        await this.journal.result(
          record,
          {
            recoveryRequired: true,
            id: record.id,
            attempt: record.attempt,
            artifactId: record.artifactId,
            ok: false,
            message:
              "Runner interrupted application work. Review and explicitly resume recovery; no action was repeated.",
            writers: record.members.map((m) => m.name),
            stopped: record.members.filter((m) => m.running).map((m) => m.name),
          },
          true,
        );
    }
  }
  hasPendingRecovery() {
    return [...this.journal.records.values()].some((record) => record.blocked);
  }
  isBlocked(name: string, id?: string) {
    return this.journal.isBlocked(name, id);
  }
  async flush() {
    for (const record of this.journal.records.values())
      if (record.result) {
        try {
          await this.dependencies.client.reportApplicationBackup(record.result);
          await this.journal.acknowledge(record.id);
        } catch {
          /* The durable result remains report-only work. */
        }
      }
  }
  async discover(name: string): Promise<Discovery> {
    const { docker } = this.dependencies;
    const summaries = await docker.containerSummaries();
    if (summaries.length > 4096) throw new Error("Fleet is too large for bounded application discovery.");
    const all: Member[] = [];
    for (const summary of summaries) {
      if (summary.Labels?.[HOST_HELPER.label] === HOST_HELPER.labelValue) continue;
      const details = await docker.inspect(summary.Id);
      if (details?.Id) all.push({ name: details.Name.replace(/^\//, ""), details });
    }
    const root = all.find((member) => member.name === name || member.details.Id === name);
    if (!root) throw new Error("Application container is missing.");
    const selected = new Set<Member>([root]);
    let changed = true;
    let comparisons = 0;
    while (changed) {
      changed = false;
      for (const candidate of all) {
        if (selected.has(candidate)) continue;
        for (const before of selected) {
          if (++comparisons > 200000) throw new Error("Application writer graph exceeds its discovery bound.");
          if (sharesRollbackData(before.details, candidate.details)) {
            selected.add(candidate);
            changed = true;
            break;
          }
        }
        if (selected.size > APPLICATION_BACKUPS.writers)
          throw new Error("Application has too many shared-data writers.");
      }
    }
    const members = [...selected].sort((a, b) => a.name.localeCompare(b.name));
    const mounts = [
      ...new Map(
        members.flatMap((member) =>
          dataMountsOf(member.details).map((mount) => [`${mount.type}:${mount.source}`, mount] as const),
        ),
      ).values(),
    ];
    if (!mounts.length || mounts.length > APPLICATION_BACKUPS.mounts)
      throw new Error("Application mount coverage is unsupported.");
    // Overlapping nonidentical roots would replay two potentially conflicting images into one filesystem tree.
    for (const [index, left] of mounts.entries())
      for (const right of mounts.slice(index + 1))
        if (
          left.type === "bind" &&
          right.type === "bind" &&
          (left.source.startsWith(`${right.source}/`) || right.source.startsWith(`${left.source}/`))
        )
          throw new Error("Overlapping application mount roots need an explicit storage plan.");
    let stopBudget = 0;
    for (const member of members) {
      const timeout = member.details.Config.StopTimeout ?? STOP_GRACE_SECONDS;
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30 || member.details.State.Restarting)
        throw new Error("Application stop timeout must be finite and at most 30 seconds.");
      if (member.details.State.Running) stopBudget += timeout;
    }
    if (stopBudget > 300) throw new Error("Application shutdown exceeds the bounded five-minute stop budget.");
    for (const mount of mounts) {
      if (mount.type !== "volume")
        throw new Error(
          "Initial application plans require local Docker directory volumes; bind or remote storage cannot prove complete writer isolation.",
        );
      const volume = await docker.inspectVolume(mount.source);
      if (!volume || volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length)
        throw new Error("Opaque, aliased or remote volume drivers are unsupported for application consistency.");
    }
    mounts.sort((a, b) => `${a.type}:${a.source}:${a.target}`.localeCompare(`${b.type}:${b.source}:${b.target}`));
    const resources = [
      ...new Set(
        members.flatMap((member) => [
          ...containerResources(member.name, member.details),
          ...dataMountsOf(member.details).map(
            (mount) => `application-mount:${member.details.Id}:${mount.type}:${mount.source}:${mount.target}`,
          ),
          ...rollbackDataSources(member.details).map((source) => `application-data:${source.type}:${source.source}`),
        ]),
      ),
    ].sort();
    return { members, mounts, resources, fingerprint: operationFingerprint(resources) };
  }
  async run(input: ApplicationBackupTask) {
    const task = applicationBackupTaskSchema.parse(input);
    if (this.active) throw new Error("Another application backup task is active.");
    this.active = true;
    try {
      const before = this.journal.records.get(task.id);
      if (before) await this.settleHelpers(task.id);
      if (before?.result && !task.resume) {
        await this.flush();
        return;
      }
      if (task.expiresAt <= this.clock()) throw new Error("Application task expired before admission.");
      await this.dependencies.guard.operations.containers(
        () => this.discover(task.definition.containerName),
        async (scope) => {
          if (task.operation === "preview") {
            const protectedName = scope.members.find((m) => this.dependencies.protectedContainers.has(m.name));
            await this.dependencies.client.reportApplicationBackup({
              id: task.id,
              attempt: task.attempt ?? 0,
              artifactId: task.artifactId,
              ok: !protectedName,
              message: protectedName
                ? "A protected container belongs to this writer group."
                : "Review the complete writer group. Restore stops every listed service and replaces all covered writable data.",
              writers: scope.members.map((m) => m.name),
              stopped: [],
              fingerprint: scope.fingerprint,
            });
            return;
          }
          if (task.automatic && scope.members.some((member) => this.dependencies.guard.maintenanceHeld(member.name)))
            throw new Error("Scheduled application backup is held by maintenance.");
          if (this.dependencies.dryRun()) throw new Error("Application backup mutation is disabled in dry run.");
          if (scope.members.some((m) => this.dependencies.protectedContainers.has(m.name)))
            throw new Error("A protected container belongs to the application group.");
          if (task.expectedFingerprint && scope.fingerprint !== task.expectedFingerprint)
            throw new Error("The reviewed application writer group changed. Request a fresh preview.");
          // Found before anything is recorded or stopped: without it there is nothing to copy with.
          await this.helperImage();
          if (scope.members.some((m) => this.isBlocked(m.name, m.details.Id) && !before))
            throw new Error("Application recovery must be resumed before another task.");
          if (task.operation === "drill") {
            await this.executeDrill(task, scope);
            return;
          }
          if (task.operation === "boot-drill") {
            await this.executeBootDrill(task, scope);
            return;
          }
          let record =
            (before ? await this.journal.save({ ...before, attempt: task.attempt ?? 0, result: null }) : null) ??
            (await this.journal.save({
              version: 1,
              id: task.id,
              attempt: task.attempt ?? 0,
              revision: 0,
              operation: task.operation,
              artifactId: task.artifactId,
              phase: "stopping",
              blocked: true,
              members: scope.members.map((m) => ({
                name: m.name,
                id: m.details.Id!,
                running: !!m.details.State.Running,
                restartPolicy: {
                  Name: m.details.HostConfig?.RestartPolicy?.Name || "no",
                  MaximumRetryCount: m.details.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0,
                },
              })),
              result: null,
            }));
          if (
            record.members.some(
              (m) => !scope.members.some((current) => current.details.Id === m.id && current.name === m.name),
            )
          )
            throw new Error("Recovery container identities changed; manual recovery is required.");
          if (before && task.resume && task.operation === "capture") {
            const failed = await this.restart(record);
            await this.journal.result(
              record,
              {
                id: task.id,
                attempt: task.attempt ?? 0,
                artifactId: task.artifactId,
                ok: false,
                message:
                  "Interrupted capture was not repeated; originally running writers were restarted where possible.",
                writers: record.members.map((m) => m.name),
                stopped: failed,
              },
              failed.length > 0,
            );
            await this.flush();
            return;
          }
          for (const member of record.members) this.dependencies.guard.hold(member.name);
          let dataStarted = record.phase === "restoring" || record.phase === "restarting";
          try {
            // Clone verification happens before any live writer stops or data is replaced.
            if (task.operation === "restore") await this.drill(task, scope);
            if (task.automatic && scope.members.some((member) => this.dependencies.guard.maintenanceHeld(member.name)))
              throw new Error("Maintenance began during application preparation.");
            if (!(await this.dependencies.client.authorizeApplicationBackup(task.id, task.attempt ?? 0)))
              throw new Error("Application admission authorization changed before stopping writers.");
            for (const member of record.members) {
              await this.dependencies.docker.setRestartPolicy(member.id, { Name: "no", MaximumRetryCount: 0 });
              if ((await this.dependencies.docker.inspect(member.id))?.HostConfig?.RestartPolicy?.Name !== "no")
                throw new Error("Could not disable writer auto-restart before application data work.");
            }
            for (const member of record.members) {
              const current = await this.dependencies.docker.inspect(member.id);
              if (!current) throw new Error("A writer disappeared before quiesce.");
              if (current.State.Running) {
                record = await this.journal.save({ ...record, uncertainIds: [...record.uncertainIds, member.id] });
                await this.dependencies.docker.stop(member.id, current.Config.StopTimeout ?? STOP_GRACE_SECONDS);
                const stopped = await this.dependencies.docker.inspect(member.id);
                if (stopped?.State.Running !== false) throw new Error("Writer shutdown state is uncertain.");
                record = await this.journal.save({
                  ...record,
                  uncertainIds: record.uncertainIds.filter((id) => id !== member.id),
                });
                if (stopped.State.OOMKilled || stopped.State.ExitCode !== 0)
                  throw new Error("A writer did not exit cleanly; application consistency cannot be promised.");
              }
            }
            // Re-discover after all stops to catch external actors adding a writer while shutdown awaited.
            if ((await this.discover(task.definition.containerName)).fingerprint !== scope.fingerprint)
              throw new Error("Application writer group changed during shutdown.");
            let delivered: { payloadBytes: number; payloadSha256: string } | undefined;
            if (task.operation === "capture")
              delivered = await this.capture(task, scope, task.artifactId, task.recipient);
            else {
              if (!task.identity || !task.safetyArtifactId || !task.safetyRecipient)
                throw new Error("Restore key or safety backup binding is missing.");
              if (!dataStarted) await this.capture(task, scope, task.safetyArtifactId, task.safetyRecipient);
              record = await this.journal.save({ ...record, phase: "restoring" });
              dataStarted = true;
              await this.apply(task, scope);
            }
            record = await this.journal.save({ ...record, phase: "restarting" });
            const stopped = await this.restart(record);
            if (stopped.length) throw new Error("Some originally running writers could not restart.");
            const result: ApplicationBackupResult = {
              id: task.id,
              attempt: task.attempt ?? 0,
              artifactId: task.artifactId,
              ok: true,
              message:
                task.operation === "capture"
                  ? "Encrypted application backup captured after all writers exited cleanly."
                  : "Reviewed application data restored and originally running writers restarted.",
              writers: record.members.map((m) => m.name),
              stopped: [],
              ...delivered,
              fingerprint: scope.fingerprint,
              ...(task.operation === "restore" ? { restored: true } : {}),
              ...(task.operation === "capture" ? this.imageOf(task, scope) : {}),
              integrity:
                task.operation === "restore" && task.definition.sqlite ? "sqlite-integrity-ok" : "metadata-verified",
            };
            record = await this.journal.result(record, result, false);
          } catch {
            const stopped = dataStarted
              ? record.members.filter((m) => m.running).map((m) => m.name)
              : await this.restart(record);
            record = await this.journal.result(
              record,
              {
                id: task.id,
                attempt: task.attempt ?? 0,
                artifactId: task.artifactId,
                ok: false,
                recoveryRequired: dataStarted || stopped.length > 0,
                message: dataStarted
                  ? "Application restore or restart did not finish. Data recovery remains blocked; resume this restore explicitly."
                  : "Application quiesce/copy failed. Originally running writers were restarted where possible.",
                writers: record.members.map((m) => m.name),
                stopped,
              },
              dataStarted || stopped.length > 0,
            );
          } finally {
            for (const member of record.members) this.dependencies.guard.release(member.name);
            await this.dependencies.guard.persisted();
          }
          await this.flush();
        },
      );
    } catch (error) {
      if (!this.journal.records.has(task.id))
        await this.dependencies.client.reportApplicationBackup({
          id: task.id,
          attempt: task.attempt ?? 0,
          artifactId: task.artifactId,
          ok: false,
          message:
            error instanceof HelperImageMissing
              ? error.message
              : "Application task was refused before changing live data; review capability, scope, quota and recovery state.",
          writers: [],
          stopped: [],
        });
      else {
        const record = this.journal.records.get(task.id)!;
        if (task.resume && record.attempt !== (task.attempt ?? 0)) {
          await this.journal.result(
            { ...record, attempt: task.attempt ?? 0 },
            {
              id: task.id,
              attempt: task.attempt ?? 0,
              artifactId: task.artifactId,
              ok: false,
              recoveryRequired: true,
              message:
                "Recovery could not settle its previous helper or verify its identities. Keep writers blocked and review Docker state before retrying.",
              writers: record.members.map((member) => member.name),
              stopped: record.members.filter((member) => member.running).map((member) => member.name),
            },
            true,
          );
        }
        await this.flush();
      }
    } finally {
      this.active = false;
    }
  }
  private async restart(record: ApplicationJournalRecord) {
    await this.settleHelpers(record.id);
    const failed: string[] = [];
    for (const member of record.members) {
      try {
        const current = await this.dependencies.docker.inspect(member.id);
        if (!current) throw new Error("Missing original writer.");
        if (record.uncertainIds.includes(member.id) && current.State.Running)
          throw new Error("A previous stop is still uncertain; keep this writer blocked.");
        await this.dependencies.docker.setRestartPolicy(member.id, member.restartPolicy);
        const restoredPolicy = (await this.dependencies.docker.inspect(member.id))?.HostConfig?.RestartPolicy;
        if (
          restoredPolicy?.Name !== member.restartPolicy.Name ||
          (restoredPolicy.MaximumRetryCount ?? 0) !== member.restartPolicy.MaximumRetryCount
        )
          throw new Error("Writer restart policy was not restored.");
        if (!member.running) continue;
        if (!current.State.Running) await this.dependencies.docker.start(member.id);
        if (!(await this.dependencies.docker.inspect(member.id))?.State.Running)
          throw new Error("Writer stayed stopped.");
      } catch {
        failed.push(member.name);
      }
    }
    return failed;
  }
  private async helper(
    taskId: string,
    scope: Discovery,
    artifact: string,
    mode: "capture" | "restore" | "drill",
    recipient?: string,
    identity?: string,
    sqlite: ApplicationBackupTask["definition"]["sqlite"] = null,
  ) {
    const { docker } = this.dependencies;
    const image = await this.helperImage();
    const helper = `autoheal-application-helper-${randomUUID()}`;
    const mount = (m: DataMount, index: number) => ({
      Type: m.type,
      Source: m.source,
      Target: `/application/${index}`,
      ReadOnly: mode === "capture",
      ...(m.type === "volume" ? { VolumeOptions: { NoCopy: true } } : {}),
    });
    await docker.create(helper, {
      Image: image,
      Cmd: ["application-copy", "wait"],
      User: HOST_HELPER.user,
      Labels: {
        [HOST_HELPER.label]: HOST_HELPER.labelValue,
        "autoheal.application-backup.task": taskId,
        "autoheal.application-backup.group": scope.fingerprint,
        "autoheal.application-backup.mode": mode,
      },
      NetworkDisabled: true,
      Healthcheck: { Test: [HOST_HELPER.noHealthcheck] },
      HostConfig: {
        Mounts: [
          ...scope.mounts.map(mount),
          {
            Type: "volume",
            Source: artifact,
            Target: "/artifact",
            ReadOnly: mode !== "capture",
            VolumeOptions: { NoCopy: true },
          },
        ],
        Tmpfs: { "/work": "rw,nosuid,nodev,noexec,size=73400320,mode=0700" },
        ReadonlyRootfs: true,
        CapDrop: [HOST_HELPER.allCapabilities],
        CapAdd: [...CHECKPOINT.capabilities],
        SecurityOpt: [HOST_HELPER.noNewPrivileges, HOST_HELPER.noSelinuxLabel],
        NetworkMode: HOST_HELPER.network,
        Memory: CHECKPOINT.memoryBytes,
        PidsLimit: HOST_HELPER.pidsLimit,
      },
    });
    try {
      await docker.start(helper);
      const command = [
        "/nodejs/bin/node",
        "/app/dist/server/main.js",
        "application-copy",
        mode,
        String(scope.mounts.length),
        ...(recipient ? [recipient, scope.fingerprint] : [scope.fingerprint]),
      ];
      const response =
        mode === "capture"
          ? await docker.runCommand(helper, command, 8192)
          : await docker.runInputCommand(
              helper,
              command,
              Buffer.from(
                JSON.stringify({
                  identity,
                  sqlite,
                  index: sqlite ? scope.mounts.findIndex((m) => m.target === sqlite.mountTarget) : -1,
                }),
              ),
              8192,
            );
      const result = resultSchema.parse(JSON.parse(response.stdout.trim()));
      if (response.exitCode !== 0 || response.truncated || !result.ok)
        throw new Error("Application helper verification failed.");
      return { helper, result };
    } catch (error) {
      await docker.stop(helper, STOP_GRACE_SECONDS).catch(() => undefined);
      await docker.removeStopped(helper).catch(() => undefined);
      throw error;
    }
  }
  private async settleHelpers(taskId: string) {
    for (const summary of await this.dependencies.docker.containerSummaries()) {
      if (summary.Labels?.["autoheal.application-backup.task"] !== taskId) continue;
      const current = await this.dependencies.docker.inspect(summary.Id);
      if (current?.State.Running) await this.dependencies.docker.stop(summary.Id, STOP_GRACE_SECONDS);
      if ((await this.dependencies.docker.inspect(summary.Id))?.State.Running)
        throw new Error("An application data helper is still running; recovery remains blocked.");
      if (await this.dependencies.docker.inspect(summary.Id)) await this.dependencies.docker.removeStopped(summary.Id);
    }
  }
  private async removeHelper(helper: string) {
    await this.dependencies.docker.stop(helper, STOP_GRACE_SECONDS);
    await this.dependencies.docker.removeStopped(helper);
  }
  private async capture(task: ApplicationBackupTask, scope: Discovery, artifactId: string, recipient: string) {
    const volume = `autoheal-application-artifact-${artifactId}`;
    const { docker, client } = this.dependencies;
    await docker.createVolume(volume, { "autoheal.application-backup.artifact": artifactId });
    const { helper } = await this.helper(task.id, scope, volume, "capture", recipient);
    try {
      let payloadBytes = 0;
      const hash = createHash("sha256"),
        source = await docker.getArchiveStream(helper, "/artifact/payload.age");
      const measured = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          payloadBytes += chunk.length;
          if (payloadBytes > APPLICATION_BACKUPS.payloadBytes)
            cb(new Error("Encrypted application artifact exceeds quota."));
          else {
            hash.update(chunk);
            cb(null, chunk);
          }
        },
      });
      const forwarding = pipeline(source, measured);
      try {
        await Promise.all([
          forwarding,
          client.uploadApplicationBackup(task.id, artifactId, measured, task.attempt ?? 0),
        ]);
      } finally {
        source.destroy();
        measured.destroy();
        await forwarding.catch(() => undefined);
      }
      return { payloadBytes, payloadSha256: hash.digest("hex") };
    } finally {
      await this.removeHelper(helper);
      await docker.removeVolume(volume).catch(() => undefined);
    }
  }
  private async download(task: ApplicationBackupTask) {
    const { docker, client } = this.dependencies;
    const volume = `autoheal-application-download-${task.id}`;
    await docker.createVolume(volume, {
      "autoheal.application-backup.download": task.id,
      // A boot drill's copy is named and swept with its clones if it cannot be removed. A restore's is left to its journal.
      ...(task.operation === "boot-drill" ? { [APPLICATION_BOOT_DRILL.volumeLabel]: task.id } : {}),
    });
    const image = await this.helperImage();
    const helper = `autoheal-application-download-${randomUUID()}`;
    await docker.create(helper, {
      Image: image,
      Cmd: ["application-copy", "wait"],
      User: HOST_HELPER.user,
      Labels: { [HOST_HELPER.label]: HOST_HELPER.labelValue },
      NetworkDisabled: true,
      HostConfig: {
        Mounts: [{ Type: "volume", Source: volume, Target: "/artifact", VolumeOptions: { NoCopy: true } }],
        ReadonlyRootfs: true,
        CapDrop: [HOST_HELPER.allCapabilities],
        SecurityOpt: [HOST_HELPER.noNewPrivileges],
        NetworkMode: HOST_HELPER.network,
        Memory: CHECKPOINT.memoryBytes,
        PidsLimit: HOST_HELPER.pidsLimit,
      },
    });
    try {
      await docker.start(helper);
      await docker.putArchiveStream(
        helper,
        "/artifact",
        await client.downloadApplicationBackup(task.id, task.artifactId, task.attempt ?? 0),
      );
    } finally {
      await this.removeHelper(helper);
    }
    return volume;
  }
  private imageOf(task: ApplicationBackupTask, scope: Discovery) {
    const image = scope.members.find(({ name }) => name === task.definition.containerName)?.details.Image;
    return image === undefined ? {} : { imageId: image };
  }
  private async drill(
    task: ApplicationBackupTask,
    scope: Discovery,
    withClones: (mounts: DataMount[]) => Promise<void> = async () => undefined,
  ) {
    const { docker } = this.dependencies;
    const volume = await this.download(task);
    const clones: string[] = [];
    try {
      const mounts: DataMount[] = [];
      for (const [i, mount] of scope.mounts.entries()) {
        const name = `autoheal-application-drill-${task.id}-${i}`;
        await docker.createVolume(name, { [APPLICATION_BOOT_DRILL.volumeLabel]: task.id });
        clones.push(name);
        mounts.push({ type: "volume", source: name, target: mount.target });
      }
      const { helper, result } = await this.helper(
        task.id,
        { ...scope, mounts },
        volume,
        "drill",
        undefined,
        task.identity,
        task.definition.sqlite,
      );
      await this.removeHelper(helper);
      await withClones(mounts);
      return result;
    } finally {
      for (const name of clones) await docker.removeVolume(name).catch(() => undefined);
      await docker.removeVolume(volume).catch(() => undefined);
    }
  }
  /** Whatever becomes of it, nothing of the live application or the backup changes: only this drill's evidence. */
  private async executeBootDrill(task: ApplicationBackupTask, scope: Discovery) {
    const { docker, guard } = this.dependencies;
    const recipe = task.definition.bootDrill!;
    const user = scope.members.find(({ name }) => name === task.definition.containerName)?.details.Config.User ?? "";
    let evidence: ApplicationBootEvidence = {
      imageId: task.imageId ?? null,
      readySeconds: recipe.readySeconds,
      readiness: null,
      problem: null,
      logs: null,
      left: [],
    };
    const wait = this.dependencies.wait ?? ((milliseconds) => delay(milliseconds));
    const restored = await this.drill(task, scope, async (mounts) => {
      evidence = await bootOnClones(
        { docker, guard, wait, clock: this.clock },
        {
          taskId: task.id,
          imageId: task.imageId ?? null,
          user,
          volumes: mounts.map(({ source, target }) => ({ source, target })),
          recipe,
        },
      );
    }).catch((error: unknown) => {
      evidence = { ...evidence, problem: describeError(error).slice(0, APPLICATION_BOOT_DRILL.problemCharacters) };
      return null;
    });
    const volumesLeft = await docker.volumes(APPLICATION_BOOT_DRILL.volumeLabel).catch(() => null);
    const left = [
      ...evidence.left,
      ...(volumesLeft ?? [])
        .filter(({ Labels }) => Labels?.[APPLICATION_BOOT_DRILL.volumeLabel] === task.id)
        .map(({ Name }) => Name),
    ].slice(0, APPLICATION_BOOT_DRILL.leftListed);
    const ok = restored !== null && evidence.problem === null;
    const proven = evidence.readiness === APPLICATION_BOOT_READINESS.healthy;
    const passedMessage = proven ? APPLICATION_BOOT_TEXT.passed : APPLICATION_BOOT_TEXT.notProven;
    const record = await this.journal.save({
      version: 1,
      id: task.id,
      attempt: task.attempt ?? 0,
      revision: 0,
      operation: "drill",
      artifactId: task.artifactId,
      phase: "restarting",
      blocked: false,
      members: [],
      result: {
        id: task.id,
        attempt: task.attempt ?? 0,
        artifactId: task.artifactId,
        ok,
        message: ok ? passedMessage : APPLICATION_BOOT_TEXT.failed(evidence.problem ?? ""),
        writers: scope.members.map((m) => m.name),
        stopped: [],
        ...(restored === null ? {} : { integrity: restored.integrity }),
        boot: { ...evidence, left },
      },
    });
    await this.dependencies.client.reportApplicationBackup(record.result!);
    await this.journal.acknowledge(record.id);
  }
  private async executeDrill(task: ApplicationBackupTask, scope: Discovery) {
    const result = await this.drill(task, scope);
    const record = await this.journal.save({
      version: 1,
      id: task.id,
      attempt: task.attempt ?? 0,
      revision: 0,
      operation: "drill",
      artifactId: task.artifactId,
      phase: "restarting",
      blocked: false,
      members: [],
      result: {
        id: task.id,
        attempt: task.attempt ?? 0,
        artifactId: task.artifactId,
        ok: true,
        message:
          "Encrypted backup restored only into isolated clone volumes; integrity verified. Live mounts were unchanged.",
        writers: scope.members.map((m) => m.name),
        stopped: [],
        integrity: result.integrity,
      },
    });
    await this.dependencies.client.reportApplicationBackup(record.result!);
    await this.journal.acknowledge(record.id);
  }
  private async apply(task: ApplicationBackupTask, scope: Discovery) {
    const volume = await this.download(task);
    try {
      const { helper } = await this.helper(task.id, scope, volume, "restore", undefined, task.identity);
      await this.removeHelper(helper);
    } finally {
      await this.dependencies.docker.removeVolume(volume).catch(() => undefined);
    }
  }
}
