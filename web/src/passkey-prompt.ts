import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

// What the browser library says when this device already has a passkey for the dashboard.
const PREVIOUSLY_REGISTERED = "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED";

/** The browser's own prompt ended without a passkey: cancelled, timed out, nothing to offer, or one already here. */
export class PasskeyPromptStopped extends Error {
  constructor(readonly alreadyHere: boolean) {
    super(PREVIOUSLY_REGISTERED);
  }
}

const isAlreadyHere = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === PREVIOUSLY_REGISTERED;

async function prompted<Result>(prompt: () => Promise<Result>): Promise<Result> {
  try {
    return await prompt();
  } catch (error) {
    throw new PasskeyPromptStopped(isAlreadyHere(error));
  }
}

export const answerWithPasskey = (optionsJSON: PublicKeyCredentialRequestOptionsJSON) =>
  prompted(() => startAuthentication({ optionsJSON }));

export const makePasskey = (optionsJSON: PublicKeyCredentialCreationOptionsJSON) =>
  prompted(() => startRegistration({ optionsJSON }));
