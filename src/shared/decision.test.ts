import { describe, expect, it } from "vitest";
import { ACTION_ESCALATE, ACTION_RESTART, ACTION_RESTART_DEPENDENCY, DIAGNOSIS_TEXT_LIMIT } from "./constants.js";
import { decisionJsonSchema, isRestart, modelDecision, parseDecision, validateAnswer } from "./decision.js";
import type { IncidentReport } from "./report.js";

const KNOWN = new Set(["paperless", "tika", "beszel", "redis"]);
const PROTECTED = new Set(["beszel"]);

// paperless and tika are one compose project; redis is in another.
const report = (overrides: Partial<IncidentReport> = {}): IncidentReport => ({
  containerName: "paperless",
  image: "ghcr.io/paperless-ngx/paperless-ngx:2.13",
  trigger: "die",
  stateSummary: "status=exited exit_code=1",
  healthOutputs: [],
  knownContainers: [...KNOWN],
  protectedContainers: [...PROTECTED],
  logs: "",
  composeProject: "paperless",
  projectContainers: ["tika", "beszel"],
  ...overrides,
});

const answer = (action: unknown, target = "paperless", diagnosis = "because") =>
  JSON.stringify({ action, target, diagnosis });

describe("parseDecision", () => {
  it("restart always targets the failed container", () => {
    const decision = parseDecision(answer(ACTION_RESTART, "tika"), report());
    expect([decision.action, decision.target]).toEqual([ACTION_RESTART, "paperless"]);
  });

  it("restarts a dependency in the failed container's compose project", () => {
    const decision = parseDecision(answer(ACTION_RESTART_DEPENDENCY, "tika"), report());
    expect([decision.action, decision.target]).toEqual([ACTION_RESTART_DEPENDENCY, "tika"]);
  });

  it.each([
    ["not json", "not json"],
    ["an unknown action", answer("rm -rf")],
    ["a container that is not on this host", answer(ACTION_RESTART_DEPENDENCY, "cedar1")],
    ["a protected container", answer(ACTION_RESTART_DEPENDENCY, "beszel")],
    ["a container of another compose project", answer(ACTION_RESTART_DEPENDENCY, "redis")],
    ["the failed container itself as its own dependency", answer(ACTION_RESTART_DEPENDENCY, "paperless")],
  ])("escalates %s", (_case, raw) => {
    const decision = parseDecision(raw, report());
    expect([decision.action, decision.target]).toEqual([ACTION_ESCALATE, "paperless"]);
  });

  it("says why it escalates a dependency outside the compose project", () => {
    expect(parseDecision(answer(ACTION_RESTART_DEPENDENCY, "redis"), report()).diagnosis).toBe(
      'The model gave an unusable answer ("redis" is not one of the other containers in the failed container\'s compose project); escalating instead. because',
    );
  });

  it("offers no dependency outside a compose project, nor when an older runner did not say", () => {
    const outside = report({ composeProject: null, projectContainers: [] });
    expect(parseDecision(answer(ACTION_RESTART_DEPENDENCY, "tika"), outside).action).toBe(ACTION_ESCALATE);

    const { composeProject: _project, projectContainers: _members, ...older } = report();
    expect(parseDecision(answer(ACTION_RESTART_DEPENDENCY, "tika"), older).action).toBe(ACTION_ESCALATE);
  });
});

describe("parseDecision edge cases", () => {
  it.each([["[]"], ["null"], ["42"], ['"restart"']])("escalates valid JSON that is not an object: %s", (raw) => {
    const decision = parseDecision(raw, report());
    expect(decision.action).toBe(ACTION_ESCALATE);
    expect(decision.diagnosis).toContain("not a JSON object");
  });

  it("keeps the model's diagnosis when escalating its unusable answer", () => {
    const decision = parseDecision(answer("delete", "paperless", "disk is full"), report());
    expect(decision.diagnosis).toBe(
      'The model gave an unusable answer (unknown action "delete"); escalating instead. disk is full',
    );
  });

  it("keeps an escalation's diagnosis within the protocol's limit, however long the answer", () => {
    const raw = answer(ACTION_RESTART_DEPENDENCY, "x".repeat(10_000), "d".repeat(10_000));
    const decision = parseDecision(raw, report());
    expect(decision.action).toBe(ACTION_ESCALATE);
    expect(decision.diagnosis).toHaveLength(DIAGNOSIS_TEXT_LIMIT);
  });

  it("fills in a missing diagnosis", () => {
    const decision = parseDecision(JSON.stringify({ action: ACTION_ESCALATE }), report());
    expect(decision).toEqual({ action: ACTION_ESCALATE, target: "paperless", diagnosis: "No diagnosis available." });
  });

  it("re-checks a decision object received from elsewhere", () => {
    const relayed = { action: ACTION_RESTART_DEPENDENCY, target: "beszel", diagnosis: "x" };
    expect(validateAnswer(relayed, "paperless", KNOWN, PROTECTED).action).toBe(ACTION_ESCALATE);
  });

  it("holds the model to the compose project, but leaves a person's choice open", () => {
    const outsideProject = { action: ACTION_RESTART_DEPENDENCY, target: "redis", diagnosis: "x" };
    expect(modelDecision(outsideProject, report()).action).toBe(ACTION_ESCALATE);
    expect(validateAnswer(outsideProject, "paperless", KNOWN, PROTECTED)).toEqual(outsideProject);
  });
});

describe("decision helpers", () => {
  it("only restart and restart_dependency restart anything", () => {
    expect(isRestart({ action: ACTION_RESTART, target: "a", diagnosis: "" })).toBe(true);
    expect(isRestart({ action: ACTION_RESTART_DEPENDENCY, target: "a", diagnosis: "" })).toBe(true);
    expect(isRestart({ action: ACTION_ESCALATE, target: "a", diagnosis: "" })).toBe(false);
  });

  it("gives Ollama a schema limited to the menu", () => {
    expect(decisionJsonSchema).toMatchObject({
      type: "object",
      required: ["action", "target", "diagnosis"],
      properties: { action: { enum: [ACTION_RESTART, ACTION_RESTART_DEPENDENCY, ACTION_ESCALATE] } },
    });
    expect(decisionJsonSchema).not.toHaveProperty("$schema");
  });
});
