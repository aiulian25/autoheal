import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { NEW_ADMIN_PASSWORD, currentCode, fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, type SessionView, type TotpSetupView } from "../../shared/api.js";
import { SESSION_COOKIE_NAME, TOTP_PERIOD_SECONDS } from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import { recoveryCodes, users } from "../database/schema.js";
import { SecretBox } from "../database/secret-box.js";

const FULL_ACCESS_ROUTE = "/api/test/full";
const STEP_MILLISECONDS = TOTP_PERIOD_SECONDS * 1000;
const OTHER_PASSPHRASE = "another-backup-passphrase-0123456789abcdef";

describe("TOTP for every account", () => {
  let controlPlane: TestControlPlane;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane({
      extendApp: (app) => {
        app.get(FULL_ACCESS_ROUTE, async () => ({ ok: true }));
      },
    });
  });

  afterEach(() => controlPlane.app.close());

  // The token from before the second step opens nothing any more; the one that replaced it opens everything.
  async function expectReplaced(client: TestClient, before: string) {
    expect(client.sessionToken).not.toBe(before);
    expect((await client.get(FULL_ACCESS_ROUTE)).json()).toEqual({ ok: true });
    const withOldToken = await client.request({
      method: "GET",
      url: FULL_ACCESS_ROUTE,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${before}` },
    });
    expect(withOldToken.json()).toEqual({ error: "not_signed_in" });
    expect(controlPlane.services.sessions.completeSecondFactor(sha256Hex(before))).toBeNull();
  }

  it("takes the first-run admin from password change through enrolment to full access", async () => {
    const { client, recoveryCodes: codes } = await fullySignedInAdmin(controlPlane);
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect((await client.get(FULL_ACCESS_ROUTE)).json()).toEqual({ ok: true });
    const session = (await client.get(API_ROUTES.session)).json();
    expect(session).toMatchObject({ secondFactorDone: true, user: { totpEnabled: true, mustChangePassword: false } });
  });

  it("stores recovery codes only as hashes", async () => {
    const { recoveryCodes: codes } = await fullySignedInAdmin(controlPlane);
    const stored = JSON.stringify(controlPlane.services.databaseHandle.database.select().from(recoveryCodes).all());
    for (const code of codes) {
      expect(stored).not.toContain(code);
    }
  });

  it("refuses a wrong enrolment code and enrolling twice", async () => {
    const firstPassword = await controlPlane.firstAdminPassword();
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    await client.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_ADMIN_PASSWORD });
    expect((await client.post(API_ROUTES.totpConfirm, { code: "123456" })).json()).toEqual({
      error: "totp_setup_not_started",
    });
    const { secret } = (await client.post(API_ROUTES.totpSetup)).json();
    expect((await client.post(API_ROUTES.totpConfirm, { code: "000000" })).json()).toEqual({ error: "wrong_code" });
    await client.post(API_ROUTES.totpConfirm, { code: currentCode(secret, controlPlane.clock.now) });
    expect((await client.post(API_ROUTES.totpSetup)).statusCode).toBe(409);
  });

  it("asks for the code at the next sign-in and refuses a replayed one", async () => {
    const { secret } = await fullySignedInAdmin(controlPlane);
    const client = controlPlane.client();
    await client.signIn("admin", NEW_ADMIN_PASSWORD);
    expect((await client.get(FULL_ACCESS_ROUTE)).json()).toEqual({ error: "second_factor_required" });
    expect((await client.post(API_ROUTES.changePassword, { currentPassword: "x", newPassword: "y" })).json()).toEqual({
      error: "second_factor_required",
    });

    const usedAtEnrolment = currentCode(secret, controlPlane.clock.now);
    expect((await client.post(API_ROUTES.secondFactor, { code: usedAtEnrolment })).json()).toEqual({
      error: "code_already_used",
    });

    controlPlane.clock.now += STEP_MILLISECONDS;
    const fresh = currentCode(secret, controlPlane.clock.now);
    expect((await client.post(API_ROUTES.secondFactor, { code: fresh })).statusCode).toBe(204);
    expect((await client.get(FULL_ACCESS_ROUTE)).json()).toEqual({ ok: true });

    const another = controlPlane.client();
    await another.signIn("admin", NEW_ADMIN_PASSWORD);
    expect((await another.post(API_ROUTES.secondFactor, { code: fresh })).json()).toEqual({
      error: "code_already_used",
    });
  });

  it("gives the session a new strict cookie once the sign-in code is right, and keeps its CSRF token", async () => {
    const { secret } = await fullySignedInAdmin(controlPlane);
    const client = controlPlane.client();
    await client.signIn("admin", NEW_ADMIN_PASSWORD);
    const before = client.sessionToken!;
    const csrfToken = client.csrfToken;
    controlPlane.clock.now += STEP_MILLISECONDS;
    const verified = await client.post(API_ROUTES.secondFactor, { code: currentCode(secret, controlPlane.clock.now) });
    expect(verified.statusCode).toBe(204);
    expect(verified.cookies[0]).toMatchObject({
      name: SESSION_COOKIE_NAME,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    await expectReplaced(client, before);
    expect((await client.get(API_ROUTES.session)).json<SessionView>().csrfToken).toBe(csrfToken);
  });

  it("gives the first-run admin's session a new cookie once TOTP is set up", async () => {
    const firstPassword = await controlPlane.firstAdminPassword();
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    await client.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_ADMIN_PASSWORD });
    const before = client.sessionToken!;
    const { secret } = (await client.post(API_ROUTES.totpSetup)).json<TotpSetupView>();
    const confirmed = await client.post(API_ROUTES.totpConfirm, { code: currentCode(secret, controlPlane.clock.now) });
    expect(confirmed.statusCode).toBe(200);
    await expectReplaced(client, before);
  });

  it("names the server in the authenticator entry, so entries from two instances differ", async () => {
    const firstPassword = await controlPlane.firstAdminPassword();
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    await client.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_ADMIN_PASSWORD });
    const { otpauthUri } = (await client.post(API_ROUTES.totpSetup)).json<{ otpauthUri: string }>();
    expect(decodeURIComponent(new URL(otpauthUri).pathname)).toBe("/Autoheal:admin@localhost");
    expect(new URL(otpauthUri).searchParams.get("image")).toBe("https://localhost/brand/autoheal-512.png");
  });

  it("takes a code typed with a space, and says when a clock is behind instead of just refusing", async () => {
    const { secret } = await fullySignedInAdmin(controlPlane);
    const client = controlPlane.client();
    await client.signIn("admin", NEW_ADMIN_PASSWORD);
    const behindByThreeSteps = currentCode(secret, controlPlane.clock.now, -3);
    expect((await client.post(API_ROUTES.secondFactor, { code: behindByThreeSteps })).json()).toEqual({
      error: "clock_drift",
      clockOffsetSeconds: -90,
    });
    expect(controlPlane.stdout.join("")).toContain('"reason":"clock","offsetSeconds":-90');

    controlPlane.clock.now += STEP_MILLISECONDS;
    const code = currentCode(secret, controlPlane.clock.now);
    const typedWithSpace = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await client.post(API_ROUTES.secondFactor, { code: typedWithSpace })).statusCode).toBe(204);
  });

  it("never says a wrong code belongs to a later time, which a guesser could wait for", async () => {
    const { secret } = await fullySignedInAdmin(controlPlane);
    const client = controlPlane.client();
    await client.signIn("admin", NEW_ADMIN_PASSWORD);
    const aheadByThreeSteps = currentCode(secret, controlPlane.clock.now, 3);
    expect((await client.post(API_ROUTES.secondFactor, { code: aheadByThreeSteps })).json()).toEqual({
      error: "wrong_code",
    });
  });

  it("accepts each recovery code once, typed loosely", async () => {
    const { recoveryCodes: codes } = await fullySignedInAdmin(controlPlane);
    const first = controlPlane.client();
    await first.signIn("admin", NEW_ADMIN_PASSWORD);
    const typedLoosely = codes[0]!.toLowerCase().replace("-", " ");
    expect((await first.post(API_ROUTES.secondFactor, { code: typedLoosely })).statusCode).toBe(204);

    const second = controlPlane.client();
    await second.signIn("admin", NEW_ADMIN_PASSWORD);
    expect((await second.post(API_ROUTES.secondFactor, { code: codes[0]! })).json()).toEqual({ error: "wrong_code" });
    expect((await second.post(API_ROUTES.secondFactor, { code: codes[1]! })).statusCode).toBe(204);
  });

  it("ends the session after five wrong codes", async () => {
    await fullySignedInAdmin(controlPlane);
    const client = controlPlane.client();
    await client.signIn("admin", NEW_ADMIN_PASSWORD);
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await client.post(API_ROUTES.secondFactor, { code: "000000" })).statusCode);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 401]);
    expect((await client.get(API_ROUTES.session)).statusCode).toBe(401);
  });

  it("counts wrong codes as sign-in failures, so the password alone buys no extra guesses", async () => {
    const { secret } = await fullySignedInAdmin(controlPlane);
    const first = controlPlane.client();
    await first.signIn("admin", NEW_ADMIN_PASSWORD);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await first.post(API_ROUTES.secondFactor, { code: "000000" });
    }
    // Five failures are the free allowance; the sixth starts the delays, on both doors.
    const second = controlPlane.client();
    expect((await second.signIn("admin", NEW_ADMIN_PASSWORD)).statusCode).toBe(200);
    expect((await second.post(API_ROUTES.secondFactor, { code: "000000" })).json()).toEqual({ error: "wrong_code" });
    const throttledCode = await second.post(API_ROUTES.secondFactor, { code: "000000" });
    expect(throttledCode.statusCode).toBe(429);
    expect(throttledCode.headers["retry-after"]).toBe("1");
    const throttledPassword = await controlPlane.client().signIn("admin", NEW_ADMIN_PASSWORD);
    expect(throttledPassword.statusCode).toBe(429);

    controlPlane.clock.now += STEP_MILLISECONDS;
    const right = await second.post(API_ROUTES.secondFactor, { code: currentCode(secret, controlPlane.clock.now) });
    expect(right.statusCode).toBe(204);
    expect((await controlPlane.client().signIn("admin", NEW_ADMIN_PASSWORD)).statusCode).toBe(200);
  });

  it("keeps the TOTP secret out of every response after enrolment", async () => {
    const { client, secret } = await fullySignedInAdmin(controlPlane);
    expect((await client.get(API_ROUTES.session)).body).not.toContain(secret);
  });

  it("keeps the authenticator secret sealed in the database, from setup on", async () => {
    const firstPassword = await controlPlane.firstAdminPassword();
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    await client.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_ADMIN_PASSWORD });
    const { secret } = (await client.post(API_ROUTES.totpSetup)).json<TotpSetupView>();
    const stored = () => controlPlane.services.databaseHandle.database.select().from(users).get()!;
    expect(stored().totpPendingSecret).not.toContain(secret);
    await client.post(API_ROUTES.totpConfirm, { code: currentCode(secret, controlPlane.clock.now) });
    expect(stored()).toMatchObject({ totpEnabled: true, totpPendingSecret: null });
    expect(stored().totpSecret).not.toContain(secret);
  });

  it("says when a code was sealed under another backup passphrase, and still takes a recovery code", async () => {
    const { secret, recoveryCodes: codes } = await fullySignedInAdmin(controlPlane);
    controlPlane.services.databaseHandle.database
      .update(users)
      .set({ totpSecret: SecretBox.fromPassphrase(OTHER_PASSPHRASE).seal(secret) })
      .where(eq(users.username, "admin"))
      .run();
    const client = controlPlane.client();
    await client.signIn("admin", NEW_ADMIN_PASSWORD);
    controlPlane.clock.now += STEP_MILLISECONDS;
    const refused = await client.post(API_ROUTES.secondFactor, { code: currentCode(secret, controlPlane.clock.now) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "stored_secret_unreadable" });
    expect((await client.post(API_ROUTES.secondFactor, { code: codes[0]! })).statusCode).toBe(204);
  });
});
