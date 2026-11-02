import { describe, expect, it } from "vitest";
import { OllamaMonitor } from "./ollama-monitor.js";

describe("OllamaMonitor", () => {
  it("reports the version, the models and what is loaded, whether the model is there, and what it says of itself", async () => {
    let up = true;
    const monitor = new OllamaMonitor(
      {
        model: "qwen3:4b-instruct",
        version: async () => {
          if (!up) {
            throw new Error("connect ECONNREFUSED 192.168.10.123:11443");
          }
          return "0.12.6";
        },
        models: async () => ({
          models: [
            {
              name: "qwen3:4b-instruct",
              size: 2_500_000_000,
              details: { parameter_size: "4.0B", quantization_level: "Q4_K_M" },
            },
            { name: "llama3.2:3b", size: 2_000_000_000 },
          ],
        }),
        running: async () => ({
          models: [
            {
              name: "qwen3:4b-instruct",
              size: 3_100_000_000,
              size_vram: 3_100_000_000,
              expires_at: "2026-10-21T03:00:00Z",
            },
          ],
        }),
        modelFacts: async () => ({ answers: true, thinks: true, contextLength: 262_144 }),
      },
      () => 1_000,
    );
    expect(monitor.status()).toMatchObject({ reachable: false, checkedAt: null, modelPresent: null });

    await monitor.check();
    expect(monitor.status()).toEqual({
      reachable: true,
      checkedAt: 1_000,
      error: null,
      version: "0.12.6",
      model: "qwen3:4b-instruct",
      modelPresent: true,
      facts: { answers: true, thinks: true, contextLength: 262_144 },
      models: [
        { name: "qwen3:4b-instruct", sizeBytes: 2_500_000_000, parameterSize: "4.0B", quantization: "Q4_K_M" },
        { name: "llama3.2:3b", sizeBytes: 2_000_000_000, parameterSize: null, quantization: null },
      ],
      loaded: [
        {
          name: "qwen3:4b-instruct",
          sizeBytes: 3_100_000_000,
          videoMemoryBytes: 3_100_000_000,
          expiresAt: Date.UTC(2026, 9, 21, 3),
        },
      ],
    });

    up = false;
    await monitor.check();
    expect(monitor.status()).toMatchObject({
      reachable: false,
      error: "connect ECONNREFUSED 192.168.10.123:11443",
      models: [expect.objectContaining({ name: "qwen3:4b-instruct" }), expect.anything()],
    });
  });
});
