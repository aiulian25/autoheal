import { CERTIFICATE_STATUS, type CertificateStatus, type ProbeCertificate } from "../../../src/shared/probes.js";
import { TEXT } from "../constants.js";
import { Badge, TimeAgo } from "./common.js";

const text = TEXT.probes;
const toneOf = (status: CertificateStatus) => {
  if (status === CERTIFICATE_STATUS.valid) return "good";
  return status === CERTIFICATE_STATUS.expiring ? "warning" : "danger";
};
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The certificate a check last saw, with the dates that say how current this is. */
export function CertificateStatusLine({
  certificate,
  status,
}: {
  certificate: ProbeCertificate;
  status: CertificateStatus;
}) {
  return (
    <div className="small stack">
      <p>
        <Badge value={text.certificate[status]} tone={toneOf(status)} />{" "}
        <span className="muted">{text.certificateFacts(certificate.name, certificate.issuer)}</span>
      </p>
      <p className="muted">
        {text.certificateDates} {dayOf(certificate.validTo)} · {text.certificateSeen}{" "}
        <TimeAgo timestamp={certificate.observedAt} /> · {text.certificateSince}{" "}
        <TimeAgo timestamp={certificate.firstSeenAt} />
      </p>
      {certificate.chainError !== null && <p className="muted mono">{certificate.chainError}</p>}
    </div>
  );
}
