import { Link } from "react-router";
import { heldBackBy, type HostView } from "../../../../src/shared/api.js";
import { DETECTOR_THRESHOLDS, HOST_STATE } from "../../../../src/shared/constants.js";
import { fleetCounts } from "../../attention-places.js";
import { DISK_FULL_DANGER_PERCENT, PATHS, TEXT } from "../../constants.js";
import { percent, shortTimeAgo } from "../../format.js";
import { hostLink } from "../../host-links.js";
import { healingPaused, hostStateText } from "../fleet-page.js";

// Online, healing, and nothing holding its runner back.
const isFine = (host: HostView) =>
  host.state === HOST_STATE.online && !healingPaused(host) && heldBackBy(host).length === 0;

const Dot = ({ tone }: { tone: "good" | "warning" | "danger" }) => <span className={`status-dot tone-${tone}`} />;

function diskTone(filled: number): "good" | "warning" | "danger" {
  if (filled >= DISK_FULL_DANGER_PERCENT) return "danger";
  return filled >= DETECTOR_THRESHOLDS.diskPercent ? "warning" : "good";
}

/** How the fleet stands, in one line under the title: it names what is wrong, and only counts what is fine. */
export function FleetLine({ hosts }: { hosts: readonly HostView[] }) {
  const counts = fleetCounts(hosts);
  const text = TEXT.attention.fleet;
  const notFine = hosts.filter((host) => !isFine(host));
  const fullest = counts.fullest;
  return (
    <p className="fleet-line" aria-label={text.label}>
      <span>
        <Dot tone={counts.online === counts.total ? "good" : "warning"} />
        <strong>{text.hostsOnline(counts.online, counts.total)}</strong> {text.online}
      </span>
      {notFine.map((host) => (
        <Link key={host.id} className="fleet-wrong" to={hostLink(host.id)}>
          <Dot tone="danger" />
          <strong>
            {host.label} {hostStateText(host)}
          </strong>
          {host.state !== HOST_STATE.online && host.lastHeartbeatAt !== null && (
            <span>{shortTimeAgo(host.lastHeartbeatAt)}</span>
          )}
        </Link>
      ))}
      <span>
        <Dot tone={counts.running === counts.containers ? "good" : "warning"} />
        <strong>{text.containers(counts.running, counts.containers)}</strong> {text.running}
      </span>
      {fullest !== null && (
        <span>
          <Dot tone={diskTone(fullest.percent)} />
          {text.fullestDisk}{" "}
          <strong className={fullest.percent >= DETECTOR_THRESHOLDS.diskPercent ? "text-danger" : undefined}>
            {percent(fullest.percent)}
          </strong>{" "}
          {text.on(fullest.host.label)}
        </span>
      )}
      <Link to={PATHS.hosts}>{text.link}</Link>
    </p>
  );
}
