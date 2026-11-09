import { randomUUID } from "node:crypto";
import type { VolumeLookAnswer, VolumeLookRequest } from "../../shared/volumes.js";
import type { Actor } from "../audit/audit-log.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { ContainerAccessService } from "./container-access-service.js";
import { RunnerRelay } from "./runner-relay.js";
import type { WaitingRunners } from "./waiting-runners.js";

/** What a volume holds, read by its runner when an admin looks. Nothing of it is kept here. */
export class VolumeLookService {
  private readonly relay: RunnerRelay<VolumeLookRequest, VolumeLookAnswer>;

  constructor(
    private readonly access: Pick<ContainerAccessService, "requireHostAdmin">,
    runners: Pick<WaitingRunners, "wake">,
  ) {
    this.relay = new RunnerRelay(runners);
  }

  read(actor: Actor, hostId: string, name: string): Promise<VolumeLookAnswer> {
    this.access.requireHostAdmin(hostId, actor.userId);
    return this.relay.ask(hostId, { id: randomUUID(), name });
  }

  take(host: Pick<HostRow, "id">) {
    return this.relay.take(host.id);
  }

  answer(host: Pick<HostRow, "id">, requestId: string, answer: VolumeLookAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  reset() {
    this.relay.reset();
  }

  resetHost(hostId: string) {
    this.relay.resetHost(hostId);
  }
}
