import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { API_ERRORS, type MadeSshKeyView, type SshKeyView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  FORMER_USER_LABEL,
  HOST_KIND,
  HOST_STATUS_ACTIVE,
  TARGET_SSH_KEY,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, sshKeys, users } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import { makeKey, readUserKey } from "./ssh-keys.js";

/** A stored key opened for a connection; it stays in memory only while dialling. */
export interface OpenedSshKey {
  privateKey: string;
  passphrase: string | null;
}

/**
 * The SSH keys the control plane signs in with: the user's own, read and checked before they are stored, or one it
 * made for a user without one. The private half and its passphrase are sealed and never shown back.
 */
export class SshKeysService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly secretBox: SecretBox,
    private readonly clock: () => number = Date.now,
  ) {}

  add(actor: Actor, name: string, privateKey: string, passphrase: string | null): SshKeyView {
    const read = readUserKey(privateKey, passphrase);
    const id = this.insert(actor, name, {
      publicLine: read.publicLine,
      fingerprint: read.fingerprint,
      privateKey,
      passphrase: read.passphrase,
      madeByAutoheal: false,
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.sshKeyAdded,
      { kind: TARGET_SSH_KEY, id },
      { name, fingerprint: read.fingerprint },
    );
    return this.view(id);
  }

  /** A new key for a user who has none; its private half is given this once, for them to keep if they want. */
  make(actor: Actor, name: string, passphrase: string | null = null): MadeSshKeyView {
    const made = makeKey(name, passphrase);
    const id = this.insert(actor, name, { ...made, passphrase, madeByAutoheal: true });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.sshKeyMade,
      { kind: TARGET_SSH_KEY, id },
      { name, fingerprint: made.fingerprint },
    );
    return { key: this.view(id), privateKey: made.privateKey };
  }

  list(): SshKeyView[] {
    return this.databaseHandle.database
      .select({ id: sshKeys.id })
      .from(sshKeys)
      .orderBy(asc(sshKeys.name))
      .all()
      .map(({ id }) => this.view(id));
  }

  /** Refused while an active host signs in with it; a revoked host lets go of it. */
  remove(actor: Actor, keyId: string) {
    this.databaseHandle.database.transaction((transaction) => {
      const key = transaction.select({ name: sshKeys.name }).from(sshKeys).where(eq(sshKeys.id, keyId)).get();
      if (key === undefined) {
        throw new DomainError(API_ERRORS.sshKeyNotFound);
      }
      const used = transaction
        .select({ id: hosts.id })
        .from(hosts)
        .where(and(eq(hosts.sshKeyId, keyId), eq(hosts.status, HOST_STATUS_ACTIVE)))
        .get();
      if (used !== undefined) {
        throw new DomainError(API_ERRORS.sshKeyInUse);
      }
      transaction.update(hosts).set({ sshKeyId: null }).where(eq(hosts.sshKeyId, keyId)).run();
      transaction.delete(sshKeys).where(eq(sshKeys.id, keyId)).run();
      this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.sshKeyRemoved, { kind: TARGET_SSH_KEY, id: keyId }, key);
    });
  }

  /** The key to dial with; one another backup passphrase sealed reads as missing, for a person to give again. */
  opened(keyId: string): OpenedSshKey {
    const row = this.databaseHandle.database
      .select({ privateKey: sshKeys.privateKey, passphrase: sshKeys.passphrase })
      .from(sshKeys)
      .where(eq(sshKeys.id, keyId))
      .get();
    const privateKey = row === undefined ? null : this.secretBox.open(row.privateKey);
    if (row === undefined || privateKey === null) {
      throw new DomainError(API_ERRORS.sshKeyNotFound);
    }
    return { privateKey, passphrase: row.passphrase === null ? null : this.secretBox.open(row.passphrase) };
  }

  fingerprintOf(keyId: string): string {
    return this.view(keyId).fingerprint;
  }

  private insert(
    actor: Actor,
    name: string,
    key: Pick<SshKeyView, "publicLine" | "fingerprint" | "madeByAutoheal"> & OpenedSshKey,
  ): string {
    const database = this.databaseHandle.database;
    if (database.select({ id: sshKeys.id }).from(sshKeys).where(eq(sshKeys.name, name)).get()) {
      throw new DomainError(API_ERRORS.sshKeyNameTaken);
    }
    const id = randomUUID();
    database
      .insert(sshKeys)
      .values({
        id,
        name,
        publicLine: key.publicLine,
        fingerprint: key.fingerprint,
        privateKey: this.secretBox.seal(key.privateKey),
        passphrase: key.passphrase === null ? null : this.secretBox.seal(key.passphrase),
        madeByAutoheal: key.madeByAutoheal,
        createdBy: actor.userId,
        createdAt: this.clock(),
      })
      .run();
    return id;
  }

  private view(keyId: string): SshKeyView {
    const database = this.databaseHandle.database;
    const row = database
      .select({ key: sshKeys, username: users.username })
      .from(sshKeys)
      .leftJoin(users, eq(users.id, sshKeys.createdBy))
      .where(eq(sshKeys.id, keyId))
      .get();
    if (row === undefined) {
      throw new DomainError(API_ERRORS.sshKeyNotFound);
    }
    const using = database
      .select({ label: hosts.label })
      .from(hosts)
      .where(and(eq(hosts.sshKeyId, keyId), eq(hosts.kind, HOST_KIND.ssh), eq(hosts.status, HOST_STATUS_ACTIVE)))
      .orderBy(asc(hosts.label))
      .all();
    return {
      id: row.key.id,
      name: row.key.name,
      publicLine: row.key.publicLine,
      fingerprint: row.key.fingerprint,
      madeByAutoheal: row.key.madeByAutoheal,
      createdBy: row.username ?? FORMER_USER_LABEL,
      createdAt: row.key.createdAt,
      hosts: using.map(({ label }) => label),
    };
  }
}
