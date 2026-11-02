import { describe, expect, it } from "vitest";
import { OllamaClient } from "../ollama/ollama-client.js";
import type { IncidentSubmission, Outcome } from "../shared/protocol.js";
import { ControlPlaneClient, ControlPlaneError } from "./control-plane-client.js";
import { Decider } from "./decider.js";

const submissionFor = (containerName: string): IncidentSubmission => ({
  detectedAt: 1,
  report: {
    containerName,
    image: "example:1",
    trigger: "die",
    stateSummary: "status=exited",
    healthOutputs: [],
    knownContainers: [containerName],
    protectedContainers: [],
    logs: "",
  },
});

const result: Outcome = { outcome: "Restarted.", verdict: "restarted", executed: true };

describe("the outbox of incidents handled while the control plane was away", () => {
  it("retains refused results and sends other outcomes without blocking them", async () => {
    const controlPlane = new ControlPlaneClient({ url: "https://control-plane.test", token: "unused", pin: null });
    const failures = new Map<string, Error>([
      ["refused", new ControlPlaneError(400, '{"error":"invalid_request"}')],
      ["rate-limited", new ControlPlaneError(429, "")],
    ]);
    const sent: string[] = [];
    controlPlane.submitHandled = async (handled) => {
      const failure = failures.get(handled.report.containerName);
      if (failure !== undefined) {
        throw failure;
      }
      sent.push(handled.report.containerName);
    };
    const client = new OllamaClient(() => ({ url: "https://ollama.test", model: "unused", contextTokens: 4_096 }));
    const decider = new Decider(controlPlane, () => ({ client, contextTokens: 4_096 }));
    for (const name of ["refused", "accepted", "rate-limited", "later"]) {
      const decision = { action: "restart" as const, target: name, diagnosis: "Crashed." };
      await decider.recordOutcome(
        submissionFor(name),
        { incidentId: null, decision, decidedBy: "agent_fallback" },
        result,
      );
    }

    await decider.flushOutbox();
    expect(sent).toEqual(["accepted", "later"]);
    expect(decider.pendingHandled).toBe(2);

    failures.delete("rate-limited");
    failures.delete("refused");
    await decider.flushOutbox();
    expect(sent).toEqual(["accepted", "later", "refused", "rate-limited"]);
    expect(decider.pendingHandled).toBe(0);
  });
});

it("retries a known incident outcome after delivery fails", async () => {
  const client = new ControlPlaneClient({ url: "https://unused.test", token: "unused", pin: null });
  let attempts = 0;
  client.reportOutcome = async () => {
    if (++attempts === 1) throw new Error("response lost");
  };
  const decider = new Decider(client, () => null);
  await decider.recordOutcome(
    submissionFor("app"),
    {
      incidentId: "existing",
      decision: { action: "restart", target: "app", diagnosis: "crashed" },
      decidedBy: "model",
    },
    result,
  );
  await decider.flushOutbox();
  expect(attempts).toBe(2);
});
