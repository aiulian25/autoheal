import { describe, expect, it, vi } from "vitest";
import { PRIORITY_LIVE } from "../../shared/constants.js";
import { DecisionQueue } from "../decisions/decision-queue.js";
import { OllamaClient } from "../../ollama/ollama-client.js";
import type { OllamaServerRow } from "../settings/ollama-servers-service.js";
import { OllamaMonitor } from "./ollama-monitor.js";
import { OllamaPool, type ModelServer } from "./ollama-pool.js";

const DEFAULTS = { url: "http://default:11434", model: "small", contextTokens: 8_000 };
const BIG: OllamaServerRow = { id: "big", name: "Big", url: "http://big:11434", model: "large", contextTokens: 32_000 };

function poolWith(rows: OllamaServerRow[] = [BIG], assignments: Record<string, string> = { h1: "big" }) {
  const client = new OllamaClient(() => DEFAULTS);
  const state = { rows, assignments, review: null as string | null };
  const pool = new OllamaPool(
    { id: null, name: null, client, queue: new DecisionQueue(), monitor: new OllamaMonitor(client) },
    () => DEFAULTS,
    {
      list: () => state.rows,
      serverIdOf: (hostId) => state.assignments[hostId] ?? null,
      hostIdsByServer: () => {
        const found = new Map<string, string[]>();
        for (const [hostId, id] of Object.entries(state.assignments)) found.set(id, [...(found.get(id) ?? []), hostId]);
        return found;
      },
      reviewServerId: () => state.review,
      routerServerId: () => null,
      defaultName: () => null,
    },
  );
  return { pool, state };
}

const urlOf = (server: ModelServer) => server.client.model;
const asking = (pool: OllamaPool, hostId: string, work: (server: ModelServer) => Promise<string>, told?: () => void) =>
  pool.askFor(hostId, PRIORITY_LIVE, (server) => work(server), told);

describe("which server a host's work goes to", () => {
  it("is its own, and the default when it has none or its server is gone", async () => {
    const { pool, state } = poolWith();
    expect(await asking(pool, "h1", async (server) => urlOf(server))).toBe("large");
    expect(await asking(pool, "h2", async (server) => urlOf(server))).toBe("small");
    state.rows = [];
    expect(await asking(pool, "h1", async (server) => urlOf(server))).toBe("small");
  });

  it("tells a runner the same", () => {
    const { pool } = poolWith();
    expect(pool.settingsFor("h1")).toEqual({ url: BIG.url, model: "large", contextTokens: 32_000 });
    expect(pool.settingsFor("h2")).toEqual(DEFAULTS);
  });

  it("follows a change to its server, on the same queue", async () => {
    const { pool, state } = poolWith();
    await asking(pool, "h1", async (server) => urlOf(server));
    state.rows = [{ ...BIG, model: "larger" }];
    expect(await asking(pool, "h1", async (server) => urlOf(server))).toBe("larger");
  });
});

describe("separate queues", () => {
  it("lets a slow server's call wait without holding up another server", async () => {
    const { pool } = poolWith();
    let finishSlow = (_answer: string) => {};
    const slow = asking(pool, "h1", () => new Promise<string>((resolve) => (finishSlow = resolve)));
    expect(await asking(pool, "h2", async () => "quick")).toBe("quick");
    finishSlow("done");
    expect(await slow).toBe("done");
  });

  it("queues calls on one server, one at a time", async () => {
    const { pool } = poolWith();
    const order: string[] = [];
    let finishFirst = (_answer: string) => {};
    const first = asking(pool, "h1", () => new Promise<string>((resolve) => (finishFirst = resolve)));
    const second = asking(pool, "h1", async () => {
      order.push("second");
      return "second";
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    finishFirst("first");
    await Promise.all([first, second]);
    expect(order).toEqual(["second"]);
  });

  it("stops and starts every queue, as a restore needs", async () => {
    const { pool } = poolWith();
    pool.all();
    pool.cancelAll();
    await expect(asking(pool, "h1", async () => "no")).rejects.toThrow();
    await expect(asking(pool, "h2", async () => "no")).rejects.toThrow();
    pool.resume();
    expect(await asking(pool, "h1", async () => "yes")).toBe("yes");
  });
});

describe("falling back", () => {
  const refused = () => new TypeError("fetch failed");

  it("gives the work to the default once when a server cannot be reached, and says so", async () => {
    const { pool } = poolWith();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(refused());
    const told = vi.fn();
    const asked: string[] = [];
    const answer = await pool.askFor(
      "h1",
      PRIORITY_LIVE,
      async (server) => {
        asked.push(urlOf(server));
        if (server.id !== null) throw refused();
        return "from the default";
      },
      told,
    );
    expect(answer).toBe("from the default");
    expect(asked).toEqual(["large", "small"]);
    expect(told).toHaveBeenCalledWith("Big", "fetch failed");
    vi.restoreAllMocks();
  });

  it("goes straight to the default when its server is known to be down", async () => {
    const { pool } = poolWith();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(refused());
    await pool.checkAll();
    vi.restoreAllMocks();
    const told = vi.fn();
    const asked: string[] = [];
    await pool.askFor(
      "h1",
      PRIORITY_LIVE,
      async (server) => {
        asked.push(urlOf(server));
        return "ok";
      },
      told,
    );
    expect(asked).toEqual(["small"]);
    expect(told).toHaveBeenCalledOnce();
    expect(pool.settingsFor("h1")).toEqual(DEFAULTS);
  });

  it("does not for a bad answer, a stopped call, or the default's own failure", async () => {
    const { pool } = poolWith();
    const asked: string[] = [];
    const failing = (error: Error) => async (server: ModelServer) => {
      asked.push(urlOf(server));
      throw error;
    };
    await expect(asking(pool, "h1", failing(new Error("Ollama answered 500")))).rejects.toThrow("500");
    await expect(asking(pool, "h1", failing(new DOMException("stopped", "AbortError")))).rejects.toThrow("stopped");
    await expect(asking(pool, "h2", failing(refused()))).rejects.toThrow("fetch failed");
    expect(asked).toEqual(["large", "large", "small"]);
  });
});

describe("the Home Assistant review's server", () => {
  it("is the chosen one, and the default once that is gone", () => {
    const { pool, state } = poolWith();
    expect(pool.reviewServer().id).toBeNull();
    state.review = "big";
    expect(pool.reviewServer().id).toBe("big");
    state.rows = [];
    state.review = null;
    expect(pool.reviewServer().id).toBeNull();
  });
});
