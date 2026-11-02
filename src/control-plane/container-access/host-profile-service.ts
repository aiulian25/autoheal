import { randomUUID } from "node:crypto";
import type { HostProfileAnswer, HostProfileRequest } from "../../shared/protocol.js";
import type { Actor } from "../audit/audit-log.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { ContainerAccessService } from "./container-access-service.js";
import { RunnerRelay } from "./runner-relay.js";
import type { WaitingRunners } from "./waiting-runners.js";

/** How a host is set up, worked out by its runner when an admin looks. Nothing of it is kept here. */
export class HostProfileService {
  private readonly relay: RunnerRelay<HostProfileRequest, HostProfileAnswer>;

  constructor(
    private readonly access: Pick<ContainerAccessService, "requireHostAdmin">,
    runners: Pick<WaitingRunners, "wake">,
  ) {
    this.relay = new RunnerRelay(runners);
  }

  read(actor: Actor, hostId: string): Promise<HostProfileAnswer> {
    this.access.requireHostAdmin(hostId, actor.userId);
    return this.relay.ask(hostId, { id: randomUUID() });
  }

  take(host: Pick<HostRow, "id">) {
    return this.relay.take(host.id);
  }

  answer(host: Pick<HostRow, "id">, requestId: string, answer: HostProfileAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  reset() {
    this.relay.reset();
  }
}
