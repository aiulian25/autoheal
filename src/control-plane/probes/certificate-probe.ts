import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { connect } from "node:tls";
import type { ProbeCertificate, ProbeTarget } from "../../shared/probes.js";

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
    const socket = connect({
      host: address,
      port: target.port,
      rejectUnauthorized: false,
      ...(isIP(name) === 0 ? { servername: name } : {}),
      ...(target.caPem === null ? {} : { ca: target.caPem }),
    });
    limit.addEventListener("abort", () => socket.destroy(), { once: true });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const presented = socket.getPeerX509Certificate();
      const chainError = socket.authorized ? null : String(socket.authorizationError);
      socket.destroy();
      if (presented === undefined) {
        reject(new Error("The endpoint presented no certificate."));
        return;
      }
      resolve({
        fingerprint: presented.fingerprint256,
        subject: presented.subject.replaceAll("\n", ", "),
        issuer: presented.issuer.replaceAll("\n", ", "),
        validFrom: Date.parse(presented.validFrom),
        validTo: Date.parse(presented.validTo),
        name,
        nameMatches: (isIP(name) === 0 ? presented.checkHost(name) : presented.checkIP(name)) !== undefined,
        chainError,
      });
    });
  });
}
