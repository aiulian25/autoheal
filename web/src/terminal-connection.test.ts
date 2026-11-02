import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_INPUT_CHARACTERS } from "../../src/shared/constants.js";
import { TerminalConnection, type TerminalListener } from "./terminal-connection.js";

const OPENED = "/api/inventory/hosts/h1/containers/attic/terminals";
const STREAM = "/api/terminals/t1/stream";
const INPUT = "/api/terminals/t1/input";
const NO_CONTENT = 204;

// Only what the connection uses of the browser's EventSource.
class FakeEventSource {
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: { data: string }) => void>();

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: string) {
    this.listeners.get(type)!({ data });
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

// Each request answers at once, unless the test holds it: then it waits for the test's word.
function serve() {
  const held: { path: string; release: () => void }[] = [];
  let hold = false;
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
    if (hold && path === INPUT) {
      await new Promise<void>((release) => held.push({ path, release }));
    }
    if (path === OPENED) {
      return new Response(JSON.stringify({ id: "t1" }), { headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: NO_CONTENT });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    held,
    holdInput: () => {
      hold = true;
    },
    sent: (method: string, path: string) =>
      fetch.mock.calls
        .filter(([calledPath, init]) => calledPath === path && (init?.method ?? "GET") === method)
        .map(([, init]) => (init?.body === undefined ? null : JSON.parse(String(init.body)))),
  };
}

function listener() {
  return {
    output: vi.fn<TerminalListener["output"]>(),
    opened: vi.fn<TerminalListener["opened"]>(),
    gap: vi.fn<TerminalListener["gap"]>(),
    ended: vi.fn<TerminalListener["ended"]>(),
    failed: vi.fn<TerminalListener["failed"]>(),
    lost: vi.fn<TerminalListener["lost"]>(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a shell, from the browser", () => {
  beforeEach(() => {
    FakeEventSource.opened = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens at the size it is drawn, shows what it prints, and ends with it", async () => {
    const server = serve();
    const events = listener();
    const connection = new TerminalConnection(events);
    await connection.open(OPENED, { columns: 80, rows: 24 });

    expect(server.sent("POST", OPENED)).toEqual([{ columns: 80, rows: 24 }]);
    const [source] = FakeEventSource.opened;
    expect(source!.url).toBe(STREAM);
    source!.emit("output", Buffer.from("héllo\r\n").toString("base64"));
    expect(new TextDecoder().decode(events.output.mock.calls[0]![0])).toBe("héllo\r\n");

    source!.emit("ended", JSON.stringify({ exitCode: 0, reason: null }));
    expect(events.ended).toHaveBeenCalledWith({ exitCode: 0, reason: null });
    expect(source!.readyState).toBe(FakeEventSource.CLOSED);
    // It ended on its own: there is nothing to close.
    connection.close();
    expect(server.sent("DELETE", "/api/terminals/t1")).toEqual([]);
  });

  it("reports a replay gap and continues receiving available output on the same shell", async () => {
    const server = serve();
    const events = listener();
    const connection = new TerminalConnection(events);
    await connection.open(OPENED, { columns: 80, rows: 24 });
    const source = FakeEventSource.opened[0]!;
    source.emit("gap", "{}");
    source.onopen!();
    source.emit("output", Buffer.from("retained output").toString("base64"));
    expect(events.gap).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(events.output.mock.calls[0]![0])).toBe("retained output");
    expect(events.lost).not.toHaveBeenCalled();
    expect(server.sent("POST", OPENED)).toHaveLength(1);
    connection.close();
  });

  it("types in order, one request at a time, passes a new size on, and closes", async () => {
    const server = serve();
    const connection = new TerminalConnection(listener());
    await connection.open(OPENED, { columns: 80, rows: 24 });
    server.holdInput();

    connection.type("l");
    connection.type("s");
    connection.type("\r");
    await settle();
    expect(server.sent("POST", INPUT)).toEqual([{ data: "l" }]);
    server.held.shift()!.release();
    await vi.waitFor(() => expect(server.held).toHaveLength(1));
    expect(server.sent("POST", INPUT)).toEqual([{ data: "l" }, { data: "s\r" }]);
    server.held.shift()!.release();

    connection.resize({ columns: 120, rows: 40 });
    await vi.waitFor(() =>
      expect(server.sent("POST", "/api/terminals/t1/resize")).toEqual([{ columns: 120, rows: 40 }]),
    );
    connection.close();
    expect(server.sent("DELETE", "/api/terminals/t1")).toEqual([null]);
    expect(FakeEventSource.opened[0]!.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("never splits a character between two requests", async () => {
    const server = serve();
    const connection = new TerminalConnection(listener());
    await connection.open(OPENED, { columns: 80, rows: 24 });
    const pasted = `${"a".repeat(TERMINAL_INPUT_CHARACTERS - 1)}😀b`;

    connection.type(pasted);
    await vi.waitFor(() => expect(server.sent("POST", INPUT)).toHaveLength(2));
    const [first, second] = server.sent("POST", INPUT) as { data: string }[];
    expect(first!.data).toBe("a".repeat(TERMINAL_INPUT_CHARACTERS - 1));
    expect(second!.data).toBe("😀b");
  });

  it("ends a shell closed while it was opening, and says when its stream is refused", async () => {
    const server = serve();
    const closedEarly = new TerminalConnection(listener());
    const opening = closedEarly.open(OPENED, { columns: 80, rows: 24 });
    closedEarly.close();
    await opening;
    await vi.waitFor(() => expect(server.sent("DELETE", "/api/terminals/t1")).toEqual([null]));
    expect(FakeEventSource.opened).toEqual([]);

    const events = listener();
    await new TerminalConnection(events).open(OPENED, { columns: 80, rows: 24 });
    const [source] = FakeEventSource.opened;
    source!.readyState = FakeEventSource.CLOSED;
    source!.onerror!();
    expect(events.lost).toHaveBeenCalled();
  });
});
