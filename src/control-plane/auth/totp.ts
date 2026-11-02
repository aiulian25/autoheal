import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BASE32_ALPHABET,
  BITS_PER_BASE32_CHARACTER,
  BITS_PER_BYTE,
  DECIMAL_BASE,
  HOTP_CODE_MASK,
  HOTP_COUNTER_BYTES,
  HOTP_DYNAMIC_OFFSET_MASK,
  MILLISECONDS_PER_SECOND,
  TOTP_ALGORITHM,
  TOTP_ALLOWED_DRIFT_STEPS,
  TOTP_CODE_SEPARATORS,
  TOTP_DIAGNOSIS_STEPS,
  TOTP_DIGITS,
  TOTP_FAILURE,
  TOTP_ACCOUNT_HOST_SEPARATOR,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
} from "../../shared/constants.js";

export type TotpFailure =
  | { reason: typeof TOTP_FAILURE.alreadyUsed }
  | { reason: typeof TOTP_FAILURE.clock; offsetSeconds: number }
  | { reason: typeof TOTP_FAILURE.noMatch };

const BASE32_CHARACTER_MASK = (1 << BITS_PER_BASE32_CHARACTER) - 1;
const BYTE_MASK = (1 << BITS_PER_BYTE) - 1;

/** RFC 4648 base32 without padding, the format authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_BASE32_CHARACTER) {
      output += BASE32_ALPHABET[(value >>> (bits - BITS_PER_BASE32_CHARACTER)) & BASE32_CHARACTER_MASK];
      bits -= BITS_PER_BASE32_CHARACTER;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (BITS_PER_BASE32_CHARACTER - bits)) & BASE32_CHARACTER_MASK];
  }
  return output;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text.toUpperCase()) {
    value = (value << BITS_PER_BASE32_CHARACTER) | BASE32_ALPHABET.indexOf(character);
    bits += BITS_PER_BASE32_CHARACTER;
    if (bits >= BITS_PER_BYTE) {
      bytes.push((value >>> (bits - BITS_PER_BYTE)) & BYTE_MASK);
      bits -= BITS_PER_BYTE;
    }
  }
  return Buffer.from(bytes);
}

export const generateTotpSecret = () => base32Encode(randomBytes(TOTP_SECRET_BYTES));

/** RFC 4226 HOTP: the code for one counter value. */
export function hotp(key: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(HOTP_COUNTER_BYTES);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(TOTP_ALGORITHM, key).update(message).digest();
  const offset = digest[digest.length - 1]! & HOTP_DYNAMIC_OFFSET_MASK;
  const binary = digest.readUInt32BE(offset) & HOTP_CODE_MASK;
  return String(binary % DECIMAL_BASE ** digits).padStart(digits, "0");
}

export const totpStep = (milliseconds: number) =>
  Math.floor(milliseconds / MILLISECONDS_PER_SECOND / TOTP_PERIOD_SECONDS);

const sameCode = (first: string, second: string) =>
  first.length === second.length && timingSafeEqual(Buffer.from(first), Buffer.from(second));

/** "123 456" and "123-456", as apps show codes, become "123456". */
export const normalizeTotpCode = (code: string) => code.replace(TOTP_CODE_SEPARATORS, "");

/**
 * The time step the code belongs to, or null. A step at or before `lastUsedStep` is refused,
 * so a code seen over someone's shoulder cannot be used a second time.
 */
export function matchTotp(secret: string, code: string, now: number, lastUsedStep: number | null): number | null {
  const key = base32Decode(secret);
  const current = totpStep(now);
  for (let drift = -TOTP_ALLOWED_DRIFT_STEPS; drift <= TOTP_ALLOWED_DRIFT_STEPS; drift += 1) {
    const step = current + drift;
    const unused = lastUsedStep === null || step > lastUsedStep;
    if (unused && sameCode(hotp(key, step), code)) {
      return step;
    }
  }
  return null;
}

/**
 * Why a code `matchTotp` refused failed, so the person knows what to fix: it was used already, it
 * belongs to a time minutes away (a clock is off), or it matches nothing near now (another secret:
 * an old authenticator entry, or a typo).
 */
export function explainTotpFailure(secret: string, code: string, now: number): TotpFailure {
  const key = base32Decode(secret);
  const current = totpStep(now);
  for (let drift = -TOTP_DIAGNOSIS_STEPS; drift <= TOTP_DIAGNOSIS_STEPS; drift += 1) {
    if (!sameCode(hotp(key, current + drift), code)) {
      continue;
    }
    // In the window, matchTotp only refuses a step it has seen before.
    if (Math.abs(drift) <= TOTP_ALLOWED_DRIFT_STEPS) {
      return { reason: TOTP_FAILURE.alreadyUsed };
    }
    return { reason: TOTP_FAILURE.clock, offsetSeconds: drift * TOTP_PERIOD_SECONDS };
  }
  return { reason: TOTP_FAILURE.noMatch };
}

/** The entry's name in an authenticator app: the user and the dashboard's host, so instances differ. */
export const totpAccountName = (username: string, host: string) => `${username}${TOTP_ACCOUNT_HOST_SEPARATOR}${host}`;

/** `imageUrl`: the logo FreeOTP shows beside the entry; apps that don't know the parameter ignore it. */
export function otpauthUri(accountName: string, secret: string, imageUrl: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${accountName}`);
  const parameters = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: TOTP_ALGORITHM.toUpperCase(),
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
    image: imageUrl,
  });
  return `otpauth://totp/${label}?${parameters}`;
}
