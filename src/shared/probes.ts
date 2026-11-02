import { z } from "zod";

export const PROBE_KIND = { http: "http", tcp: "tcp", dns: "dns", tls: "tls" } as const;
// Which addresses a check may reach, chosen when it is made and held at every check, whatever a name resolves to then.
export const PROBE_SCOPE = {
  thisMachine: "this-machine",
  localNetwork: "local-network",
  internet: "internet",
} as const;
export const PROBE_STATE = { unknown: "unknown", up: "up", down: "down" } as const;
export const PROBE_OUTCOME = { up: "up", down: "down", maintenance: "maintenance" } as const;
export type ProbeScope = (typeof PROBE_SCOPE)[keyof typeof PROBE_SCOPE];
export type ProbeState = (typeof PROBE_STATE)[keyof typeof PROBE_STATE];
export type ProbeOutcome = (typeof PROBE_OUTCOME)[keyof typeof PROBE_OUTCOME];

export const PROBE_LIMITS = {
  perHost: 32,
  total: 256,
  atOnce: 8,
  nameCharacters: 80,
  targetCharacters: 512,
  problemCharacters: 300,
  intervalSeconds: { minimum: 30, maximum: 3600, usual: 60 },
  timeoutSeconds: { minimum: 1, maximum: 30, usual: 5 },
  failuresBeforeDown: { minimum: 1, maximum: 10, usual: 3 },
  // It must answer twice in a row to count as back, so one lucky answer does not close and reopen a task.
  answersBeforeUp: 2,
  samplesKept: 2880,
  samplesShown: 288,
  hoursKept: 90 * 24,
  warnDays: { minimum: 1, maximum: 365, usual: 30 },
  trustCharacters: 16_384,
  statusFrom: 100,
  statusTo: 599,
  portTo: 65535,
} as const;
export const PROBE_DNS_PORT = 53;
export const PROBE_TICK_MILLISECONDS = 5_000;
export const PROBE_WINDOWS = { day: 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000 } as const;

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*\.?$/iu;
// Its shape only, as this also runs in the browser: the control plane checks the address itself.
const ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:.]*:[0-9a-f:.]*)$/iu;
const isAddress = (value: string) => ADDRESS.test(value);
const isHost = (value: string) => isAddress(value) || HOST_NAME.test(value);
const hostField = z.string().trim().max(PROBE_LIMITS.targetCharacters).refine(isHost);

// No names, passwords or query strings: a check has nothing secret to keep, and nothing to redact.
const isPlainWebAddress = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol, username, password, search, hash } = new URL(value);
  const isWeb = protocol === "http:" || protocol === "https:";
  return isWeb && username === "" && password === "" && search === "" && hash === "";
};

// A certificate to trust, and never a key: only a public certificate is ever kept.
const isCertificateText = (value: string) =>
  value.includes("-----BEGIN CERTIFICATE-----") && !value.includes("PRIVATE KEY");

const portField = z.number().int().min(1).max(PROBE_LIMITS.portTo);
const probeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(PROBE_KIND.http),
      url: z.string().trim().max(PROBE_LIMITS.targetCharacters).refine(isPlainWebAddress),
      expectedStatus: z.number().int().min(PROBE_LIMITS.statusFrom).max(PROBE_LIMITS.statusTo),
      // For a service on its own certificate: only whether it answers is asked here.
      ignoreCertificate: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal(PROBE_KIND.tcp), host: hostField, port: portField }).strict(),
  z
    .object({
      kind: z.literal(PROBE_KIND.tls),
      host: hostField,
      port: portField,
      // The name clients ask for, when that is not the host connected to.
      serverName: hostField.nullable(),
      warnDays: z.number().int().min(PROBE_LIMITS.warnDays.minimum).max(PROBE_LIMITS.warnDays.maximum),
      // Null trusts the system's authorities. A private authority or self-signed certificate is trusted by naming it.
      caPem: z.string().trim().max(PROBE_LIMITS.trustCharacters).refine(isCertificateText).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(PROBE_KIND.dns),
      name: hostField,
      // Null asks this machine's own resolver, which is not a destination chosen here.
      server: z.string().trim().refine(isAddress).nullable(),
      port: portField,
      expectedAnswer: z.string().trim().max(PROBE_LIMITS.targetCharacters).nullable(),
    })
    .strict(),
]);
export type ProbeTarget = z.infer<typeof probeTargetSchema>;

const { intervalSeconds, timeoutSeconds, failuresBeforeDown } = PROBE_LIMITS;
export const probeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(PROBE_LIMITS.nameCharacters),
    scope: z.enum(Object.values(PROBE_SCOPE)),
    intervalSeconds: z.number().int().min(intervalSeconds.minimum).max(intervalSeconds.maximum),
    timeoutSeconds: z.number().int().min(timeoutSeconds.minimum).max(timeoutSeconds.maximum),
    failuresBeforeDown: z.number().int().min(failuresBeforeDown.minimum).max(failuresBeforeDown.maximum),
    objectivePercent: z.number().min(0).max(100).nullable(),
    target: probeTargetSchema,
  })
  .strict();
export type ProbeBody = z.infer<typeof probeBodySchema>;

export interface ProbeAvailability {
  // Of the checks that ran outside maintenance; null when none did.
  percent: number | null;
  down: number;
  maintenance: number;
  // The share of the time since it was made in which no check ran, so what was never seen does not count as up.
  unknownPercent: number;
}

export const CERTIFICATE_STATUS = {
  valid: "valid",
  expiring: "expiring",
  expired: "expired",
  notYetValid: "not_yet_valid",
  wrongName: "wrong_name",
  untrusted: "untrusted",
} as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUS)[keyof typeof CERTIFICATE_STATUS];

// Public facts only. There is no private key to keep: an endpoint never sends one.
export interface ProbeCertificate {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: number;
  validTo: number;
  name: string;
  nameMatches: boolean;
  chainError: string | null;
  observedAt: number;
  // When this very certificate was first seen, so a rotation shows.
  firstSeenAt: number;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** What a certificate means now: dates first, as an expired one is expired whoever issued it. */
export function certificateStatusOf(certificate: ProbeCertificate, warnDays: number, now: number): CertificateStatus {
  if (now >= certificate.validTo) return CERTIFICATE_STATUS.expired;
  if (now < certificate.validFrom) return CERTIFICATE_STATUS.notYetValid;
  if (!certificate.nameMatches) return CERTIFICATE_STATUS.wrongName;
  if (certificate.chainError !== null) return CERTIFICATE_STATUS.untrusted;
  return certificate.validTo - now <= warnDays * MILLISECONDS_PER_DAY
    ? CERTIFICATE_STATUS.expiring
    : CERTIFICATE_STATUS.valid;
}

export interface ProbeView extends ProbeBody {
  id: string;
  hostId: string;
  state: ProbeState;
  stateSince: number;
  inMaintenance: boolean;
  lastCheckedAt: number | null;
  lastLatencyMilliseconds: number | null;
  lastProblem: string | null;
  // TLS checks only, once one has seen a certificate: the last it saw, kept while the endpoint cannot be reached.
  certificate: ProbeCertificate | null;
  certificateStatus: CertificateStatus | null;
  day: ProbeAvailability;
  month: ProbeAvailability;
  // Oldest first.
  samples: { at: number; outcome: ProbeOutcome; latencyMilliseconds: number | null }[];
}

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export const PROBE_TEXT = {
  certificate: (name: string, host: string, status: CertificateStatus, certificate: ProbeCertificate) => {
    const seen = `seen ${dayOf(certificate.observedAt)}`;
    const said: Record<CertificateStatus, string> = {
      valid: "is valid",
      expiring: `expires ${dayOf(certificate.validTo)}`,
      expired: `expired ${dayOf(certificate.validTo)}`,
      not_yet_valid: `is not valid until ${dayOf(certificate.validFrom)}`,
      wrong_name: `does not cover ${certificate.name}`,
      untrusted: `is not trusted (${certificate.chainError ?? "unknown"})`,
    };
    return `The certificate of ${name} on ${host} ${said[status]} (${seen})`;
  },
  certificateDetails: (certificate: ProbeCertificate) =>
    `Asked for ${certificate.name}. Issued to ${certificate.subject} by ${certificate.issuer}, ` +
    `valid ${dayOf(certificate.validFrom)} to ${dayOf(certificate.validTo)}. Fingerprint ${certificate.fingerprint}. ` +
    "Autoheal does not renew certificates. This clears once a check sees a valid one.",
  // The reason is in the title, as that is what Attention shows.
  down: (name: string, host: string, problem: string | null) =>
    `${name} on ${host} is not answering${problem === null ? "." : `: ${problem}`}`,
  downDetails: (problem: string | null, failures: number) =>
    `${problem ?? "It did not answer."} ${failures} checks in a row failed. Nothing is restarted because of this.`,
  timedOut: (seconds: number) => `It did not answer within ${seconds} seconds.`,
  wrongStatus: (status: number, expected: number) => `It answered ${status}, not ${expected}.`,
  noAnswer: "The name has no address.",
  wrongAnswer: (expected: string) => `The name did not resolve to ${expected}.`,
  refused: "It resolves to an address outside what this check may reach, so it was not contacted.",
} as const;
