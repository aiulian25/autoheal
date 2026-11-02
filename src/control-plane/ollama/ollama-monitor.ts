import type { OllamaStatusView } from "../../shared/api.js";
import { OLLAMA_MODEL_LIST_LIMIT } from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { modelNamesOf, type OllamaClient } from "../../ollama/ollama-client.js";

const timestampOf = (isoTime: string | undefined) => {
  const milliseconds = Date.parse(isoTime ?? "");
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

/** Whether Ollama answers, what it can run and what it holds in memory; checked every minute. */
export class OllamaMonitor {
  private latest!: OllamaStatusView;

  constructor(
    private readonly client: Pick<OllamaClient, "model" | "version" | "models" | "running" | "modelFacts">,
    private readonly clock: () => number = Date.now,
  ) {
    this.reset();
  }

  reset() {
    this.latest = {
      reachable: false,
      checkedAt: null,
      error: null,
      version: null,
      model: this.client.model,
      modelPresent: null,
      facts: null,
      models: [],
      loaded: [],
    };
  }

  status(): OllamaStatusView {
    return this.latest;
  }

  async check() {
    const checkedAt = this.clock();
    try {
      const [version, available, running] = await Promise.all([
        this.client.version(),
        this.client.models(),
        this.client.running(),
      ]);
      const models = (available.models ?? []).slice(0, OLLAMA_MODEL_LIST_LIMIT).map((model) => ({
        name: model.name ?? model.model ?? "",
        sizeBytes: model.size ?? 0,
        parameterSize: model.details?.parameter_size ?? null,
        quantization: model.details?.quantization_level ?? null,
      }));
      const wanted = modelNamesOf(this.client.model);
      const modelPresent = models.some((model) => wanted.has(model.name));
      // What it says of itself, when it is there: a server that cannot say leaves it unknown.
      const facts = modelPresent ? await this.client.modelFacts().catch(() => null) : null;
      this.latest = {
        reachable: true,
        checkedAt,
        error: null,
        version,
        model: this.client.model,
        modelPresent,
        facts,
        models,
        loaded: (running.models ?? []).map((model) => ({
          name: model.name ?? model.model ?? "",
          sizeBytes: model.size ?? 0,
          videoMemoryBytes: model.size_vram ?? 0,
          expiresAt: timestampOf(model.expires_at),
        })),
      };
    } catch (error) {
      // What it had last time stays listed; it is only no longer reachable.
      this.latest = { ...this.latest, reachable: false, checkedAt, error: describeError(error) };
    }
  }
}
