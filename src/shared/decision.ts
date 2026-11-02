import { z } from "zod";
import {
  ACTION_ESCALATE,
  ACTION_RESTART_DEPENDENCY,
  ALLOWED_ACTIONS,
  DECISION_MESSAGES,
  DIAGNOSIS_TEXT_LIMIT,
  RESTARTING_ACTIONS,
  type AllowedAction,
} from "./constants.js";
import { restartableContainers, type IncidentReport } from "./report.js";

export interface Decision {
  action: AllowedAction;
  target: string;
  diagnosis: string;
}

const decisionAnswerSchema = z.object({
  action: z.enum(ALLOWED_ACTIONS),
  target: z.string(),
  diagnosis: z.string(),
});

// Sent to Ollama as `format`, so the model can only answer in this shape.
const { $schema: _draftUri, ...decisionJsonSchema } = z.toJSONSchema(decisionAnswerSchema);
export { decisionJsonSchema };

const isAllowedAction = (action: unknown): action is AllowedAction =>
  ALLOWED_ACTIONS.some((allowed) => allowed === action);

export const isRestart = (decision: Decision) => RESTARTING_ACTIONS.has(decision.action);

function escalation(failedContainer: string, reason: string, diagnosis: string = DECISION_MESSAGES.unknownDiagnosis) {
  const note = DECISION_MESSAGES.invalidDecision(reason);
  // The reason can quote the model's target, so the whole text is capped, not just the model's part.
  const fullDiagnosis = `${note} ${diagnosis}`.slice(0, DIAGNOSIS_TEXT_LIMIT);
  return { action: ACTION_ESCALATE, target: failedContainer, diagnosis: fullDiagnosis } satisfies Decision;
}

function parseJsonObject(rawAnswer: string): Record<string, unknown> | null {
  try {
    const answer: unknown = JSON.parse(rawAnswer);
    const isObject = typeof answer === "object" && answer !== null && !Array.isArray(answer);
    return isObject ? (answer as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Turn an answer object into a safe Decision; anything off becomes an escalation. `dependencies`: the only
 * containers a dependency restart may name, for the model's answers; null for a person's choice.
 */
export function validateAnswer(
  answer: Record<string, unknown>,
  failedContainer: string,
  knownContainers: ReadonlySet<string>,
  protectedContainers: ReadonlySet<string>,
  dependencies: ReadonlySet<string> | null = null,
): Decision {
  const action = answer.action;
  const diagnosis = String(answer.diagnosis || DECISION_MESSAGES.unknownDiagnosis).slice(0, DIAGNOSIS_TEXT_LIMIT);
  if (!isAllowedAction(action)) {
    return escalation(failedContainer, DECISION_MESSAGES.reasonUnknownAction(action), diagnosis);
  }
  if (action !== ACTION_RESTART_DEPENDENCY) {
    return { action, target: failedContainer, diagnosis };
  }
  const target = String(answer.target ?? "");
  if (!knownContainers.has(target)) {
    return escalation(failedContainer, DECISION_MESSAGES.reasonUnknownTarget(target), diagnosis);
  }
  if (protectedContainers.has(target)) {
    return escalation(failedContainer, DECISION_MESSAGES.reasonProtectedTarget(target), diagnosis);
  }
  if (dependencies !== null && !dependencies.has(target)) {
    return escalation(failedContainer, DECISION_MESSAGES.reasonNotOffered(target), diagnosis);
  }
  return { action, target, diagnosis };
}

/** The model's decision for one incident: only a dependency the report offered it is taken. */
export function modelDecision(answer: Record<string, unknown>, report: IncidentReport): Decision {
  return validateAnswer(
    answer,
    report.containerName,
    new Set(report.knownContainers),
    new Set(report.protectedContainers),
    new Set(restartableContainers(report)),
  );
}

/** Turn the model's raw answer into a safe Decision; anything off becomes an escalation. */
export function parseDecision(rawAnswer: string, report: IncidentReport): Decision {
  const answer = parseJsonObject(rawAnswer);
  if (answer === null) {
    return escalation(report.containerName, DECISION_MESSAGES.reasonBadJson);
  }
  return modelDecision(answer, report);
}
