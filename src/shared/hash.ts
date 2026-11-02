import { createHash, type KeyObject } from "node:crypto";
import {
  HASH_ALGORITHM,
  HASH_ENCODING,
  PUBLIC_KEY_EXPORT,
  PUBLIC_KEY_PIN_DIGEST,
  PUBLIC_KEY_PIN_ENCODING,
} from "./constants.js";

/** The SHA-256 of text or bytes, as lowercase hex: token and code hashes, prompt and file fingerprints. */
export const sha256Hex = (data: string | Uint8Array) => createHash(HASH_ALGORITHM).update(data).digest(HASH_ENCODING);

/** What a runner knows the control plane by: the SHA-256 of its certificate's public key. */
export const publicKeyPin = (key: KeyObject) =>
  createHash(PUBLIC_KEY_PIN_DIGEST).update(key.export(PUBLIC_KEY_EXPORT)).digest(PUBLIC_KEY_PIN_ENCODING);
