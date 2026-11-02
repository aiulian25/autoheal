import { afterEach, describe, expect, it } from "vitest";
import { FakeOllama, MODEL_DIGEST, answer } from "../../test/fakes/fake-ollama.js";
import { OllamaClient } from "./ollama-client.js";

const settings = (url: string) => () => ({ url, model: "qwen3:4b-instruct", contextTokens: 16_384 });

describe("OllamaClient", () => {
  let ollama: FakeOllama;

  afterEach(() => ollama.close());

  it.each([
    ["by IP", "127.0.0.1"],
    ["by name", "localhost"],
  ])("talks to a TLS proxy whose certificate comes from the private CA, %s", async (_case, host) => {
    ollama = await FakeOllama.start("trusted");
    ollama.handler = () => answer({ action: "restart", target: "x", diagnosis: "ok" });
    const client = new OllamaClient(settings(ollama.url(host)));
    expect(JSON.parse((await client.chat("system", "user")).content)).toMatchObject({ action: "restart" });
  });

  it("refuses a server with someone else's certificate", async () => {
    ollama = await FakeOllama.start("untrusted");
    const client = new OllamaClient(settings(ollama.url()));
    await expect(client.chat("system", "user")).rejects.toThrow(/fetch failed/);
    expect(ollama.requests).toHaveLength(0);
  });

  it("sends a fixed context size, temperature 0, room to think and answer, and the decision schema", async () => {
    ollama = await FakeOllama.start();
    await new OllamaClient(settings(ollama.url())).chat("the rules", "the report");
    const [request] = ollama.requests;
    expect(request).not.toHaveProperty("think");
    expect(request).toMatchObject({
      model: "qwen3:4b-instruct",
      stream: true,
      options: { temperature: 0, num_ctx: 16_384, num_predict: 8_192 },
      messages: [
        { role: "system", content: "the rules" },
        { role: "user", content: "the report" },
      ],
    });
    expect(request!.format).toMatchObject({
      properties: { action: { enum: ["restart", "restart_dependency", "escalate"] } },
    });
  });

  it("joins a streamed answer, and keeps what a thinking model thought apart from it", async () => {
    ollama = await FakeOllama.start();
    ollama.handler = () => answer({ action: "restart_dependency", target: "paperless-db", diagnosis: "db stopped" });
    const { content, thinking } = await new OllamaClient(settings(ollama.url())).chat("the rules", "the report");

    expect(JSON.parse(content)).toEqual({
      action: "restart_dependency",
      target: "paperless-db",
      diagnosis: "db stopped",
    });
    expect(thinking).toBe("The logs show…");
  });

  it("reads what a model says of itself: whether it answers, thinks first, and how much it reads", async () => {
    ollama = await FakeOllama.start();
    const client = new OllamaClient(settings(ollama.url()));
    expect(await client.modelFacts()).toEqual({ answers: true, thinks: true, contextLength: 40_960 });
    // An Ollama from before capabilities were listed: its models are taken to answer.
    ollama.models["older"] = {};
    expect(await client.modelFacts("older")).toEqual({ answers: true, thinks: false, contextLength: null });
    await expect(client.modelFacts("missing")).rejects.toThrow("Ollama answered HTTP 404");
  });

  it("asks a lookup without thinking, and with a shorter answer", async () => {
    ollama = await FakeOllama.start();
    ollama.handler = () => ({ status: 200, body: { message: { content: '{"keepsData":[]}' } } });
    const { thinking } = await new OllamaClient(settings(ollama.url())).chat("the rules", "curl", undefined, {}, false);

    expect(ollama.requests[0]).toMatchObject({ think: false, options: { num_predict: 2_048 } });
    expect(thinking).toBe("");
  });

  it("says when the model ran out of room, or Ollama stopped partway", async () => {
    ollama = await FakeOllama.start();
    const client = new OllamaClient(settings(ollama.url()));
    const line = (fields: object) => JSON.stringify({ model: "qwen3:30b-a3b", ...fields });

    ollama.handler = () => ({
      status: 200,
      stream: [
        line({ message: { content: "", thinking: "Let me think about this…" }, done: false }),
        line({ message: { content: "" }, done: true, done_reason: "length" }),
      ].join("\n"),
    });
    await expect(client.chat("s", "u")).rejects.toThrow("The model used its whole answer (8192 tokens)");

    ollama.handler = () => ({
      status: 200,
      stream: [line({ message: { content: '{"action":' }, done: false }), line({ error: "model runner stopped" })].join(
        "\n",
      ),
    });
    await expect(client.chat("s", "u")).rejects.toThrow(
      "Ollama stopped in the middle of its answer: model runner stopped",
    );
  });

  it("reports a bad status and caches the model digest", async () => {
    ollama = await FakeOllama.start();
    ollama.handler = () => ({ status: 500, body: { error: "out of memory" } });
    const now = { value: 0 };
    const client = new OllamaClient(settings(ollama.url()), () => now.value);
    await expect(client.chat("s", "u")).rejects.toThrow("Ollama answered HTTP 500");
    expect(await client.modelDigest()).toBe(MODEL_DIGEST);
    await ollama.close();
    expect(await client.modelDigest()).toBe(MODEL_DIGEST);
    ollama = await FakeOllama.start();
  });
});
