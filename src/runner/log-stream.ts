import { DOCKER_STREAM, DOCKER_STREAM_HEADER_SIZE, DOCKER_STREAM_SIZE_OFFSET } from "../shared/constants.js";

/**
 * Docker's output without a terminal: frames of an 8-byte header (which stream, how long) and their bytes. They
 * are split as they stream in, so neither the whole response nor a single huge frame is ever held in memory.
 */
class FrameSplitter {
  private header = Buffer.alloc(0);
  private stream = 0;
  private remainingInFrame = 0;

  constructor(private readonly onPayload: (stream: number, payload: Buffer) => void) {}

  feed(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remainingInFrame === 0) {
        offset = this.readHeader(chunk, offset);
        continue;
      }
      const payload = chunk.subarray(offset, offset + this.remainingInFrame);
      this.onPayload(this.stream, payload);
      this.remainingInFrame -= payload.length;
      offset += payload.length;
    }
  }

  private readHeader(chunk: Buffer, offset: number): number {
    const needed = DOCKER_STREAM_HEADER_SIZE - this.header.length;
    const piece = chunk.subarray(offset, offset + needed);
    this.header = Buffer.concat([this.header, piece]);
    if (this.header.length === DOCKER_STREAM_HEADER_SIZE) {
      this.stream = this.header[0]!;
      this.remainingInFrame = this.header.readUInt32BE(DOCKER_STREAM_SIZE_OFFSET);
      this.header = Buffer.alloc(0);
    }
    return offset + piece.length;
  }
}

/** Keeps the newest `limitBytes` of a container's log output while it streams in. */
export class LogStreamTail {
  private readonly frames = new FrameSplitter((_stream, payload) => this.keep(payload));
  private tail: Buffer[] = [];
  private tailBytes = 0;

  constructor(
    private readonly usesTty: boolean,
    private readonly limitBytes: number,
  ) {}

  feed(chunk: Buffer) {
    if (this.usesTty) {
      this.keep(chunk);
      return;
    }
    this.frames.feed(chunk);
  }

  text(): string {
    return Buffer.concat(this.tail).subarray(-this.limitBytes).toString();
  }

  private keep(payload: Buffer) {
    if (payload.length === 0) {
      return;
    }
    // Only the newest bytes of a very large payload can matter.
    const newest = payload.length > this.limitBytes ? payload.subarray(-this.limitBytes) : payload;
    this.tail.push(Buffer.from(newest));
    this.tailBytes += newest.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= this.limitBytes) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }
}

/** A command's output as it streams in: what it printed and what it complained of, apart, each to its first bytes. */
export class CommandOutput {
  private readonly frames = new FrameSplitter((stream, payload) => this.keep(stream, payload));
  private readonly kept = new Map<number, { chunks: Buffer[]; bytes: number }>();
  // Some of what it printed did not fit.
  truncated = false;

  constructor(private readonly limitBytes: number) {}

  feed(chunk: Buffer) {
    this.frames.feed(chunk);
  }

  stdout(): string {
    return this.textOf(DOCKER_STREAM.stdout);
  }

  stderr(): string {
    return this.textOf(DOCKER_STREAM.stderr);
  }

  private textOf(stream: number): string {
    return Buffer.concat(this.kept.get(stream)?.chunks ?? []).toString();
  }

  private keep(stream: number, payload: Buffer) {
    const kept = this.kept.get(stream) ?? { chunks: [], bytes: 0 };
    this.kept.set(stream, kept);
    const room = this.limitBytes - kept.bytes;
    if (payload.length > room) {
      this.truncated = true;
    }
    const fitting = payload.subarray(0, Math.max(0, room));
    kept.chunks.push(Buffer.from(fitting));
    kept.bytes += fitting.length;
  }
}
