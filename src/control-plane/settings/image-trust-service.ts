import { createPublicKey, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS } from "../../shared/api.js";
import { AUDIT_ACTIONS, HEX_RADIX, IMAGE_PROVENANCE, TARGET_REGISTRY } from "../../shared/constants.js";
import type { ImageTrustPolicy, TrustRule, TrustedPublisher } from "../../shared/image-provenance.js";
import { sha256Hex } from "../../shared/hash.js";
import { registryHostOf } from "../../shared/registry-credentials.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { imageTrustRules, trustedPublishers } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

export const publisherBodySchema = z
  .object({
    name: z.string().trim().min(1).max(IMAGE_PROVENANCE.publisherNameLength),
    publicKey: z.string().trim().min(1).max(IMAGE_PROVENANCE.publisherKeyLength),
  })
  .strict();

export const trustRuleBodySchema = z
  .object({
    registry: z.string().trim().min(1),
    repository: z.string().trim().nullable().default(null),
    publishers: z.array(z.string().trim().min(1)).max(IMAGE_PROVENANCE.publishersLimit).default([]),
  })
  .strict();

export type PublisherBody = z.infer<typeof publisherBodySchema>;
export type TrustRuleBody = z.infer<typeof trustRuleBodySchema>;

/** What the dashboard shows: the rules, the publishers and what each key is, never a question of secrecy. */
export interface ImageTrustView {
  publishers: (TrustedPublisher & { keyType: string; createdBy: string; createdAt: number })[];
  rules: (TrustRule & { id: string; createdBy: string; createdAt: number })[];
  revision: number;
}

const scopeOf = (rule: { registry: string; repository: string | null }) =>
  rule.repository === null ? rule.registry : `${rule.registry}/${rule.repository}`;

/** What kind of key it is, for the card to show; a key that does not read as one is refused before it is kept. */
function keyTypeOf(publicKey: string): string {
  try {
    return createPublicKey(publicKey).asymmetricKeyType ?? "";
  } catch {
    throw new DomainError(API_ERRORS.publisherKeyInvalid);
  }
}

/**
 * Which publishers an admin trusts, and where a signed image is required before Autoheal puts one in place. Nothing
 * here is secret: a public key is kept as it was given. The revision is what every runner caches its evidence
 * under, so adding a key or a rule makes every host ask again rather than believe what it read before.
 */
export class ImageTrustService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  view(): ImageTrustView {
    const publishers = this.publisherRows();
    return {
      publishers: publishers.map((row) => ({
        name: row.name,
        publicKey: row.publicKey,
        keyType: keyTypeOf(row.publicKey),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      })),
      rules: this.ruleRows().map((row) => ({
        id: row.id,
        registry: row.registry,
        repository: row.repository,
        publishers: row.publishersJson === null ? [] : (JSON.parse(row.publishersJson) as string[]),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      })),
      revision: this.revision(),
    };
  }

  /** What every runner is given: the keys, the scopes, and which policy this is. */
  policy(): ImageTrustPolicy {
    const view = this.view();
    return {
      revision: view.revision,
      publishers: view.publishers.map(({ name, publicKey }) => ({ name, publicKey })),
      required: view.rules.map(({ registry, repository, publishers }) => ({ registry, repository, publishers })),
    };
  }

  addPublisher(actor: Actor, body: PublisherBody) {
    const keyType = keyTypeOf(body.publicKey);
    const existing = this.publisherRows().some((row) => row.name === body.name);
    if (existing) throw new DomainError(API_ERRORS.publisherNameTaken);
    this.databaseHandle.database
      .insert(trustedPublishers)
      .values({ ...body, createdBy: actor.username, createdAt: this.clock() })
      .run();
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.trustedPublisherAdded, this.target(body.name), { keyType });
  }

  removePublisher(actor: Actor, name: string) {
    const used = this.ruleRows().filter((row) => (row.publishersJson ?? "").includes(`"${name}"`));
    if (used.length > 0) throw new DomainError(API_ERRORS.publisherInUse);
    const removed = this.databaseHandle.database
      .delete(trustedPublishers)
      .where(eq(trustedPublishers.name, name))
      .run();
    if (removed.changes === 0) throw new DomainError(API_ERRORS.publisherNotFound);
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.trustedPublisherRemoved, this.target(name));
  }

  /** Where proof is required. An empty publisher list means any trusted publisher; named ones must exist. */
  addRule(actor: Actor, body: TrustRuleBody): { id: string } {
    const registry = registryHostOf(body.registry);
    const repository = body.repository === null || body.repository === "" ? null : body.repository;
    const known = new Set(this.publisherRows().map((row) => row.name));
    if (known.size === 0) throw new DomainError(API_ERRORS.publisherNeeded);
    const unknown = body.publishers.filter((name) => !known.has(name));
    if (unknown.length > 0) throw new DomainError(API_ERRORS.publisherNotFound);
    const taken = this.ruleRows().some((row) => row.registry === registry && row.repository === repository);
    if (taken) throw new DomainError(API_ERRORS.trustScopeTaken);
    if (this.ruleRows().length >= IMAGE_PROVENANCE.rulesLimit) throw new DomainError(API_ERRORS.trustRulesFull);
    const id = randomUUID();
    this.databaseHandle.database
      .insert(imageTrustRules)
      .values({
        id,
        registry,
        repository,
        publishersJson: body.publishers.length === 0 ? null : JSON.stringify(body.publishers),
        createdBy: actor.username,
        createdAt: this.clock(),
      })
      .run();
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.imageTrustRuleAdded, this.target(id), {
      scope: scopeOf({ registry, repository }),
      publishers: body.publishers,
    });
    return { id };
  }

  removeRule(actor: Actor, id: string) {
    const removed = this.databaseHandle.database.delete(imageTrustRules).where(eq(imageTrustRules.id, id)).run();
    if (removed.changes === 0) throw new DomainError(API_ERRORS.trustRuleNotFound);
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.imageTrustRuleRemoved, this.target(id));
  }

  /**
   * Which policy this is, as one number: read from the keys and scopes a runner is given, so any other policy has
   * another number whatever the clock did or a restore put back, and a key or a rule added or taken away makes every
   * runner ask its registries again. Nothing set up is 0, as a runner starts with.
   */
  private revision(): number {
    const entries = [
      ...this.publisherRows().map(({ name, publicKey }) => JSON.stringify([name, publicKey])),
      ...this.ruleRows().map(({ registry, repository, publishersJson }) =>
        JSON.stringify([registry, repository, publishersJson]),
      ),
    ].toSorted();
    if (entries.length === 0) return 0;
    return Number.parseInt(sha256Hex(JSON.stringify(entries)).slice(0, IMAGE_PROVENANCE.revisionHexDigits), HEX_RADIX);
  }

  private publisherRows() {
    return this.databaseHandle.database.select().from(trustedPublishers).orderBy(trustedPublishers.name).all();
  }

  private ruleRows() {
    return this.databaseHandle.database.select().from(imageTrustRules).orderBy(imageTrustRules.registry).all();
  }

  private target(id: string) {
    return { kind: TARGET_REGISTRY, id } as const;
  }
}
