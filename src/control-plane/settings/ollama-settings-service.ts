import { z } from "zod";
import type { OllamaSettings } from "../../config/shared-settings.js";
import { API_ERRORS, type OllamaServerModel, type OllamaSettingsView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  INTEGRATION_SOURCES,
  OLLAMA_MODEL_LIST_LIMIT,
  PLAIN_HTTP_PROTOCOL,
  SETTING_KEYS,
  TARGET_INTEGRATION,
} from "../../shared/constants.js";
import { OllamaClient } from "../../ollama/ollama-client.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { DomainError } from "../domain-error.js";
import type { SettingsStore } from "./settings-store.js";

const OLLAMA_TARGET = { kind: TARGET_INTEGRATION, id: "ollama" } as const;
const storedSchema = z.object({ url: z.string(), model: z.string(), contextTokens: z.number().int() });

/**
 * The Ollama Autoheal asks. Unlike the other integrations the .env's is required and only the default: Autoheal
 * cannot decide without a model, and an admin may point it elsewhere without a restart.
 */
export class OllamaSettingsService {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: SettingsStore,
    private readonly auditLog: AuditLog,
    private readonly environment: OllamaSettings,
  ) {}

  current(): OllamaSettings {
    return this.stored() ?? this.environment;
  }

  view(): OllamaSettingsView {
    const stored = this.stored();
    const current = stored ?? this.environment;
    return {
      source: stored === null ? INTEGRATION_SOURCES.environment : INTEGRATION_SOURCES.dashboard,
      url: current.url,
      model: current.model,
      contextTokens: current.contextTokens,
      plainHttp: new URL(current.url).protocol === PLAIN_HTTP_PROTOCOL,
      fromEnvironment: this.environment,
    };
  }

  /** The models at an address, whichever is in use: what a person can choose from before saving it. */
  async modelsAt(url: string): Promise<OllamaServerModel[]> {
    const client = new OllamaClient(() => ({ ...this.current(), url }));
    try {
      const [available, running] = await Promise.all([client.models(), client.running()]);
      const loaded = new Set((running.models ?? []).map((model) => model.name ?? model.model));
      return (available.models ?? []).slice(0, OLLAMA_MODEL_LIST_LIMIT).map((model) => {
        const name = model.name ?? model.model ?? "";
        return {
          name,
          sizeBytes: model.size ?? 0,
          parameterSize: model.details?.parameter_size ?? null,
          quantization: model.details?.quantization_level ?? null,
          loaded: loaded.has(name),
        };
      });
    } catch {
      throw new DomainError(API_ERRORS.ollamaUnreachable);
    }
  }

  /** Saved only once that Ollama answers with the model, the model answers chats, and reads that much. */
  async save(actor: Actor, request: OllamaSettings) {
    await checked(request);
    this.store.write(SETTING_KEYS.ollama, request);
    // "Tokens" are the model's units here, not a secret: the audit's guard reads the word as one.
    const { url, model, contextTokens: contextWindow } = request;
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaSaved, OLLAMA_TARGET, { url, model, contextWindow });
    this.changed();
  }

  /** Back to the .env's. */
  remove(actor: Actor) {
    this.store.remove(SETTING_KEYS.ollama);
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaRemoved, OLLAMA_TARGET);
    this.changed();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  private stored(): OllamaSettings | null {
    return this.store.read(SETTING_KEYS.ollama, storedSchema);
  }

  private changed() {
    this.listeners.forEach((listener) => listener());
  }
}

// A typing slip in the address or the model, or a model that only makes embeddings, would make every decision
// escalate with "Ollama could not be asked": that Ollama is asked first.
export async function checked(settings: OllamaSettings) {
  const client = new OllamaClient(() => settings);
  const present = await client.hasModel(settings.model).catch(() => null);
  if (present === null) {
    throw new DomainError(API_ERRORS.ollamaUnreachable);
  }
  if (!present) {
    throw new DomainError(API_ERRORS.modelNotFound);
  }
  // A server that cannot say leaves it to the model.
  const facts = await client.modelFacts().catch(() => null);
  if (facts?.answers === false) {
    throw new DomainError(API_ERRORS.modelCannotAnswer);
  }
  const contextLength = facts?.contextLength ?? null;
  if (contextLength !== null && settings.contextTokens > contextLength) {
    throw new DomainError(API_ERRORS.contextTooLarge);
  }
}
