import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import { AUDIT_ACTIONS, REGISTRY, TARGET_REGISTRY, type AuditAction } from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { redactSecrets } from "../../shared/redaction.js";
import {
  accessForImage,
  type RegistryAccess,
  type RegistryCredentialBody,
  type RegistryCredentialTestView,
  type RegistryCredentialView,
} from "../../shared/registry-credentials.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, registryCredentials } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";

type CredentialRow = typeof registryCredentials.$inferSelect;

/** What a credential is tried against: the same reads an update check makes, with the credential given to them. */
export interface RegistryReader {
  digest(
    reference: { registry: string; repository: string; tag: string },
    access: RegistryAccess | null,
  ): Promise<string>;
}

const targetOf = (id: string) => ({ kind: TARGET_REGISTRY, id }) as const;
const hostIdsOf = (row: Pick<CredentialRow, "hostIdsJson">): string[] =>
  row.hostIdsJson === null ? [] : (JSON.parse(row.hostIdsJson) as string[]);
const scopeOf = (row: Pick<CredentialRow, "registry" | "repository">) =>
  row.repository === null ? row.registry : `${row.registry}/${row.repository}`;

const viewOf = (row: CredentialRow): RegistryCredentialView => ({
  id: row.id,
  registry: row.registry,
  repository: row.repository,
  username: row.username,
  hostIds: hostIdsOf(row),
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * What private registries want, kept for the hosts allowed to use them. A password goes in, is sealed with the
 * backup passphrase, and is never read back out to anyone but a runner asking for an image it covers: the views
 * this answers with carry the scope and the user name, never the password. Each change is in the audit log, and a
 * runner's next heartbeat carries what it may use, so a rotation or a removal reaches it within seconds.
 */
export class RegistryCredentialsService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly secretBox: SecretBox,
    private readonly registry: RegistryReader,
    private readonly clock: () => number = Date.now,
  ) {}

  views(): RegistryCredentialView[] {
    return this.rows().map(viewOf);
  }

  /** What one host may use: every credential set for every host, and those naming this one. */
  accessFor(hostId: string): RegistryAccess[] {
    return this.rows().flatMap((row) => {
      const hostIds = hostIdsOf(row);
      if (hostIds.length > 0 && !hostIds.includes(hostId)) return [];
      const password = this.secretBox.open(row.sealedPassword);
      if (password === null) return [];
      return [{ registry: row.registry, repository: row.repository, username: row.username, password }];
    });
  }

  add(actor: Actor, body: RegistryCredentialBody): { id: string } {
    this.requireKnownHosts(body.hostIds);
    this.refuseTakenScope(body, null);
    const now = this.clock();
    const id = randomUUID();
    this.databaseHandle.database
      .insert(registryCredentials)
      .values({
        id,
        registry: body.registry,
        repository: body.repository,
        username: body.username,
        sealedPassword: this.secretBox.seal(body.password),
        hostIdsJson: body.hostIds.length === 0 ? null : JSON.stringify(body.hostIds),
        createdBy: actor.username,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.record(actor, AUDIT_ACTIONS.registryCredentialAdded, id, body);
    return { id };
  }

  /** A new password, user name or scope for a credential already there: what it replaces is gone at once. */
  change(actor: Actor, id: string, body: RegistryCredentialBody) {
    const row = this.require(id);
    this.requireKnownHosts(body.hostIds);
    this.refuseTakenScope(body, row.id);
    this.databaseHandle.database
      .update(registryCredentials)
      .set({
        registry: body.registry,
        repository: body.repository,
        username: body.username,
        sealedPassword: this.secretBox.seal(body.password),
        hostIdsJson: body.hostIds.length === 0 ? null : JSON.stringify(body.hostIds),
        updatedAt: this.clock(),
      })
      .where(eq(registryCredentials.id, id))
      .run();
    this.record(actor, AUDIT_ACTIONS.registryCredentialRotated, id, body);
  }

  remove(actor: Actor, id: string) {
    const row = this.require(id);
    this.databaseHandle.database.delete(registryCredentials).where(eq(registryCredentials.id, id)).run();
    this.record(actor, AUDIT_ACTIONS.registryCredentialRemoved, id, { ...row, hostIds: hostIdsOf(row) });
  }

  /**
   * Asks the registry for a repository's newest digest with this credential, because a person asked: one network
   * call from the control plane, and its answer is a sentence to show, with nothing secret in it.
   */
  async test(actor: Actor, id: string, repository: string | null): Promise<RegistryCredentialTestView> {
    const row = this.require(id);
    const asked = repository ?? row.repository;
    if (asked === null) throw new DomainError(API_ERRORS.registryRepositoryNeeded);
    const password = this.secretBox.open(row.sealedPassword);
    if (password === null) throw new DomainError(API_ERRORS.registryCredentialSealed);
    const access = { registry: row.registry, repository: row.repository, username: row.username, password };
    if (accessForImage([access], { registry: row.registry, repository: asked }) === null) {
      throw new DomainError(API_ERRORS.registryRepositoryOutOfScope);
    }
    const problem = await this.problemReaching(asked, access);
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.registryCredentialTested, targetOf(id), {
      scope: scopeOf(row),
      repository: asked,
      reached: problem === null,
    });
    return { reached: problem === null, problem };
  }

  private async problemReaching(repository: string, access: RegistryAccess): Promise<string | null> {
    try {
      await this.registry.digest({ registry: access.registry, repository, tag: REGISTRY.defaultTag }, access);
      return null;
    } catch (error) {
      // The credential travels in a header, never in this text; redacted even so, as nothing secret may be shown.
      return redactSecrets(describeError(error));
    }
  }

  private rows(): CredentialRow[] {
    return this.databaseHandle.database
      .select()
      .from(registryCredentials)
      .orderBy(registryCredentials.registry, registryCredentials.createdAt)
      .all();
  }

  private require(id: string): CredentialRow {
    const row = this.databaseHandle.database
      .select()
      .from(registryCredentials)
      .where(eq(registryCredentials.id, id))
      .get();
    if (row === undefined) throw new DomainError(API_ERRORS.registryCredentialNotFound);
    return row;
  }

  private requireKnownHosts(hostIds: string[]) {
    if (hostIds.length === 0) return;
    const known = this.databaseHandle.database
      .select({ id: hosts.id })
      .from(hosts)
      .where(inArray(hosts.id, hostIds))
      .all();
    if (known.length !== new Set(hostIds).size) throw new DomainError(API_ERRORS.hostNotFound);
  }

  // One credential per scope, so which one a pull uses is never a question of order.
  private refuseTakenScope(body: RegistryCredentialBody, keeping: string | null) {
    const taken = this.rows().some(
      (row) => row.id !== keeping && row.registry === body.registry && row.repository === body.repository,
    );
    if (taken) throw new DomainError(API_ERRORS.registryScopeTaken);
  }

  private record(
    actor: Actor,
    action: AuditAction,
    id: string,
    scope: Pick<CredentialRow, "registry" | "repository"> & { username: string; hostIds?: string[] },
  ) {
    this.auditLog.recordUserAction(actor, action, targetOf(id), {
      scope: scopeOf(scope),
      username: scope.username,
      hosts: scope.hostIds?.length ?? 0,
    });
  }
}
