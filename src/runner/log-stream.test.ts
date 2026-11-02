import { describe, expect, it } from "vitest";
import { LogStreamTail } from "./log-stream.js";

const frame = (stream: number, text: string) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const collect = (chunks: Buffer[], usesTty = false, limit = 1_024) => {
  const tail = new LogStreamTail(usesTty, limit);
  for (const chunk of chunks) {
    tail.feed(chunk);
  }
  return tail.text();
};

describe("LogStreamTail", () => {
  it("joins stdout and stderr frames without their headers", () => {
    const raw = Buffer.concat([frame(1, "started\n"), frame(2, "error: no key\n")]);
    expect(collect([raw])).toBe("started\nerror: no key\n");
  });

  it("parses frames however the bytes are chunked, including a header split in two", () => {
    const raw = Buffer.concat([frame(1, "one\n"), frame(2, "two\n"), frame(1, "three\n")]);
    const chunks = [raw.subarray(0, 3), raw.subarray(3, 13), raw.subarray(13, 14), raw.subarray(14)];
    expect(collect(chunks)).toBe("one\ntwo\nthree\n");
  });

  it("ignores a truncated trailing header", () => {
    expect(collect([frame(1, "ok\n"), Buffer.from([1, 0, 0])])).toBe("ok\n");
  });

  it("passes TTY output through untouched", () => {
    expect(collect([Buffer.from("raw "), Buffer.from("tty")], true)).toBe("raw tty");
  });

  it("keeps only the newest bytes, even inside one enormous frame", () => {
    const huge = `${"x".repeat(100_000)}NEWEST`;
    const text = collect([frame(1, "old\n"), frame(1, huge)], false, 64);
    expect(text).toHaveLength(64);
    expect(text.endsWith("NEWEST")).toBe(true);
    expect(text).not.toContain("old");
  });
});
