import { randomUUID } from "node:crypto";
import { sha256Hex } from "../../shared/hash.js";
import { imageRepository } from "../../shared/image-reference.js";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import { API_ERRORS, type PromptSnapshotView, type RunbookView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  RUNBOOK_CHARACTER_LIMIT,
  RUNBOOK_SCOPE_CONTAINER,
  RUNBOOK_SCOPE_GLOBAL,
  RUNBOOK_SCOPE_IMAGE,
  RUNBOOK_SCOPES,
  TARGET_RUNBOOK,
  type RunbookScope,
} from "../../shared/constants.js";
import type { RunbookInstruction } from "../../shared/prompt.js";
import type { IncidentReport } from "../../shared/report.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { promptSnapshots, runbookVersions, runbooks, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

export interface RunbookDraft {
  scope: RunbookScope;
  pattern?: string | undefined;
  title: string;
  body: string;
}

type RunbookRow = typeof runbooks.$inferSelect;
type VersionRow = typeof runbookVersions.$inferSelect;

function checkPattern(scope: RunbookScope, pattern: string | undefined): string | null {
  const isGlobal = scope === RUNBOOK_SCOPE_GLOBAL;
  const missing = pattern === undefined || pattern.length === 0;
  if (isGlobal !== missing) {
    throw new DomainError(API_ERRORS.runbookPatternInvalid);
  }
  return isGlobal ? null : pattern!;
}

function checkLength(body: string) {
  if (body.length > RUNBOOK_CHARACTER_LIMIT) {
    throw new DomainError(API_ERRORS.runbookTooLong);
  }
}

const latestPublished = (versions: readonly VersionRow[]) =>
  versions
    .filter((version) => version.publishedAt !== null)
    .sort((first, second) => second.publishedAt! - first.publishedAt! || second.version - first.version)[0] ?? null;

/**
 * The owner's own instructions to the model. Versions never change once saved; decisions use
 * each runbook's most recently published version, so drafts can be tried (replayed) first.
 */
export class RunbooksService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  list(): RunbookView[] {
    const database = this.databaseHandle.database;
    const allRunbooks = database.select().from(runbooks).orderBy(asc(runbooks.title)).all();
    const versions = this.versionsWithAuthors(allRunbooks.map((runbook) => runbook.id));
    return allRunbooks.map((runbook) => this.view(runbook, versions.get(runbook.id) ?? []));
  }

  get(runbookId: string): RunbookView {
    const runbook = this.requireRunbook(runbookId);
    return this.view(runbook, this.versionsWithAuthors([runbookId]).get(runbookId) ?? []);
  }

  create(actor: Actor, draft: RunbookDraft): RunbookView {
    const pattern = checkPattern(draft.scope, draft.pattern);
    checkLength(draft.body);
    const now = this.clock();
    const runbook = this.databaseHandle.database.transaction((transaction) => {
      const created = transaction
        .insert(runbooks)
        .values({
          id: randomUUID(),
          scope: draft.scope,
          pattern,
          title: draft.title,
          createdBy: actor.userId,
          createdAt: now,
        })
        .returning()
        .get();
      transaction
        .insert(runbookVersions)
        .values(this.versionRow(created.id, 1, draft.body, actor, now))
        .run();
      return created;
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.runbookCreated,
      { kind: TARGET_RUNBOOK, id: runbook.id },
      {
        title: draft.title,
        scope: draft.scope,
      },
    );
    return this.get(runbook.id);
  }

  saveVersion(actor: Actor, runbookId: string, body: string): RunbookView {
    this.requireEditableRunbook(runbookId);
    checkLength(body);
    const version = this.databaseHandle.database.transaction((transaction) => {
      const latest = transaction
        .select({ version: max(runbookVersions.version) })
        .from(runbookVersions)
        .where(eq(runbookVersions.runbookId, runbookId))
        .get();
      const next = (latest?.version ?? 0) + 1;
      transaction
        .insert(runbookVersions)
        .values(this.versionRow(runbookId, next, body, actor, this.clock()))
        .run();
      return next;
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.runbookVersionSaved,
      { kind: TARGET_RUNBOOK, id: runbookId },
      {
        version,
      },
    );
    return this.get(runbookId);
  }

  publish(actor: Actor, runbookId: string, versionId: string): RunbookView {
    this.requireEditableRunbook(runbookId);
    const published = this.databaseHandle.database
      .update(runbookVersions)
      .set({ publishedAt: this.clock() })
      .where(and(eq(runbookVersions.id, versionId), eq(runbookVersions.runbookId, runbookId)))
      .returning()
      .get();
    if (published === undefined) {
      throw new DomainError(API_ERRORS.runbookVersionNotFound);
    }
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.runbookPublished,
      { kind: TARGET_RUNBOOK, id: runbookId },
      {
        version: published.version,
      },
    );
    return this.get(runbookId);
  }

  archive(actor: Actor, runbookId: string): RunbookView {
    this.requireRunbook(runbookId);
    this.databaseHandle.database
      .update(runbooks)
      .set({ archivedAt: this.clock() })
      .where(eq(runbooks.id, runbookId))
      .run();
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.runbookArchived, { kind: TARGET_RUNBOOK, id: runbookId });
    return this.get(runbookId);
  }

  /**
   * The published runbooks that apply to this incident, least specific first. `drafts` swaps in
   * unpublished versions (by version id) for a replay, without touching what live decisions use.
   */
  instructionsFor(report: IncidentReport, drafts: readonly string[] = []): RunbookInstruction[] {
    const database = this.databaseHandle.database;
    const active = database.select().from(runbooks).where(isNull(runbooks.archivedAt)).all();
    const matching = active.filter(
      (runbook) =>
        runbook.scope === RUNBOOK_SCOPE_GLOBAL ||
        (runbook.scope === RUNBOOK_SCOPE_CONTAINER && runbook.pattern === report.containerName) ||
        (runbook.scope === RUNBOOK_SCOPE_IMAGE && runbook.pattern === imageRepository(report.image)),
    );
    const versions = this.versionsWithAuthors(matching.map((runbook) => runbook.id));
    const draftIds = new Set(drafts);
    return matching
      .sort(
        (first, second) =>
          RUNBOOK_SCOPES.indexOf(first.scope) - RUNBOOK_SCOPES.indexOf(second.scope) ||
          first.title.localeCompare(second.title),
      )
      .flatMap((runbook) => {
        const own = versions.get(runbook.id) ?? [];
        const chosen = own.find((version) => draftIds.has(version.id)) ?? latestPublished(own);
        return chosen === null
          ? []
          : [
              {
                runbookId: runbook.id,
                versionId: chosen.id,
                title: runbook.title,
                version: chosen.version,
                body: chosen.body,
              },
            ];
      });
  }

  assertVersionsExist(versionIds: readonly string[]) {
    const unique = [...new Set(versionIds)];
    if (unique.length === 0) {
      return;
    }
    const found = this.databaseHandle.database
      .select({ id: runbookVersions.id })
      .from(runbookVersions)
      .where(inArray(runbookVersions.id, unique))
      .all();
    if (found.length !== unique.length) {
      throw new DomainError(API_ERRORS.runbookVersionNotFound);
    }
  }

  savePromptSnapshot(hash: string, systemPrompt: string) {
    this.databaseHandle.database
      .insert(promptSnapshots)
      .values({ hash, systemPrompt, createdAt: this.clock() })
      .onConflictDoNothing()
      .run();
  }

  promptSnapshot(hash: string): PromptSnapshotView {
    const snapshot = this.databaseHandle.database
      .select()
      .from(promptSnapshots)
      .where(eq(promptSnapshots.hash, hash))
      .get();
    if (snapshot === undefined) {
      throw new DomainError(API_ERRORS.promptNotFound);
    }
    return snapshot;
  }

  private versionRow(runbookId: string, version: number, body: string, actor: Actor, now: number) {
    return {
      id: randomUUID(),
      runbookId,
      version,
      body,
      contentHash: sha256Hex(body),
      createdBy: actor.userId,
      createdAt: now,
    };
  }

  private requireRunbook(runbookId: string): RunbookRow {
    const runbook = this.databaseHandle.database.select().from(runbooks).where(eq(runbooks.id, runbookId)).get();
    if (runbook === undefined) {
      throw new DomainError(API_ERRORS.runbookNotFound);
    }
    return runbook;
  }

  private requireEditableRunbook(runbookId: string): RunbookRow {
    const runbook = this.requireRunbook(runbookId);
    if (runbook.archivedAt !== null) {
      throw new DomainError(API_ERRORS.runbookArchived);
    }
    return runbook;
  }

  private versionsWithAuthors(runbookIds: string[]): Map<string, (VersionRow & { author: string })[]> {
    const byRunbook = new Map<string, (VersionRow & { author: string })[]>();
    if (runbookIds.length === 0) {
      return byRunbook;
    }
    const rows = this.databaseHandle.database
      .select({ version: runbookVersions, author: users.username })
      .from(runbookVersions)
      .innerJoin(users, eq(users.id, runbookVersions.createdBy))
      .where(inArray(runbookVersions.runbookId, runbookIds))
      .orderBy(asc(runbookVersions.version))
      .all();
    for (const { version, author } of rows) {
      byRunbook.set(version.runbookId, [...(byRunbook.get(version.runbookId) ?? []), { ...version, author }]);
    }
    return byRunbook;
  }

  private view(runbook: RunbookRow, versions: (VersionRow & { author: string })[]): RunbookView {
    return {
      id: runbook.id,
      scope: runbook.scope,
      pattern: runbook.pattern,
      title: runbook.title,
      archived: runbook.archivedAt !== null,
      createdAt: runbook.createdAt,
      publishedVersion: latestPublished(versions)?.version ?? null,
      versions: versions.map((version) => ({
        id: version.id,
        version: version.version,
        body: version.body,
        contentHash: version.contentHash,
        createdBy: version.author,
        createdAt: version.createdAt,
        publishedAt: version.publishedAt,
      })),
    };
  }
}
