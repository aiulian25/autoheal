import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { API_ERRORS, type ReplayRunView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  PRIORITY_REPLAY,
  REPLAY_FINISHED,
  REPLAY_LIST_LIMIT,
  REPLAY_RUNNING,
  TARGET_REPLAY,
} from "../../shared/constants.js";
import { parseDecision } from "../../shared/decision.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { buildPrompt, composeSystemPrompt } from "../../shared/prompt.js";
import type { OllamaClient } from "../../ollama/ollama-client.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { incidents, replayResults, replayRuns, users } from "../database/schema.js";
import type { DecisionQueue } from "../decisions/decision-queue.js";
import { DomainError } from "../domain-error.js";
import type { IncidentRow, IncidentsService } from "../incidents/incidents-service.js";
import type { RunbooksService } from "../runbooks/runbooks-service.js";

export interface ReplayRequest {
  draftVersionIds: string[];
  incidentCount: number;
  // These instead of the most recent ones.
  incidentIds?: string[] | undefined;
  // Another model of the same Ollama instead of the one in use.
  modelName?: string | undefined;
}

interface ReplayContext {
  incidents: IncidentsService;
  runbooks: RunbooksService;
  queue: DecisionQueue;
  ollama: OllamaClient;
}

/**
 * "What would the model decide now?" for recent real incidents, using draft runbooks. It only
 * reads incidents and writes its own results: no work items, no changes to the incidents.
 */
export class ReplayService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly context: ReplayContext,
    private readonly clock: () => number = Date.now,
  ) {}

  async start(actor: Actor, request: ReplayRequest): Promise<ReplayRunView> {
    this.context.runbooks.assertVersionsExist(request.draftVersionIds);
    const ollama = await this.candidate(request.modelName);
    const database = this.databaseHandle.database;
    const targets =
      request.incidentIds === undefined ? this.recent(request.incidentCount) : this.chosen(request.incidentIds);
    const run = database
      .insert(replayRuns)
      .values({
        id: randomUUID(),
        createdBy: actor.userId,
        createdAt: this.clock(),
        status: REPLAY_RUNNING,
        modelName: ollama.model,
        modelDigest: await ollama.modelDigest(),
        draftVersionIdsJson: JSON.stringify(request.draftVersionIds),
        incidentCount: targets.length,
      })
      .returning()
      .get();
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.replayStarted,
      { kind: TARGET_REPLAY, id: run.id },
      {
        incidents: targets.length,
        drafts: request.draftVersionIds.length,
        model: ollama.model,
      },
    );
    const work = this.replayAll(ollama, run.id, targets, request.draftVersionIds)
      .catch((error: unknown) => log(describeError(error)))
      .finally(() => this.running.delete(run.id));
    this.running.set(run.id, work);
    return this.get(run.id);
  }

  // The model in use, or another the same Ollama has: one it lacks is refused before anything is stored.
  private async candidate(modelName: string | undefined): Promise<OllamaClient> {
    if (modelName === undefined) {
      return this.context.ollama;
    }
    // An Ollama that does not answer has no model to try either.
    const present = await this.context.ollama.hasModel(modelName).catch(() => false);
    if (!present) {
      throw new DomainError(API_ERRORS.modelNotFound);
    }
    return this.context.ollama.withModel(modelName);
  }

  // The most recent incidents the model decided.
  private recent(count: number): IncidentRow[] {
    return this.databaseHandle.database
      .select()
      .from(incidents)
      .where(isNotNull(incidents.action))
      .orderBy(desc(incidents.createdAt))
      .limit(count)
      .all();
  }

  // The ones asked for, each with a decision to compare the draft's against.
  private chosen(incidentIds: readonly string[]): IncidentRow[] {
    const wanted = [...new Set(incidentIds)];
    const found = this.databaseHandle.database
      .select()
      .from(incidents)
      .where(and(inArray(incidents.id, wanted), isNotNull(incidents.action)))
      .orderBy(desc(incidents.createdAt))
      .all();
    if (found.length !== wanted.length) {
      throw new DomainError(API_ERRORS.incidentNotFound);
    }
    return found;
  }

  /** A run still "running" at startup has no process behind it any more. */
  finishInterrupted(): number {
    const stuck = this.databaseHandle.database
      .update(replayRuns)
      .set({ status: REPLAY_FINISHED, finishedAt: this.clock() })
      .where(eq(replayRuns.status, REPLAY_RUNNING))
      .run();
    return stuck.changes;
  }

  /** Resolves when the replay is done; for tests. */
  whenFinished(replayId: string): Promise<void> {
    return this.running.get(replayId) ?? Promise.resolve();
  }

  list(): ReplayRunView[] {
    return this.databaseHandle.database
      .select({ id: replayRuns.id })
      .from(replayRuns)
      .orderBy(desc(replayRuns.createdAt))
      .limit(REPLAY_LIST_LIMIT)
      .all()
      .map(({ id }) => this.get(id));
  }

  get(replayId: string): ReplayRunView {
    const database = this.databaseHandle.database;
    const row = database
      .select({ run: replayRuns, createdBy: users.username })
      .from(replayRuns)
      .innerJoin(users, eq(users.id, replayRuns.createdBy))
      .where(eq(replayRuns.id, replayId))
      .get();
    if (row === undefined) {
      throw new DomainError(API_ERRORS.replayNotFound);
    }
    const results = database
      .select({ result: replayResults, containerName: incidents.containerName })
      .from(replayResults)
      .innerJoin(incidents, eq(incidents.id, replayResults.incidentId))
      .where(eq(replayResults.replayRunId, replayId))
      .orderBy(asc(replayResults.id))
      .all();
    return {
      id: row.run.id,
      status: row.run.status,
      createdBy: row.createdBy,
      createdAt: row.run.createdAt,
      finishedAt: row.run.finishedAt,
      modelName: row.run.modelName,
      modelDigest: row.run.modelDigest,
      draftVersionIds: JSON.parse(row.run.draftVersionIdsJson) as string[],
      incidentCount: row.run.incidentCount,
      changedCount: results.filter(({ result }) => result.changed).length,
      results: results.map(({ result, containerName }) => ({
        incidentId: result.incidentId,
        containerName,
        originalAction: result.originalAction,
        originalTarget: result.originalTarget,
        replayAction: result.replayAction,
        replayTarget: result.replayTarget,
        replayDiagnosis: result.replayDiagnosis,
        changed: result.changed,
        error: result.error,
      })),
    };
  }

  private async replayAll(ollama: OllamaClient, replayId: string, targets: IncidentRow[], drafts: string[]) {
    for (const incident of targets) {
      await this.replayOne(ollama, replayId, incident, drafts);
    }
    this.databaseHandle.database
      .update(replayRuns)
      .set({ status: REPLAY_FINISHED, finishedAt: this.clock() })
      .where(eq(replayRuns.id, replayId))
      .run();
  }

  private async replayOne(ollama: OllamaClient, replayId: string, incident: IncidentRow, drafts: string[]) {
    const { incidents: incidentsService, runbooks, queue } = this.context;
    const original = {
      replayRunId: replayId,
      incidentId: incident.id,
      originalAction: incident.action,
      originalTarget: incident.target,
    };
    const report = incidentsService.reportOf(incident.id);
    try {
      const { systemPrompt } = composeSystemPrompt(runbooks.instructionsFor(report!, drafts));
      const prompt = buildPrompt(report!, ollama.contextTokens, systemPrompt, incidentsService.evidenceOf(incident.id));
      const { content } = await queue.enqueue(PRIORITY_REPLAY, (signal) =>
        ollama.chat(prompt.systemPrompt, prompt.userPrompt, signal),
      );
      const decision = parseDecision(content, report!);
      const changed = decision.action !== incident.action || decision.target !== incident.target;
      this.databaseHandle.database
        .insert(replayResults)
        .values({
          ...original,
          replayAction: decision.action,
          replayTarget: decision.target,
          replayDiagnosis: decision.diagnosis,
          changed,
        })
        .run();
    } catch (error) {
      this.databaseHandle.database
        .insert(replayResults)
        .values({ ...original, changed: false, error: describeError(error) })
        .run();
    }
  }
}
