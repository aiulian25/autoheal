import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { API_ERRORS, type ApiErrorCode } from "../../shared/api.js";
import {
  JARVIS_ANSWER,
  JARVIS_ANSWER_HOW,
  JARVIS_STATUS,
  type JarvisOutcome,
  type JarvisReplies,
  type JarvisStatus,
} from "../../shared/jarvis.js";

// Still waiting for its answer. One its house never confirmed hearing may still be answered by a phone's button.
export const OPEN_TO_ANSWERS: readonly JarvisStatus[] = [
  JARVIS_STATUS.waiting,
  JARVIS_STATUS.sent,
  JARVIS_STATUS.asked,
  JARVIS_STATUS.unconfirmed,
];
// Ended without an answer: whoever answers late is told so. One answered already is not answered again, in silence.
export const ENDED_UNANSWERED: readonly JarvisStatus[] = [JARVIS_STATUS.retired, JARVIS_STATUS.dropped];

const GONE: readonly ApiErrorCode[] = [
  API_ERRORS.noUpdate,
  API_ERRORS.containerNotFound,
  API_ERRORS.notDispatchable,
  API_ERRORS.taskNotFound,
];

export const answerSchema = z.object({
  answer: z.enum(Object.values(JARVIS_ANSWER)),
  how: z.enum(Object.values(JARVIS_ANSWER_HOW)),
  room: z.string().nullable(),
  by: z.string(),
  at: z.number(),
  // How each update a yes started ended, by its task: true when it was updated.
  outcomes: z.record(z.string(), z.boolean()),
});
export type AssistantAnswer = z.infer<typeof answerSchema>;

/** Whether a code that came back is this one, compared in constant time. */
export function sameCode(kept: string | null, given: string): boolean {
  if (kept === null || kept.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(kept), Buffer.from(given));
}

/** What the hand-over's refusal means to a person who said yes. */
export function refusalWords(code: ApiErrorCode, host: string, replies: JarvisReplies) {
  if (code === API_ERRORS.handsOff) return replies.handsOff(host);
  if (code === API_ERRORS.hostPackagesBusy) return replies.busy(host);
  return GONE.includes(code) ? replies.gone : replies.notHandedOver;
}

/** What came of a yes, update by update in the question's order: updated, not updated, or not done yet. */
export function outcomeOf(
  names: readonly string[],
  taskIds: readonly string[],
  outcomes: Readonly<Record<string, boolean>>,
): JarvisOutcome {
  const ended = taskIds.map((taskId, index) => ({ name: names[index]!, updated: outcomes[taskId] }));
  return {
    updated: ended.filter(({ updated }) => updated === true).map(({ name }) => name),
    notUpdated: ended.filter(({ updated }) => updated === false).map(({ name }) => name),
    notDone: ended.filter(({ updated }) => updated === undefined).map(({ name }) => name),
  };
}
