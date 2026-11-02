import {
  ANSWER_TOKEN_RESERVE,
  CHARACTERS_PER_TOKEN_ESTIMATE,
  ANSWER_SHARE_AT_MOST,
  RUNBOOK_SECTION,
  RUNBOOKS_HEADING,
  RUNBOOKS_IN_PROMPT_CHARACTER_LIMIT,
  SYSTEM_PROMPT,
} from "./constants.js";
import { sha256Hex } from "./hash.js";
import { renderReport, type IncidentReport } from "./report.js";

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
  // Identifies the instructions (system prompt and, later, runbooks), not the incident.
  promptHash: string;
}

export interface RunbookInstruction {
  runbookId: string;
  versionId: string;
  title: string;
  version: number;
  body: string;
}

/**
 * The built-in rules plus the owner's runbooks, least specific first. Runbooks that would push
 * the total past the limit are left out whole rather than cut mid-sentence. `rules`: a decision's, or a repair's.
 */
export function composeSystemPrompt(
  instructions: readonly RunbookInstruction[],
  rules = SYSTEM_PROMPT,
): {
  systemPrompt: string;
  included: RunbookInstruction[];
} {
  const included: RunbookInstruction[] = [];
  let used = 0;
  for (const instruction of instructions) {
    const section = RUNBOOK_SECTION(instruction.title, instruction.version, instruction.body);
    if (used + section.length > RUNBOOKS_IN_PROMPT_CHARACTER_LIMIT) {
      continue;
    }
    included.push(instruction);
    used += section.length;
  }
  if (included.length === 0) {
    return { systemPrompt: rules, included };
  }
  const sections = included.map((instruction) =>
    RUNBOOK_SECTION(instruction.title, instruction.version, instruction.body),
  );
  return { systemPrompt: [rules, RUNBOOKS_HEADING, ...sections].join("\n\n"), included };
}

/** How many characters of the model's context are left once its answer has room and these are in. */
export function charactersLeft(contextTokens: number, ...taken: readonly string[]): number {
  const answerRoom = Math.min(ANSWER_TOKEN_RESERVE, contextTokens * ANSWER_SHARE_AT_MOST);
  const budget = (contextTokens - answerRoom) * CHARACTERS_PER_TOKEN_ESTIMATE;
  return Math.max(0, budget - taken.reduce((sum, text) => sum + text.length, 0));
}

/**
 * The prompt for one incident, trimmed to the model's context: the oldest log lines go first, so
 * the instructions, the added sections and the newest lines always fit and Ollama never has to cut silently.
 */
export function buildPrompt(
  report: IncidentReport,
  contextTokens: number,
  systemPrompt = SYSTEM_PROMPT,
  sections: readonly string[] = [],
): BuiltPrompt {
  const withoutLogs = renderReport({ ...report, logs: "" }, sections);
  const roomForLogs = charactersLeft(contextTokens, systemPrompt, withoutLogs);
  const logs = report.logs.length > roomForLogs ? report.logs.slice(report.logs.length - roomForLogs) : report.logs;
  return {
    systemPrompt,
    userPrompt: renderReport({ ...report, logs }, sections),
    promptHash: sha256Hex(systemPrompt),
  };
}
