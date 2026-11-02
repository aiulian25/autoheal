// bcrypt-pbkdf ships no types: the one function OpenSSH's key format needs, as ssh2 calls it. 0 on success.
declare module "bcrypt-pbkdf" {
  const bcryptPbkdf: {
    pbkdf(
      passphrase: Uint8Array,
      passphraseLength: number,
      salt: Uint8Array,
      saltLength: number,
      key: Uint8Array,
      keyLength: number,
      rounds: number,
    ): number;
  };
  export default bcryptPbkdf;
}
