import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { describe, expect, it } from "vitest";
import { makeKey, readUserKey } from "./ssh-keys.js";
import { sshFingerprint } from "./ssh-session.js";

const PASSPHRASE = "the user's own passphrase";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";

// ssh2's generator makes an unreadable ed25519 key about once in 200, so each test key is read back first.
function readable(make: () => { private: string; public: string }, passphrase?: string) {
  for (;;) {
    const pair = make();
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
  }
}

const blobOf = (publicLine: string) => Buffer.from(publicLine.split(" ")[1]!, "base64");

describe("the user's own SSH keys", () => {
  it("reads ed25519, ECDSA and RSA keys, with or without a passphrase, and says which key each is", () => {
    const keys = [
      { type: "ssh-ed25519", pair: readable(() => utils.generateKeyPairSync("ed25519", { comment: "alex@mini" })) },
      {
        type: "ecdsa-sha2-nistp256",
        pair: readable(
          () => utils.generateKeyPairSync("ecdsa", { bits: 256, passphrase: PASSPHRASE, cipher: "aes256-ctr" }),
          PASSPHRASE,
        ),
        passphrase: PASSPHRASE,
      },
      {
        type: "ssh-rsa",
        pair: readable(
          () => utils.generateKeyPairSync("rsa", { bits: 2048, passphrase: PASSPHRASE, cipher: "aes256-cbc" }),
          PASSPHRASE,
        ),
        passphrase: PASSPHRASE,
      },
    ];
    for (const { type, pair, passphrase } of keys) {
      const read = readUserKey(pair.private, passphrase ?? null);
      expect(read.publicLine.startsWith(`${type} ${pair.public.split(" ")[1]}`)).toBe(true);
      expect(read.fingerprint).toBe(sshFingerprint(blobOf(pair.public)));
      expect(read.passphrase).toBe(passphrase ?? null);
    }
    // A passphrase typed for a key without one is not kept.
    const plain = keys[0]!.pair;
    expect(readUserKey(plain.private, "typed anyway")).toMatchObject({ passphrase: null });
    expect(readUserKey(plain.private, null).publicLine.endsWith(" alex@mini")).toBe(true);
  });

  it("refuses a wrong passphrase, a public key, and what is not a key at all", () => {
    const rsa = readable(
      () => utils.generateKeyPairSync("rsa", { bits: 2048, passphrase: PASSPHRASE, cipher: "aes256-cbc" }),
      PASSPHRASE,
    );
    expect(() => readUserKey(rsa.private, "not it")).toThrow("ssh_key_unreadable");
    expect(() => readUserKey(rsa.private, null)).toThrow("ssh_key_unreadable");
    expect(() => readUserKey(rsa.public, null)).toThrow("ssh_key_not_private");
    expect(() => readUserKey("hello", null)).toThrow("ssh_key_unreadable");
  });
});

describe("a key Autoheal makes", () => {
  it("is an OpenSSH ed25519 key that reads back, named for where it is used", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const made = makeKey("cedar2");
      expect(made.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
      const read = readUserKey(made.privateKey, null);
      expect(read).toEqual({ publicLine: made.publicLine, fingerprint: made.fingerprint, passphrase: null });
      expect(made.publicLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{68} autoheal@cedar2$/);
    }
  });

  it("is encrypted with the passphrase given, as ssh-keygen encrypts one: opened by it alone", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const made = makeKey("cedar2", PASSPHRASE);
      expect(readUserKey(made.privateKey, PASSPHRASE)).toEqual({
        publicLine: made.publicLine,
        fingerprint: made.fingerprint,
        passphrase: PASSPHRASE,
      });
      expect(() => readUserKey(made.privateKey, "not it")).toThrow();
      expect(() => readUserKey(made.privateKey, null)).toThrow();
    }
  });

  // OpenSSH itself reads the file the person downloads: the same public key with the passphrase, nothing without.
  it.skipIf(!existsSync(SSH_KEYGEN))("opens in OpenSSH's own ssh-keygen with the passphrase, and not without", () => {
    const made = makeKey("cedar2", PASSPHRASE);
    const folder = mkdtempSync(join(tmpdir(), "autoheal-made-key-"));
    const file = join(folder, "id_ed25519");
    writeFileSync(file, made.privateKey, { mode: 0o600 });
    try {
      const publicLine = execFileSync(SSH_KEYGEN, ["-y", "-P", PASSPHRASE, "-f", file]).toString().trim();
      expect(publicLine).toBe(made.publicLine);
      expect(() => execFileSync(SSH_KEYGEN, ["-y", "-P", "", "-f", file], { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
