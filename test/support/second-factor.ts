import type { TotpEnabledView, TotpSetupView } from "../../src/shared/api.js";
import { API_ROUTES } from "../../src/shared/api.js";
import { base32Decode, hotp, totpStep } from "../../src/control-plane/auth/totp.js";
import type { TestClient, TestControlPlane } from "./control-plane.js";

export const currentCode = (secret: string, now: number, offsetSteps = 0) =>
  hotp(base32Decode(secret), totpStep(now) + offsetSteps);

export const NEW_ADMIN_PASSWORD = "tangerine-orbit-quietly";

/** Walks the first-run admin through password change and TOTP enrolment to full access. */
export async function fullySignedInAdmin(controlPlane: TestControlPlane): Promise<{
  client: TestClient;
  secret: string;
  recoveryCodes: string[];
  backupPassphrase: string | null;
}> {
  const firstPassword = await controlPlane.firstAdminPassword();
  const client = controlPlane.client();
  await client.signIn("admin", firstPassword);
  await client.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_ADMIN_PASSWORD });
  const { secret } = (await client.post(API_ROUTES.totpSetup)).json<TotpSetupView>();
  const confirm = await client.post(API_ROUTES.totpConfirm, { code: currentCode(secret, controlPlane.clock.now) });
  const { recoveryCodes, backupPassphrase } = confirm.json<TotpEnabledView>();
  return { client, secret, recoveryCodes, backupPassphrase };
}

/** An admin creates the account; the new user signs in and completes password change and TOTP. */
export async function fullySignedInUser(
  controlPlane: TestControlPlane,
  admin: TestClient,
  username: string,
  role: "admin" | "viewer",
): Promise<{ client: TestClient; userId: string; password: string; secret: string }> {
  const created = (await admin.post(API_ROUTES.users, { username, role })).json<{
    account: { id: string };
    temporaryPassword: string;
  }>();
  const password = "quietly-orbiting-tangerine-42";
  const client = controlPlane.client();
  await client.signIn(username, created.temporaryPassword);
  await client.post(API_ROUTES.changePassword, { currentPassword: created.temporaryPassword, newPassword: password });
  const { secret } = (await client.post(API_ROUTES.totpSetup)).json<TotpSetupView>();
  await client.post(API_ROUTES.totpConfirm, { code: currentCode(secret, controlPlane.clock.now) });
  return { client, userId: created.account.id, password, secret };
}
