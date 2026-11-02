import { Decrypter, Encrypter } from "age-encryption";
import { BACKUP_SCRYPT_WORK_FACTOR } from "../../shared/constants.js";

/**
 * age in passphrase mode: symmetric, so only the passphrase holder can make a file that decrypts.
 * That is also what keeps a forged "backup" out of a restore. Readable with the standard
 * `age -d` when the app itself cannot start.
 */
export function encryptBackup(plain: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  encrypter.setScryptWorkFactor(BACKUP_SCRYPT_WORK_FACTOR);
  return encrypter.encrypt(plain);
}

export function decryptBackup(encrypted: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(passphrase);
  return decrypter.decrypt(encrypted);
}
