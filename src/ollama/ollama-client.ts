import type { OllamaSettings } from "../config/shared-settings.js";
import {
  JSON_CONTENT_TYPE,
  MODEL_DIGEST_CACHE_MILLISECONDS,
  OLLAMA_CHAT_PATH,
  OLLAMA_LATEST_TAG,
  OLLAMA_MESSAGES,
  OLLAMA_ROLE_SYSTEM,
  OLLAMA_ROLE_USER,
  OLLAMA_RUNNING_PATH,
  OLLAMA_SHOW_PATH,
  OLLAMA_STATUS_TIMEOUT_MILLISECONDS,
  OLLAMA_TAGS_PATH,
  OLLAMA_ANSWER_TOKENS,
  OLLAMA_CAPABILITY,
  OLLAMA_CONTEXT_LENGTH_SUFFIX,
  OLLAMA_CUT_SHORT,
  OLLAMA_LOOKUP_TOKENS,
  OLLAMA_TEMPERATURE,
  OLLAMA_TIMEOUT_MILLISECONDS,
  OLLAMA_VERSION_PATH,
  HTTP_HEADERS,
} from "../shared/constants.js";
import type { OllamaModelFacts } from "../shared/api.js";
import { decisionJsonSchema } from "../shared/decision.js";
import { joinUrl } from "../shared/urls.js";

export interface TagsResponse {
  models?: {
    name?: string;
    model?: string;
    digest?: string;
    size?: number;
    details?: { parameter_size?: string; quantization_level?: string };
  }[];
}

export interface RunningResponse {
  models?: { name?: string; model?: string; size?: number; size_vram?: number; expires_at?: string }[];
}

interface ShowResponse {
  capabilities?: unknown;
  model_info?: Record<string, unknown>;
}

// An Ollama from before capabilities were listed says nothing of them: its models are taken to answer chats.
function factsOf(show: ShowResponse): OllamaModelFacts {
  const capabilities = Array.isArray(show.capabilities) ? (show.capabilities as unknown[]) : null;
  const contextLength = Object.entries(show.model_info ?? {}).find(([key]) =>
    key.endsWith(OLLAMA_CONTEXT_LENGTH_SUFFIX),
  )?.[1];
  return {
    answers: capabilities === null || capabilities.includes(OLLAMA_CAPABILITY.completion),
    thinks: capabilities?.includes(OLLAMA_CAPABILITY.thinking) ?? false,
    contextLength: typeof contextLength === "number" ? contextLength : null,
  };
}

interface StreamedPart {
  message?: { content?: unknown; thinking?: unknown };
  error?: unknown;
  done_reason?: unknown;
}

/** The model's answer, and what a thinking model thought before it: empty when it did not. */
export interface ModelAnswer {
  content: string;
  thinking: string;
}

const textsOf = (parts: readonly StreamedPart[], field: keyof NonNullable<StreamedPart["message"]>) =>
  parts.map((part) => part.message?.[field]).filter((text) => typeof text === "string");

// Ollama streams its answer one JSON object to a line (a thinking model's thinking first, in its own
// field); each field is its parts joined. A stream that broke off says why in an `error` line.
function answerIn(stream: string, tokens: number): ModelAnswer {
  const parts = stream
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as StreamedPart);
  const failure = parts.find((part) => part.error !== undefined);
  if (failure !== undefined) {
    throw new Error(OLLAMA_MESSAGES.failedMidway(String(failure.error)));
  }
  if (parts.at(-1)?.done_reason === OLLAMA_CUT_SHORT) {
    throw new Error(OLLAMA_MESSAGES.cutShort(tokens));
  }
  const contents = textsOf(parts, "content");
  if (contents.length === 0) {
    throw new Error(OLLAMA_MESSAGES.noMessage);
  }
  return { content: contents.join(""), thinking: textsOf(parts, "thinking").join("") };
}

/** The names a pulled model can be listed under: as configured, and with Ollama's default tag. */
export const modelNamesOf = (model: string): ReadonlySet<string> => new Set([model, `${model}${OLLAMA_LATEST_TAG}`]);

/**
 * Asks Ollama for one decision. TLS is verified against the system store plus the private CA in
 * NODE_EXTRA_CA_CERTS; the model can only answer in the decision schema. Its settings are read at each call,
 * so a change in Settings reaches the next question without a restart.
 */
export class OllamaClient {
  private cachedDigest: { key: string; value: string | null; fetchedAt: number } | null = null;

  constructor(
    private readonly settings: () => OllamaSettings,
    private readonly clock: () => number = Date.now,
  ) {}

  resetDigest() {
    this.cachedDigest = null;
  }

  get model() {
    return this.settings().model;
  }

  get contextTokens() {
    return this.settings().contextTokens;
  }

  /** Whether this Ollama has the model, under either name it lists one by; throws when it does not answer. */
  async hasModel(model: string): Promise<boolean> {
    const names = modelNamesOf(model);
    const listed = await this.models();
    return (listed.models ?? []).some((entry) => names.has(entry.name ?? "") || names.has(entry.model ?? ""));
  }

  /** The same Ollama asked about another model: a candidate tried before switching to it. */
  withModel(model: string): OllamaClient {
    return new OllamaClient(() => ({ ...this.settings(), model }), this.clock);
  }

  /**
   * One answer, held to `format` (a JSON schema): the incident decision unless told otherwise. A model that
   * thinks does so first, to understand what it reads, except on a lookup (`thinking` false). The answer is
   * streamed, so a long one is not cut off: Node's fetch gives up on a response whose headers take five
   * minutes, and Ollama sends them with its first words.
   */
  async chat(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    format: object = decisionJsonSchema,
    thinking = true,
  ): Promise<ModelAnswer> {
    const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MILLISECONDS);
    const tokens = thinking ? OLLAMA_ANSWER_TOKENS : OLLAMA_LOOKUP_TOKENS;
    const settings = this.settings();
    const response = await fetch(joinUrl(settings.url, OLLAMA_CHAT_PATH), {
      method: "POST",
      headers: { [HTTP_HEADERS.contentType]: JSON_CONTENT_TYPE },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: OLLAMA_ROLE_SYSTEM, content: systemPrompt },
          { role: OLLAMA_ROLE_USER, content: userPrompt },
        ],
        format,
        stream: true,
        // Left out, a model that can think does; models that cannot take `false` as well.
        ...(thinking ? {} : { think: false }),
        options: {
          temperature: OLLAMA_TEMPERATURE,
          num_ctx: settings.contextTokens,
          num_predict: tokens,
        },
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      throw new Error(OLLAMA_MESSAGES.badStatus(response.status));
    }
    return answerIn(await response.text(), tokens);
  }

  /** The digest behind the model tag, so a re-pulled model shows up as a different model. */
  async modelDigest(): Promise<string | null> {
    const now = this.clock();
    const { url, model } = this.settings();
    // Another address or model since: what was kept is someone else's.
    const key = `${url} ${model}`;
    const cached = this.cachedDigest;
    if (cached !== null && cached.key === key && now - cached.fetchedAt < MODEL_DIGEST_CACHE_MILLISECONDS) {
      return cached.value;
    }
    const value = await this.fetchDigest().catch(() => null);
    this.cachedDigest = { key, value, fetchedAt: now };
    return value;
  }

  /** What a model says of itself: whether it answers chats, thinks first, and how much it reads. */
  async modelFacts(model: string = this.model): Promise<OllamaModelFacts> {
    const response = await fetch(joinUrl(this.settings().url, OLLAMA_SHOW_PATH), {
      method: "POST",
      headers: { [HTTP_HEADERS.contentType]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(OLLAMA_STATUS_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) {
      throw new Error(OLLAMA_MESSAGES.badStatus(response.status));
    }
    return factsOf((await response.json()) as ShowResponse);
  }

  async version(): Promise<string | null> {
    const body = (await this.getJson(OLLAMA_VERSION_PATH)) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  }

  models(): Promise<TagsResponse> {
    return this.getJson(OLLAMA_TAGS_PATH) as Promise<TagsResponse>;
  }

  /** The models loaded in memory now. */
  running(): Promise<RunningResponse> {
    return this.getJson(OLLAMA_RUNNING_PATH) as Promise<RunningResponse>;
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(joinUrl(this.settings().url, path), {
      signal: AbortSignal.timeout(OLLAMA_STATUS_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) {
      throw new Error(OLLAMA_MESSAGES.badStatus(response.status));
    }
    return response.json();
  }

  private async fetchDigest(): Promise<string | null> {
    const tags = await this.models();
    const names = modelNamesOf(this.settings().model);
    const model = tags.models?.find((entry) => names.has(entry.name ?? "") || names.has(entry.model ?? ""));
    return model?.digest ?? null;
  }
}
