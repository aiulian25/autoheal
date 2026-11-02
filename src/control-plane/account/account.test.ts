import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import {
  NEW_ADMIN_PASSWORD,
  currentCode,
  fullySignedInAdmin,
  fullySignedInUser,
} from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type OwnAccountView,
  type RecoveryCodesView,
  type TotpSetupView,
} from "../../shared/api.js";
import { TOTP_PERIOD_SECONDS } from "../../shared/constants.js";

const STEP_MILLISECONDS = TOTP_PERIOD_SECONDS * 1000;

describe("your own account", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let secret: string;
  let recoveryCodes: string[];

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    ({ client: admin, secret, recoveryCodes } = await fullySignedInAdmin(controlPlane));
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const nextStep = () => {
    controlPlane.clock.now += STEP_MILLISECONDS;
  };
  const account = async (client = admin) => (await client.get(API_ROUTES.account)).json<OwnAccountView>();
  const signedIn = async (username: string, password: string, code: string) => {
    const client = controlPlane.client();
    await client.signIn(username, password);
    return { client, verified: await client.post(API_ROUTES.secondFactor, { code }) };
  };
  const auditActions = () => controlPlane.stdout.join("");

  it("shows your name, your authenticator entry, the recovery codes left and where you are signed in", async () => {
    nextStep();
    const laptop = await signedIn("admin", NEW_ADMIN_PASSWORD, currentCode(secret, controlPlane.clock.now));
    expect(laptop.verified.statusCode).toBe(204);
    const view = await account();
    expect(view).toMatchObject({
      username: "admin",
      role: "admin",
      authenticatorName: "admin@localhost",
      recoveryCodesLeft: 10,
    });
    expect(view.sessions.map((session) => session.current).sort()).toEqual([false, true]);
    expect(view.sessions[0]!.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("renames you only with your password, and never to a name someone else has", async () => {
    await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const rename = (payload: object) => admin.request({ method: "PATCH", url: API_ROUTES.account, payload });
    expect((await rename({ username: "alex", currentPassword: "not-my-password" })).json()).toEqual({
      error: "wrong_password",
    });
    expect((await rename({ username: "Partner", currentPassword: NEW_ADMIN_PASSWORD })).json()).toEqual({
      error: "username_taken",
    });
    const renamed = await rename({ username: "alex", currentPassword: NEW_ADMIN_PASSWORD });
    expect(renamed.json<OwnAccountView>()).toMatchObject({ username: "alex", authenticatorName: "alex@localhost" });
    nextStep();
    expect(
      (await signedIn("alex", NEW_ADMIN_PASSWORD, currentCode(secret, controlPlane.clock.now))).verified.statusCode,
    ).toBe(204);
    expect(auditActions()).toContain('"action":"account.renamed"');
  });

  it("moves to a new authenticator with a current code, and keeps the old one until the new one is confirmed", async () => {
    expect((await admin.post(API_ROUTES.accountAuthenticator, { code: "000000" })).json()).toEqual({
      error: "wrong_code",
    });
    nextStep();
    const started = await admin.post(API_ROUTES.accountAuthenticator, {
      code: currentCode(secret, controlPlane.clock.now),
    });
    const moved = started.json<TotpSetupView>();
    expect(decodeURIComponent(new URL(moved.otpauthUri).pathname)).toBe("/Autoheal:admin@localhost");

    nextStep();
    // Not confirmed yet: the old entry still signs in.
    expect(
      (await signedIn("admin", NEW_ADMIN_PASSWORD, currentCode(secret, controlPlane.clock.now))).verified.statusCode,
    ).toBe(204);
    const confirmed = await admin.post(API_ROUTES.accountAuthenticatorConfirm, {
      code: currentCode(moved.secret, controlPlane.clock.now),
    });
    expect(confirmed.statusCode).toBe(204);

    nextStep();
    const withOld = await signedIn("admin", NEW_ADMIN_PASSWORD, currentCode(secret, controlPlane.clock.now));
    expect(withOld.verified.json()).toEqual({ error: "wrong_code" });
    const withNew = await signedIn("admin", NEW_ADMIN_PASSWORD, currentCode(moved.secret, controlPlane.clock.now));
    expect(withNew.verified.statusCode).toBe(204);
    expect(auditActions()).toContain('"action":"account.authenticator_moved"');
  });

  it("starts the move with a recovery code when the old phone is gone", async () => {
    const started = await admin.post(API_ROUTES.accountAuthenticator, { code: recoveryCodes[0] });
    expect(started.statusCode).toBe(200);
    expect((await account()).recoveryCodesLeft).toBe(9);
  });

  it("replaces the recovery codes with a current code; the old ones stop working at once", async () => {
    nextStep();
    const renewed = await admin.post(API_ROUTES.accountRecoveryCodes, {
      code: currentCode(secret, controlPlane.clock.now),
    });
    const fresh = renewed.json<RecoveryCodesView>().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect((await signedIn("admin", NEW_ADMIN_PASSWORD, recoveryCodes[1]!)).verified.json()).toEqual({
      error: "wrong_code",
    });
    expect((await signedIn("admin", NEW_ADMIN_PASSWORD, fresh[0]!)).verified.statusCode).toBe(204);
    expect(auditActions()).toContain('"action":"account.recovery_codes_renewed"');
  });

  it("ends one of your sessions, or all the others, but never someone else's", async () => {
    nextStep();
    const laptop = (await signedIn("admin", NEW_ADMIN_PASSWORD, currentCode(secret, controlPlane.clock.now))).client;
    const { client: partner } = await fullySignedInUser(controlPlane, admin, "partner", "admin");
    const partnerSession = (await account(partner)).sessions[0]!.id;
    const laptopSession = (await account()).sessions.find((session) => !session.current)!.id;

    const endOne = (client: TestClient, sessionId: string) =>
      client.request({ method: "DELETE", url: apiPath(API_ROUTES.accountSession, { sessionId }) });
    expect((await endOne(admin, partnerSession)).json()).toEqual({ error: "session_not_found" });
    expect((await account(partner)).username).toBe("partner");
    expect((await endOne(admin, laptopSession)).statusCode).toBe(204);
    expect((await laptop.get(API_ROUTES.account)).statusCode).toBe(401);

    nextStep();
    const phone = (await signedIn("admin", NEW_ADMIN_PASSWORD, currentCode(secret, controlPlane.clock.now))).client;
    const others = await admin.request({ method: "DELETE", url: API_ROUTES.accountOtherSessions });
    expect(others.statusCode).toBe(204);
    expect((await phone.get(API_ROUTES.account)).statusCode).toBe(401);
    expect((await account()).sessions).toHaveLength(1);
    expect(auditActions()).toContain('"action":"account.other_sessions_ended"');
  });
});
