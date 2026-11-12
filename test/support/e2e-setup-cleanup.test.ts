import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import globalSetup, { E2E_SESSION_DIRECTORY } from "../e2e/global-setup.js";

// The engine the browser tests' setup is given, kept here: what it has is a set of "kind name" lines, and nothing
// reaches Docker. A container named for the browser tests carries their label; any other is someone else's.
const engine = vi.hoisted(() => ({
  world: new Set<string>(),
  // The first words of the one command it refuses.
  refusing: null as string | null,
  logs: "",
  modelServerStarts: true,
  modelServerClosed: 0,
}));

vi.mock("node:child_process", () => {
  const valueAfter = (words: string[], flag: string) => words[words.indexOf(flag) + 1] ?? "";
  const named = (kind: string) =>
    [...engine.world].filter((thing) => thing.startsWith(`${kind} `)).map((thing) => thing.slice(kind.length + 1));
  const forTheTests = (name: string) => name.startsWith("autoheal-e2e-");
  const add = (kind: string, name: string) => {
    engine.world.add(`${kind} ${name}`);
    return "";
  };
  const remove = (kind: string, names: string[]) => {
    for (const name of names) {
      if (!engine.world.delete(`${kind} ${name}`)) throw new Error(`Error response from daemon: No such ${kind}`);
    }
    return "";
  };
  const containers = (words: string[]) => {
    if (words.includes("-aq")) return named("container").filter(forTheTests).join("\n");
    if (!valueAfter(words, "--format").includes("\t")) return named("container").join("\n");
    return named("container")
      .map((name) => `${name}\timage\t${forTheTests(name) ? "1" : ""}`)
      .join("\n");
  };
  const listed = (kind: string, words: string[]) => {
    const filters = words.filter((_, index) => words[index - 1] === "--filter");
    const exactly = filters.find((filter) => filter.startsWith("name=^"))?.slice("name=^".length, -"$".length);
    if (exactly !== undefined)
      return named(kind)
        .filter((name) => name === exactly)
        .join("\n");
    if (filters.includes("label=autoheal.guard.state"))
      return named(kind)
        .filter((name) => name.startsWith("autoheal-guard-"))
        .join("\n");
    if (filters.length > 0) return "";
    return named(kind).join("\n");
  };
  const answer = (words: string[]) => {
    const [verb = "", object = ""] = words;
    if (verb === "run") return add("container", valueAfter(words, "--name"));
    if (verb === "rm") return remove("container", words.slice(2));
    if (verb === "ps") return containers(words);
    if (verb === "logs") return engine.logs;
    if (object === "create") return add(verb, words.at(-1)!);
    if (object === "rm") return remove(verb, words.slice(2));
    if (object === "ls") return listed(verb, words);
    return "";
  };
  return {
    execFileSync: (_command: string, words: string[]) => {
      if (engine.refusing !== null && words.join(" ").startsWith(engine.refusing)) {
        throw new Error("Error response from daemon: refused");
      }
      return answer(words);
    },
    spawnSync: (_command: string, words: string[]) =>
      engine.world.has(`container ${words.at(-1)}`)
        ? { status: 0, stdout: "what it wrote out\n", stderr: "what it wrote as errors\n" }
        : { status: 1, stdout: "", stderr: "Error response from daemon: No such container\n" },
  };
});
vi.mock("../fakes/fake-ollama.js", () => ({
  answer: () => ({}),
  FakeOllama: {
    start: async () => {
      if (!engine.modelServerStarts) throw new Error("the model server could not listen");
      return {
        listeningPort: 1,
        handler: null,
        close: async () => {
          engine.modelServerClosed += 1;
        },
      };
    },
  },
}));

// Someone else's, on the same engine: no container, which the setup refuses, but a volume and a network.
const SOMEONE_ELSES = ["network someone-elses-network", "volume someone-elses-data"];

describe("the browser tests' setup", () => {
  let shown: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    engine.world = new Set(SOMEONE_ELSES);
    engine.refusing = null;
    engine.logs = "the one-time password made-up-first-password";
    engine.modelServerStarts = true;
    engine.modelServerClosed = 0;
    shown = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const leftOnTheEngine = () => [...engine.world].toSorted();
  const said = () => shown.mock.calls.flat().map(String).join("\n");
  const expectNothingOfItsOwnLeft = () => {
    expect(leftOnTheEngine()).toEqual(SOMEONE_ELSES);
    expect(existsSync(E2E_SESSION_DIRECTORY)).toBe(false);
  };

  it.each([
    ["its first record of state cannot be made", "volume create --label autoheal.guard.state"],
    ["its network cannot be made", "network create"],
    ["its data volume cannot be made", "volume create autoheal-e2e-data"],
    ["the control plane cannot be started", "run"],
  ])("removes all it made, and only that, when %s", async (_what, refusing) => {
    engine.refusing = refusing;

    await expect(globalSetup()).rejects.toThrow("refused");

    expectNothingOfItsOwnLeft();
    expect(engine.modelServerClosed).toBe(1);
  });

  it("removes all it made, and shows what the control plane said, when it prints no first-run password", async () => {
    engine.logs = "";

    await expect(globalSetup()).rejects.toThrow("first-run password");

    expectNothingOfItsOwnLeft();
    expect(engine.modelServerClosed).toBe(1);
    expect(said()).toContain("what it wrote out");
    expect(said()).toContain("what it wrote as errors");
  });

  it("removes all it made, and shows what the control plane said, when it never becomes healthy", async () => {
    vi.useFakeTimers();
    engine.refusing = "exec";

    const failed = expect(globalSetup()).rejects.toThrow("healthy");
    await vi.runAllTimersAsync();
    await failed;

    expectNothingOfItsOwnLeft();
    expect(engine.modelServerClosed).toBe(1);
    expect(said()).toContain("what it wrote as errors");
  });

  it("makes nothing when the model server cannot listen", async () => {
    engine.modelServerStarts = false;

    await expect(globalSetup()).rejects.toThrow("could not listen");

    expectNothingOfItsOwnLeft();
  });

  it("still refuses an engine with someone else's containers, and removes nothing there", async () => {
    engine.world.add("container someone-elses-app");

    await expect(globalSetup()).rejects.toThrow("disposable Docker engine");

    expect(leftOnTheEngine()).toEqual(["container someone-elses-app", ...SOMEONE_ELSES]);
  });

  it("says what it could not remove after a failed setup, and fails for the first reason", async () => {
    engine.logs = "";
    engine.refusing = "network rm";

    await expect(globalSetup()).rejects.toThrow("first-run password");

    expect(said()).toContain("refused");
    expect(engine.modelServerClosed).toBe(1);
  });

  it("gives back a clean-up that removes all it made, and may run again", async () => {
    const teardown = await globalSetup();
    expect(engine.world.size).toBeGreaterThan(SOMEONE_ELSES.length);

    await teardown();
    await teardown();

    expectNothingOfItsOwnLeft();
    expect(engine.modelServerClosed).toBe(1);
  });

  it("lets a removal the engine refuses be seen, and still closes the model server and the session's folder", async () => {
    const teardown = await globalSetup();
    engine.refusing = "network rm";

    await expect(teardown()).rejects.toThrow("refused");

    expect(existsSync(E2E_SESSION_DIRECTORY)).toBe(false);
    expect(engine.modelServerClosed).toBe(1);
  });
});
