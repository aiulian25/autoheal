import { hash, verify } from "@node-rs/argon2";
import { ARGON2_OPTIONS } from "../../shared/constants.js";

export const hashPassword = (password: string) => hash(password, ARGON2_OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
