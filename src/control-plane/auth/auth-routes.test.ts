import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { currentCode } from "../../../test/support/second-factor.js";
import { API_ROUTES, type SessionView, type TotpSetupView } from "../../shared/api.js";
import { LOGIN_FREE_FAILURES, SESSION_COOKIE_NAME, SESSION_IDLE_MILLISECONDS } from "../../shared/constants.js";
import { auditEvents, users } from "../database/schema.js";

const NEW_PASSWORD = "tangerine-orbit-quietly";
const FULL_ACCESS_ROUTE = "/api/test/full";

describe("login, sessions and the forced password change", () => {
  let controlPlane: TestControlPlane;
  let firstPassword: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane({
      extendApp: (app) => {
        app.get(FULL_ACCESS_ROUTE, async () => ({ ok: true }));
      },
    });
    firstPassword = await controlPlane.firstAdminPassword();
  });

  afterEach(() => controlPlane.app.close());

  const auditActions = () =>
    controlPlane.services.databaseHandle.database
      .select()
      .from(auditEvents)
      .all()
      .map((event) => [event.action, JSON.parse(event.detailsJson).reason ?? null]);

  it("signs in with a strict session cookie", async () => {
    const response = await controlPlane.client().signIn("admin", firstPassword);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { username: "admin", role: "admin", mustChangePassword: true } });
    const cookie = response.cookies[0]!;
    expect(cookie).toMatchObject({
      name: "__Host-autoheal-session",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
  });

  it("slows wrong guesses at the current password as signing in does", async () => {
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    const change = (currentPassword: string) =>
      client.post(API_ROUTES.changePassword, { currentPassword, newPassword: NEW_PASSWORD });
    for (let guess = 0; guess <= LOGIN_FREE_FAILURES; guess += 1) {
      expect((await change("not-it-at-all")).json()).toEqual({ error: "wrong_password" });
    }
    const slowed = await change(firstPassword);
    expect(slowed.statusCode).toBe(429);
    expect(slowed.json()).toEqual({ error: "too_many_attempts", retryAfterSeconds: 1 });
  });

  it("blocks everything but the password change until the first-run password is replaced, then asks for TOTP", async () => {
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    expect((await client.get(API_ROUTES.session)).statusCode).toBe(200);
    const blocked = await client.get(FULL_ACCESS_ROUTE);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: "password_change_required" });

    const tooShort = await client.post(API_ROUTES.changePassword, {
      currentPassword: firstPassword,
      newPassword: "short",
    });
    expect(tooShort.json()).toMatchObject({ error: "password_policy", problems: ["must be at least 12 characters"] });
    const same = await client.post(API_ROUTES.changePassword, {
      currentPassword: firstPassword,
      newPassword: firstPassword,
    });
    expect(same.json()).toEqual({ error: "same_password" });
    const wrong = await client.post(API_ROUTES.changePassword, {
      currentPassword: "not-it-at-all",
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.json()).toEqual({ error: "wrong_password" });

    const changed = await client.post(API_ROUTES.changePassword, {
      currentPassword: firstPassword,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.statusCode).toBe(204);
    expect((await client.get(FULL_ACCESS_ROUTE)).json()).toEqual({ error: "totp_setup_required" });
    expect(auditActions()).toContainEqual(["auth.password_changed", null]);
  });

  it("gives the session a new token whenever its password changes, forced or not, and keeps its CSRF token", async () => {
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    await client.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_PASSWORD });
    const { secret } = (await client.post(API_ROUTES.totpSetup)).json<TotpSetupView>();
    await client.post(API_ROUTES.totpConfirm, { code: currentCode(secret, controlPlane.clock.now) });
    const csrfToken = (await client.get(API_ROUTES.session)).json<SessionView>().csrfToken;
    // The token from before the change opens nothing any more; the one that replaced it opens everything.
    const changeFrom = async (currentPassword: string, newPassword: string) => {
      const before = client.sessionToken!;
      expect((await client.post(API_ROUTES.changePassword, { currentPassword, newPassword })).statusCode).toBe(204);
      expect(client.sessionToken).not.toBe(before);
      expect((await client.get(FULL_ACCESS_ROUTE)).json()).toEqual({ ok: true });
      const withOldToken = await client.request({
        method: "GET",
        url: FULL_ACCESS_ROUTE,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${before}` },
      });
      expect(withOldToken.json()).toEqual({ error: "not_signed_in" });
      expect((await client.get(API_ROUTES.session)).json<SessionView>().csrfToken).toBe(csrfToken);
    };
    // Of its own accord, from the account page.
    await changeFrom(NEW_PASSWORD, "orbiting-quiet-tangerines");
    // Forced, as after an admin's reset: the held-back token goes to full access only under a new one.
    controlPlane.services.databaseHandle.database
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.username, "admin"))
      .run();
    expect((await client.get(FULL_ACCESS_ROUTE)).json()).toEqual({ error: "password_change_required" });
    await changeFrom("orbiting-quiet-tangerines", "tangerines-orbit-quietly-again");
  });

  it("gives unknown users and wrong passwords the same answer, and audits both", async () => {
    const wrongPassword = await controlPlane.client().signIn("admin", "wrong-password-here");
    const unknownUser = await controlPlane.client().signIn("nobody", "wrong-password-here");
    expect([wrongPassword.statusCode, unknownUser.statusCode]).toEqual([401, 401]);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
    expect(auditActions().filter(([action]) => action === "auth.login_failed")).toHaveLength(2);
  });

  it("slows repeated failures down with growing delays instead of locking the account", async () => {
    const client = controlPlane.client();
    for (let failure = 1; failure <= 6; failure += 1) {
      expect((await client.signIn("admin", "wrong-password-here")).statusCode).toBe(401);
    }
    const throttled = await client.signIn("admin", firstPassword);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("1");

    controlPlane.clock.now += 1_000;
    expect((await client.signIn("admin", "wrong-password-here")).statusCode).toBe(401);
    expect((await client.signIn("admin", firstPassword)).headers["retry-after"]).toBe("2");

    controlPlane.clock.now += 2_000;
    expect((await client.signIn("admin", firstPassword)).statusCode).toBe(200);
    // Refused-before-checking requests are not attempts: they leave no audit row.
    expect(auditActions().filter(([action]) => action === "auth.login_failed")).toHaveLength(7);
  });

  it("refuses a deactivated account even with the right password", async () => {
    controlPlane.services.databaseHandle.database
      .update(users)
      .set({ status: "deactivated" })
      .where(eq(users.username, "admin"))
      .run();
    expect((await controlPlane.client().signIn("admin", firstPassword)).statusCode).toBe(401);
    expect(auditActions()).toContainEqual(["auth.login_failed", "deactivated"]);
  });

  it("ends the session on logout and after an hour idle", async () => {
    const client = controlPlane.client();
    await client.signIn("admin", firstPassword);
    expect((await client.post(API_ROUTES.logout)).statusCode).toBe(204);
    expect((await client.get(API_ROUTES.session)).statusCode).toBe(401);

    const idle = controlPlane.client();
    await idle.signIn("admin", firstPassword);
    controlPlane.clock.now += SESSION_IDLE_MILLISECONDS;
    expect((await idle.get(API_ROUTES.session)).json()).toEqual({ error: "not_signed_in" });
  });

  it("signs other sessions out when the password changes", async () => {
    const phone = controlPlane.client();
    const laptop = controlPlane.client();
    await phone.signIn("admin", firstPassword);
    await laptop.signIn("admin", firstPassword);
    await laptop.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_PASSWORD });
    expect((await phone.get(API_ROUTES.session)).statusCode).toBe(401);
    expect((await laptop.get(API_ROUTES.session)).statusCode).toBe(200);
  });

  it("rejects malformed bodies with the field names", async () => {
    const response = await controlPlane.client().post(API_ROUTES.login, { username: "" });
    expect(response.statusCode).toBe(400);
    expect(
      response
        .json()
        .issues.map((issue: { path: string }) => issue.path)
        .sort(),
    ).toEqual(["password", "username"]);
  });
});
