import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { connect } from "node:tls";
import { PROBE_TEXT, type ProbeCertificate, type ProbeTarget } from "../../shared/probes.js";

export type CertificateTarget = Extract<ProbeTarget, { kind: "tls" }>;
export type ObservedCertificate = Omit<ProbeCertificate, "observedAt" | "firstSeenAt">;

/** Whether what was given to trust is a certificate this can use. */
export function trustIsUsable({ caPem }: CertificateTarget) {
  if (caPem === null) return true;
  try {
    new X509Certificate(caPem);
    return true;
  } catch {
    return false;
  }
}

/**
 * What an endpoint presents, against the trust this check names: the system's authorities, or only the one given. It
 * is looked at and judged here, not refused, so a bad certificate can be reported. Nothing but the handshake is sent.
 */
export function observeCertificate(target: CertificateTarget, address: string, limit: AbortSignal) {
  const name = target.serverName ?? target.host;
  return new Promise<ObservedCertificate>((resolve, reject) => {
    // Asked after its time was up: nothing is opened at all. A signal that has already fired never fires again, so
    // this cannot be left to the listener below.
    if (limit.aborted) {
      reject(new Error(PROBE_TEXT.cancelled));
      return;
    }
    const socket = connect({
      host: address,
      port: target.port,
      rejectUnauthorized: false,
      ...(isIP(name) === 0 ? { servername: name } : {}),
      ...(target.caPem === null ? {} : { ca: target.caPem }),
    });
    // One way out, however it ends: the socket goes, the listener goes, and the promise settles once. A peer that
    // answers the connect and never speaks TLS ends through close, not error, so that has to count as an ending too.
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      limit.removeEventListener("abort", stop);
      socket.destroy();
      outcome();
    };
    const stop = () => finish(() => reject(new Error(PROBE_TEXT.cancelled)));
    limit.addEventListener("abort", stop, { once: true });
    socket.once("error", (error: Error) => finish(() => reject(error)));
    // A peer that says it is done, or hangs up, before the handshake: both are an answer, and neither waits for
    // the deadline. An "end" leaves this side half-open, so it has to be let go of here.
    socket.once("end", () => finish(() => reject(new Error(PROBE_TEXT.closedEarly))));
    socket.once("close", () => finish(() => reject(new Error(PROBE_TEXT.closedEarly))));
    socket.once("secureConnect", () => {
      const presented = socket.getPeerX509Certificate();
      const chainError = socket.authorized ? null : String(socket.authorizationError);
      if (presented === undefined) {
        finish(() => reject(new Error("The endpoint presented no certificate.")));
        return;
      }
      const observed: ObservedCertificate = {
        fingerprint: presented.fingerprint256,
        subject: presented.subject.replaceAll("\n", ", "),
        issuer: presented.issuer.replaceAll("\n", ", "),
        validFrom: Date.parse(presented.validFrom),
        validTo: Date.parse(presented.validTo),
        name,
        nameMatches: (isIP(name) === 0 ? presented.checkHost(name) : presented.checkIP(name)) !== undefined,
        chainError,
      };
      finish(() => resolve(observed));
    });
  });
}
