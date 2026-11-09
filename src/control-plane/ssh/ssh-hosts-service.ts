import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  API_ERRORS,
  type HostHealthView,
  type HostView,
  type PendingSshHostView,
  type SshDockerReadiness,
  type SshHostDetailsView,
} from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  DEFAULT_SELF_CONTAINER_NAME,
  HOST_KIND,
  HOST_STATUS_ACTIVE,
  SSH_KEY,
  SSH_READINESS,
  SSH_STATE,
  SSH_TEXT,
  TARGET_HOST,
  TOKEN_HINT_LENGTH,
  type RootMethod,
  type SshState,
} from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import { DEFAULT_SSH_HOST_SETTINGS, sshHostSettingsSchema, type SshHostSettings } from "../../shared/ssh-hosts.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { newToken } from "../../shared/join-code.js";
import { toHostView } from "../inventory/host-views.js";
import type { SshKeysService } from "./ssh-keys-service.js";
import { probeSsh, type SshProbe, type SshTarget } from "./ssh-session.js";

export interface SshHostRequest {
  label: string;
  address: string;
  port: number;
  user: string;
  keyId: string;
}

/**
 * What a host's embedded runner is built from: its label, its settings, the token it reports with, and the root
 * password it runs root commands with (null while none is saved).
 */
export interface SshRunnerDetails {
  label: string;
  settings: SshHostSettings;
  token: string;
  root: { method: RootMethod; password: string } | null;
}

interface Pending {
  request: SshHostRequest;
  hostKey: { key: string; fingerprint: string };
  docker: SshDockerReadiness;
  // The runner host this one becomes, its history kept; null for a new host.
  switching: string | null;
  actorId: string;
  expiresAt: number;
}

// What a failed probe means for the person adding or changing a host.
const PROBE_ERRORS: Partial<Record<SshState, (typeof API_ERRORS)[keyof typeof API_ERRORS]>> = {
  [SSH_STATE.authenticationFailed]: API_ERRORS.sshHostRefusedKey,
  [SSH_STATE.hostKeyChanged]: API_ERRORS.sshHostKeyMismatch,
  [SSH_STATE.unreachable]: API_ERRORS.sshHostUnreachable,
};

/** What the readiness command printed: one mark per line. */
export function readinessOf(output: string | null): SshDockerReadiness {
  const lines = (output ?? "").split("\n").map((line) => line.trim());
  return { socket: lines.includes(SSH_READINESS.socketMark), usable: lines.includes(SSH_READINESS.usableMark) };
}

/** What a runner host's .env said, as its last report gave it: its SSH settings carry on from there. */
function settingsAsReported(runner: HostRow): SshHostSettings {
  const reported = runner.healthJson === null ? null : (JSON.parse(runner.healthJson) as HostHealthView);
  const protectedContainers = (JSON.parse(runner.protectedContainersJson) as string[]).filter(
    (name) => name !== DEFAULT_SELF_CONTAINER_NAME,
  );
  return sshHostSettingsSchema.parse({
    ...DEFAULT_SSH_HOST_SETTINGS,
    dryRun: runner.dryRun ?? DEFAULT_SSH_HOST_SETTINGS.dryRun,
    protectedContainers,
    containerAccess: runner.containerAccess ?? DEFAULT_SSH_HOST_SETTINGS.containerAccess,
    hostTerminal: runner.hostTerminal ?? DEFAULT_SSH_HOST_SETTINGS.hostTerminal,
    hostDeploy: runner.hostDeploy ?? DEFAULT_SSH_HOST_SETTINGS.hostDeploy,
    hostPackages: reported?.packages?.setting ?? DEFAULT_SSH_HOST_SETTINGS.hostPackages,
  });
}

function requireConnected(probe: SshProbe): asserts probe is SshProbe & { hostKey: NonNullable<SshProbe["hostKey"]> } {
  const refusal = PROBE_ERRORS[probe.state];
  if (refusal !== undefined || probe.hostKey === null) {
    throw new DomainError(refusal ?? API_ERRORS.sshHostUnreachable);
  }
}

/**
 * Hosts the control plane reaches over SSH. Adding one dials it with the chosen key and stores nothing until a
 * person has compared and trusted its host key; from then on that key is pinned, and a different one is refused
 * until a person trusts it again. Each host gets a runner token, kept sealed, for its embedded runner to report with.
 */
export class SshHostsService {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly secretBox: SecretBox,
    private readonly keys: Pick<SshKeysService, "opened" | "fingerprintOf" | "list">,
    private readonly clock: () => number = Date.now,
    private readonly probe: typeof probeSsh = probeSsh,
    // Called once a host is stored, trusts a new host key, signs in with another key or has new settings.
    private readonly onChanged: (hostId: string) => void = () => undefined,
    // The runner on the dashboard's own machine stays one: that machine is managed in place.
    private readonly isLocalRunner: (hostId: string) => boolean = () => false,
  ) {}

  /**
   * Dials the host with the key: when it opens, its host key's fingerprint waits for a person to compare, with what
   * its user found of Docker (informing, never required). Asked again, it dials again.
   */
  async add(actor: Actor, request: SshHostRequest): Promise<PendingSshHostView> {
    this.refuseTakenLabel(request.label);
    return this.pend(actor, request, null);
  }

  /**
   * A runner host to be reached over SSH from now on, as the same host: its name, history, tasks and incidents stay.
   * Dialled and checked as a new host is; once a person trusts its host key, its runner's token stops working.
   */
  async switchToSsh(actor: Actor, hostId: string, request: Omit<SshHostRequest, "label">): Promise<PendingSshHostView> {
    const runner = this.runnerHost(hostId);
    return this.pend(actor, { ...request, label: runner.label }, hostId);
  }

  private async pend(actor: Actor, request: SshHostRequest, switching: string | null): Promise<PendingSshHostView> {
    const probe = await this.probe(
      this.target(request, request.keyId, null),
      SSH_KEY.probeTimeoutMilliseconds,
      SSH_READINESS.command,
    );
    requireConnected(probe);
    this.dropExpired();
    const pendingId = randomUUID();
    const expiresAt = this.clock() + SSH_KEY.pendingMilliseconds;
    const docker = readinessOf(probe.output);
    this.pending.set(pendingId, {
      request,
      hostKey: probe.hostKey,
      docker,
      switching,
      actorId: actor.userId,
      expiresAt,
    });
    return { pendingId, label: request.label, hostKeyFingerprint: probe.hostKey.fingerprint, expiresAt, docker };
  }

  /** The person compared the fingerprint: the host is stored, its host key pinned. */
  confirm(actor: Actor, pendingId: string): HostView {
    this.dropExpired();
    const pending = this.pending.get(pendingId);
    if (pending === undefined || pending.actorId !== actor.userId) {
      throw new DomainError(API_ERRORS.sshPendingNotFound);
    }
    this.pending.delete(pendingId);
    if (pending.switching !== null) {
      return this.switched(actor, pending.switching, pending);
    }
    const { request, hostKey } = pending;
    const token = newToken();
    const host = this.databaseHandle.database.transaction((transaction) => {
      this.refuseTakenLabel(request.label);
      return transaction
        .insert(hosts)
        .values({
          id: randomUUID(),
          label: request.label,
          tokenHash: sha256Hex(token),
          tokenHint: token.slice(-TOKEN_HINT_LENGTH),
          enrolledBy: actor.userId,
          enrolledAt: this.clock(),
          kind: HOST_KIND.ssh,
          sshAddress: request.address,
          sshPort: request.port,
          sshUser: request.user,
          sshKeyId: request.keyId,
          sshHostKey: hostKey.key,
          sshHostKeyFingerprint: hostKey.fingerprint,
          sshRunnerToken: this.secretBox.seal(token),
          sshSettingsJson: JSON.stringify(DEFAULT_SSH_HOST_SETTINGS),
        })
        .returning()
        .get();
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostSshAdded,
      { kind: TARGET_HOST, id: host.id },
      { label: host.label, address: request.address, user: request.user, hostKey: hostKey.fingerprint },
    );
    this.onChanged(host.id);
    return toHostView(host, this.clock());
  }

  // The same row, now an SSH host: a new token (the runner's no longer opens anything), and the settings its runner
  // last reported, so it goes on as it did.
  private switched(actor: Actor, hostId: string, pending: Pending): HostView {
    const { request, hostKey } = pending;
    const runner = this.runnerHost(hostId);
    const token = newToken();
    const host = this.update(hostId, {
      kind: HOST_KIND.ssh,
      tokenHash: sha256Hex(token),
      tokenHint: token.slice(-TOKEN_HINT_LENGTH),
      sshAddress: request.address,
      sshPort: request.port,
      sshUser: request.user,
      sshKeyId: request.keyId,
      sshHostKey: hostKey.key,
      sshHostKeyFingerprint: hostKey.fingerprint,
      sshRunnerToken: this.secretBox.seal(token),
      sshSettingsJson: JSON.stringify(settingsAsReported(runner)),
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostSwitchedToSsh,
      { kind: TARGET_HOST, id: hostId },
      { label: host.label, address: request.address, user: request.user, hostKey: hostKey.fingerprint },
    );
    this.onChanged(hostId);
    return toHostView(host, this.clock());
  }

  // An active runner host, not the dashboard's own machine's.
  private runnerHost(hostId: string): HostRow {
    const host = this.databaseHandle.database
      .select()
      .from(hosts)
      .where(and(eq(hosts.id, hostId), eq(hosts.kind, HOST_KIND.runner), eq(hosts.status, HOST_STATUS_ACTIVE)))
      .get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    if (this.isLocalRunner(hostId)) {
      throw new DomainError(API_ERRORS.sshSwitchLocalHost);
    }
    return host;
  }

  /**
   * The host's key changed and a person compared the new fingerprint: it is pinned if the host offers exactly that
   * key now, and the host's own key still opens it.
   */
  async trustHostKey(actor: Actor, hostId: string, fingerprint: string): Promise<HostView> {
    const host = this.sshHost(hostId);
    const probe = await this.probe(
      this.target(this.requestOf(host), host.sshKeyId!, null),
      SSH_KEY.probeTimeoutMilliseconds,
    );
    requireConnected(probe);
    if (probe.hostKey.fingerprint !== fingerprint) {
      throw new DomainError(API_ERRORS.sshHostKeyMismatch);
    }
    const updated = this.update(hostId, { sshHostKey: probe.hostKey.key, sshHostKeyFingerprint: fingerprint });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostSshHostKeyTrusted,
      { kind: TARGET_HOST, id: hostId },
      { from: host.sshHostKeyFingerprint, to: fingerprint },
    );
    this.onChanged(hostId);
    return toHostView(updated, this.clock());
  }

  /** Signs in with another stored key, once that key has opened the host (its pinned host key unchanged). */
  async replaceKey(actor: Actor, hostId: string, keyId: string): Promise<HostView> {
    const host = this.sshHost(hostId);
    const probe = await this.probe(
      this.target(this.requestOf(host), keyId, host.sshHostKey),
      SSH_KEY.probeTimeoutMilliseconds,
    );
    requireConnected(probe);
    const updated = this.update(hostId, { sshKeyId: keyId });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostSshKeyReplaced,
      { kind: TARGET_HOST, id: hostId },
      {
        from: host.sshKeyId === null ? null : this.keys.fingerprintOf(host.sshKeyId),
        to: this.keys.fingerprintOf(keyId),
      },
    );
    this.onChanged(hostId);
    return toHostView(updated, this.clock());
  }

  settingsOf(hostId: string): SshHostSettings {
    const stored = this.sshHost(hostId).sshSettingsJson;
    // A row saved before a setting existed has none for it: it reads as a runner's .env that leaves it unset.
    return stored === null
      ? DEFAULT_SSH_HOST_SETTINGS
      : sshHostSettingsSchema.parse({ ...DEFAULT_SSH_HOST_SETTINGS, ...JSON.parse(stored) });
  }

  updateSettings(actor: Actor, hostId: string, settings: SshHostSettings): SshHostSettings {
    this.sshHost(hostId);
    const checked = sshHostSettingsSchema.parse(settings);
    this.update(hostId, { sshSettingsJson: JSON.stringify(checked) });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostSshSettingsSaved,
      { kind: TARGET_HOST, id: hostId },
      checked,
    );
    this.onChanged(hostId);
    return checked;
  }

  /** Where and as whom, with which key, and its settings; the host key it offers now comes from its session. */
  detailsOf(hostId: string, offeredHostKeyFingerprint: string | null): SshHostDetailsView {
    const host = this.sshHost(hostId);
    const keyId = host.sshKeyId!;
    const key = this.keys.list().find((candidate) => candidate.id === keyId);
    return {
      address: host.sshAddress!,
      port: host.sshPort!,
      user: host.sshUser!,
      keyId,
      keyName: key?.name ?? "",
      hostKeyFingerprint: host.sshHostKeyFingerprint!,
      offeredHostKeyFingerprint:
        offeredHostKeyFingerprint === host.sshHostKeyFingerprint ? null : offeredHostKeyFingerprint,
      settings: this.settingsOf(hostId),
      rootMethod: host.sshRootPassword === null ? null : host.sshRootMethod,
    };
  }

  /** Kept sealed, with the way it was found to make root; Autoheal runs root commands with it by itself. */
  saveRootPassword(actor: Actor, hostId: string, password: string, method: RootMethod) {
    this.sshHost(hostId);
    this.update(hostId, { sshRootPassword: this.secretBox.seal(password), sshRootMethod: method });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostSshRootPasswordSaved,
      { kind: TARGET_HOST, id: hostId },
      { method },
    );
    // Its runner starts again with it: package jobs run as root from now on.
    this.onChanged(hostId);
  }

  removeRootPassword(actor: Actor, hostId: string) {
    this.sshHost(hostId);
    this.update(hostId, { sshRootPassword: null, sshRootMethod: null });
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.hostSshRootPasswordRemoved, { kind: TARGET_HOST, id: hostId });
    this.onChanged(hostId);
  }

  activeHostIds(): string[] {
    return this.databaseHandle.database
      .select({ id: hosts.id })
      .from(hosts)
      .where(and(eq(hosts.kind, HOST_KIND.ssh), eq(hosts.status, HOST_STATUS_ACTIVE)))
      .all()
      .map(({ id }) => id);
  }

  /** The runner token opens only with the passphrase that sealed it; one another passphrase sealed is refused. */
  runnerOf(hostId: string): SshRunnerDetails {
    const host = this.sshHost(hostId);
    const token = host.sshRunnerToken === null ? null : this.secretBox.open(host.sshRunnerToken);
    if (token === null) {
      throw new Error(SSH_TEXT.runnerTokenUnreadable(host.label));
    }
    const password = host.sshRootPassword === null ? null : this.secretBox.open(host.sshRootPassword);
    const root = password === null || host.sshRootMethod === null ? null : { method: host.sshRootMethod, password };
    return { label: host.label, settings: this.settingsOf(hostId), token, root };
  }

  /** Where and with what to dial an active SSH host now: for its session. */
  targetOf(hostId: string): SshTarget {
    const host = this.sshHost(hostId);
    return this.target(this.requestOf(host), host.sshKeyId!, host.sshHostKey);
  }

  private target(
    request: Omit<SshHostRequest, "label" | "keyId">,
    keyId: string,
    pinnedHostKey: string | null,
  ): SshTarget {
    const key = this.keys.opened(keyId);
    return { address: request.address, port: request.port, user: request.user, ...key, pinnedHostKey };
  }

  private requestOf(host: HostRow): Omit<SshHostRequest, "label" | "keyId"> {
    return { address: host.sshAddress!, port: host.sshPort!, user: host.sshUser! };
  }

  private sshHost(hostId: string): HostRow {
    const host = this.databaseHandle.database
      .select()
      .from(hosts)
      .where(and(eq(hosts.id, hostId), eq(hosts.kind, HOST_KIND.ssh), eq(hosts.status, HOST_STATUS_ACTIVE)))
      .get();
    if (host === undefined || host.sshKeyId === null) {
      throw new DomainError(API_ERRORS.sshHostNotFound);
    }
    return host;
  }

  private update(hostId: string, values: Partial<typeof hosts.$inferInsert>): HostRow {
    return this.databaseHandle.database.update(hosts).set(values).where(eq(hosts.id, hostId)).returning().get()!;
  }

  private refuseTakenLabel(label: string) {
    if (this.databaseHandle.database.select({ id: hosts.id }).from(hosts).where(eq(hosts.label, label)).get()) {
      throw new DomainError(API_ERRORS.hostLabelTaken);
    }
  }

  private dropExpired() {
    const now = this.clock();
    [...this.pending.entries()]
      .filter(([, pending]) => pending.expiresAt <= now)
      .forEach(([pendingId]) => this.pending.delete(pendingId));
  }
}
