import { EventEmitter } from "node:events";
import type { ClientCallback, ClientChannel } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { runBounded } from "./ssh-exec.js";

const fakeChannel = () =>
  Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: vi.fn() }) as unknown as ClientChannel & {
    close: ReturnType<typeof vi.fn>;
  };
const listeners = (channel: ClientChannel) =>
  channel.listenerCount("data") + channel.listenerCount("close") + channel.stderr.listenerCount("data");
const BOUNDS = { timeoutMilliseconds: 20, operation: "A command", outputLimitBytes: 10 };

describe("one bounded command", () => {
  it("settles once, leaving no listener or timer behind, when the deadline comes first", async () => {
    const channel = fakeChannel();
    const running = runBounded((opened) => opened(undefined, channel), BOUNDS);
    expect(listeners(channel)).toBe(3);
    await expect(running).rejects.toThrow("did not finish");
    expect(channel.close).toHaveBeenCalledOnce();
    expect(listeners(channel)).toBe(0);
    channel.emit("close", 0);
    await expect(running).rejects.toThrow("did not finish");
  });

  it("closes a channel that opens only after its deadline", async () => {
    let answer!: ClientCallback;
    const running = runBounded((opened) => (answer = opened), BOUNDS);
    await expect(running).rejects.toThrow("did not finish");
    const channel = fakeChannel();
    answer(undefined, channel);
    expect(channel.close).toHaveBeenCalledOnce();
    expect(listeners(channel)).toBe(0);
  });

  it("keeps output exactly at its limit, and counts both streams towards it", async () => {
    const whole = fakeChannel();
    const fits = runBounded((opened) => opened(undefined, whole), { ...BOUNDS, timeoutMilliseconds: 5_000 });
    whole.emit("data", Buffer.from("12345"));
    whole.stderr.emit("data", Buffer.from("67890"));
    whole.emit("close", 3);
    await expect(fits).resolves.toEqual({ stdout: "12345", stderr: "67890", exitCode: 3 });
    expect(listeners(whole)).toBe(0);

    const over = fakeChannel();
    const stopped = runBounded((opened) => opened(undefined, over), { ...BOUNDS, timeoutMilliseconds: 5_000 });
    over.emit("data", Buffer.from("12345"));
    over.stderr.emit("data", Buffer.from("678901"));
    await expect(stopped).rejects.toThrow("printed more than");
    expect(over.close).toHaveBeenCalledOnce();
    expect(listeners(over)).toBe(0);
  });

  it("answers at once when the channel is refused, or asking for one throws", async () => {
    const refused = new Error("refused");
    await expect(runBounded((opened) => opened(refused, undefined as never), BOUNDS)).rejects.toBe(refused);
    const notConnected = new Error("Not connected");
    const throwing = () => {
      throw notConnected;
    };
    await expect(runBounded(throwing, BOUNDS)).rejects.toBe(notConnected);
  });
});
