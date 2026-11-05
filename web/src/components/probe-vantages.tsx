import { useQuery } from "@tanstack/react-query";
import type { HostView } from "../../../src/shared/api.js";
import { HOST_KIND } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";
import { hostsQuery } from "../queries.js";

const text = TEXT.probes.vantage;

/** Autoheal itself, or any host in the fleet whose runner can make a check from where it is. */
export function useVantages(hostId: string) {
  const hosts = useQuery(hostsQuery);
  const fleet = (hosts.data ?? []).filter((host) => host.serviceProbes === true);
  const ownHost = fleet.find((host) => host.id === hostId);
  // The check's own host first: making it from there is the common wish.
  const others = fleet.filter((host) => host.id !== hostId);
  return ownHost === undefined ? others : [ownHost, ...others];
}

/** Where a check is made from: Autoheal, or a host that can make it itself. */
export function VantageChoice({
  hostId,
  value,
  onChange,
}: {
  hostId: string;
  value: string | null;
  onChange: (vantage: string | null) => void;
}) {
  const vantages = useVantages(hostId);
  return (
    <>
      <label>
        {text.label}
        <select
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">{text.controlPlane}</option>
          {vantages.map((host) => (
            <option key={host.id} value={host.id}>
              {text.fromHost(host.label)}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">{text.note}</p>
    </>
  );
}

/** Where one check is made from, for its row: said plainly, as two hosts may watch the same service. */
export function VantageLine({ vantage, hosts }: { vantage: string | null; hosts: readonly HostView[] }) {
  if (vantage === null) {
    return <span className="small muted">{text.madeHere}</span>;
  }
  const host = hosts.find((each) => each.id === vantage);
  if (host === undefined) {
    return <span className="small text-warning">{text.hostGone}</span>;
  }
  const watchesItself = host.kind === HOST_KIND.local;
  return <span className="small muted">{watchesItself ? text.madeHere : text.madeFrom(host.label)}</span>;
}
