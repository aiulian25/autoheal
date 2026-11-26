import { describe, expect, it } from "vitest";
import { HOME_REVIEW_ANSWER_FORMAT } from "../control-plane/home-assistant/home-review.js";
import { NETWORK_EXPLAIN_FORMAT, NETWORK_REPORT_FORMAT } from "../control-plane/network/network-review.js";
import {
  ASSESSMENT_JSON_SCHEMA,
  FAILURE_REPORT_JSON_SCHEMA,
  OLLAMA_FORMAT_LENGTH_LIMIT,
  PACKAGE_KINDS_BATCH,
  PACKAGE_KINDS_JSON_SCHEMA,
  REPAIR_JSON_SCHEMA,
} from "../shared/constants.js";
import { decisionJsonSchema } from "../shared/decision.js";

interface Format {
  type?: string;
  enum?: readonly unknown[];
  maxLength?: number;
  maxItems?: number;
  items?: Format;
  properties?: Record<string, Format>;
}

const heldTo = (limit: number | undefined) => limit !== undefined && limit <= OLLAMA_FORMAT_LENGTH_LIMIT;

// Where an answer in this format could go on: each string or list without a limit Ollama keeps, by its path.
function endless(format: Format, path: string): string[] {
  if (format.type === "string") {
    return format.enum !== undefined || heldTo(format.maxLength) ? [] : [path];
  }
  if (format.type === "array") {
    return [...(heldTo(format.maxItems) ? [] : [path]), ...endless(format.items ?? {}, `${path}[]`)];
  }
  if (format.type === "object") {
    return Object.entries(format.properties ?? {}).flatMap(([key, value]) => endless(value, `${path}.${key}`));
  }
  return [path];
}

const fullBatch = Array.from({ length: PACKAGE_KINDS_BATCH }, (_, index) => `package-${index}`);

describe("what Ollama may answer", () => {
  it.each([
    ["a decision", decisionJsonSchema],
    ["a repair", REPAIR_JSON_SCHEMA],
    ["a failed hand-over's report", FAILURE_REPORT_JSON_SCHEMA],
    ["an update's assessment", ASSESSMENT_JSON_SCHEMA],
    ["a full batch of package names", PACKAGE_KINDS_JSON_SCHEMA(fullBatch)],
    ["Home Assistant suggestions", HOME_REVIEW_ANSWER_FORMAT],
    ["what a device's network facts mean", NETWORK_EXPLAIN_FORMAT],
    ["the network's week", NETWORK_REPORT_FORMAT],
  ])("ends, every string and list in %s held to a length Ollama keeps", (_name, format) => {
    expect(endless(format as Format, "answer")).toEqual([]);
  });

  it("finds a string that could go on, and a limit Ollama would ignore", () => {
    const format: Format = {
      type: "object",
      properties: {
        open: { type: "string" },
        tooLong: { type: "string", maxLength: OLLAMA_FORMAT_LENGTH_LIMIT + 1 },
        list: { type: "array", items: { type: "string", maxLength: 1 } },
      },
    };
    expect(endless(format, "answer")).toEqual(["answer.open", "answer.tooLong", "answer.list"]);
  });
});
