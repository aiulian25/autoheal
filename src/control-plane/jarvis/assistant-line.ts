import { MILLISECONDS_PER_SECOND } from "../../shared/constants.js";
import {
  JARVIS_ANSWER,
  JARVIS_ANSWER_HOW,
  JARVIS_CODE_CHARACTERS,
  JARVIS_LIMITS,
  type JarvisAnswerHow,
} from "../../shared/jarvis.js";

// The way back that needs no key: Home Assistant writes one line into a Text helper, and Autoheal reads it on the
// socket it already keeps. Only Text helpers are read, and only text that starts so.
export const ANSWER_BOX_DOMAIN = "input_text.";
export const LINE_PREFIX = "autoheal ";

export const LINE_VERB = { heard: "heard", later: "later", ...JARVIS_ANSWER } as const;

export type AssistantLine =
  // About a message: it was said or shown, or it was not the time. The id is the message's, or the test's nonce.
  | { verb: typeof LINE_VERB.heard | typeof LINE_VERB.later; id: string; at: number }
  // An answer to a question, by its code, and how it was given.
  | {
      verb: typeof LINE_VERB.yes | typeof LINE_VERB.no;
      code: string;
      at: number;
      how: JarvisAnswerHow;
      room: string | null;
    };

const TIME_DIGITS_AT_MOST = 12;
const TIME = `(\\d{1,${TIME_DIGITS_AT_MOST}})`;
const ABOUT = new RegExp(
  `^${LINE_PREFIX}(${LINE_VERB.heard}|${LINE_VERB.later}) ([A-Za-z0-9_-]{1,${JARVIS_LIMITS.messageIdCharacters}}) ${TIME}$`,
);
const ANSWER = new RegExp(
  `^${LINE_PREFIX}(${LINE_VERB.yes}|${LINE_VERB.no}) ([A-Za-z0-9_-]{${JARVIS_CODE_CHARACTERS}}) ${TIME} ` +
    `(${Object.values(JARVIS_ANSWER_HOW).join("|")})(?: ([\\p{L}\\p{N}._' -]{1,${JARVIS_LIMITS.roomCharacters}}))?$`,
  "u",
);

const secondsAt = (seconds: string) => Number(seconds) * MILLISECONDS_PER_SECOND;

/**
 * `autoheal heard|later <id> <time>` or `autoheal yes|no <code> <time> voice|phone [room]`, the time in seconds by
 * Home Assistant's clock; null for anything else.
 */
export function parseAssistantLine(text: string): AssistantLine | null {
  if (text.length > JARVIS_LIMITS.lineCharacters) return null;
  const about = ABOUT.exec(text);
  if (about !== null) {
    const [, verb, id, seconds] = about;
    return { verb: verb as typeof LINE_VERB.heard, id: id!, at: secondsAt(seconds!) };
  }
  const answer = ANSWER.exec(text);
  if (answer === null) return null;
  const [, verb, code, seconds, how, room] = answer;
  const said = room?.trim() ?? "";
  return {
    verb: verb as typeof LINE_VERB.yes,
    code: code!,
    at: secondsAt(seconds!),
    how: how as JarvisAnswerHow,
    room: said === "" ? null : said,
  };
}
