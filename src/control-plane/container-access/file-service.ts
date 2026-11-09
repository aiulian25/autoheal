import type { ResourceMember } from "../auth/resource-permissions.js";
import { randomUUID } from "node:crypto";
import { API_ERRORS } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  CONTAINER_STATE_RUNNING,
  FILE_OPERATION,
  TARGET_CONTAINER,
  type FileOperation,
} from "../../shared/constants.js";
import type { FileAnswer, FileRequest } from "../../shared/protocol.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { ContainerAccessService } from "./container-access-service.js";
import { RunnerRelay } from "./runner-relay.js";
import type { WaitingRunners } from "./waiting-runners.js";

/** What a person asks of a container's files: an operation on a path, a rename's new path, a write's content. */
export interface FileAsk {
  operation: FileOperation;
  path: string;
  to: string | null;
  content: string | null;
}

// A listing changes nothing and says little: only reading a file and changing one are on record.
const UNAUDITED = new Set<FileOperation>([FILE_OPERATION.list]);
// What may go to the runner twice: a folder listed or a file read again changes nothing.
const READS = new Set<FileOperation>([FILE_OPERATION.list, FILE_OPERATION.read]);

/**
 * A container's files, reached through its runner, which hears of each request at once; the person's answer
 * waits for the runner's. Contents pass through, never kept.
 */
export class FileService {
  private readonly authorizations = new Map<
    string,
    { hostId: string; containerName: string; userId: string; tokenHash: string }
  >();
  private readonly relay: RunnerRelay<FileRequest, FileAnswer>;

  constructor(
    private readonly access: Pick<ContainerAccessService, "require"> &
      Partial<Pick<ContainerAccessService, "operatorUserId" | "authorizeOperator">>,
    private readonly auditLog: AuditLog,
    runners: Pick<WaitingRunners, "wake">,
  ) {
    this.relay = new RunnerRelay(runners, (request) => READS.has(request.operation));
  }

  ask(actor: Actor, hostId: string, containerName: string, ask: FileAsk, tokenHash?: string) {
    const container = this.access.require(hostId, containerName, actor.userId, "files");
    if (container.state !== CONTAINER_STATE_RUNNING) {
      throw new DomainError(API_ERRORS.containerNotRunning);
    }
    const operatorUserId = this.access.operatorUserId?.(actor.userId);
    if (operatorUserId && !tokenHash) throw new DomainError(API_ERRORS.resourceForbidden);
    const request: FileRequest = {
      id: randomUUID(),
      containerName,
      ...ask,
      requestedBy: actor.username,
      ...(operatorUserId ? { operatorUserId } : {}),
    };
    if (operatorUserId)
      this.authorizations.set(request.id, { hostId, containerName, userId: operatorUserId, tokenHash: tokenHash! });
    this.audit(actor, hostId, request);
    return this.relay
      .ask(hostId, request)
      .then((answer) => {
        if (
          operatorUserId &&
          !this.authorizeOperator({ id: hostId } as HostRow, request.id, [
            { name: containerName, composeProject: container.composeProject },
          ])
        )
          throw new DomainError(API_ERRORS.resourceForbidden);
        return answer;
      })
      .finally(() => this.authorizations.delete(request.id));
  }

  authorizeOperator(host: HostRow, requestId: string, members: readonly ResourceMember[]): boolean {
    const owner = this.authorizations.get(requestId);
    return (
      owner !== undefined &&
      owner.hostId === host.id &&
      (this.access.authorizeOperator?.(host.id, owner.containerName, owner.userId, "files", members, owner.tokenHash) ??
        false)
    );
  }

  take(host: HostRow): FileRequest[] {
    return this.relay.take(
      host.id,
      (request) => request.operatorUserId === undefined || host.resourcePermissions === true,
    );
  }

  answer(host: HostRow, requestId: string, answer: FileAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  reset() {
    this.authorizations.clear();
    this.relay.reset();
  }

  resetHost(hostId: string) {
    this.relay.resetHost(hostId);
  }

  private audit(actor: Actor, hostId: string, request: FileRequest) {
    if (UNAUDITED.has(request.operation)) {
      return;
    }
    const action = request.operation === FILE_OPERATION.read ? AUDIT_ACTIONS.fileRead : AUDIT_ACTIONS.fileChanged;
    this.auditLog.recordUserAction(
      actor,
      action,
      { kind: TARGET_CONTAINER, id: `${hostId}/${request.containerName}` },
      { hostId, operation: request.operation, path: request.path, to: request.to },
    );
  }
}
