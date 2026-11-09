import { randomUUID } from "node:crypto";
import { AUDIT_ACTIONS, TARGET_HOST } from "../../shared/constants.js";
import { STACK_ASK, type StackAnswer, type StackAsk, type StackRequest } from "../../shared/stacks.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { ContainerAccessService } from "./container-access-service.js";
import { RunnerRelay } from "./runner-relay.js";
import type { WaitingRunners } from "./waiting-runners.js";

const CHANGING_ASKS: ReadonlySet<string> = new Set([STACK_ASK.save, STACK_ASK.restore]);
// What may go to the runner twice: reading the files, their logs or a check of edits changes nothing.
const READS: ReadonlySet<string> = new Set([STACK_ASK.read, STACK_ASK.logs, STACK_ASK.check]);

/** A stack's files, read and written by its runner when an admin asks. Nothing of them is kept here, or logged. */
export class StackService {
  private readonly relay: RunnerRelay<StackRequest, StackAnswer>;

  constructor(
    private readonly access: Pick<ContainerAccessService, "requireHostAdmin">,
    runners: Pick<WaitingRunners, "wake">,
    private readonly auditLog: Pick<AuditLog, "recordUserAction">,
  ) {
    this.relay = new RunnerRelay(runners, (request) => READS.has(request.kind));
  }

  async ask(actor: Actor, hostId: string, project: string, ask: StackAsk): Promise<StackAnswer> {
    this.access.requireHostAdmin(hostId, actor.userId);
    const answer = await this.relay.ask(hostId, { ...ask, id: randomUUID(), project });
    if (CHANGING_ASKS.has(ask.kind) && answer.error === null) {
      const files = "files" in ask ? ask.files.map(({ path }) => path) : [];
      this.auditLog.recordUserAction(
        actor,
        AUDIT_ACTIONS.stackFilesChanged,
        { kind: TARGET_HOST, id: hostId },
        { project, kind: ask.kind, files },
      );
    }
    return answer;
  }

  take(host: Pick<HostRow, "id">) {
    return this.relay.take(host.id);
  }

  answer(host: Pick<HostRow, "id">, requestId: string, answer: StackAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  reset() {
    this.relay.reset();
  }

  resetHost(hostId: string) {
    this.relay.resetHost(hostId);
  }
}
