import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every temporary folder a test makes (databases, backups, sockets) lands under one root that is
 * removed when the run ends. The test processes start after this, so they inherit TMPDIR.
 */
export default function useTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "autoheal-tests-"));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true });
}
