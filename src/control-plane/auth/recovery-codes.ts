import { randomInt } from "node:crypto";
import { sha256Hex } from "../../shared/hash.js";
import {
  BASE32_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_GROUP_LENGTH,
  RECOVERY_CODE_IGNORED,
  RECOVERY_CODE_SEPARATOR,
} from "../../shared/constants.js";

const randomGroup = () =>
  Array.from({ length: RECOVERY_CODE_GROUP_LENGTH }, () => BASE32_ALPHABET[randomInt(BASE32_ALPHABET.length)]).join("");

/** Ten one-use codes for a lost phone, shown once; like XXXXX-XXXXX, 50 random bits each. */
export const generateRecoveryCodes = () =>
  Array.from({ length: RECOVERY_CODE_COUNT }, () => `${randomGroup()}${RECOVERY_CODE_SEPARATOR}${randomGroup()}`);

// Random enough that a fast hash is fine; people may type them with spaces or lower case.
export const hashRecoveryCode = (code: string) => sha256Hex(code.toUpperCase().replace(RECOVERY_CODE_IGNORED, ""));
