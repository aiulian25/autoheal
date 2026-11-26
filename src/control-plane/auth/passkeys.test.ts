import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { NEW_ADMIN_PASSWORD, currentCode, fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { SoftwarePasskey } from "../../../test/support/software-passkey.js";
import { API_ROUTES, apiPath, type PasskeyStatusView, type PasskeyView, type SessionView } from "../../shared/api.js";
import {
  LOCAL_PUBLIC_BASE_URL,
  LOGIN_FAILURE_REASONS,
  PASSKEY_CEREMONY_LIMIT,
  PASSKEY_CEREMONY_MILLISECONDS,
  TOTP_PERIOD_SECONDS,
} from "../../shared/constants.js";
import { auditEvents, passkeys, users } from "../database/schema.js";
import { resetOwner } from "./bootstrap.js";
import { PasskeyService } from "./passkey-service.js";

// What a test does the moment the WebAuthn library has checked an answer, before the dashboard acts on it: whatever a
// person may do to the account while a check is under way.
const afterCheck = vi.hoisted(() => {
  const nothing = async () => {};
  return { nothing, signIn: nothing, enrol: nothing };
});
vi.mock("@simplewebauthn/server", async (original) => {
  const library = await original<typeof import("@simplewebauthn/server")>();
  return {
    ...library,
    verifyAuthenticationResponse: async (...options: Parameters<typeof library.verifyAuthenticationResponse>) => {
      const checked = await library.verifyAuthenticationResponse(...options);
      await afterCheck.signIn();
      return checked;
    },
    verifyRegistrationResponse: async (...options: Parameters<typeof library.verifyRegistrationResponse>) => {
      const checked = await library.verifyRegistrationResponse(...options);
      await afterCheck.enrol();
      return checked;
    },
  };
});

// Runs once, the first time a check finishes: an answer given from inside it is checked as any other.
const once = (step: () => Promise<void>, which: "signIn" | "enrol") => {
  afterCheck[which] = async () => {
    afterCheck[which] = afterCheck.nothing;
    await step();
  };
};

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
    afterCheck.signIn = afterCheck.nothing;
    afterCheck.enrol = afterCheck.nothing;
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

  it("lets a flood of sign-in starts from one address end only its own, not someone else's sign-in under way", async () => {
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
    await enrol(passkey);
    const visitor = controlPlane.client();
    const options = (await visitor.post(API_ROUTES.passkeySignInOptions)).json<PublicKeyCredentialRequestOptionsJSON>();
    const flood = { ip: "192.0.2.66", userAgent: null };
    for (let start = 0; start < PASSKEY_CEREMONY_LIMIT; start += 1) {
      await controlPlane.services.passkeys.signInOptions(flood);
    }
    const answered = await visitor.post(API_ROUTES.passkeySignIn, { response: passkey.signIn(options) });
    expect(answered.statusCode).toBe(200);
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

  it("keeps the same passkey once, though a device offers it again", async () => {
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
    expect((await enrol(passkey)).statusCode).toBe(200);
    expect((await enrol(passkey)).json()).toMatchObject({ error: "passkey_not_added" });
    expect((await admin.get(API_ROUTES.accountPasskeys)).json<PasskeyView[]>()).toHaveLength(1);
  });

  it("stops working while its account may not sign in, and the host's reset-admin removes them", async () => {
    const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
    expect((await enrol(passkey)).statusCode).toBe(200);
    const { databaseHandle: handle, auditLog } = controlPlane.services;
    const setStatus = (status: "active" | "deactivated") => handle.database.update(users).set({ status }).run();

    setStatus("deactivated");
    expect((await signIn(passkey)).statusCode).toBe(401);
    setStatus("active");
    expect((await signIn(passkey)).statusCode).toBe(200);

    await resetOwner(handle, auditLog, undefined, () => undefined);
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
    await expect(atAddress.signInOptions({ ip: "192.0.2.10" })).rejects.toMatchObject({ code: "passkeys_unavailable" });
  });

  describe("while an answer is being checked", () => {
    const stored = () => controlPlane.services.databaseHandle.database.select().from(passkeys).all();
    const removal = (passkey: PasskeyView) => apiPath(API_ROUTES.accountPasskey, { passkeyId: passkey.id });

    it("signs no one in with a passkey removed meanwhile, though removing one after leaves its sign-in open", async () => {
      const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
      const added = (await enrol(passkey)).json<PasskeyView>();
      once(async () => {
        expect((await admin.delete(removal(added))).statusCode).toBe(204);
      }, "signIn");
      const visitor = controlPlane.client();
      expect((await signIn(passkey, visitor)).json()).toMatchObject({ error: "passkey_refused" });
      expect((await visitor.get(API_ROUTES.account)).statusCode).toBe(401);

      const kept = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
      const keptView = (await enrol(kept)).json<PasskeyView>();
      const signedIn = controlPlane.client();
      expect((await signIn(kept, signedIn)).statusCode).toBe(200);
      expect((await admin.delete(removal(keptView))).statusCode).toBe(204);
      expect((await signedIn.get(API_ROUTES.account)).statusCode).toBe(200);
      expect((await signIn(kept)).statusCode).toBe(401);
    });

    it("signs no one into an account deactivated meanwhile", async () => {
      const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
      expect((await enrol(passkey)).statusCode).toBe(200);
      const { database } = controlPlane.services.databaseHandle;
      once(async () => {
        database.update(users).set({ status: "deactivated" }).run();
      }, "signIn");
      expect((await signIn(passkey)).json()).toMatchObject({ error: "passkey_refused" });
      const reasons = database
        .select({ details: auditEvents.detailsJson })
        .from(auditEvents)
        .all()
        .map(({ details }) => (JSON.parse(details) as { reason?: string }).reason);
      expect(reasons).toContain(LOGIN_FAILURE_REASONS.deactivated);
    });

    it("keeps a passkey's count from going back when two of its answers are checked at once: the slower is refused", async () => {
      const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
      await enrol(passkey);
      const faster = controlPlane.client();
      once(async () => {
        expect((await signIn(passkey, faster)).statusCode).toBe(200);
      }, "signIn");
      expect((await signIn(passkey)).json()).toMatchObject({ error: "passkey_refused" });
      expect(stored()[0]!.counter).toBe(2);
      expect((await faster.get(API_ROUTES.account)).statusCode).toBe(200);
    });

    it("still signs in twice at once with a passkey whose count stays at 0, as many synced ones keep it", async () => {
      const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL, { synced: true, countsSignIns: false });
      await enrol(passkey);
      once(async () => {
        expect((await signIn(passkey)).statusCode).toBe(200);
      }, "signIn");
      expect((await signIn(passkey)).statusCode).toBe(200);
      expect(stored()[0]!.counter).toBe(0);
    });

    it("adds no passkey for a session that ended meanwhile", async () => {
      const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
      once(async () => {
        expect((await admin.post(API_ROUTES.logout)).statusCode).toBeLessThan(300);
      }, "enrol");
      const added = await enrol(passkey);
      expect(added.statusCode).toBe(401);
      expect(added.json()).toMatchObject({ error: "not_signed_in" });
      expect(stored()).toEqual([]);
      expect((await signIn(passkey)).statusCode).toBe(401);
    });

    it("lets no other session of the account finish an enrolment it did not start", async () => {
      const passkey = new SoftwarePasskey(LOCAL_PUBLIC_BASE_URL);
      const options = (
        await admin.post(API_ROUTES.accountPasskeyOptions, { code: freshCode() })
      ).json<PublicKeyCredentialCreationOptionsJSON>();
      const other = controlPlane.client();
      await other.signIn("admin", NEW_ADMIN_PASSWORD);
      expect((await other.post(API_ROUTES.secondFactor, { code: freshCode() })).statusCode).toBe(204);
      const finished = await other.post(API_ROUTES.accountPasskeys, { response: passkey.register(options) });
      expect(finished.json()).toMatchObject({ error: "passkey_not_added" });
      expect(stored()).toEqual([]);
    });
  });
});
