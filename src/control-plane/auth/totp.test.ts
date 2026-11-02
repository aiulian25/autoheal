import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  explainTotpFailure,
  generateTotpSecret,
  hotp,
  matchTotp,
  normalizeTotpCode,
  otpauthUri,
  totpStep,
} from "./totp.js";

const RFC_SECRET = Buffer.from("12345678901234567890");

describe("TOTP", () => {
  it("encodes base32 like RFC 4648", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").equals(RFC_SECRET)).toBe(true);
    expect(base32Decode(base32Encode(Buffer.from([1, 2, 3]))).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches the RFC 6238 SHA-1 test vector at %i seconds", (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(expected);
  });

  it("accepts one step of clock drift either way, not two", () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 9, 20, 12);
    const codeAt = (offsetSteps: number) => hotp(base32Decode(secret), totpStep(now) + offsetSteps);
    expect(matchTotp(secret, codeAt(-1), now, null)).toBe(totpStep(now) - 1);
    expect(matchTotp(secret, codeAt(1), now, null)).toBe(totpStep(now) + 1);
    expect(matchTotp(secret, codeAt(2), now, null)).toBeNull();
    expect(matchTotp(secret, codeAt(-2), now, null)).toBeNull();
  });

  it("refuses a code from a step already used", () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 9, 20, 12);
    const code = hotp(base32Decode(secret), totpStep(now));
    expect(matchTotp(secret, code, now, totpStep(now))).toBeNull();
    expect(matchTotp(secret, code, now, totpStep(now) - 1)).toBe(totpStep(now));
  });

  it("reads a code the way apps show it", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode(" 123-456 ")).toBe("123456");
  });

  it("says why a code failed: used already, a clock that is off, or no match near now", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = Date.UTC(2026, 9, 21, 8, 3, 43);
    const codeAt = (offsetSteps: number) => hotp(RFC_SECRET, totpStep(now) + offsetSteps);
    expect(explainTotpFailure(secret, codeAt(0), now)).toEqual({ reason: "already_used" });
    expect(explainTotpFailure(secret, codeAt(3), now)).toEqual({ reason: "clock", offsetSeconds: 90 });
    expect(explainTotpFailure(secret, codeAt(-4), now)).toEqual({ reason: "clock", offsetSeconds: -120 });
    const near = new Set(Array.from({ length: 21 }, (_, index) => codeAt(index - 10)));
    const elsewhere = [50, 51, 52].map(codeAt).find((code) => !near.has(code))!;
    expect(explainTotpFailure(secret, elsewhere, now)).toEqual({ reason: "no_match" });
  });

  it("builds a URI authenticator apps can scan, with the logo for those that show one", () => {
    const logo = "https://autoheal.home.lan/brand/autoheal-512.png";
    const uri = new URL(otpauthUri("admin@autoheal.home.lan", "JBSWY3DPEHPK3PXP", logo));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/Autoheal:admin@autoheal.home.lan");
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "Autoheal",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
      image: logo,
    });
  });
});
