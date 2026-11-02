import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { API_ERRORS, type HostView } from "../../shared/api.js";
import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  HOST_KIND,
  HOST_STATUS_ACTIVE,
  HOST_STATUS_REVOKED,
  JOIN_DIRECTORY,
  LOCAL_HOST,
  SYSTEM_ACTOR_LABEL,
  TARGET_HOST,
  TOKEN_HINT_LENGTH,
} from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import { log } from "../../shared/log.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import { newToken, pendingLabel, type HostRow, type HostsService } from "../hosts/hosts-service.js";
import { toHostView } from "../inventory/host-views.js";

export interface LocalRunnerDetails {
  hostId: string;
  // What its runner gives the runner API on loopback, as a runner container gives its own.
  token: string;
}

/**
 * The control plane's own machine as a host it looks after in place, from inside its container. It is the machine's
 * runner host when it had one (the join volume names it), switched with its history; otherwise a new host, named by
 * its first report as a runner added without a name is. Its token is kept sealed, as an SSH host's runner's is.
 */
export class LocalHostService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly secretBox: SecretBox,
    private readonly hostsService: Pick<HostsService, "localMachine" | "labelWhenBack">,
    private readonly clock: () => number,
    private readonly joinDirectory: string = JOIN_DIRECTORY,
  ) {}

  /** This machine's host, ready for its runner; null while it is revoked, which only a person undoes. */
  ensure(): LocalRunnerDetails | null {
    const machine = this.hostsService.localMachine(this.joinDirectory);
    if (machine?.status === HOST_STATUS_REVOKED) {
      return null;
    }
    if (machine?.kind === HOST_KIND.local) {
      return { hostId: machine.id, token: this.tokenOf(machine) };
    }
    const token = newToken();
    return machine === null ? this.added(token) : this.switched(machine, token);
  }

  /** This machine's revoked host back, as the same host with its history and a new token: its runner starts again. */
  reenroll(actor: Actor): HostView {
    const machine = this.hostsService.localMachine(this.joinDirectory);
    if (machine?.kind !== HOST_KIND.local || machine.status !== HOST_STATUS_REVOKED) {
      throw new DomainError(API_ERRORS.notLocalRunner);
    }
    const host = this.withToken(machine.id, newToken(), {
      status: HOST_STATUS_ACTIVE,
      revokedAt: null,
      label: this.hostsService.labelWhenBack(machine),
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostReenrolled,
      { kind: TARGET_HOST, id: host.id },
      {
        label: host.label,
      },
    );
    return toHostView(host, this.clock());
  }

  /** Whether this machine's host is looked after in place, revoked or not. */
  inPlace(): boolean {
    return this.hostsService.localMachine(this.joinDirectory)?.kind === HOST_KIND.local;
  }

  private added(token: string): LocalRunnerDetails {
    const host = this.databaseHandle.database
      .insert(hosts)
      .values({
        id: randomUUID(),
        label: pendingLabel(),
        namedByRunner: true,
        tokenHash: sha256Hex(token),
        tokenHint: token.slice(-TOKEN_HINT_LENGTH),
        enrolledBy: null,
        enrolledAt: this.clock(),
        kind: HOST_KIND.local,
        sshRunnerToken: this.secretBox.seal(token),
      })
      .returning()
      .get();
    this.recordSystem(AUDIT_ACTIONS.hostEnrolled, host);
    log(LOCAL_HOST.added);
    return { hostId: host.id, token };
  }

  // The runner host it was, with its history: the runner container's token opens nothing from now on.
  private switched(machine: HostRow, token: string): LocalRunnerDetails {
    const host = this.withToken(machine.id, token, { kind: HOST_KIND.local });
    this.recordSystem(AUDIT_ACTIONS.hostSwitchedToLocal, host);
    log(LOCAL_HOST.switched);
    return { hostId: host.id, token };
  }

  private withToken(hostId: string, token: string, changes: Partial<HostRow>): HostRow {
    return this.databaseHandle.database
      .update(hosts)
      .set({
        ...changes,
        tokenHash: sha256Hex(token),
        tokenHint: token.slice(-TOKEN_HINT_LENGTH),
        sshRunnerToken: this.secretBox.seal(token),
      })
      .where(eq(hosts.id, hostId))
      .returning()
      .get()!;
  }

  private tokenOf(host: HostRow): string {
    const token = host.sshRunnerToken === null ? null : this.secretBox.open(host.sshRunnerToken);
    if (token === null) {
      throw new Error(LOCAL_HOST.failed(LOCAL_HOST.tokenUnreadable));
    }
    return token;
  }

  private recordSystem(action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS], host: HostRow) {
    this.auditLog.record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: SYSTEM_ACTOR_LABEL,
      action,
      targetKind: TARGET_HOST,
      targetId: host.id,
      details: { label: host.label },
    });
  }
}
