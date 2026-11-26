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
  private readonly relay: RunnerRelay<FileRequest, FileAnswer>;

  constructor(
    private readonly access: Pick<ContainerAccessService, "require">,
    private readonly auditLog: AuditLog,
    runners: Pick<WaitingRunners, "wake">,
  ) {
    this.relay = new RunnerRelay(runners, (request) => READS.has(request.operation));
  }

  ask(actor: Actor, hostId: string, containerName: string, ask: FileAsk) {
    const container = this.access.require(hostId, containerName, actor.userId);
    if (container.state !== CONTAINER_STATE_RUNNING) {
      throw new DomainError(API_ERRORS.containerNotRunning);
    }
    const request: FileRequest = { id: randomUUID(), containerName, ...ask, requestedBy: actor.username };
    this.audit(actor, hostId, request);
    return this.relay.ask(hostId, request);
  }

  take(host: HostRow): FileRequest[] {
    return this.relay.take(host.id);
  }

  answer(host: HostRow, requestId: string, answer: FileAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  reset() {
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
