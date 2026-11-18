import { JOB_ACTION, type JobAction } from "../../src/shared/constants.js";
import { ASK_FIRST_ON, ASK_FIRST_STORAGE_KEY, TEXT } from "./constants.js";
import { listSeparator } from "./format.js";

// What asks first: the two that leave a container down until someone acts again.
const QUESTIONS: Partial<Record<JobAction, (containers: string) => string>> = {
  [JOB_ACTION.stop]: TEXT.actions.confirmStop,
  [JOB_ACTION.remove]: TEXT.actions.confirmRemove,
};
// Nothing brings a removed container back: it asks in every browser, chosen or not.
const ALWAYS_ASKED: ReadonlySet<JobAction> = new Set([JOB_ACTION.remove]);

/** Whether this browser asks before a stop: only once chosen here, and never while storage is off. */
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
    // Storage can be off (a private window): nothing is kept, and a stop acts on one click as by default.
  }
}

/** What a removal of these containers asks once first, and a stop where this browser chose that; null goes ahead. */
export function askFirstQuestion(action: JobAction, names: readonly string[]): string | null {
  const question = QUESTIONS[action];
  const asks = ALWAYS_ASKED.has(action) || asksFirst();
  if (question === undefined || !asks) {
    return null;
  }
  const said = names.map((name, index) => `${listSeparator(index, names.length)}${name}`).join("");
  return question(said);
}
