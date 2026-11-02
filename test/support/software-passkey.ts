import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

// WebAuthn's authenticator data flags, and the COSE names of an ES256 public key.
const FLAGS = { userPresent: 0x01, userVerified: 0x04, backupEligible: 0x08, backedUp: 0x10, attestedData: 0x40 };
const COSE = { keyType: 1, algorithm: 3, curve: -1, x: -2, y: -3, ellipticCurve: 2, es256: -7, p256: 1 };
const NO_AAGUID = "00000000-0000-0000-0000-000000000000";
const COUNTER_BYTES = 4;
const LENGTH_BYTES = 2;
const CREDENTIAL_ID_BYTES = 16;

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();
const base64url = (data: Uint8Array) => Buffer.from(data).toString("base64url");

interface PasskeyTraits {
  // The password manager it claims to be, by AAGUID.
  aaguid?: string;
  // Whether it checked the person (fingerprint, face, PIN); a passkey that doesn't is refused.
  userVerified?: boolean;
  // Kept by a password manager that syncs it between devices.
  synced?: boolean;
  // Where it believes it is: a page elsewhere answering for this dashboard is refused.
  origin?: string;
}

/** A passkey kept in memory, answering as a phone or a password manager would, for tests. */
export class SoftwarePasskey {
  private readonly credentialId = randomBytes(CREDENTIAL_ID_BYTES);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;
  private userHandle = "";

  constructor(
    private readonly origin: string,
    // Changeable mid-test: the same passkey asked from somewhere else.
    readonly traits: PasskeyTraits = {},
  ) {}

  get id() {
    return base64url(this.credentialId);
  }

  register(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const publicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [COSE.keyType, COSE.ellipticCurve],
        [COSE.algorithm, COSE.es256],
        [COSE.curve, COSE.p256],
        [COSE.x, Buffer.from(jwk.x!, "base64url")],
        [COSE.y, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const length = Buffer.alloc(LENGTH_BYTES);
    length.writeUInt16BE(this.credentialId.length);
    const aaguid = Buffer.from((this.traits.aaguid ?? NO_AAGUID).replaceAll("-", ""), "hex");
    const authenticatorData = Buffer.concat([
      this.header(options.rp.id!, FLAGS.attestedData),
      aaguid,
      length,
      this.credentialId,
      publicKey,
    ]);
    const attestation = new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authenticatorData],
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(this.clientData("webauthn.create", options.challenge)),
        attestationObject: base64url(isoCBOR.encode(attestation as Parameters<typeof isoCBOR.encode>[0])),
        transports: ["internal"],
      },
    };
  }

  signIn(options: PublicKeyCredentialRequestOptionsJSON): AuthenticationResponseJSON {
    this.counter += 1;
    const authenticatorData = this.header(options.rpId!, 0);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientData)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientData),
        authenticatorData: base64url(authenticatorData),
        signature: base64url(signature),
        // One never registered anywhere has no handle to give.
        ...(this.userHandle === "" ? {} : { userHandle: this.userHandle }),
      },
    };
  }

  private header(relyingPartyId: string, extraFlags: number): Buffer {
    const verified = this.traits.userVerified ?? true;
    const synced = this.traits.synced ?? false;
    const flags =
      FLAGS.userPresent |
      (verified ? FLAGS.userVerified : 0) |
      (synced ? FLAGS.backupEligible | FLAGS.backedUp : 0) |
      extraFlags;
    const counter = Buffer.alloc(COUNTER_BYTES);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(relyingPartyId), Buffer.from([flags]), counter]);
  }

  private clientData(type: string, challenge: string): Buffer {
    const origin = this.traits.origin ?? this.origin;
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
}
