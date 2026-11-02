import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IN_MEMORY_DATABASE } from "../../shared/constants.js";
import { DatabaseHandle } from "../database/connection.js";
import { PackageKinds } from "./package-kinds.js";

describe("which packages keep data, as Ollama names them", () => {
  let handle: DatabaseHandle;
  let questions: string[][];
  let answer: (names: string[]) => string;

  const queue = {
    enqueue: <Result>(_priority: unknown, run: (signal: AbortSignal) => Promise<Result>) =>
      run(new AbortController().signal),
  };
  let formats: object[];
  const ollama = {
    chat: async (_system: string, user: string, _signal?: AbortSignal, format: object = {}) => {
      const names = user.split("\n");
      questions.push(names);
      formats.push(format);
      return { content: answer(names), thinking: "" };
    },
  };

  beforeEach(() => {
    handle = new DatabaseHandle(IN_MEMORY_DATABASE);
    questions = [];
    formats = [];
    answer = () => JSON.stringify({ keepsData: ["mosquitto"] });
  });

  afterEach(() => handle.close());

  it("asks once per name and keeps the answer", async () => {
    const kinds = new PackageKinds(handle, ollama, queue as never, () => 1);

    await kinds.learn(["mosquitto", "htop"]);
    await kinds.learn(["htop", "mosquitto", "tmux"]);

    expect(questions).toEqual([["mosquitto", "htop"], ["tmux"]]);
    expect(Object.fromEntries(kinds.known(["mosquitto", "htop", "tmux", "never-asked"]))).toEqual({
      mosquitto: true,
      htop: false,
      tmux: false,
    });
  });

  it("holds Ollama to the names asked about, never more of them than there are", async () => {
    const kinds = new PackageKinds(handle, ollama, queue as never, () => 1);

    await kinds.learn(["mosquitto", "htop"]);

    expect(formats[0]).toEqual({
      type: "object",
      properties: { keepsData: { type: "array", maxItems: 2, items: { type: "string", enum: ["mosquitto", "htop"] } } },
      required: ["keepsData"],
    });
  });

  it("ignores names it was not asked about", async () => {
    answer = () => JSON.stringify({ keepsData: ["mosquitto", "something-else"] });
    const kinds = new PackageKinds(handle, ollama, queue as never, () => 1);

    await kinds.learn(["mosquitto"]);

    expect(kinds.known(["something-else"]).size).toBe(0);
  });

  it("keeps nothing when Ollama could not be asked, so the next check asks again", async () => {
    answer = () => "not json";
    const kinds = new PackageKinds(handle, ollama, queue as never, () => 1);

    await kinds.learn(["mosquitto"]);
    answer = () => JSON.stringify({ keepsData: [] });
    await kinds.learn(["mosquitto"]);

    expect(questions).toHaveLength(2);
    expect(kinds.known(["mosquitto"]).get("mosquitto")).toBe(false);
  });
});
