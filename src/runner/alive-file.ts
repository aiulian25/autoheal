import { statSync, writeFileSync } from "node:fs";

/** The runner has no port to probe, so it proves it is alive by touching a file in /tmp. */
export const touchAliveFile = (path: string, now: number) => writeFileSync(path, String(now));

export function aliveFileAge(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
