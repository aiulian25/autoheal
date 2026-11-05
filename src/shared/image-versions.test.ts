import { describe, expect, it } from "vitest";
import { isNewerTag, isVersionTag, newerTags } from "./image-versions.js";

describe("newer tags of any image, knowing nothing of it", () => {
  it.each([
    ["1.2.0", ["1.1.9", "1.2.0", "1.2.1", "1.10.0", "latest"], ["1.10.0", "1.2.1"]],
    ["v1.2.3", ["v1.4.0", "1.5.0", "v1.2.2"], ["v1.4.0"]],
    ["16-alpine", ["16", "17", "17-alpine", "15-alpine", "17-bookworm"], ["17-alpine"]],
    [
      "2.7.0.5723-ls166",
      ["2.7.0.5723-ls167", "2.8.1.5800-ls170", "2.7.0.5723"],
      ["2.8.1.5800-ls170", "2.7.0.5723-ls167"],
    ],
    ["2024.05.01", ["2024.06.12", "2023.12.31"], ["2024.06.12"]],
    ["1.2", ["1.3", "1.3.0", "2.0"], ["2.0", "1.3"]],
    ["3.12-alpine3.19", ["3.13-alpine3.20", "3.12-slim", "3.13"], ["3.13-alpine3.20"]],
  ])("%s, among %j, has %j", (current, tags, expected) => {
    expect(newerTags(current, tags)).toEqual(expected);
  });

  it("keeps a stable line away from prereleases, and a prerelease on its own", () => {
    expect(newerTags("1.2.0", ["1.3.0-rc1", "1.3.0-beta.2"])).toEqual([]);
    expect(newerTags("1.3.0-rc1", ["1.3.0-rc2", "1.3.0"])).toEqual(["1.3.0-rc2"]);
  });

  it("offers nothing for a tag that is no version: a channel name or a commit", () => {
    expect(newerTags("latest", ["1.0.0", "2.0.0"])).toEqual([]);
    expect(newerTags("sha-a1b2c3d", ["sha-a1b2c3e"])).toEqual([]);
    expect(newerTags("1.0.0", ["9f8e7d6c5b"])).toEqual([]);
  });

  it("compares numbers too long for a plain number exactly", () => {
    expect(newerTags("20240101123045678901", ["20240101123045678902"])).toEqual(["20240101123045678902"]);
  });

  it("answers for one candidate", () => {
    expect(isNewerTag("1.2.0", "1.2.1")).toBe(true);
    expect(isNewerTag("1.2.1", "1.2.0")).toBe(false);
    expect(isNewerTag("latest", "1.2.0")).toBe(false);
    expect([isVersionTag("1.2.0"), isVersionTag("16-alpine"), isVersionTag("latest")]).toEqual([true, true, false]);
  });
});
