import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES } from "../../../../src/shared/api.js";
import { CHECK_RESULT, type NetworkFirewallView } from "../../../../src/shared/network.js";
import { api } from "../../api-client.js";
import { ErrorNotice, Loading, TimeAgo } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { REFRESH_MILLISECONDS } from "./network-refresh.js";

const text = TEXT.network;

const CHECK_MARK = { [CHECK_RESULT.passed]: "✓", [CHECK_RESULT.failed]: "!", [CHECK_RESULT.notTested]: "○" };

const CHECK_CLASS = {
  [CHECK_RESULT.passed]: "text-good",
  [CHECK_RESULT.failed]: "text-warning",
  [CHECK_RESULT.notTested]: "muted",
};

export function Firewall() {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["network-firewall"],
    queryFn: () => api<NetworkFirewallView>("GET", API_ROUTES.networkFirewall),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  const confirm = useMutation({
    mutationFn: () => api("POST", API_ROUTES.networkFirewallConfirm),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const data = view.data;
  if (data === undefined) return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  const waiting = data.checks.some(({ key, result }) => key === "rules" && result === CHECK_RESULT.failed);
  return (
    <div className="stack">
      <section className="card">
        <h3>{text.firewall.evidence}</h3>
        <p className="small muted">{text.firewall.noClaim}</p>
        {data.checks.map(({ key, result }) => (
          <p key={key} className="small">
            <span className={CHECK_CLASS[result]}>{CHECK_MARK[result]}</span>{" "}
            {text.firewall.checks[key as keyof typeof text.firewall.checks][result]}
          </p>
        ))}
        {data.logLastAt !== null && (
          <p className="small muted">
            {text.firewall.logsLast}: <TimeAgo timestamp={data.logLastAt} />
          </p>
        )}
        {data.logLastAt !== null && <p className="small muted">{text.firewall.logsTrust}</p>}
        {data.logRefusedSender !== null && (
          <p className="notice warning small">{text.firewall.logsRefused(data.logRefusedSender)}</p>
        )}
        {data.logRefusedSender === null && data.logIgnored !== null && (
          <p className="small muted">
            {text.firewall.logsIgnored(data.logIgnored.lines, data.logIgnored.sender)}{" "}
            <TimeAgo timestamp={data.logIgnored.at} />.
          </p>
        )}
        {data.logNameUnresolved && <p className="notice warning small">{text.firewall.logsNameUnresolved}</p>}
      </section>
      <div className="network-two">
        <section className="card">
          <h3>{text.firewall.open}</h3>
          {!data.exposureReadable && <p className="muted">{text.firewall.cannotRead}</p>}
          {data.exposureReadable && data.forwards.length === 0 && <p className="muted">{text.firewall.noForwards}</p>}
          {data.forwards.map(({ name, detail, isNew }) => (
            <p key={`${name}${detail}`} className="small">
              <strong>{name}</strong> <span className="mono">{detail}</span>{" "}
              {isNew && <span className="text-warning">{text.firewall.isNew}</span>}
            </p>
          ))}
          {data.rules.length > 0 && <p className="small muted">{text.firewall.rules(data.rules.length)}</p>}
          {waiting && (
            <button type="button" className="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
              {text.firewall.iMadeThis}
            </button>
          )}
          <ErrorNotice error={confirm.error} />
        </section>
        <section className="card">
          <h3>{text.firewall.blocked}</h3>
          {data.blocked7Days === null && <p className="muted">{text.firewall.logsOff}</p>}
          {data.blocked7Days !== null && <p className="network-big">{data.blocked7Days.toLocaleString()}</p>}
          {data.blocked7Days !== null && <p className="small muted">{text.firewall.blockedNote}</p>}
          {data.crossing.slice(0, 8).map(({ source, destination, port, lines, blocked }) => (
            <p key={`${source}${destination}${port}${blocked}`} className="small">
              <strong>{source}</strong> {text.firewall.to} <strong>{destination}</strong>
              {TEXT.separator}
              {text.firewall.crossing(port, lines, blocked)}
            </p>
          ))}
        </section>
      </div>
    </div>
  );
}
