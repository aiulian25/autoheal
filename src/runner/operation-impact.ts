import { sha256Hex } from "../shared/hash.js";
/** Fingerprint the exact coordinator keys; public labels never disclose a future path-based key. */
export const operationFingerprint = (resources: readonly string[]) =>
  sha256Hex(JSON.stringify([...new Set(resources)].sort()));
export const publicOperationResources = (resources: readonly string[]) =>
  [...new Set(resources)].sort().map((key) => `resource-${sha256Hex(key).slice(0, 16)}`);
export const OPERATION_SCOPE_CHANGED =
  "The reviewed operation scope changed. No new operation was started; review the affected containers again.";
