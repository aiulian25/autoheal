import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEED_SOURCE, SPEED_TEST_LIMITS } from "../../shared/network.js";
import { NetworkSpeedRun, type NetworkSpeedDependencies } from "./network-speed.js";
import { measureSpeed } from "./own-speed-test.js";
import type { RouterAdapter } from "./router-adapter.js";

const NOW = 5_000_000;
const OLD_TEST = { at: 1_000, downMbps: 1, upMbps: 1, ping: 1 };
const NEW_TEST = { at: 2_000, downMbps: 900, upMbps: 50, ping: 8 };

function runWith(router: Partial<RouterAdapter> | null, overrides: Partial<NetworkSpeedDependencies> = {}) {
  const addSpeedTest = vi.fn();
  const measure = vi.fn(async () => ({ downMbps: 700, upMbps: 40 }));
  const run = new NetworkSpeedRun({
    store: { addSpeedTest },
    adapter: () => router as RouterAdapter | null,
    contractDownMbps: () => 1_000,
    quietBusyMbps: () => 5,
    clock: () => NOW,
    measure,
    routerPollMilliseconds: 1,
    ...overrides,
  });
  return { run, addSpeedTest, measure };
}

const internetAnswers = (...tests: (typeof OLD_TEST | null)[]) => {
  const internet = vi.fn(async () => ({ lines: [], publicAddress: null, busyMbps: 0, lastTest: tests.at(-1) ?? null }));
  tests.forEach((lastTest) =>
    internet.mockResolvedValueOnce({ lines: [], publicAddress: null, busyMbps: 0, lastTest }),
  );
  return internet;
};

describe("a speed test a person asks for", () => {
  it("is the router's own when it will run one", async () => {
    const { run, addSpeedTest, measure } = runWith({
      internet: internetAnswers(OLD_TEST, OLD_TEST, NEW_TEST),
      startSpeedTest: async () => true,
    });
    run.start();
    expect(run.status().status).toBe("running");
    await vi.waitFor(() => expect(run.status().status).toBe("idle"));
    expect(addSpeedTest).toHaveBeenCalledWith(NEW_TEST, 5, true, SPEED_SOURCE.router);
    expect(measure).not.toHaveBeenCalled();
  });

  it("is measured from this machine when this user may not start one", async () => {
    const { run, addSpeedTest } = runWith({ internet: internetAnswers(OLD_TEST), startSpeedTest: async () => false });
    run.start();
    await vi.waitFor(() => expect(run.status().status).toBe("idle"));
    expect(addSpeedTest).toHaveBeenCalledWith(
      { downMbps: 700, upMbps: 40, at: NOW, ping: null },
      5,
      true,
      SPEED_SOURCE.thisMachine,
    );
  });

  it("is measured from this machine when the router accepts and never reports", async () => {
    const { run, addSpeedTest } = runWith({
      internet: async () => ({ lines: [], publicAddress: null, busyMbps: 0, lastTest: OLD_TEST }),
      startSpeedTest: async () => true,
    });
    run.start();
    await vi.waitFor(() => expect(run.status().status).toBe("idle"));
    expect(addSpeedTest.mock.calls[0]?.[3]).toBe(SPEED_SOURCE.thisMachine);
  });

  it("does not count a busy line against the provider, from how busy it was before", async () => {
    const { run, addSpeedTest } = runWith(
      { internet: internetAnswers(OLD_TEST), startSpeedTest: async () => false },
      { quietBusyMbps: () => 800 },
    );
    run.start();
    await vi.waitFor(() => expect(run.status().status).toBe("idle"));
    expect(addSpeedTest.mock.calls[0]?.[2]).toBe(false);
  });

  it("starts only one at a time", async () => {
    const startSpeedTest = vi.fn(async () => false);
    const { run } = runWith({ internet: internetAnswers(null), startSpeedTest });
    run.start();
    run.start();
    await vi.waitFor(() => expect(run.status().status).toBe("idle"));
    expect(startSpeedTest).toHaveBeenCalledTimes(1);
  });

  it("says why it failed, and can be run again", async () => {
    const { run, addSpeedTest, measure } = runWith(null);
    measure.mockRejectedValueOnce(new Error("no way out"));
    run.start();
    await vi.waitFor(() => expect(run.status()).toEqual({ status: "failed", error: "no way out" }));
    run.start();
    await vi.waitFor(() => expect(run.status().status).toBe("idle"));
    expect(addSpeedTest).toHaveBeenCalledTimes(1);
  });
});

describe("measuring from this machine", () => {
  let server: Server;
  const serve = async (status: number) => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(status);
        if (status !== 200 || request.method === "POST") return void response.end();
        response.end(Buffer.alloc(1_000_000));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const milliseconds = SPEED_TEST_LIMITS.warmUpMilliseconds + 300;

  it("gives a figure each way", { timeout: 20_000 }, async () => {
    const { downMbps, upMbps } = await measureSpeed(await serve(200), milliseconds);
    expect(downMbps).toBeGreaterThan(0);
    expect(upMbps).toBeGreaterThan(0);
  });

  it("fails plainly when the server refuses", { timeout: 20_000 }, async () => {
    await expect(measureSpeed(await serve(429), milliseconds)).rejects.toThrow("429");
  });
});
