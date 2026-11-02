import { describe, expect, it } from "vitest";
import type { IncidentDetailView, TraceEventView } from "../../src/shared/api.js";
import { incidentSteps, repairOf } from "./incident-steps.js";

const event = (id: number, kind: string, createdAt: number): TraceEventView => ({ id, kind, payload: {}, createdAt });

const incident = (overrides: Partial<IncidentDetailView>): IncidentDetailView => ({
  id: "i1",
  hostId: "h1",
  hostLabel: "Alder",
  containerName: "tika",
  image: "apache/tika:3",
  trigger: "die",
  status: "resolved",
  decidedBy: "model",
  action: "restart",
  target: "tika",
  verdict: "restarted",
  detectedAt: 100,
  updatedAt: 400,
  diagnosis: null,
  outcome: null,
  promptHash: null,
  modelName: null,
  modelDigest: null,
  reasoning: null,
  report: null,
  trace: [event(1, "reported", 100), event(2, "decided", 200), event(3, "outcome_reported", 300)],
  approvals: [],
  earlier: [],
  evidence: [],
  usage: [],
  ...overrides,
});

const shape = (view: IncidentDetailView) => incidentSteps(view).map((step) => `${step.name}:${step.state}`);

describe("an incident's steps", () => {
  it("runs from noticed to done when Autoheal fixed it alone", () => {
    expect(shape(incident({}))).toEqual(["Noticed:done", "Decided:done", "Acted:done", "Done:done"]);
    expect(incidentSteps(incident({}))[2]!.detail).toBe("restarted");
  });

  it("waits on the person when escalated, and says what they chose afterwards", () => {
    const waiting = incident({ status: "awaiting_approval", verdict: "needs you" });
    expect(shape(waiting)).toEqual([
      "Noticed:done",
      "Decided:done",
      "Acted:done",
      "Your decision:current",
      "Done:todo",
    ]);
    const approved = incident({
      approvals: [{ id: "a1", choice: "restart", target: "tika", note: null, decidedBy: "alex", decidedAt: 350 }],
    });
    expect(incidentSteps(approved)[3]).toMatchObject({ state: "done", detail: "restart, by alex" });
  });

  it("says nothing was left to decide once the container went or came back before anyone chose", () => {
    const settled = incident({
      verdict: "no longer needed",
      outcome: "tika is running again: nothing is left to decide.",
      trace: [
        event(1, "reported", 100),
        event(2, "decided", 200),
        { ...event(3, "outcome_reported", 300), payload: { verdict: "needs you" } },
        event(4, "no_longer_needed", 500),
      ],
    });
    expect(incidentSteps(settled).map(({ name, detail, at }) => [name, detail, at])).toEqual([
      ["Noticed", "It stopped", 100],
      ["Decided", "restart → tika", 200],
      ["Acted", "needs you", 300],
      ["Your decision", "Not needed any more", 500],
      ["Done", "resolved", 400],
    ]);
  });

  it("shows where it stands while Autoheal still decides", () => {
    const deciding = incident({ status: "deciding", verdict: null, action: null, trace: [event(1, "reported", 100)] });
    expect(shape(deciding)).toEqual(["Noticed:done", "Decided:current", "Acted:todo", "Done:todo"]);
  });

  it("says when Ollama could not be asked", () => {
    const failed = incident({ trace: [event(1, "reported", 100), event(2, "model_failed", 150)] });
    expect(incidentSteps(failed)[1]!.detail).toBe("Ollama could not be asked");
  });

  describe("on a container given to Ollama", () => {
    const restartDidNotHold = [
      event(1, "reported", 100),
      event(2, "decided", 200),
      { ...event(3, "outcome_reported", 300), payload: { verdict: "needs you" } },
      { ...event(4, "repair_started", 400), payload: { offered: ["recreate", "report"] } },
    ];
    const planned = (payload: object) => ({
      ...event(5, "repair_planned", 500),
      payload: {
        repair: "recreate",
        findings: "A stale pid file.",
        cause: "Killed mid-run.",
        steps: ["Remove it."],
        ...payload,
      },
    });

    it("needs nobody while Ollama looks into it, and once its repair held", () => {
      const looking = incident({ status: "approved", verdict: "needs you", trace: restartDidNotHold });
      expect(shape(looking)).toEqual([
        "Noticed:done",
        "Decided:done",
        "Acted:done",
        "Ollama's repair:current",
        "Done:todo",
      ]);
      expect(repairOf(looking)).toMatchObject({ state: "looking", offered: ["recreate", "report"], repair: null });

      const repaired = incident({
        verdict: "repaired",
        trace: [
          ...restartDidNotHold,
          planned({ jobId: "j1", thinking: "It says the pid file exists." }),
          { ...event(6, "repair_finished", 600), payload: { succeeded: true, outcome: "Recreated tika." } },
        ],
      });
      expect(shape(repaired)).toEqual([
        "Noticed:done",
        "Decided:done",
        "Acted:done",
        "Ollama's repair:done",
        "Done:done",
      ]);
      expect(repairOf(repaired)).toMatchObject({
        state: "held",
        repair: "recreate",
        outcome: "Recreated tika.",
        thinking: "It says the pid file exists.",
        at: 600,
      });
    });

    it("waits on the person once its repair did not work, or it sent a report", () => {
      const failed = incident({
        status: "awaiting_approval",
        verdict: "needs you",
        trace: [
          ...restartDidNotHold,
          planned({ jobId: "j1" }),
          { ...event(6, "repair_finished", 600), payload: { succeeded: false, outcome: "It exited again." } },
        ],
      });
      expect(
        incidentSteps(failed)
          .slice(3)
          .map(({ name, detail, state }) => [name, detail, state]),
      ).toEqual([
        ["Ollama's repair", "Did not hold", "done"],
        ["Your decision", "Waiting for you", "current"],
        ["Done", "", "todo"],
      ]);

      const reported = incident({
        status: "awaiting_approval",
        verdict: "needs you",
        trace: [...restartDidNotHold, planned({ repair: "report" })],
      });
      expect(repairOf(reported)).toMatchObject({ state: "reported", at: 500, steps: ["Remove it."] });
      expect(shape(reported).slice(3)).toEqual(["Ollama's repair:done", "Your decision:current", "Done:todo"]);
    });

    it("follows the latest attempt once a person hands it over again after one that failed", () => {
      const again = incident({
        status: "approved",
        verdict: "needs you",
        trace: [
          ...restartDidNotHold,
          planned({ jobId: "j1" }),
          { ...event(6, "repair_finished", 600), payload: { succeeded: false, outcome: "It exited again." } },
          { ...event(7, "dispatched", 700), payload: { by: "admin" } },
          { ...event(8, "repair_started", 800), payload: { offered: ["recreate", "report"] } },
        ],
      });
      expect(repairOf(again)).toMatchObject({ state: "looking", repair: null, outcome: null, handedBy: "admin" });
    });

    it("has no repair step for an ask a restart cut short, once the incident settled", () => {
      expect(repairOf(incident({ trace: restartDidNotHold }))).toBeNull();
    });
  });
});
