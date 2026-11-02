import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { BackupManifest } from "../shared/container-backups.js";

const SEAL_KEY_BYTES = 32;
const SEAL_ALGORITHM = "sha256";
// Keeps this use of the backup's key apart from any other.
const SEAL_PURPOSE = "autoheal-container-backup-manifest";

// One text for one manifest, whatever order its fields were written in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const fields = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .toSorted(([one], [other]) => (one < other ? -1 : 1));
  return `{${fields.map(([name, field]) => `${JSON.stringify(name)}:${canonical(field)}`).join(",")}}`;
}

/**
 * Ties a backup's manifest to its own key. That key is sealed with the backup passphrase, which only the dashboard
 * holds, so whoever can change files in the backup folder can change the manifest but cannot make this match it.
 */
export function manifestSeal(manifest: BackupManifest, identity: string): string {
  const { seal: _seal, ...sealed } = manifest;
  const key = hkdfSync(SEAL_ALGORITHM, identity, "", SEAL_PURPOSE, SEAL_KEY_BYTES);
  return createHmac(SEAL_ALGORITHM, Buffer.from(key)).update(canonical(sealed)).digest("hex");
}

export function manifestSealMatches(manifest: BackupManifest, identity: string): boolean {
  if (manifest.seal === undefined) return false;
  const expected = Buffer.from(manifestSeal(manifest, identity), "hex");
  const stored = Buffer.from(manifest.seal, "hex");
  return stored.length === expected.length && timingSafeEqual(stored, expected);
}
