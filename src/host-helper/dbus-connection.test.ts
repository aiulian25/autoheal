import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DBUS, DBUS_TYPE, SYSTEMD } from "../shared/constants.js";
import {
  DbusConnection,
  DbusError,
  DbusVariant,
  decodeMessage,
  encodeMessage,
  encodeMethodCall,
  splitSignature,
  type DbusValue,
  type MethodCall,
} from "./dbus-connection.js";
import { packageUnit } from "./package-units.js";

const JOB = "0b8c3c5e-6a52-4f7e-9d3c-2f6d7a1b9e10";
const HELLO: MethodCall = {
  destination: DBUS.bus.name,
  path: DBUS.bus.path,
  interface: DBUS.bus.interface,
  member: DBUS.bus.hello,
  signature: "",
  body: [],
};
// Hello as libdbus and sd-bus send it: the header fields padded to 8 bytes, 128 bytes in all.
const HELLO_BYTES = Buffer.from(
  "l\x01\x00\x01\x00\x00\x00\x00\x01\x00\x00\x00m\x00\x00\x00" +
    "\x01\x01o\x00\x15\x00\x00\x00/org/freedesktop/DBus\x00\x00\x00" +
    "\x02\x01s\x00\x14\x00\x00\x00org.freedesktop.DBus\x00\x00\x00\x00" +
    "\x03\x01s\x00\x05\x00\x00\x00Hello\x00\x00\x00" +
    "\x06\x01s\x00\x14\x00\x00\x00org.freedesktop.DBus\x00\x00\x00\x00",
  "latin1",
);

describe("D-Bus signatures", () => {
  it("split into complete types", () => {
    expect(splitSignature(SYSTEMD.startTransientUnitSignature)).toEqual(["s", "s", "a(sv)", "a(sa(sv))"]);
    expect(splitSignature(DBUS_TYPE.commands)).toEqual([DBUS_TYPE.commands]);
    expect(splitSignature("")).toEqual([]);
  });

  it("refuse an unbalanced struct", () => {
    expect(() => splitSignature("(s")).toThrow(/unbalanced/);
  });
});

describe("the D-Bus wire format", () => {
  it("encodes Hello byte for byte as the reference libraries do", () => {
    expect(encodeMethodCall(1, HELLO)).toEqual(HELLO_BYTES);
  });

  it("decodes what it encodes, a whole transient unit with its commands and a 64-bit timeout", () => {
    const properties = packageUnit("apt", "upgrade", JOB, ["openssl", "libc6:i386"]).map(({ name, value }) => [
      name,
      value,
    ]);
    const body: DbusValue[] = ["autoheal-packages.service", SYSTEMD.jobMode, properties, []];
    const encoded = encodeMethodCall(7, { ...HELLO, signature: SYSTEMD.startTransientUnitSignature, body });

    const decoded = decodeMessage(encoded);

    expect(decoded?.size).toBe(encoded.length);
    expect(decoded?.message).toEqual({ type: DBUS.messageType.methodCall, replySerial: null, errorName: null, body });
  });

  it("waits for the rest of a message that has not all arrived", () => {
    const encoded = encodeMethodCall(1, HELLO);
    expect(decodeMessage(encoded.subarray(0, 10))).toBeNull();
    expect(decodeMessage(encoded.subarray(0, encoded.length - 1))).toBeNull();
  });

  it("refuses a variant without its signature", () => {
    expect(() => encodeMethodCall(1, { ...HELLO, signature: "v", body: ["plain"] })).toThrow(/signature/);
  });
});

// --- a bus that speaks just enough D-Bus to answer the client ------------------------------------

// What the bus sends back for the call with this serial: Hello is 1, the call under test 2.
type Answer = (serial: number) => Buffer[];
const SERIAL_OFFSET = 8;

const reply = (replySerial: number, signature: string, body: DbusValue[]) =>
  encodeMessage({
    type: DBUS.messageType.methodReturn,
    serial: 1000 + replySerial,
    fields: [[DBUS.headerField.replySerial, new DbusVariant(DBUS_TYPE.uint32, replySerial)]],
    signature,
    body,
  });

const errorReply = (replySerial: number, name: string, text: string) =>
  encodeMessage({
    type: DBUS.messageType.error,
    serial: 2000 + replySerial,
    fields: [
      [DBUS.headerField.errorName, new DbusVariant(DBUS_TYPE.string, name)],
      [DBUS.headerField.replySerial, new DbusVariant(DBUS_TYPE.uint32, replySerial)],
    ],
    signature: DBUS_TYPE.string,
    body: [text],
  });

const signal = () =>
  encodeMessage({
    type: DBUS.messageType.signal,
    serial: 1,
    fields: [
      [DBUS.headerField.path, new DbusVariant(DBUS_TYPE.objectPath, DBUS.bus.path)],
      [DBUS.headerField.interface, new DbusVariant(DBUS_TYPE.string, DBUS.bus.interface)],
      [DBUS.headerField.member, new DbusVariant(DBUS_TYPE.string, "NameAcquired")],
    ],
    signature: DBUS_TYPE.string,
    body: [":1.42"],
  });

function fakeBus(socketPath: string, answer: Answer, authenticationLine = "OK 0123456789abcdef"): Promise<Server> {
  const server = createServer((socket: Socket) => {
    const lines = [() => socket.write(`${authenticationLine}${DBUS.lineEnd}`), () => undefined];
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      // The AUTH line, then BEGIN; after those, only messages.
      for (let lineEnd = received.indexOf(DBUS.lineEnd); lines.length > 0 && lineEnd !== -1;) {
        lines.shift()!();
        received = received.subarray(lineEnd + DBUS.lineEnd.length);
        lineEnd = received.indexOf(DBUS.lineEnd);
      }
      if (lines.length > 0) {
        return;
      }
      for (let decoded = decodeMessage(received); decoded !== null; decoded = decodeMessage(received)) {
        const serial = received.readUInt32LE(SERIAL_OFFSET);
        received = received.subarray(decoded.size);
        answer(serial).forEach((message) => socket.write(message));
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

describe("a D-Bus connection", () => {
  let directory: string;
  let server: Server | null;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-dbus-"));
    server = null;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
    rmSync(directory, { recursive: true, force: true });
  });

  const socketPath = () => join(directory, "bus");

  it("authenticates, says Hello, ignores signals, and returns a call's reply", async () => {
    server = await fakeBus(socketPath(), (serial) =>
      serial === 1
        ? [signal(), reply(serial, DBUS_TYPE.string, [":1.42"])]
        : [signal(), reply(serial, DBUS_TYPE.objectPath, ["/org/freedesktop/systemd1/job/88"])],
    );
    const connection = await DbusConnection.open(socketPath());

    const body = await connection.call({
      ...HELLO,
      member: SYSTEMD.startTransientUnit,
      signature: "ss",
      body: ["a", "b"],
    });

    expect(body).toEqual(["/org/freedesktop/systemd1/job/88"]);
    connection.close();
  });

  it("turns an error reply into a DbusError carrying systemd's name for it", async () => {
    server = await fakeBus(socketPath(), (serial) =>
      serial === 1
        ? [reply(serial, DBUS_TYPE.string, [":1.42"])]
        : [errorReply(serial, SYSTEMD.unitExists, "Unit autoheal-packages.service was already loaded")],
    );
    const connection = await DbusConnection.open(socketPath());

    const failure = await connection.call({ ...HELLO, member: SYSTEMD.startTransientUnit }).catch((error) => error);

    expect(failure).toBeInstanceOf(DbusError);
    expect(failure).toMatchObject({ errorName: SYSTEMD.unitExists, message: expect.stringContaining("already") });
    connection.close();
  });

  it("gives up when the bus refuses who we are", async () => {
    server = await fakeBus(socketPath(), () => [], "REJECTED EXTERNAL");
    await expect(DbusConnection.open(socketPath())).rejects.toThrow(/refused to authenticate: REJECTED/);
  });

  it("fails a waiting call when the bus goes away", async () => {
    server = await fakeBus(socketPath(), (serial) => (serial === 1 ? [reply(serial, DBUS_TYPE.string, [":1"])] : []));
    const connection = await DbusConnection.open(socketPath());
    const waiting = connection.call({ ...HELLO, member: SYSTEMD.startTransientUnit });

    connection.close();

    await expect(waiting).rejects.toThrow(/closed/);
  });
});
