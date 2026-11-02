import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP, isIPv4 } from "node:net";
import { join } from "node:path";
import {
  ALTERNATIVE_NAME_SEPARATOR,
  ALTERNATIVE_NAME_VALUE_SEPARATOR,
  DER,
  IPV6,
  IPV6_HOST_BRACKETS,
  MILLISECONDS_PER_DAY,
  OBJECT_IDENTIFIERS,
  PRIVATE_KEY_EXPORT,
  PUBLIC_KEY_EXPORT,
  SECRET_DIRECTORY_MODE,
  SECRET_FILE_MODE,
  TLS_BACKDATE_MILLISECONDS,
  TLS_CERTIFICATE_DAYS,
  TLS_CERTIFICATE_FILE_NAME,
  TLS_COMMON_NAME,
  TLS_KEY_CURVE,
  TLS_KEY_FILE_NAME,
  TLS_KEY_TYPE,
  TLS_RENEW_BEFORE_DAYS,
  TLS_SERIAL_BYTES,
  TLS_SIGNATURE_DIGEST,
} from "../../shared/constants.js";
import { publicKeyPin } from "../../shared/hash.js";

/** What both listeners serve, and the pin join codes carry. */
export interface ServerCertificate {
  key: string;
  certificate: string;
  // The SHA-256 of the certificate's public key: a runner accepts the control plane by it.
  pin: string;
}

// --- DER: as much as one self-signed certificate needs ---------------------------------------------

function encodedLength(size: number): Buffer {
  if (size < DER.longLength) {
    return Buffer.from([size]);
  }
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / DER.byteValues)) {
    bytes.unshift(rest % DER.byteValues);
  }
  return Buffer.from([DER.longLength | bytes.length, ...bytes]);
}

const element = (tag: number, content: Uint8Array) =>
  Buffer.concat([Buffer.from([tag]), encodedLength(content.length), content]);
const sequence = (...items: Uint8Array[]) => element(DER.tags.sequence, Buffer.concat(items));
const set = (...items: Uint8Array[]) => element(DER.tags.set, Buffer.concat(items));
const integer = (content: Uint8Array) => element(DER.tags.integer, content);
const octetString = (content: Uint8Array) => element(DER.tags.octetString, content);
const bitString = (content: Uint8Array, unusedBits: number = DER.noUnusedBits) =>
  element(DER.tags.bitString, Buffer.concat([Buffer.from([unusedBits]), content]));
const explicit = (tagNumber: number, content: Uint8Array) => element(DER.contextConstructed | tagNumber, content);

function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * DER.firstArcs + second];
  for (const arc of rest) {
    const groups = [arc % DER.base128];
    for (let value = Math.floor(arc / DER.base128); value > 0; value = Math.floor(value / DER.base128)) {
      groups.unshift((value % DER.base128) | DER.continuation);
    }
    bytes.push(...groups);
  }
  return element(DER.tags.objectIdentifier, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const digits = date.toISOString().slice(0, DER.isoSecondsLength).replace(DER.isoSeparators, "");
  if (date.getUTCFullYear() < DER.generalizedTimeFrom) {
    return element(DER.tags.utcTime, Buffer.from(`${digits.slice(DER.utcTimeCenturyDigits)}${DER.timeZoneSuffix}`));
  }
  return element(DER.tags.generalizedTime, Buffer.from(`${digits}${DER.timeZoneSuffix}`));
}

// WHATWG URL parsing gives equivalent IPv6 forms one spelling, including IPv4-mapped tails.
function normalizedName(value: string): string {
  const name = value.replace(IPV6_HOST_BRACKETS, "");
  return isIP(name) === IPV6 ? new URL(`https://[${name}]/`).hostname.slice(1, -1) : name;
}

function generalName(value: string): Buffer {
  const name = normalizedName(value);
  if (isIPv4(name)) {
    return element(DER.ipAddress, Buffer.from(name.split(".").map(Number)));
  }
  if (isIP(name) === IPV6) {
    const [head = "", tail = ""] = name.split("::");
    const left = head.split(":").filter(Boolean);
    const right = tail.split(":").filter(Boolean);
    // Eight 16-bit words in network byte order: RFC 5280's sixteen-octet iPAddress SAN.
    const words = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
    return element(DER.ipAddress, Buffer.from(words.map((word) => word.padStart(4, "0")).join(""), "hex"));
  }
  return element(DER.dnsName, Buffer.from(name));
}

function extension(identifier: string, value: Uint8Array, critical: boolean): Buffer {
  const criticality = critical ? [element(DER.tags.boolean, Buffer.from([DER.true]))] : [];
  return sequence(objectIdentifier(identifier), ...criticality, octetString(value));
}

// A positive serial with no leading zero byte, so its DER is exactly these bytes.
function serialNumber(): Buffer {
  const serial = randomBytes(TLS_SERIAL_BYTES);
  serial[0] = (serial[0]! & DER.serialFirstByteMask) | DER.serialFirstByteMinimum;
  return serial;
}

/** A self-signed ECDSA server certificate for `names` (DNS names, IPv4 or IPv6 addresses), as PEM. */
export function selfSignedCertificate(privateKey: KeyObject, names: readonly string[], now: number): string {
  const subject = sequence(
    set(
      sequence(
        objectIdentifier(OBJECT_IDENTIFIERS.commonName),
        element(DER.tags.utf8String, Buffer.from(TLS_COMMON_NAME)),
      ),
    ),
  );
  const algorithm = sequence(objectIdentifier(OBJECT_IDENTIFIERS.ecdsaWithSha256));
  const validity = sequence(
    time(new Date(now - TLS_BACKDATE_MILLISECONDS)),
    time(new Date(now + TLS_CERTIFICATE_DAYS * MILLISECONDS_PER_DAY)),
  );
  const extensions = sequence(
    extension(OBJECT_IDENTIFIERS.basicConstraints, sequence(), true),
    extension(
      OBJECT_IDENTIFIERS.keyUsage,
      bitString(Buffer.from([DER.digitalSignature]), DER.digitalSignatureUnusedBits),
      true,
    ),
    extension(OBJECT_IDENTIFIERS.extendedKeyUsage, sequence(objectIdentifier(OBJECT_IDENTIFIERS.serverAuth)), false),
    extension(OBJECT_IDENTIFIERS.subjectAltName, sequence(...names.map(generalName)), false),
  );
  const toBeSigned = sequence(
    explicit(DER.versionTag, integer(Buffer.from([DER.version3]))),
    integer(serialNumber()),
    algorithm,
    subject,
    validity,
    subject,
    createPublicKey(privateKey).export(PUBLIC_KEY_EXPORT),
    explicit(DER.extensionsTag, extensions),
  );
  const signature = sign(TLS_SIGNATURE_DIGEST, toBeSigned, privateKey);
  return new X509Certificate(sequence(toBeSigned, algorithm, bitString(signature))).toString();
}

const certificateNames = (names: readonly string[]) => [...new Set(names.map(normalizedName))].sort();

const namesIn = (certificate: X509Certificate) =>
  certificateNames(
    (certificate.subjectAltName ?? "")
      .split(ALTERNATIVE_NAME_SEPARATOR)
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf(ALTERNATIVE_NAME_VALUE_SEPARATOR) + 1)),
  );

function stillServes(certificate: string, privateKey: KeyObject, names: readonly string[], now: number): boolean {
  const parsed = new X509Certificate(certificate);
  return (
    parsed.checkPrivateKey(privateKey) &&
    Date.parse(parsed.validTo) - now > TLS_RENEW_BEFORE_DAYS * MILLISECONDS_PER_DAY &&
    namesIn(parsed).join() === names.join()
  );
}

function keyIn(path: string): string {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync(TLS_KEY_TYPE, { namedCurve: TLS_KEY_CURVE });
    writeFileSync(path, privateKey.export(PRIVATE_KEY_EXPORT), { mode: SECRET_FILE_MODE });
  }
  return readFileSync(path, "utf8");
}

/**
 * The certificate Autoheal makes for itself when given none. The key is made once and kept in
 * `directory`, so runners' pins survive; the certificate is signed again with it when it nears its
 * end or the dashboard's address changes. `issued` says whether that happened now.
 */
export function ownCertificate(
  directory: string,
  names: readonly string[],
  now: number,
): { material: ServerCertificate; issued: boolean } {
  mkdirSync(directory, { recursive: true, mode: SECRET_DIRECTORY_MODE });
  const key = keyIn(join(directory, TLS_KEY_FILE_NAME));
  const privateKey = createPrivateKey(key);
  const pin = publicKeyPin(createPublicKey(privateKey));
  const certificatePath = join(directory, TLS_CERTIFICATE_FILE_NAME);
  const wanted = certificateNames(names);
  const current = existsSync(certificatePath) ? readFileSync(certificatePath, "utf8") : null;
  if (current !== null && stillServes(current, privateKey, wanted, now)) {
    return { material: { key, certificate: current, pin }, issued: false };
  }
  const certificate = selfSignedCertificate(privateKey, wanted, now);
  writeFileSync(certificatePath, certificate);
  return { material: { key, certificate, pin }, issued: true };
}

/** The operator's own certificate and key, from their files: runners may trust its CA or its pin. */
export function providedCertificate(files: { certificateFile: string; keyFile: string }): ServerCertificate {
  const certificate = readFileSync(files.certificateFile, "utf8");
  return {
    key: readFileSync(files.keyFile, "utf8"),
    certificate,
    pin: publicKeyPin(new X509Certificate(certificate).publicKey),
  };
}
