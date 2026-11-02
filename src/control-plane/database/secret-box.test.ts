import { describe, expect, it } from "vitest";
import { SECRET_BOX } from "../../shared/constants.js";
import { SecretBox, isSealed } from "./secret-box.js";

const PASSPHRASE = "a-backup-passphrase-made-of-forty-four-chars";
const OTHER_PASSPHRASE = "another-backup-passphrase-of-forty-four-char";
const SEED = "JBSWY3DPEHPK3PXP";

describe("the box stored secrets are sealed in", () => {
  const box = SecretBox.fromPassphrase(PASSPHRASE);

  it("seals to its own format, never showing the secret, and opens it again", () => {
    const sealed = box.seal(SEED);
    expect(sealed.startsWith(SECRET_BOX.prefix)).toBe(true);
    expect(sealed).not.toContain(SEED);
    expect(isSealed(sealed)).toBe(true);
    expect(box.open(sealed)).toBe(SEED);
  });

  it("seals the same secret differently each time", () => {
    expect(box.seal(SEED)).not.toBe(box.seal(SEED));
  });

  it("opens what the same passphrase sealed in another process, and nothing another passphrase sealed", () => {
    const sealed = box.seal(SEED);
    expect(SecretBox.fromPassphrase(PASSPHRASE).open(sealed)).toBe(SEED);
    expect(SecretBox.fromPassphrase(OTHER_PASSPHRASE).open(sealed)).toBeNull();
  });

  it("opens nothing altered, cut short or never sealed", () => {
    const sealed = box.seal(SEED);
    const bytes = Buffer.from(sealed.slice(SECRET_BOX.prefix.length), "base64url");
    bytes[SECRET_BOX.nonceBytes] = bytes[SECRET_BOX.nonceBytes]! ^ 1;
    expect(box.open(`${SECRET_BOX.prefix}${bytes.toString("base64url")}`)).toBeNull();
    expect(box.open(sealed.slice(0, SECRET_BOX.prefix.length + SECRET_BOX.nonceBytes))).toBeNull();
    expect(box.open(SEED)).toBeNull();
    expect(isSealed(SEED)).toBe(false);
  });
});
