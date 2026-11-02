import { readFileSync } from "node:fs";
import { APP_VERSION, BUILD_ID_FILE } from "./constants.js";

function buildId(): string | null {
  try {
    return readFileSync(new URL(`../${BUILD_ID_FILE}`, import.meta.url), "utf8").trim();
  } catch {
    return null;
  }
}

const id = buildId();

/** This build's version, telling apart builds of one release: runner hosts run their own copy of the code. */
export const RUNNING_VERSION = id === null || id === "" ? APP_VERSION : `${APP_VERSION}+${id}`;
