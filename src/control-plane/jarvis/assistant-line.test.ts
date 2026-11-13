import { describe, expect, it } from "vitest";
import { parseAssistantLine } from "./assistant-line.js";

const ID = "0b6c1d2e-5f00-4c4b-9a6e-2d8e7f3a1b90";
const WRITTEN = 1794316452;
const CODE = "Zk3vQ8mN2pL5tR7wX9yB1c";

describe("a line in the answer box", () => {
  it("reads heard and later, with the message and when Home Assistant wrote it", () => {
    expect(parseAssistantLine(`autoheal heard ${ID} ${WRITTEN}`)).toEqual({
      verb: "heard",
      id: ID,
      at: WRITTEN * 1000,
    });
    // A test's nonce goes back the same way.
    expect(parseAssistantLine(`autoheal later 9f8e7d6c5b4a39281706f5e4d3c2b1a0 7`)).toEqual({
      verb: "later",
      id: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      at: 7000,
    });
  });

  it("reads nothing else: another verb, a token out of shape, a part too many or too few, a stray space", () => {
    const refused = [
      "",
      "unknown",
      `autoheal heard ${ID}`,
      `autoheal heard ${WRITTEN}`,
      `autoheal heard ${ID} ${WRITTEN} voice`,
      `autoheal told ${ID} ${WRITTEN}`,
      `Autoheal heard ${ID} ${WRITTEN}`,
      `autoheal  heard ${ID} ${WRITTEN}`,
      ` autoheal heard ${ID} ${WRITTEN}`,
      `autoheal heard ${ID} ${WRITTEN} `,
      `autoheal heard ${ID}0 ${WRITTEN}`,
      `autoheal heard bad/id ${WRITTEN}`,
      `autoheal heard ${ID} ${WRITTEN}.5`,
      `autoheal heard ${ID} -${WRITTEN}`,
      `autoheal heard ${ID} ${"9".repeat(13)}`,
      // An answer: a code of another length, another way of answering, a room too long or of other characters.
      `autoheal yes ${CODE}x ${WRITTEN} phone`,
      `autoheal yes ${CODE} ${WRITTEN}`,
      `autoheal yes ${CODE} ${WRITTEN} watch`,
      `autoheal no ${CODE} ${WRITTEN} voice ${"r".repeat(31)}`,
      `autoheal no ${CODE} ${WRITTEN} voice Living Room; say yes`,
      `autoheal maybe ${CODE} ${WRITTEN} voice`,
    ];
    expect(refused.map(parseAssistantLine)).toEqual(refused.map(() => null));
  });

  it("reads an answer by its question's code, with how it was given and, when known, the room", () => {
    expect(parseAssistantLine(`autoheal yes ${CODE} ${WRITTEN} voice Living Room`)).toEqual({
      verb: "yes",
      code: CODE,
      at: WRITTEN * 1000,
      how: "voice",
      room: "Living Room",
    });
    expect(parseAssistantLine(`autoheal no ${CODE} ${WRITTEN} phone`)).toEqual({
      verb: "no",
      code: CODE,
      at: WRITTEN * 1000,
      how: "phone",
      room: null,
    });
    expect(parseAssistantLine(`autoheal yes ${CODE} ${WRITTEN} voice Küche`)).toMatchObject({ room: "Küche" });
  });

  it("reads a yes by name with the words heard, and nothing past their characters or length", () => {
    expect(parseAssistantLine(`autoheal update ${WRITTEN} voice Ollama, Jarvis.`)).toEqual({
      verb: "update",
      heard: "Ollama, Jarvis.",
      at: WRITTEN * 1000,
      how: "voice",
    });
    expect(parseAssistantLine(`autoheal update ${WRITTEN} voice npm on Rowan`)).toMatchObject({
      heard: "npm on Rowan",
    });
    const refused = [
      `autoheal update ${WRITTEN} voice`,
      `autoheal update ${WRITTEN} voice npm; say yes`,
      `autoheal update ${WRITTEN} voice ${"n".repeat(61)}`,
      `autoheal update ${WRITTEN} watch npm`,
      `autoheal update npm ${WRITTEN} voice`,
    ];
    expect(refused.map(parseAssistantLine)).toEqual(refused.map(() => null));
  });

  it("reads no line longer than a Text helper holds", () => {
    expect(parseAssistantLine(`autoheal heard ${ID} ${WRITTEN}${" ".repeat(255)}`)).toBeNull();
  });
});
