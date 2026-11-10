import { randomBytes } from "node:crypto";
import { MILLISECONDS_PER_SECOND } from "../../shared/constants.js";
import {
  JARVIS_LIMITS,
  JARVIS_TEST_OUTCOME,
  type JarvisAnswer,
  type JarvisAnswerHow,
  type JarvisTestAnswer,
  type JarvisTestOutcome,
  type JarvisTestQuestionView,
} from "../../shared/jarvis.js";
import { sameCode } from "./assistant-answers.js";

/**
 * The card's test question, while it is the last one sent. It goes out as any question does, and the lines that come
 * back for it are the ones any question gets: whichever of them came says which part of the way back works.
 */
export class TestQuestion {
  readonly id = randomBytes(JARVIS_LIMITS.nonceBytes).toString("hex");
  readonly code = randomBytes(JARVIS_LIMITS.codeBytes).toString("base64url");
  // Whether Home Assistant took it; null while it is on its way.
  delivered: boolean | null = null;
  private heard = false;
  private putOff = false;
  private answered: JarvisTestAnswer | null = null;

  constructor(private readonly startedAt: number) {}

  hear(id: string) {
    if (id === this.id) this.heard = true;
  }

  postpone(id: string) {
    if (id === this.id) this.putOff = true;
  }

  owns(code: string) {
    return sameCode(this.code, code);
  }

  /** Its first answer, however late it comes; null once it was answered already. */
  answer(said: JarvisAnswer, how: JarvisAnswerHow, now: number): JarvisTestAnswer | null {
    if (this.answered !== null) return null;
    this.answered = { said, how, seconds: Math.round((now - this.startedAt) / MILLISECONDS_PER_SECOND) };
    return this.answered;
  }

  view(now: number): JarvisTestQuestionView {
    return { outcome: this.outcome(now), answer: this.answered };
  }

  private outcome(now: number): JarvisTestOutcome {
    if (this.answered !== null) return JARVIS_TEST_OUTCOME.answered;
    if (this.putOff) return JARVIS_TEST_OUTCOME.putOff;
    // A line about it proves Home Assistant took it, whatever its answer to the webhook said.
    if (this.delivered === false && !this.heard) return JARVIS_TEST_OUTCOME.notTaken;
    const waiting = this.delivered === null || now - this.startedAt < JARVIS_LIMITS.testQuestionMilliseconds;
    if (waiting) return JARVIS_TEST_OUTCOME.asking;
    return this.heard ? JARVIS_TEST_OUTCOME.notAnswered : JARVIS_TEST_OUTCOME.nothingBack;
  }
}
