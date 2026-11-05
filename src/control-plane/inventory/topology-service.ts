import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import { HOST_SILENT_AFTER_MILLISECONDS, HOST_STATUS_ACTIVE, JOB_ACTION } from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import {
  operationPreviewAnswerSchema,
  TOPOLOGY_LIMITS,
  topologySnapshotSchema,
  type OperationImpactView,
  type OperationPreviewAnswer,
  type OperationPreviewRequest,
  type PreviewAction,
  type TopologySnapshot,
  type TopologyView,
} from "../../shared/topology.js";
import type { Actor } from "../audit/audit-log.js";
import type { ResourcePermissions } from "../auth/resource-permissions.js";
import { RunnerRelay } from "../container-access/runner-relay.js";
import type { WaitingRunners } from "../container-access/waiting-runners.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { InventoryService } from "./inventory-service.js";

interface Prepared {
  session: string;
  createdAt: number;
  view: OperationImpactView;
}
/** Last reported links for browsing; fresh runner-coordinated scope for mutation review. */
export class TopologyService {
  private readonly relay: RunnerRelay<OperationPreviewRequest, OperationPreviewAnswer>;
  private readonly prepared = new Map<string, Prepared>();
  private readonly cached = new Map<string, { raw: string; snapshot: TopologySnapshot; revision: string }>();
  private pending = 0;
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly inventory: Pick<InventoryService, "containers">,
    private readonly permissions: Pick<ResourcePermissions, "requireJob">,
    runners: Pick<WaitingRunners, "wake">,
    private readonly clock = Date.now,
  ) {
    this.relay = new RunnerRelay(runners);
  }
  private host(hostId: string) {
    const host = this.handle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (!host) throw new DomainError(API_ERRORS.hostNotFound);
    if (host.status !== HOST_STATUS_ACTIVE) throw new DomainError(API_ERRORS.hostRevoked);
    return host;
  }
  view(hostId: string): TopologyView {
    const host = this.host(hostId);
    if (!host.topologyJson) return { hostId, available: false, stale: true, revision: "", snapshot: null };
    let cached = this.cached.get(hostId);
    if (cached?.raw !== host.topologyJson) {
      try {
        const snapshot = topologySnapshotSchema.parse(JSON.parse(host.topologyJson));
        cached = {
          raw: host.topologyJson,
          snapshot,
          revision: sha256Hex(JSON.stringify({ ...snapshot, capturedAt: 0 })),
        };
        this.cached.delete(hostId);
        if (this.cached.size >= 32) this.cached.delete(this.cached.keys().next().value!);
        this.cached.set(hostId, cached);
      } catch {
        return { hostId, available: false, stale: true, revision: "", snapshot: null };
      }
    }
    const now = this.clock();
    return {
      hostId,
      available: true,
      stale:
        !host.lastHeartbeatAt ||
        now - host.lastHeartbeatAt > HOST_SILENT_AFTER_MILLISECONDS ||
        now < cached!.snapshot.capturedAt ||
        now - cached!.snapshot.capturedAt > HOST_SILENT_AFTER_MILLISECONDS,
      revision: cached!.revision,
      snapshot: cached!.snapshot,
    };
  }
  private expire() {
    const now = this.clock();
    for (const [id, prepared] of this.prepared)
      if (now >= prepared.view.expiresAt || now < prepared.createdAt) this.prepared.delete(id);
  }
  async preview(
    actor: Actor,
    session: string,
    hostId: string,
    containerName: string,
    action: PreviewAction,
  ): Promise<OperationImpactView> {
    this.expire();
    this.permissions.requireJob(actor.userId, hostId, containerName, action);
    const host = this.host(hostId);
    const now = this.clock();
    if (
      !host.operationPreviews ||
      host.lastHeartbeatAt === null ||
      now < host.lastHeartbeatAt ||
      now - host.lastHeartbeatAt > HOST_SILENT_AFTER_MILLISECONDS
    )
      throw new DomainError(API_ERRORS.topologyUnavailable);
    if (!this.inventory.containers({ hostId }).some((container) => container.name === containerName))
      throw new DomainError(API_ERRORS.containerNotFound);
    if (this.pending >= TOPOLOGY_LIMITS.relayPending || this.prepared.size >= TOPOLOGY_LIMITS.previews)
      throw new DomainError(API_ERRORS.topologyBusy);
    const id = randomUUID();
    this.pending++;
    try {
      const answer = operationPreviewAnswerSchema.parse(await this.relay.ask(hostId, { id, containerName, action }));
      this.permissions.requireJob(actor.userId, hostId, containerName, action);
      if (this.prepared.size >= TOPOLOGY_LIMITS.previews) throw new DomainError(API_ERRORS.topologyBusy);
      if (answer.ok) {
        for (const member of answer.members) {
          try {
            this.permissions.requireJob(actor.userId, hostId, member.name, action);
          } catch {
            if (!answer.refusals.includes("One or more affected containers are outside your delegated access."))
              answer.refusals.push("One or more affected containers are outside your delegated access.");
          }
        }
      }
      const at = this.clock();
      const view: OperationImpactView = {
        id,
        expiresAt: at + TOPOLOGY_LIMITS.previewTtl,
        hostId,
        containerName,
        action,
        answer,
      };
      if (answer.ok && answer.refusals.length === 0) this.prepared.set(id, { session, createdAt: at, view });
      return structuredClone(view);
    } finally {
      this.pending--;
    }
  }
  /**
   * The runner's word now on what updating a container would touch, for an update run reaching it after the run
   * itself replaced some of the containers a person reviewed. Null where the host cannot say now.
   */
  async refresh(hostId: string, containerName: string): Promise<Extract<OperationPreviewAnswer, { ok: true }> | null> {
    if (!this.host(hostId).operationPreviews || this.pending >= TOPOLOGY_LIMITS.relayPending) return null;
    this.pending++;
    try {
      const request = { id: randomUUID(), containerName, action: JOB_ACTION.update };
      const answer = operationPreviewAnswerSchema.parse(await this.relay.ask(hostId, request));
      return answer.ok ? answer : null;
    } catch {
      return null;
    } finally {
      this.pending--;
    }
  }
  consume(session: string, hostId: string, containerName: string, action: string, previewId: string): string {
    return this.consumeImpact(session, hostId, containerName, action, previewId).answer.fingerprint;
  }
  consumeImpact(
    session: string,
    hostId: string,
    containerName: string,
    action: string,
    previewId: string,
  ): OperationImpactView & { answer: Extract<OperationPreviewAnswer, { ok: true }> } {
    this.expire();
    if (!this.host(hostId).operationPreviews) throw new DomainError(API_ERRORS.topologyUnavailable);
    const prepared = this.prepared.get(previewId);
    if (
      !prepared ||
      prepared.session !== session ||
      prepared.view.hostId !== hostId ||
      prepared.view.containerName !== containerName ||
      prepared.view.action !== action ||
      !prepared.view.answer.ok ||
      prepared.view.answer.refusals.length
    )
      throw new DomainError(API_ERRORS.topologyPreviewExpired);
    this.prepared.delete(previewId);
    return structuredClone(prepared.view) as OperationImpactView & {
      answer: Extract<OperationPreviewAnswer, { ok: true }>;
    };
  }
  take(host: HostRow) {
    return this.relay.take(host.id);
  }
  answer(host: HostRow, id: string, answer: OperationPreviewAnswer) {
    this.relay.answer(host.id, id, operationPreviewAnswerSchema.parse(answer));
  }
  reset() {
    this.relay.reset();
    this.prepared.clear();
    this.cached.clear();
  }
}
