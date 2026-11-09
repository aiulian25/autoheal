import { JOB_ACTION, type JobAction } from "../../src/shared/constants.js";
import { ASK_FIRST_ON, ASK_FIRST_STORAGE_KEY, TEXT } from "./constants.js";
import { listSeparator } from "./format.js";

// What asks first where chosen: the two that leave a container down until someone acts again.
const QUESTIONS: Partial<Record<JobAction, (containers: string) => string>> = {
  [JOB_ACTION.stop]: TEXT.actions.confirmStop,
  [JOB_ACTION.remove]: TEXT.actions.confirmRemove,
};

/** Whether this browser asks before a stop or a removal: only once chosen here, and never while storage is off. */
export function asksFirst(): boolean {
  try {
    return window.localStorage.getItem(ASK_FIRST_STORAGE_KEY) === ASK_FIRST_ON;
  } catch {
    return false;
  }
}

/** Keeps the choice in this browser only, as the look is kept. */
export function chooseAskFirst(on: boolean) {
  try {
    if (on) {
      window.localStorage.setItem(ASK_FIRST_STORAGE_KEY, ASK_FIRST_ON);
    } else {
      window.localStorage.removeItem(ASK_FIRST_STORAGE_KEY);
    }
  } catch {
    // Storage can be off (a private window): nothing is kept, and both act on one click as by default.
  }
}

/** What a stop or a removal of these containers asks once first, where this browser chose that; null goes ahead. */
export function askFirstQuestion(action: JobAction, names: readonly string[]): string | null {
  const question = QUESTIONS[action];
  if (question === undefined || !asksFirst()) {
    return null;
  }
  const said = names.map((name, index) => `${listSeparator(index, names.length)}${name}`).join("");
  return question(said);
}
