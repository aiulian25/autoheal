import { expect, type Page } from "@playwright/test";
import { base32Decode, hotp, totpStep } from "../../src/control-plane/auth/totp.js";

// A code from a step that was not used yet: the server refuses a replayed code.
export const usedSteps = new Map<string, number>();
export async function freshCode(secret: string): Promise<string> {
  while (totpStep(Date.now()) <= (usedSteps.get(secret) ?? -1)) {
    await new Promise((done) => setTimeout(done, 1_000));
  }
  const step = totpStep(Date.now());
  usedSteps.set(secret, step);
  return hotp(base32Decode(secret), step);
}

/**
 * Password change and TOTP enrolment for a first sign-in. Returns the TOTP secret, and the backup
 * passphrase when this sign-in was shown it (the first admin only).
 */
export async function completeFirstSignIn(page: Page, username: string, oneTimePassword: string, newPassword: string) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(oneTimePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("Current password").fill(oneTimePassword);
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("New password again").fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("heading", { name: "Set up two-step sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Show the code" }).click();
  await expect(page.locator("img.qr")).toBeVisible();
  const secret = (await page.locator("span.secret").textContent())!.trim();
  await page.getByLabel("6-digit code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await expect(page.locator("pre.secret").first()).toContainText(/[A-Z2-7]{5}-[A-Z2-7]{5}/);
  const passphraseShown = await page.getByRole("heading", { name: "And the backup passphrase" }).isVisible();
  const passphrase = passphraseShown ? (await page.locator("pre.secret").nth(1).textContent())!.trim() : null;
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByRole("heading", { name: "Attention", level: 1 })).toBeVisible();
  return { secret, passphrase };
}

export async function signIn(page: Page, username: string, password: string, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Two-step check" })).toBeVisible();
  await page.getByLabel("Code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Attention", level: 1 })).toBeVisible();
}
