import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath } from "../../shared/api.js";
import { auditEvents } from "../database/schema.js";

describe("user management", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let adminId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    adminId = (await admin.get(API_ROUTES.session)).json().user.id;
  });

  afterEach(() => controlPlane.app.close());

  const userUrl = (template: string, userId: string) => apiPath(template, { userId });
  const patch = (client: TestClient, userId: string, payload: object) =>
    client.request({ method: "PATCH", url: userUrl(API_ROUTES.user, userId), payload });
  const remove = (client: TestClient, userId: string) =>
    client.request({ method: "DELETE", url: userUrl(API_ROUTES.user, userId) });
  const auditActions = () =>
    controlPlane.services.databaseHandle.database
      .select()
      .from(auditEvents)
      .all()
      .map((event) => event.action);

  it("dates a new account by the dashboard's clock", async () => {
    const created = await admin.post(API_ROUTES.users, { username: "newcomer", role: "viewer" });
    expect(created.json().account.createdAt).toBe(controlPlane.clock.now);
  });

  it("keeps every user route admin-only", async () => {
    const { client: viewer, userId } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const attempts = [
      viewer.get(API_ROUTES.users),
      viewer.post(API_ROUTES.users, { username: "intruder", role: "admin" }),
      patch(viewer, userId, { role: "admin" }),
      viewer.post(userUrl(API_ROUTES.userResetPassword, adminId)),
      viewer.post(userUrl(API_ROUTES.userResetTotp, adminId)),
      remove(viewer, adminId),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "admin_only" });
    }
  });

  it("creates an account with a one-time password that must be changed", async () => {
    const created = await admin.post(API_ROUTES.users, { username: "partner", role: "viewer" });
    expect(created.json().account).toMatchObject({ username: "partner", role: "viewer", mustChangePassword: true });
    const newcomer = controlPlane.client();
    await newcomer.signIn("partner", created.json().temporaryPassword);
    expect((await newcomer.get(API_ROUTES.users)).json()).toEqual({ error: "password_change_required" });
    expect((await admin.post(API_ROUTES.users, { username: "PARTNER", role: "viewer" })).json()).toEqual({
      error: "username_taken",
    });
    expect(auditActions()).toContain("user.created");
  });

  it("never lets the last active admin be demoted, deactivated or deleted", async () => {
    expect((await patch(admin, adminId, { role: "viewer" })).json()).toEqual({ error: "last_admin" });
    expect((await patch(admin, adminId, { status: "deactivated" })).json()).toEqual({ error: "last_admin" });
    expect((await remove(admin, adminId)).statusCode).toBe(409);

    const { userId: secondAdmin } = await fullySignedInUser(controlPlane, admin, "backup-admin", "admin");
    expect((await patch(admin, secondAdmin, { role: "viewer" })).json()).toMatchObject({ role: "viewer" });
    expect(auditActions()).toContain("user.role_changed");
  });

  it("ends a deactivated user's open session on its next request", async () => {
    const { client: viewer, userId } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.get(API_ROUTES.session)).statusCode).toBe(200);
    expect((await patch(admin, userId, { status: "deactivated" })).json()).toMatchObject({ status: "deactivated" });
    expect((await viewer.get(API_ROUTES.session)).statusCode).toBe(401);
    expect(auditActions()).toContain("user.deactivated");
    await patch(admin, userId, { status: "active" });
    expect(auditActions()).toContain("user.reactivated");
  });

  it("resets a password: old sessions end, the temporary one works and must be changed", async () => {
    const { client: viewer, userId } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const { temporaryPassword } = (await admin.post(userUrl(API_ROUTES.userResetPassword, userId))).json();
    expect((await viewer.get(API_ROUTES.session)).statusCode).toBe(401);
    const again = controlPlane.client();
    expect((await again.signIn("partner", temporaryPassword)).statusCode).toBe(200);
    expect(auditActions()).toContain("user.password_reset");
  });

  it("resets TOTP so the user enrols again", async () => {
    const { userId, password } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await admin.post(userUrl(API_ROUTES.userResetTotp, userId))).statusCode).toBe(204);
    const client = controlPlane.client();
    await client.signIn("partner", password);
    expect((await client.get(API_ROUTES.users)).json()).toEqual({ error: "totp_setup_required" });
    expect(auditActions()).toContain("user.totp_reset");
  });

  it("deletes only accounts that never acted", async () => {
    const unused = (await admin.post(API_ROUTES.users, { username: "typo-account", role: "viewer" })).json();
    expect((await remove(admin, unused.account.id)).statusCode).toBe(204);
    const { userId } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await remove(admin, userId)).json()).toEqual({ error: "deactivate_instead" });
    expect(auditActions()).toContain("user.deleted");
  });

  it("answers 404 for an unknown user and 400 for a malformed id", async () => {
    expect((await patch(admin, "6f1c9a1e-0000-4000-8000-000000000000", { role: "viewer" })).json()).toEqual({
      error: "user_not_found",
    });
    expect((await patch(admin, "not-a-uuid", { role: "viewer" })).statusCode).toBe(400);
  });

  it("lists accounts without password hashes or TOTP secrets", async () => {
    await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const body = (await admin.get(API_ROUTES.users)).body;
    expect(JSON.parse(body).map((account: { username: string }) => account.username)).toEqual(["admin", "partner"]);
    expect(body).not.toMatch(/argon2|passwordHash|totpSecret/);
  });
});
