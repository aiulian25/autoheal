import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import bcryptPbkdf from "bcrypt-pbkdf";
import ssh2, { type ParsedKey } from "ssh2";
import { API_ERRORS } from "../../shared/api.js";
import { SSH_KEY } from "../../shared/constants.js";
import { DomainError } from "../domain-error.js";
import { sshFingerprint } from "./ssh-session.js";

// ssh2 is CommonJS: Node's ES module loader sees `Client` among its named exports, but not `utils`.
const { utils } = ssh2;

/** A private key read and checked: what to store, and how to show which key it is. */
export interface ReadKey {
  publicLine: string;
  fingerprint: string;
  // Null when the key is not encrypted, whatever was typed.
  passphrase: string | null;
}

export interface MadeKey {
  privateKey: string;
  publicLine: string;
  fingerprint: string;
}

// OpenSSH's own private key format, as `ssh-keygen` writes it: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
const OPENSSH = {
  magic: "openssh-key-v1\0",
  none: "none",
  // With a passphrase, as ssh-keygen encrypts one: bcrypt's key derivation, then AES-256 in counter mode.
  cipher: "aes256-ctr",
  nodeCipher: "aes-256-ctr",
  kdf: "bcrypt",
  saltBytes: 16,
  rounds: 16,
  keyBytes: 32,
  ivBytes: 16,
  encryptedBlockBytes: 16,
  keyType: "ssh-ed25519",
  begin: "-----BEGIN OPENSSH PRIVATE KEY-----",
  end: "-----END OPENSSH PRIVATE KEY-----",
  lineCharacters: 70,
  blockBytes: 8,
  checkBytes: 4,
} as const;

const sshString = (value: Buffer | string) => {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

// A file of several keys gives the first, as ssh-keygen reads one.
function single(result: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
  return Array.isArray(result) ? (result[0] ?? new Error(API_ERRORS.sshKeyUnreadable)) : result;
}

/**
 * The user's own private key, checked before anything is stored: refused when it is a public key, of a type the
 * control plane does not sign with, or the passphrase does not open it.
 */
export function readUserKey(text: string, passphrase: string | null): ReadKey {
  const plain = single(utils.parseKey(text));
  const encrypted = plain instanceof Error;
  const key = encrypted ? single(utils.parseKey(text, passphrase ?? undefined)) : plain;
  if (key instanceof Error) {
    throw new DomainError(API_ERRORS.sshKeyUnreadable);
  }
  if (!key.isPrivateKey()) {
    throw new DomainError(API_ERRORS.sshKeyNotPrivate);
  }
  if (!(SSH_KEY.types as readonly string[]).includes(key.type)) {
    throw new DomainError(API_ERRORS.sshKeyUnsupported);
  }
  const blob = key.getPublicSSH();
  return {
    publicLine: [key.type, blob.toString("base64"), key.comment].filter(Boolean).join(" "),
    fingerprint: sshFingerprint(blob),
    passphrase: encrypted ? passphrase : null,
  };
}

// The key's private section as the file holds it, and how it is encrypted: not at all without a passphrase, else with
// the key and IV OpenSSH derives from the passphrase and a fresh salt.
function encryptionOf(section: Buffer, passphrase: string | null) {
  if (passphrase === null) {
    return { cipher: OPENSSH.none, kdf: OPENSSH.none, options: Buffer.alloc(0), section };
  }
  const secret = Buffer.from(passphrase);
  const salt = randomBytes(OPENSSH.saltBytes);
  const bytes = Buffer.alloc(OPENSSH.keyBytes + OPENSSH.ivBytes);
  const failed = bcryptPbkdf.pbkdf(secret, secret.length, salt, salt.length, bytes, bytes.length, OPENSSH.rounds);
  if (failed !== 0) throw new Error(SSH_KEY.passphraseFailed);
  const cipher = createCipheriv(
    OPENSSH.nodeCipher,
    bytes.subarray(0, OPENSSH.keyBytes),
    bytes.subarray(OPENSSH.keyBytes),
  );
  return {
    cipher: OPENSSH.cipher,
    kdf: OPENSSH.kdf,
    options: Buffer.concat([sshString(salt), uint32(OPENSSH.rounds)]),
    section: Buffer.concat([cipher.update(section), cipher.final()]),
  };
}

/**
 * A new ed25519 key for a user who has none, in OpenSSH's own format: encrypted with the passphrase given, as
 * ssh-keygen would, or unencrypted without one (it is stored sealed either way).
 */
export function makeKey(label: string, passphrase: string | null = null): MadeKey {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d!, "base64url");
  const publicKey = Buffer.from(jwk.x!, "base64url");
  const comment = SSH_KEY.madeComment(label);
  const blob = Buffer.concat([sshString(OPENSSH.keyType), sshString(publicKey)]);
  const check = randomBytes(OPENSSH.checkBytes);
  const unpadded = Buffer.concat([
    check,
    check,
    sshString(OPENSSH.keyType),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(comment),
  ]);
  const blockBytes = passphrase === null ? OPENSSH.blockBytes : OPENSSH.encryptedBlockBytes;
  const paddingLength = (blockBytes - (unpadded.length % blockBytes)) % blockBytes;
  const padding = Buffer.from(Array.from({ length: paddingLength }, (_each, index) => index + 1));
  const encryption = encryptionOf(Buffer.concat([unpadded, padding]), passphrase);
  const body = Buffer.concat([
    Buffer.from(OPENSSH.magic),
    sshString(encryption.cipher),
    sshString(encryption.kdf),
    sshString(encryption.options),
    uint32(1),
    sshString(blob),
    sshString(encryption.section),
  ]).toString("base64");
  const lines = body.match(new RegExp(`.{1,${OPENSSH.lineCharacters}}`, "g")) ?? [];
  return {
    privateKey: [OPENSSH.begin, ...lines, OPENSSH.end, ""].join("\n"),
    publicLine: `${OPENSSH.keyType} ${blob.toString("base64")} ${comment}`,
    fingerprint: sshFingerprint(blob),
  };
}
