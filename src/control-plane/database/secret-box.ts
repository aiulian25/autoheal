import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { SECRET_BOX } from "../../shared/constants.js";

export const isSealed = (value: string) => value.startsWith(SECRET_BOX.prefix);

/**
 * Seals the secrets the database keeps with AES-256-GCM, under a key scrypt makes from the backup passphrase. A copied
 * database file gives them away only with the passphrase, and a backup's secrets open wherever its passphrase is known.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromPassphrase(passphrase: string): SecretBox {
    const key = scryptSync(passphrase, SECRET_BOX.salt, SECRET_BOX.keyBytes, {
      N: SECRET_BOX.scryptCost,
      r: SECRET_BOX.scryptBlockSize,
      p: SECRET_BOX.scryptParallelism,
      maxmem: SECRET_BOX.scryptMemoryLimitBytes,
    });
    return new SecretBox(key);
  }

  seal(plain: string): string {
    const nonce = randomBytes(SECRET_BOX.nonceBytes);
    const cipher = createCipheriv(SECRET_BOX.cipher, this.key, nonce, { authTagLength: SECRET_BOX.tagBytes });
    const sealed = Buffer.concat([nonce, cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${SECRET_BOX.prefix}${sealed.toString("base64url")}`;
  }

  /** The secret, or null when this key did not seal the value: another passphrase, plain text, or an altered value. */
  open(value: string): string | null {
    if (!isSealed(value)) {
      return null;
    }
    const sealed = Buffer.from(value.slice(SECRET_BOX.prefix.length), "base64url");
    if (sealed.length < SECRET_BOX.nonceBytes + SECRET_BOX.tagBytes) {
      return null;
    }
    const tagStart = sealed.length - SECRET_BOX.tagBytes;
    const nonce = sealed.subarray(0, SECRET_BOX.nonceBytes);
    const decipher = createDecipheriv(SECRET_BOX.cipher, this.key, nonce, { authTagLength: SECRET_BOX.tagBytes });
    decipher.setAuthTag(sealed.subarray(tagStart));
    try {
      const plain = Buffer.concat([
        decipher.update(sealed.subarray(SECRET_BOX.nonceBytes, tagStart)),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch {
      return null;
    }
  }
}
