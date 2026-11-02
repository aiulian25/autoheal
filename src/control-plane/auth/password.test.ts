import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password-hashing.js";
import { passwordProblems } from "./password-policy.js";

describe("password hashing", () => {
  it("stores Argon2id with the configured cost, never the password itself", async () => {
    const password = "a long and unusual passphrase";
    const hashed = await hashPassword(password);
    expect(hashed.startsWith("$argon2id$v=19$m=65536,t=3,p=1$")).toBe(true);
    expect(hashed).not.toContain(password);
    expect(await verifyPassword(hashed, password)).toBe(true);
    expect(await verifyPassword(hashed, `${password}!`)).toBe(false);
  });

  it("treats a corrupt hash as a failed login rather than a crash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});

describe("password policy", () => {
  it("accepts a long, uncommon password", () => {
    expect(passwordProblems("tangerine-orbit-quietly", "admin")).toEqual([]);
  });

  it.each([
    ["short1", "must be at least 12 characters"],
    ["x".repeat(129), "must be at most 128 characters"],
    ["Password1234", "is one of the most common passwords"],
    ["my-admin-passphrase", "must not contain the username"],
    ["zzzzzzzzzzzzzz", "must not be one character repeated"],
  ])("rejects %s", (password, problem) => {
    expect(passwordProblems(password, "admin")).toContain(problem);
  });
});
