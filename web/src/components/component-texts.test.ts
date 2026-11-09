import { describe, expect, it } from "vitest";

// A sentence a person reads, written in a component instead of in TEXT: between tags, or quoted.
const BETWEEN_TAGS = /(?<![=\-])>\s*[A-Z][a-z]+(?: [a-z,.'’]+){2,}[^<{}]*<\//;
const QUOTED = /"[A-Z][a-z]+(?: [a-z,.'’]+){3,}[^"]*"/;

describe("what the components say", () => {
  it("is written in the constants file, never inline in a component", () => {
    const sources = import.meta.glob<string>(["./*.tsx", "!./*.test.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const inline = Object.entries(sources).flatMap(([path, source]) =>
      source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
        .filter((line) => BETWEEN_TAGS.test(line) || QUOTED.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    expect(inline).toEqual([]);
  });
});
