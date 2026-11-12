import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  API_ERRORS,
  type CancelledEnrollmentView,
  type EnrolledHostView,
  type HostView,
  type LocalHostView,
} from "../../shared/api.js";
import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  FIRST_LABEL_COPY,
  HOST_KIND,
  HOST_LABEL_MAXIMUM_LENGTH,
  HOST_STATUS_ACTIVE,
  HOST_STATUS_REVOKED,
  JOIN_CODE_LIFETIME_MILLISECONDS,
  JOIN_FILE_NAME,
  JOIN_MESSAGES,
  LABEL_COPY_SEPARATOR,
  LOCAL_RUNNER_URL,
  PENDING_HOST_LABEL_BYTES,
  PENDING_HOST_LABEL_PREFIX,
  RUNNER_PORT,
  SECRET_FILE_MODE,
  SETTING_KEYS,
  SYSTEM_ACTOR_LABEL,
  TARGET_HOST,
  TOKEN_HINT_LENGTH,
} from "../../shared/constants.js";
import { decodeJoinCode, encodeJoinCode, newEnrolment, newToken, type JoinDetails } from "../../shared/join-code.js";
import { log } from "../../shared/log.js";
import {
  imageCanBePulled,
  imageCopyCommand,
  installCommand,
  nasInstallCommand,
  rejoinCommand,
} from "../../shared/runner-install.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { sha256Hex } from "../../shared/hash.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import { toHostView } from "../inventory/host-views.js";
import type { SettingsStore } from "../settings/settings-store.js";

export type HostRow = typeof hosts.$inferSelect;

/** What join codes and install commands carry, besides what is each host's own: a code's enrolment, or a token. */
export interface JoinSettings {
  // The control plane's public key: runners accept its certificate by it.
  pin: string;
  // The image new runners run.
  image: string;
  // The dashboard's address: its host name is where runners are first pointed.
  publicBaseUrl: string;
}

// The runner address used last, with the dashboard address it was used for: a dashboard that moved since
// (a domain where there was an IP address) offers its new name instead. One stored as a bare address, from
// before this, is from an unknown dashboard address and counts as none.
const rememberedAddressSchema = z.object({ address: z.string(), publicBaseUrl: z.string() });

// What a host is known by: its token's hash and end, and its join code's while one waits to be traded.
type HostCredential = Pick<HostRow, "tokenHash" | "tokenHint"> &
  Partial<Pick<HostRow, "joinCodeHash" | "joinCodeExpiresAt">>;
const credentialOf = (token: string): HostCredential => ({
  tokenHash: sha256Hex(token),
  tokenHint: token.slice(-TOKEN_HINT_LENGTH),
});

// A join code shown once and kept nowhere: the host keeps its hash until its runner trades it.
interface IssuedJoinCode {
  enrolment: string;
  hash: string;
  expiresAt: number;
}

export const pendingLabel = () =>
  `${PENDING_HOST_LABEL_PREFIX}${randomBytes(PENDING_HOST_LABEL_BYTES).toString("hex")}`;

// Gone from the fleet, it gives its name back for the next host to use, and history still shows which it was.
const REVOKED_LABEL_MARK = "-revoked-";
const REVOKED_LABEL_ID_CHARACTERS = 8;
const revokedLabel = ({ id, label }: Pick<HostRow, "id" | "label">) =>
  `${label}${REVOKED_LABEL_MARK}${id.slice(0, REVOKED_LABEL_ID_CHARACTERS)}`;

/** Enrolled machines and their runners' credentials; what the runners report is the inventory's. */
export class HostsService {
  private readonly renameListeners = new Set<(hostId: string, before: string, after: string) => void>();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly settingsStore: SettingsStore,
    private readonly join: JoinSettings,
    private readonly clock: () => number = Date.now,
    private readonly onRevoked: (hostId: string) => void = () => {},
  ) {}

  /**
   * Where new runners reach the control plane: the address used last while the dashboard kept its address,
   * else the dashboard's host on the runner port.
   */
  runnerAddress(): string {
    const remembered = this.settingsStore.read(SETTING_KEYS.runnerAddress, rememberedAddressSchema);
    if (remembered?.publicBaseUrl === this.join.publicBaseUrl) {
      return remembered.address;
    }
    const address = new URL(this.join.publicBaseUrl);
    address.port = String(RUNNER_PORT);
    return address.origin;
  }

  /**
   * A new host and the one paste that installs its runner, whose join code works once, within the hour. Without a
   * label it takes the name its runner reports first. `address` is where that runner reaches this control plane.
   */
  enroll(actor: Actor, label: string | null, address: string, nasFolder: string | null = null): EnrolledHostView {
    const issued = this.issueJoinCode();
    // The hash of a token nobody keeps, and no end to show: until its runner trades the join code, nothing
    // authenticates as the host.
    const credential = {
      tokenHash: sha256Hex(newToken()),
      tokenHint: "",
      joinCodeHash: issued.hash,
      joinCodeExpiresAt: issued.expiresAt,
    };
    const host = this.insert(credential, label, actor.userId);
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostEnrolled,
      { kind: TARGET_HOST, id: host.id },
      { label: host.label },
    );
    this.rememberAddress(address);
    return this.enrolledView(host, address, nasFolder, issued);
  }

  /**
   * A new join code for a runner host, in place of any it has not traded: its runner joins again with it, as the same
   * host, and the token it has works until then. Not for a host reached over SSH, nor this machine, nor its runner
   * container, which joins through the volume.
   */
  newJoinCode(
    actor: Actor,
    hostId: string,
    address: string,
    nasFolder: string | null,
    joinDirectory: string,
  ): EnrolledHostView {
    const current = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (current === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    if (current.status === HOST_STATUS_REVOKED) {
      throw new DomainError(API_ERRORS.hostRevoked);
    }
    const joinsThroughVolume = this.localRunner(joinDirectory)?.host.id === hostId;
    if (current.kind !== HOST_KIND.runner || joinsThroughVolume) {
      throw new DomainError(API_ERRORS.notRunnerHost);
    }
    const issued = this.issueJoinCode();
    const host = this.databaseHandle.database
      .update(hosts)
      .set({ joinCodeHash: issued.hash, joinCodeExpiresAt: issued.expiresAt })
      .where(eq(hosts.id, hostId))
      .returning()
      .get()!;
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostJoinCodeMade,
      { kind: TARGET_HOST, id: host.id },
      { label: host.label },
    );
    this.rememberAddress(address);
    return this.enrolledView(host, address, nasFolder, issued);
  }

  /**
   * A join code traded for the token its runner made: once, within its hour, for a runner host still enrolled. True
   * too for a token that already opens a host, its runner asking again after the answer was lost; false for a code
   * that opens nothing, used already, expired or never given, or one left from before its host moved to SSH.
   */
  redeemJoinCode(enrolment: string, token: string): boolean {
    if (this.authenticate(token) !== null) {
      return true;
    }
    return this.databaseHandle.database.transaction((transaction) => {
      const host = transaction
        .select()
        .from(hosts)
        .where(
          and(
            eq(hosts.joinCodeHash, sha256Hex(enrolment)),
            eq(hosts.status, HOST_STATUS_ACTIVE),
            eq(hosts.kind, HOST_KIND.runner),
          ),
        )
        .get();
      const expired = (host?.joinCodeExpiresAt ?? 0) <= this.clock();
      if (host === undefined || expired) {
        return false;
      }
      transaction
        .update(hosts)
        .set({ ...credentialOf(token), joinCodeHash: null, joinCodeExpiresAt: null })
        .where(eq(hosts.id, host.id))
        .run();
      return true;
    });
  }

  /**
   * The runner on this control plane's own machine joins with no paste: its join code waits in a
   * volume both containers mount. A revoked one is not brought back here, but an admin can add it
   * again; a fresh database (or a new key) gets a fresh code.
   */
  ensureLocalRunner(joinDirectory: string) {
    if (!existsSync(joinDirectory)) {
      return;
    }
    const local = this.localRunner(joinDirectory);
    if (local?.host.status === HOST_STATUS_REVOKED) {
      log(JOIN_MESSAGES.localRunnerRevoked);
      return;
    }
    if (local !== null) {
      this.writeJoinCode(local.path, { ...local.code, pin: this.join.pin });
      return;
    }
    const path = join(joinDirectory, JOIN_FILE_NAME);
    const token = newToken();
    const added = this.insert(credentialOf(token), null, null);
    this.auditLog.record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AUDIT_ACTIONS.hostEnrolled,
      targetKind: TARGET_HOST,
      targetId: added.id,
      details: { label: added.label },
    });
    this.writeJoinCode(path, { url: LOCAL_RUNNER_URL, token, pin: this.join.pin });
    log(JOIN_MESSAGES.localRunnerAdded);
  }

  /** This machine's host, revoked or not: looked after in place, or its runner's, as the join code names it. */
  localHost(joinDirectory: string): LocalHostView {
    const host = this.localMachine(joinDirectory);
    return { hostId: host?.id ?? null, revoked: host?.status === HOST_STATUS_REVOKED };
  }

  /** The host for the control plane's own machine: the one looked after in place, else its runner's; null without. */
  localMachine(joinDirectory: string): HostRow | null {
    const inPlace = this.databaseHandle.database.select().from(hosts).where(eq(hosts.kind, HOST_KIND.local)).get();
    return inPlace ?? this.localRunner(joinDirectory)?.host ?? null;
  }

  /**
   * This machine's revoked runner back, as the same host with its history: a new token, written where the
   * runner reads its join code, which it reads again once its old token is refused. Nothing restarts.
   */
  reenrollLocalRunner(actor: Actor, joinDirectory: string): HostView {
    const local = this.localRunner(joinDirectory);
    if (local === null || local.host.status !== HOST_STATUS_REVOKED) {
      throw new DomainError(API_ERRORS.notLocalRunner);
    }
    const token = newToken();
    const host = this.databaseHandle.database
      .update(hosts)
      .set({
        ...credentialOf(token),
        status: HOST_STATUS_ACTIVE,
        revokedAt: null,
        label: this.labelWhenBack(local.host),
      })
      .where(eq(hosts.id, local.host.id))
      .returning()
      .get()!;
    this.writeJoinCode(local.path, { ...local.code, token, pin: this.join.pin });
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

  /** A host added without a name takes the one its runner reports, made unique, once. */
  adoptReportedLabel(host: HostRow, reported: string | undefined) {
    if (!host.namedByRunner || reported === undefined) {
      return;
    }
    const taken = new Set(
      this.databaseHandle.database
        .select({ label: hosts.label })
        .from(hosts)
        .all()
        .map((row) => row.label),
    );
    let label = reported;
    for (let copy = FIRST_LABEL_COPY; taken.has(label); copy += 1) {
      const suffix = `${LABEL_COPY_SEPARATOR}${copy}`;
      label = `${reported.slice(0, HOST_LABEL_MAXIMUM_LENGTH - suffix.length)}${suffix}`;
    }
    this.databaseHandle.database.update(hosts).set({ label, namedByRunner: false }).where(eq(hosts.id, host.id)).run();
  }

  /**
   * A name a person chose, unique among hosts, which its runner's reports never change. Pages, incidents and
   * notifications read it as they go; open tasks take it at the detectors' next pass, and history keeps the old one.
   */
  onRename(listener: (hostId: string, before: string, after: string) => void) {
    this.renameListeners.add(listener);
  }

  rename(actor: Actor, hostId: string, label: string): HostView {
    const { before, renamed } = this.databaseHandle.database.transaction((transaction) => {
      const current = transaction.select().from(hosts).where(eq(hosts.id, hostId)).get();
      if (current === undefined) {
        throw new DomainError(API_ERRORS.hostNotFound);
      }
      const holder = transaction.select({ id: hosts.id }).from(hosts).where(eq(hosts.label, label)).get();
      if (holder !== undefined && holder.id !== hostId) {
        throw new DomainError(API_ERRORS.hostLabelTaken);
      }
      const updated = transaction
        .update(hosts)
        .set({ label, namedByRunner: false })
        .where(eq(hosts.id, hostId))
        .returning()
        .get()!;
      return { before: current.label, renamed: updated };
    });
    if (before !== label) {
      this.renameListeners.forEach((listener) => listener(hostId, before, label));
      this.auditLog.recordUserAction(
        actor,
        AUDIT_ACTIONS.hostRenamed,
        { kind: TARGET_HOST, id: hostId },
        { from: before, to: label },
      );
    }
    return toHostView(renamed, this.clock());
  }

  revoke(actor: Actor, hostId: string): HostView {
    const current = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (current === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    const host = this.databaseHandle.database
      .update(hosts)
      .set(this.revocationOf(current))
      .where(eq(hosts.id, hostId))
      .returning()
      .get()!;
    this.revoked(actor, host);
    return toHostView(host, this.clock());
  }

  /**
   * Takes back a host whose runner never traded its join code, as closing Add a host does, and nothing else: one that
   * joined meanwhile keeps its token, whatever the dialog last saw of it. Decided in one write, so a runner trading its
   * code at the same moment either joins first and stays, or finds its code opens nothing.
   */
  cancelEnrollment(actor: Actor, hostId: string): CancelledEnrollmentView {
    const current = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (current === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    // Only a runner host just added has no token's hint: its runner sets one by trading the code, and every other
    // way a host joins brings its token.
    const neverJoined = and(eq(hosts.id, hostId), eq(hosts.status, HOST_STATUS_ACTIVE), eq(hosts.tokenHint, ""));
    const host = this.databaseHandle.database
      .update(hosts)
      .set({ ...this.revocationOf(current), joinCodeHash: null, joinCodeExpiresAt: null })
      .where(neverJoined)
      .returning()
      .get();
    if (host === undefined) return { cancelled: false };
    this.revoked(actor, host);
    return { cancelled: true };
  }

  private revocationOf(current: HostRow): Pick<HostRow, "status" | "revokedAt" | "label"> {
    return {
      status: HOST_STATUS_REVOKED,
      revokedAt: this.clock(),
      label: current.status === HOST_STATUS_REVOKED ? current.label : revokedLabel(current),
    };
  }

  private revoked(actor: Actor, host: HostRow) {
    this.onRevoked(host.id);
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostRevoked,
      { kind: TARGET_HOST, id: host.id },
      {
        label: host.label,
      },
    );
  }

  /** A revoked host brought back takes its name again, unless another has it by now. */
  labelWhenBack({ id, label }: Pick<HostRow, "id" | "label">): string {
    const suffix = `${REVOKED_LABEL_MARK}${id.slice(0, REVOKED_LABEL_ID_CHARACTERS)}`;
    if (!label.endsWith(suffix)) return label;
    const name = label.slice(0, -suffix.length);
    const holder = this.databaseHandle.database.select({ id: hosts.id }).from(hosts).where(eq(hosts.label, name)).get();
    return holder === undefined ? name : label;
  }

  isActive(hostId: string): boolean {
    return (
      this.databaseHandle.database
        .select({ id: hosts.id })
        .from(hosts)
        .where(and(eq(hosts.id, hostId), eq(hosts.status, HOST_STATUS_ACTIVE)))
        .get() !== undefined
    );
  }

  /** The active host this bearer token belongs to, or null. */
  authenticate(token: string): HostRow | null {
    const host = this.databaseHandle.database
      .select()
      .from(hosts)
      .where(and(eq(hosts.tokenHash, sha256Hex(token)), eq(hosts.status, HOST_STATUS_ACTIVE)))
      .get();
    return host ?? null;
  }

  private insert(credential: HostCredential, label: string | null, enrolledBy: string | null): HostRow {
    return this.databaseHandle.database.transaction((transaction) => {
      if (label !== null && transaction.select({ id: hosts.id }).from(hosts).where(eq(hosts.label, label)).get()) {
        throw new DomainError(API_ERRORS.hostLabelTaken);
      }
      return transaction
        .insert(hosts)
        .values({
          id: randomUUID(),
          label: label ?? pendingLabel(),
          namedByRunner: label === null,
          ...credential,
          enrolledBy,
          enrolledAt: this.clock(),
        })
        .returning()
        .get();
    });
  }

  private issueJoinCode(): IssuedJoinCode {
    const enrolment = newEnrolment();
    return { enrolment, hash: sha256Hex(enrolment), expiresAt: this.clock() + JOIN_CODE_LIFETIME_MILLISECONDS };
  }

  // Where a runner reached this control plane is offered to the next host too.
  private rememberAddress(address: string) {
    this.settingsStore.write(SETTING_KEYS.runnerAddress, { address, publicBaseUrl: this.join.publicBaseUrl });
  }

  // The paste for a new host, and the line for one already installed.
  private enrolledView(
    host: HostRow,
    address: string,
    nasFolder: string | null,
    issued: IssuedJoinCode,
  ): EnrolledHostView {
    const joinCode = encodeJoinCode({ url: address, enrolment: issued.enrolment, pin: this.join.pin });
    return {
      host: toHostView(host, this.clock()),
      joinCode,
      joinCodeExpiresAt: issued.expiresAt,
      imageCopyCommand:
        nasFolder === null || imageCanBePulled(this.join.image) ? null : imageCopyCommand(this.join.image),
      installCommand:
        nasFolder === null
          ? installCommand(this.join.image, joinCode)
          : nasInstallCommand(this.join.image, joinCode, nasFolder),
      rejoinCommand: rejoinCommand(joinCode),
    };
  }

  // The join code in the shared volume, and the host its token belongs to; null without either.
  private localRunner(joinDirectory: string): { path: string; code: JoinDetails; host: HostRow } | null {
    const path = join(joinDirectory, JOIN_FILE_NAME);
    const code = existsSync(path) ? decodeJoinCode(readFileSync(path, "utf8").trim()) : null;
    const host = code === null ? undefined : this.hostWithToken(code.token);
    return code === null || host === undefined ? null : { path, code, host };
  }

  // Readable by its owner alone: it holds a runner's token.
  private writeJoinCode(path: string, code: JoinDetails) {
    writeFileSync(path, encodeJoinCode(code), { mode: SECRET_FILE_MODE });
  }

  private hostWithToken(token: string): HostRow | undefined {
    return this.databaseHandle.database
      .select()
      .from(hosts)
      .where(eq(hosts.tokenHash, sha256Hex(token)))
      .get();
  }
}
