import { randomUUID } from "node:crypto";
import { ResultJournal } from "./result-journal.js";
import {
  ACTION_ESCALATE,
  RUNNER_MESSAGES,
  DECIDED_BY,
  DECISION_DEADLINE_MILLISECONDS,
  DECISION_MESSAGES,
  type DecidedBy,
} from "../shared/constants.js";
import { parseDecision, type Decision } from "../shared/decision.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import { buildPrompt } from "../shared/prompt.js";
import type { IncidentSubmission, Outcome } from "../shared/protocol.js";
import type { OllamaClient } from "../ollama/ollama-client.js";
import type { ControlPlaneClient } from "./control-plane-client.js";

/** The Ollama to ask when deciding alone, and the context it takes; null while none is known. */
export type LocalModel = { client: OllamaClient; contextTokens: number } | null;

export interface DecisionOutcome {
  // Null when the runner decided on its own; the control plane learns about it later.
  incidentId: string | null;
  resultId?: string;
  decision: Decision;
  decidedBy: DecidedBy;
}

/**
 * Where decisions come from: the control plane when it answers in time, otherwise Ollama asked
 * directly with the built-in rules, otherwise an escalation. Healing never waits on the dashboard.
 */
export class Decider {
  private localCall: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly controlPlane: ControlPlaneClient | null,
    private readonly localModel: () => LocalModel,
    private readonly deadlineMilliseconds: number = DECISION_DEADLINE_MILLISECONDS,
    private readonly results = new ResultJournal(),
  ) {}

  async decide(submission: IncidentSubmission): Promise<DecisionOutcome> {
    if (this.controlPlane !== null) {
      try {
        const signal = AbortSignal.timeout(this.deadlineMilliseconds);
        const { incidentId, decision } = await this.controlPlane.submitIncident(submission, signal);
        return { incidentId, decision, decidedBy: DECIDED_BY.model };
      } catch (error) {
        log(RUNNER_MESSAGES.fallingBack(describeError(error)));
      }
    }
    return { incidentId: null, decision: await this.decideLocally(submission), decidedBy: DECIDED_BY.agentFallback };
  }

  async prepareOutcome(submission: IncidentSubmission, decided: DecisionOutcome) {
    decided.resultId ??= decided.incidentId ?? randomUUID();
    if (
      !(await this.results.reserve(
        decided.incidentId === null ? "handled" : "incident",
        decided.resultId,
        decided.decision.target || submission.report.containerName,
      ))
    )
      throw new Error("This action already has a saved result or requires reconciliation; it will not be repeated.");
  }

  async recordOutcome(submission: IncidentSubmission, decided: DecisionOutcome, result: Outcome) {
    if (decided.resultId === undefined) await this.prepareOutcome(submission, decided);
    const id = decided.resultId!;
    await this.results.complete(
      decided.incidentId === null
        ? { kind: "handled", id, result: { ...submission, resultId: id, decision: decided.decision, result } }
        : { kind: "incident", id, result },
    );
    // Local-only runs retain their bounded history until an operator archives it.
    if (decided.incidentId !== null) await this.flushOutbox();
  }

  async flushOutbox() {
    if (this.controlPlane === null) return;
    await this.results.flush(["handled", "incident"], (report) => {
      if (report.kind === "handled") return this.controlPlane!.submitHandled(report.result);
      if (report.kind === "incident") return this.controlPlane!.reportOutcome(report.id, report.result);
      throw new Error("Unexpected report kind");
    });
  }

  get pendingHandled(): number {
    return this.controlPlane === null ? 0 : this.results.count(["handled", "incident"]);
  }

  // One local model call at a time on this host: failures often arrive together, and the Mini answers one at a time.
  private decideLocally(submission: IncidentSubmission): Promise<Decision> {
    const call = this.localCall.then(() => this.askOllama(submission));
    this.localCall = call.catch(() => undefined);
    return call;
  }

  private async askOllama({ report }: IncidentSubmission): Promise<Decision> {
    const model = this.localModel();
    if (model === null) {
      return { action: ACTION_ESCALATE, target: report.containerName, diagnosis: DECISION_MESSAGES.noOllamaKnown };
    }
    const prompt = buildPrompt(report, model.contextTokens);
    try {
      const { content } = await model.client.chat(prompt.systemPrompt, prompt.userPrompt);
      return parseDecision(content, report);
    } catch (error) {
      const diagnosis = DECISION_MESSAGES.ollamaFailed(describeError(error));
      return { action: ACTION_ESCALATE, target: report.containerName, diagnosis };
    }
  }
}
