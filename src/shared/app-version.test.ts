import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { APP_VERSION } from "./constants.js";

it("names the release this is, as package.json has it", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  expect(APP_VERSION).toBe(manifest.version);
});
