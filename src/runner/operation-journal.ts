import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DockerClient } from "./docker-client.js";

const LABEL = "autoheal.rollback.journal";
const OPERATION = "autoheal.rollback.operation";
const RECORD = "autoheal.rollback.record";
const phases = ["prepared", "restored", "committed", "finished"] as const;
const member = z.object({
  name: z.string().min(1),
  id: z.string().min(1),
  replacementId: z.string().min(1).nullable(),
  running: z.boolean(),
  restore: z.boolean(),
});
const schema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  owner: z.string().min(1),
  phase: z.enum(phases),
  at: z.number().nullable(),
  members: z.array(member).min(1),
});
export type RollbackOperation = z.infer<typeof schema>;
export type RollbackMember = z.infer<typeof member>;
type Store = Pick<DockerClient, "volumes" | "createVolume" | "removeVolume">;

/** Immutable, append-only phase records on the same Docker engine as the checkpoints. No new host mount. */
export class OperationJournal {
  constructor(private readonly docker: Store) {}

  async pending(): Promise<RollbackOperation[]> {
    const latest = new Map<string, RollbackOperation>();
    for (const volume of await this.docker.volumes(LABEL)) {
      if (volume.Labels?.[LABEL] !== "1")
        throw new Error("Unsupported rollback journal version; recovery must be reviewed.");
      const record = schema.parse(JSON.parse(volume.Labels?.[RECORD] ?? ""));
      if (volume.Labels?.[OPERATION] !== record.id || volume.Name !== this.name(record)) {
        throw new Error("Rollback journal identity is invalid; recovery must be reviewed before starting containers.");
      }
      const members = record.members;
      if (
        members[0]!.name !== record.owner ||
        new Set(members.map(({ name }) => name)).size !== members.length ||
        new Set(members.map(({ id }) => id)).size !== members.length ||
        members.some(({ replacementId }) => replacementId !== null && members.some(({ id }) => id === replacementId))
      ) {
        throw new Error("Rollback journal members are invalid; recovery must be reviewed.");
      }
      const before = latest.get(record.id);
      if (
        before !== undefined &&
        JSON.stringify({ ...before, phase: "prepared" }) !== JSON.stringify({ ...record, phase: "prepared" })
      ) {
        throw new Error("Rollback journal phases disagree; recovery must be reviewed.");
      }
      if (before === undefined || phases.indexOf(record.phase) > phases.indexOf(before.phase))
        latest.set(record.id, record);
    }
    const pending = [...latest.values()].filter(({ phase }) => phase !== "finished");
    const owners = new Set<string>();
    for (const record of pending) {
      for (const key of record.members.flatMap(({ name, id, replacementId }) => [
        `name:${name}`,
        `id:${id}`,
        ...(replacementId === null ? [] : [`id:${replacementId}`]),
      ])) {
        if (owners.has(key)) throw new Error("Rollback journal operations overlap; recovery must be reviewed.");
        owners.add(key);
      }
    }
    return pending;
  }

  async find(name: string, id?: string): Promise<RollbackOperation | null> {
    return (
      (await this.pending()).find((record) =>
        record.members.some(
          (member) =>
            member.name === name ||
            member.id === name ||
            member.replacementId === name ||
            (id !== undefined && (member.id === id || member.replacementId === id)),
        ),
      ) ?? null
    );
  }

  async begin(owner: string, members: RollbackMember[], at: number | null): Promise<RollbackOperation> {
    const pending = await this.pending();
    if (
      pending.some((record) =>
        record.members.some((before) =>
          members.some(
            (after) =>
              before.name === after.name ||
              [before.id, before.replacementId].some(
                (id) => id !== null && (id === after.id || id === after.replacementId),
              ),
          ),
        ),
      )
    ) {
      throw new Error("Another rollback already owns part of this group; resume that operation first.");
    }
    const record: RollbackOperation = { version: 1, id: randomUUID(), owner, phase: "prepared", at, members };
    await this.save(record, "prepared");
    return record;
  }

  async save(record: RollbackOperation, phase: RollbackOperation["phase"]): Promise<RollbackOperation> {
    const next = schema.parse({ ...record, phase });
    await this.docker.createVolume(this.name(next), {
      [LABEL]: "1",
      [OPERATION]: next.id,
      [RECORD]: JSON.stringify(next),
    });
    return next;
  }

  async complete(record: RollbackOperation): Promise<void> {
    const committed = await this.save(record, "finished");
    // A tombstone is removed last, and only if every older record was removed. Failed cleanup cannot resurrect prepared state.
    let cleaned = true;
    let volumes;
    try {
      volumes = await this.docker.volumes(`${OPERATION}=${record.id}`);
    } catch {
      return;
    }
    for (const volume of volumes) {
      if (volume.Name === this.name(committed)) continue;
      try {
        await this.docker.removeVolume(volume.Name);
      } catch {
        cleaned = false;
      }
    }
    if (cleaned) await this.docker.removeVolume(this.name(committed)).catch(() => undefined);
  }

  private name(record: RollbackOperation) {
    return `autoheal-rollback-${record.id}-${record.phase}`;
  }
}
