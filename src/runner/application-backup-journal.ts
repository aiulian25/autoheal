import { z } from "zod";
import { applicationBackupResultSchema, type ApplicationBackupResult } from "../shared/application-backups.js";
import type { DockerClient } from "./docker-client.js";
const LABEL = "autoheal.application-backup.journal",
  RECORD = "autoheal.application-backup.record";
const schema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    attempt: z.number().int().nonnegative().default(0),
    uncertainIds: z.array(z.string()).max(64).default([]),
    revision: z.number().int().nonnegative(),
    operation: z.enum(["capture", "drill", "restore"]),
    phase: z.enum(["stopping", "restoring", "restarting"]),
    artifactId: z.uuid(),
    members: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          id: z.string().min(1),
          running: z.boolean(),
          restartPolicy: z
            .object({ Name: z.string(), MaximumRetryCount: z.number().int().nonnegative() })
            .default({ Name: "no", MaximumRetryCount: 0 }),
        }),
      )
      .max(64),
    blocked: z.boolean(),
    acknowledged: z.boolean().default(false),
    result: applicationBackupResultSchema.nullable(),
  })
  .strict();
export type ApplicationJournalRecord = z.infer<typeof schema>;
/** No keys, mount sources or filenames belong in engine metadata. Results survive failed acknowledgements. */
export class ApplicationBackupJournal {
  readonly records = new Map<string, ApplicationJournalRecord>();
  private uncertain = true;
  constructor(private readonly docker: Pick<DockerClient, "volumes" | "createVolume" | "removeVolume">) {}
  async initialize() {
    try {
      const volumes = await this.docker.volumes(LABEL);
      for (const volume of volumes) {
        const record = schema.parse(JSON.parse(volume.Labels?.[RECORD] ?? ""));
        if (volume.Name !== this.name(record)) throw new Error("Invalid application recovery record.");
        const previous = this.records.get(record.id);
        if (!previous || previous.revision < record.revision) this.records.set(record.id, record);
      }
      this.uncertain = false;
    } catch {
      this.uncertain = true;
      throw new Error("Application recovery journal is unreadable; container changes must remain blocked.");
    }
  }
  isBlocked(name: string, id?: string) {
    return (
      this.uncertain ||
      [...this.records.values()].some(
        (record) =>
          record.blocked &&
          record.members.some((member) => member.name === name || member.id === name || member.id === id),
      )
    );
  }
  async save(record: z.input<typeof schema>) {
    const next = schema.parse({ ...record, revision: (this.records.get(record.id)?.revision ?? -1) + 1 });
    await this.docker.createVolume(this.name(next), { [LABEL]: "1", [RECORD]: JSON.stringify(next) });
    this.records.set(next.id, next);
    for (const volume of await this.docker.volumes(LABEL))
      if (volume.Name !== this.name(next) && volume.Name.startsWith(`autoheal-application-state-${next.id}-`))
        await this.docker.removeVolume(volume.Name).catch(() => undefined);
    return next;
  }
  async result(record: ApplicationJournalRecord, result: ApplicationBackupResult, blocked: boolean) {
    return this.save({ ...record, result: applicationBackupResultSchema.parse(result), blocked });
  }
  async acknowledge(id: string) {
    const record = this.records.get(id);
    if (!record || record.blocked) return;
    // Keep a final unblocked tombstone until every older phase is gone. Cleanup failure must not resurrect a block.
    const final = record.acknowledged ? record : await this.save({ ...record, acknowledged: true });
    let cleaned = true;
    for (const volume of await this.docker.volumes(LABEL)) {
      if (volume.Name === this.name(final) || !volume.Name.startsWith(`autoheal-application-state-${id}-`)) continue;
      try {
        await this.docker.removeVolume(volume.Name);
      } catch {
        cleaned = false;
      }
    }
    if (cleaned) {
      await this.docker.removeVolume(this.name(final));
      this.records.delete(id);
    }
  }
  private name(record: ApplicationJournalRecord) {
    return `autoheal-application-state-${record.id}-${record.revision}`;
  }
}
