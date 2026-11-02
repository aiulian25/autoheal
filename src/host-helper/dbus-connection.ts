import { createConnection, type Socket } from "node:net";
import { DBUS, DBUS_TYPE } from "../shared/constants.js";

/** A value as D-Bus carries it: arrays and structs are arrays, a variant carries its own signature. */
export type DbusValue = string | number | bigint | boolean | DbusVariant | readonly DbusValue[];

export class DbusVariant {
  constructor(
    readonly signature: string,
    readonly value: DbusValue,
  ) {}
}

/** An error reply. systemd names what went wrong, for example org.freedesktop.systemd1.UnitExists. */
export class DbusError extends Error {
  constructor(
    readonly errorName: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MethodCall {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature: string;
  body: readonly DbusValue[];
}

interface IncomingMessage {
  type: number;
  replySerial: number | null;
  errorName: string | null;
  body: DbusValue[];
}

type TypeCode = keyof typeof DBUS.alignment;

// --- signatures ----------------------------------------------------------------------------------

const NESTING: Record<string, number> = { "(": 1, ")": -1 };

/** Where the one complete type starting at `start` ends: "a(sv)" is one type, "sv" is two. */
function completeTypeEnd(signature: string, start: number): number {
  if (signature[start] === "a") {
    return completeTypeEnd(signature, start + 1);
  }
  if (signature[start] !== "(") {
    return start + 1;
  }
  let depth = 0;
  for (let index = start; index < signature.length; index += 1) {
    depth += NESTING[signature[index]!] ?? 0;
    if (depth === 0) {
      return index + 1;
    }
  }
  throw new Error(`unbalanced D-Bus signature: ${signature}`);
}

export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  let start = 0;
  while (start < signature.length) {
    const end = completeTypeEnd(signature, start);
    types.push(signature.slice(start, end));
    start = end;
  }
  return types;
}

function alignmentOf(type: string): number {
  const alignment = DBUS.alignment[type[0] as TypeCode] as number | undefined;
  if (alignment === undefined) {
    throw new Error(`unsupported D-Bus type: ${type}`);
  }
  return alignment;
}

const paddingTo = (offset: number, boundary: number) => (boundary - (offset % boundary)) % boundary;

// --- the wire format -------------------------------------------------------------------------------

class WireWriter {
  private buffer = Buffer.alloc(DBUS.initialBufferBytes);
  private length = 0;

  get bytes(): Buffer {
    return this.buffer.subarray(0, this.length);
  }

  align(boundary: number) {
    const padding = paddingTo(this.length, boundary);
    this.reserve(padding);
    this.buffer.fill(0, this.length, this.length + padding);
    this.length += padding;
  }

  write(type: string, value: DbusValue) {
    this.align(alignmentOf(type));
    switch (type[0]) {
      case "y":
        this.reserve(1);
        this.length = this.buffer.writeUInt8(value as number, this.length);
        return;
      case "b":
        this.writeUint32(value === true ? 1 : 0);
        return;
      case "i":
        this.reserve(4);
        this.length = this.buffer.writeInt32LE(value as number, this.length);
        return;
      case "u":
        this.writeUint32(value as number);
        return;
      case "t":
        this.reserve(8);
        this.length = this.buffer.writeBigUInt64LE(BigInt(value as bigint | number), this.length);
        return;
      case "s":
      case "o":
        this.writeText(value as string, (size) => this.writeUint32(size));
        return;
      case "g":
        this.writeText(value as string, (size) => this.write("y", size));
        return;
      case "a":
        this.writeArray(type.slice(1), value as readonly DbusValue[]);
        return;
      case "(":
        this.writeStruct(type.slice(1, -1), value as readonly DbusValue[]);
        return;
      case "v":
        this.writeVariant(value);
        return;
    }
  }

  private reserve(bytes: number) {
    if (this.length + bytes <= this.buffer.length) {
      return;
    }
    const grown = Buffer.alloc(Math.max(this.buffer.length * 2, this.length + bytes));
    this.buffer.copy(grown, 0, 0, this.length);
    this.buffer = grown;
  }

  private writeUint32(value: number) {
    this.reserve(4);
    this.length = this.buffer.writeUInt32LE(value, this.length);
  }

  // A string and an object path have a 32-bit length, a signature an 8-bit one; both end in a NUL.
  private writeText(text: string, writeLength: (size: number) => void) {
    const bytes = Buffer.from(text, "utf8");
    writeLength(bytes.length);
    this.reserve(bytes.length + 1);
    this.length += bytes.copy(this.buffer, this.length);
    this.length = this.buffer.writeUInt8(0, this.length);
  }

  // The length counts the elements only, not the padding between it and the first one.
  private writeArray(elementType: string, elements: readonly DbusValue[]) {
    const lengthAt = this.length;
    this.writeUint32(0);
    this.align(alignmentOf(elementType));
    const start = this.length;
    for (const element of elements) {
      this.write(elementType, element);
    }
    this.buffer.writeUInt32LE(this.length - start, lengthAt);
  }

  private writeStruct(fieldTypes: string, fields: readonly DbusValue[]) {
    splitSignature(fieldTypes).forEach((fieldType, index) => this.write(fieldType, fields[index]!));
  }

  private writeVariant(value: DbusValue) {
    if (!(value instanceof DbusVariant)) {
      throw new Error("a D-Bus variant needs its signature");
    }
    this.write("g", value.signature);
    this.write(value.signature, value.value);
  }
}

class WireReader {
  constructor(
    private readonly buffer: Buffer,
    private offset = 0,
  ) {}

  read(type: string): DbusValue {
    this.offset += paddingTo(this.offset, alignmentOf(type));
    switch (type[0]) {
      case "y":
        return this.take(1, () => this.buffer.readUInt8(this.offset));
      case "b":
        return this.take(4, () => this.buffer.readUInt32LE(this.offset) !== 0);
      case "i":
        return this.take(4, () => this.buffer.readInt32LE(this.offset));
      case "u":
        return this.take(4, () => this.buffer.readUInt32LE(this.offset));
      case "t":
        return this.take(8, () => this.buffer.readBigUInt64LE(this.offset));
      case "s":
      case "o":
        return this.readText(this.read("u") as number);
      case "g":
        return this.readText(this.read("y") as number);
      case "a":
        return this.readArray(type.slice(1));
      case "(":
        return splitSignature(type.slice(1, -1)).map((fieldType) => this.read(fieldType));
      case "v": {
        const signature = this.read("g") as string;
        return new DbusVariant(signature, this.read(signature));
      }
    }
    throw new Error(`unsupported D-Bus type: ${type}`);
  }

  private take<T>(bytes: number, readValue: () => T): T {
    const value = readValue();
    this.offset += bytes;
    return value;
  }

  private readText(size: number): string {
    const text = this.buffer.toString("utf8", this.offset, this.offset + size);
    this.offset += size + 1;
    return text;
  }

  private readArray(elementType: string): DbusValue[] {
    const size = this.read("u") as number;
    this.offset += paddingTo(this.offset, alignmentOf(elementType));
    const end = this.offset + size;
    const elements: DbusValue[] = [];
    while (this.offset < end) {
      elements.push(this.read(elementType));
    }
    return elements;
  }
}

const HEADER = DBUS.headerField;

export type HeaderField = readonly [code: number, value: DbusVariant];

export interface OutgoingMessage {
  type: number;
  serial: number;
  fields: readonly HeaderField[];
  signature: string;
  body: readonly DbusValue[];
}

export function encodeMessage(message: OutgoingMessage): Buffer {
  const body = new WireWriter();
  splitSignature(message.signature).forEach((type, index) => body.write(type, message.body[index]!));
  const signatureField: HeaderField[] =
    message.signature === "" ? [] : [[HEADER.signature, new DbusVariant(DBUS_TYPE.signature, message.signature)]];
  const header = new WireWriter();
  header.write(DBUS_TYPE.byte, DBUS.littleEndian);
  header.write(DBUS_TYPE.byte, message.type);
  header.write(DBUS_TYPE.byte, DBUS.noFlags);
  header.write(DBUS_TYPE.byte, DBUS.protocolVersion);
  header.write(DBUS_TYPE.uint32, body.bytes.length);
  header.write(DBUS_TYPE.uint32, message.serial);
  header.write(DBUS_TYPE.headerFields, [...message.fields, ...signatureField]);
  header.align(DBUS.headerAlignment);
  return Buffer.concat([header.bytes, body.bytes]);
}

export const encodeMethodCall = (serial: number, call: MethodCall) =>
  encodeMessage({
    type: DBUS.messageType.methodCall,
    serial,
    fields: [
      [HEADER.path, new DbusVariant(DBUS_TYPE.objectPath, call.path)],
      [HEADER.interface, new DbusVariant(DBUS_TYPE.string, call.interface)],
      [HEADER.member, new DbusVariant(DBUS_TYPE.string, call.member)],
      [HEADER.destination, new DbusVariant(DBUS_TYPE.string, call.destination)],
    ],
    signature: call.signature,
    body: call.body,
  });

/** The first whole message in `buffer` and how many bytes it took, or null until all of it is here. */
export function decodeMessage(buffer: Buffer): { message: IncomingMessage; size: number } | null {
  if (buffer.length < DBUS.fixedHeaderBytes) {
    return null;
  }
  if (buffer[0] !== DBUS.littleEndian) {
    throw new Error("only little-endian D-Bus messages are understood");
  }
  const fieldsSize = buffer.readUInt32LE(DBUS.headerFieldsOffset);
  const bodyStart = DBUS.fixedHeaderBytes + fieldsSize + paddingTo(fieldsSize, DBUS.headerAlignment);
  const size = bodyStart + buffer.readUInt32LE(DBUS.bodyLengthOffset);
  if (buffer.length < size) {
    return null;
  }
  const fieldList = new WireReader(buffer, DBUS.headerFieldsOffset).read(DBUS_TYPE.headerFields) as DbusValue[][];
  const fields = new Map(fieldList.map(([code, variant]) => [code as number, (variant as DbusVariant).value]));
  const reader = new WireReader(buffer.subarray(bodyStart, size));
  const signature = (fields.get(HEADER.signature) as string | undefined) ?? "";
  return {
    message: {
      type: buffer[1]!,
      replySerial: (fields.get(HEADER.replySerial) as number | undefined) ?? null,
      errorName: (fields.get(HEADER.errorName) as string | undefined) ?? null,
      body: splitSignature(signature).map((type) => reader.read(type)),
    },
    size,
  };
}

// --- the connection ------------------------------------------------------------------------------

function connectTo(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** SASL EXTERNAL: the bus knows who we are from the socket; we only say which user that is. */
function authenticate(socket: Socket): Promise<Buffer> {
  const uid = Buffer.from(String(process.getuid?.() ?? 0), "ascii").toString("hex");
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const lineEnd = received.indexOf(DBUS.lineEnd);
      if (lineEnd === -1) {
        return;
      }
      socket.off("data", onData);
      const line = received.toString("ascii", 0, lineEnd);
      if (!line.startsWith(DBUS.authenticated)) {
        reject(new Error(`the D-Bus server refused to authenticate: ${line}`));
        return;
      }
      socket.write(`${DBUS.begin}${DBUS.lineEnd}`);
      resolve(received.subarray(lineEnd + DBUS.lineEnd.length));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`${DBUS.nul}${DBUS.authenticate} ${uid}${DBUS.lineEnd}`);
  });
}

interface PendingCall {
  resolve: (body: DbusValue[]) => void;
  reject: (error: Error) => void;
}

/** A client on a D-Bus socket that makes method calls and waits for their replies. */
export class DbusConnection {
  private serial = 0;
  private readonly pending = new Map<number, PendingCall>();

  private constructor(
    private readonly socket: Socket,
    private received: Buffer,
  ) {
    socket.on("data", (chunk: Buffer) => {
      this.received = Buffer.concat([this.received, chunk]);
      this.dispatch();
    });
    socket.on("close", () => this.failAll(new Error("the D-Bus connection closed")));
    socket.on("error", (error) => this.failAll(error));
    this.dispatch();
  }

  static async open(path: string = DBUS.systemBusSocket): Promise<DbusConnection> {
    const socket = await connectTo(path);
    try {
      const connection = new DbusConnection(socket, await authenticate(socket));
      await connection.call({
        destination: DBUS.bus.name,
        path: DBUS.bus.path,
        interface: DBUS.bus.interface,
        member: DBUS.bus.hello,
        signature: "",
        body: [],
      });
      return connection;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  call(call: MethodCall): Promise<DbusValue[]> {
    this.serial += 1;
    const serial = this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new Error(`no answer from ${call.destination} to ${call.member}`));
      }, DBUS.callTimeoutMilliseconds);
      const settle = () => clearTimeout(timer);
      this.pending.set(serial, {
        resolve: (body) => {
          settle();
          resolve(body);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.socket.write(encodeMethodCall(serial, call));
    });
  }

  close() {
    this.socket.end();
  }

  private dispatch() {
    for (let decoded = decodeMessage(this.received); decoded !== null; decoded = decodeMessage(this.received)) {
      this.received = this.received.subarray(decoded.size);
      this.settle(decoded.message);
    }
  }

  // Signals (NameAcquired after Hello) answer nothing we asked; they are dropped.
  private settle(message: IncomingMessage) {
    const waiting = message.replySerial === null ? undefined : this.pending.get(message.replySerial);
    if (waiting === undefined) {
      return;
    }
    this.pending.delete(message.replySerial!);
    if (message.type === DBUS.messageType.error) {
      waiting.reject(new DbusError(message.errorName ?? "", String(message.body[0] ?? message.errorName)));
      return;
    }
    waiting.resolve(message.body);
  }

  private failAll(error: Error) {
    for (const waiting of this.pending.values()) {
      waiting.reject(error);
    }
    this.pending.clear();
  }
}
