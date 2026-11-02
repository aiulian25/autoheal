import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { currentCode, fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { SoftwarePasskey } from "../../../test/support/software-passkey.js";
import { API_ROUTES, apiPath, type PasskeyStatusView, type PasskeyView, type SessionView } from "../../shared/api.js";
import { LOCAL_PUBLIC_BASE_URL, PASSKEY_CEREMONY_MILLISECONDS, TOTP_PERIOD_SECONDS } from "../../shared/constants.js";
import { PasskeyService } from "./passkey-service.js";

const GOOGLE_PASSWORD_MANAGER = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";
const NEXT_CODE_MILLISECONDS = TOTP_PERIOD_SECONDS * 1000;
const ANOTHER_USER_HANDLE = Buffer.from("another-account").toString("base64url");

// A first answer to a sign-in challenge, given the passkey this dashboard knows.
type FirstAnswer = (
  known: SoftwarePasskey,
  options: PublicKeyCredentialRequestOptionsJSON,
) => AuthenticationResponseJSON;

describe("passkeys", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let secret: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    ({ client: admin, secret } = await fullySignedInAdmin(controlPlane));
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  // A code from a step not used yet: a code works once.
  const freshCode = (codeSecret = secret) => {
    controlPlane.clock.now += NEXT_CODE_MILLISECONDS;
    return currentCode(codeSecret, controlPlane.clock.now);
  };
  const status = async () => (await controlPlane.client().get(API_ROUTES.passkeyStatus)).json<PasskeyStatusView>();
  async function enrol(passkey: SoftwarePasskey, client = admin, codeSecret = secret) {
    const options = (
      await client.post(API_ROUTES.accountPasskeyOptions, { code: freshCode(codeSecret) })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    return client.post(API_ROUTES.accountPasskeys, { response: passkey.register(options), name: "Chrome on Linux" });
  }
  async function signIn(passkey: SoftwarePasskey, visitor = controlPlane.client()) {
    const options = (await visitor.post(API_ROUTES.passkeySignInOptions)).json<PublicKeyCredentialRequestOptionsJSON>();
    return visitor.keepSession(await visitor.post(API_ROUTES.passkeySignIn, { response: passkey.signIn(options) }));
  }

  it("adds one once a current code says it is you, and signs in with it alone", async () => {
    expect(await status()).toEqual({ usable: true, offered: false });
    expect((await admin.post(API_ROUTES.accountPasskeyOptions, { code: "000000" })).json()).toMatchObject({
      error: "wrong_code",
    });
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL, { aaguid: GOOGLE_PASSWORD_MANAGER, synced: true });

    const added = (await enrol(passkey)).json<PasskeyView>();
    expect(added).toMatchObject({
      name: "Google Password Manager",
      synced: true,
      lastUsedAt: null,
      otherAddress: null,
    });
    expect(await status()).toEqual({ usable: true, offered: true });

    const visitor = controlPlane.client();
    const signedIn = await signIn(passkey, visitor);
    expect(signedIn.json<SessionView>()).toMatchObject({ user: { username: "admin" }, secondFactorDone: true });
    // Both steps at once: the account is open without a code.
    expect((await visitor.get(API_ROUTES.account)).statusCode).toBe(200);
    const [listed] = (await visitor.get(API_ROUTES.accountPasskeys)).json<PasskeyView[]>();
    expect(listed!.lastUsedAt).toBe(controlPlane.clock.now);
  });

  it("names one its password manager doesn't name after the browser, and lets you rename and remove it", async () => {
    const added = (await enrol(new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL))).json<PasskeyView>();
    expect(added.name).toBe("Chrome on Linux");
    const path = apiPath(API_ROUTES.accountPasskey, { passkeyId: added.id });

    expect((await admin.patch(path, { name: "Work laptop" })).json<PasskeyView>().name).toBe("Work laptop");
    expect((await admin.delete(path)).statusCode).toBe(204);
    expect((await admin.get(API_ROUTES.accountPasskeys)).json()).toEqual([]);
    expect((await admin.delete(path)).json()).toMatchObject({ error: "passkey_not_found" });
  });

  it("refuses an answer that doesn't check out: replayed, late, from elsewhere, or unknown", async () => {
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
    await enrol(passkey);
    const visitor = controlPlane.client();
    const options = (await visitor.post(API_ROUTES.passkeySignInOptions)).json<PublicKeyCredentialRequestOptionsJSON>();
    const answer = { response: passkey.signIn(options) };

    expect(visitor.keepSession(await visitor.post(API_ROUTES.passkeySignIn, answer)).statusCode).toBe(200);
    expect((await visitor.post(API_ROUTES.passkeySignIn, answer)).json()).toMatchObject({ error: "passkey_refused" });

    const late = (await visitor.post(API_ROUTES.passkeySignInOptions)).json<PublicKeyCredentialRequestOptionsJSON>();
    controlPlane.clock.now += PASSKEY_CEREMONY_MILLISECONDS + 1;
    expect((await visitor.post(API_ROUTES.passkeySignIn, { response: passkey.signIn(late) })).statusCode).toBe(401);

    passkey.traits.origin = "https://autoheal.example.net";
    expect((await signIn(passkey)).statusCode).toBe(401);
    expect((await signIn(new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL))).statusCode).toBe(401);
  });

  it.each<[string, FirstAnswer]>([
    ["from a passkey made elsewhere", (_known, options) => new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL).signIn(options)],
    [
      "naming another account",
      (known, options) => {
        const answer = known.signIn(options);
        return { ...answer, response: { ...answer.response, userHandle: ANOTHER_USER_HANDLE } };
      },
    ],
    [
      "the WebAuthn library refuses unread",
      (known, options) => ({ ...known.signIn(options), rawId: new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL).id }),
    ],
  ])("ends a sign-in's challenge with its first answer, even one %s", async (_case, firstAnswer) => {
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
    await enrol(passkey);
    const visitor = controlPlane.client();
    const options = (await visitor.post(API_ROUTES.passkeySignInOptions)).json<PublicKeyCredentialRequestOptionsJSON>();
    expect((await visitor.post(API_ROUTES.passkeySignIn, { response: firstAnswer(passkey, options) })).statusCode).toBe(
      401,
    );
    expect((await visitor.post(API_ROUTES.passkeySignIn, { response: passkey.signIn(options) })).json()).toMatchObject({
      error: "passkey_refused",
    });
  });

  it("ends an enrolment's challenge with its first answer, even one the WebAuthn library refuses unread", async () => {
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
    const options = (
      await admin.post(API_ROUTES.accountPasskeyOptions, { code: freshCode() })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const answer = passkey.register(options);
    const garbled = { ...answer, rawId: new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL).id };
    expect((await admin.post(API_ROUTES.accountPasskeys, { response: garbled })).json()).toMatchObject({
      error: "passkey_not_added",
    });
    expect((await admin.post(API_ROUTES.accountPasskeys, { response: answer })).json()).toMatchObject({
      error: "passkey_not_added",
    });
    expect((await admin.get(API_ROUTES.accountPasskeys)).json()).toEqual([]);
  });

  it("adds none that doesn't check the person, or that answers for another page", async () => {
    expect((await enrol(new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL, { userVerified: false }))).json()).toMatchObject({
      error: "passkey_not_added",
    });
    const elsewhere = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL, { origin: "https://autoheal.example.net" });
    expect((await enrol(elsewhere)).statusCode).toBe(422);
    expect((await admin.get(API_ROUTES.accountPasskeys)).json()).toEqual([]);
  });

  it("stops working for a deactivated account, and an admin's reset removes them", async () => {
    const viewer = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
    expect((await enrol(passkey, viewer.client, viewer.secret)).statusCode).toBe(200);
    const user = apiPath(API_ROUTES.user, { userId: viewer.userId });

    await admin.request({ method: "PATCH", url: user, payload: { status: "deactivated" } });
    expect((await signIn(passkey)).statusCode).toBe(401);
    await admin.request({ method: "PATCH", url: user, payload: { status: "active" } });
    expect((await signIn(passkey)).statusCode).toBe(200);

    await admin.post(apiPath(API_ROUTES.userResetTotp, { userId: viewer.userId }));
    expect((await signIn(passkey)).statusCode).toBe(401);
    expect(await status()).toEqual({ usable: true, offered: false });
  });

  it("keeps passkeys to the address they were made for, and to a name: none at an IP address", async () => {
    await enrol(new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL));
    const { databaseHandle, auditLog, sessions } = controlPlane.services;
    const session = { user: { id: (await admin.get(API_ROUTES.session)).json<SessionView>().user.id } };

    const moved = new PasskeyService(databaseHandle, auditLog, sessions, "https://autoheal.home.lan");
    expect(moved.status()).toEqual({ usable: true, offered: false });
    expect(moved.list(session as never)[0]!.otherAddress).toBe("localhost");

    const atAddress = new PasskeyService(databaseHandle, auditLog, sessions, "https://192.168.10.83:8443");
    expect(atAddress.status()).toEqual({ usable: false, offered: false });
    await expect(atAddress.signInOptions()).rejects.toMatchObject({ code: "passkeys_unavailable" });
  });
});
