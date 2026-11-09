import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES } from "../../../../src/shared/api.js";
import {
  INTERNET_STATE_WORDS,
  SPEED_SOURCE,
  type InternetState,
  type NetworkInternetView,
  type SpeedTestView,
} from "../../../../src/shared/network.js";
import { api } from "../../api-client.js";
import { ErrorNotice, Loading } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { PERCENT, ASKING_REFRESH_MILLISECONDS, REFRESH_MILLISECONDS } from "./network-refresh.js";

const text = TEXT.network;

const INTERNET_QUERY_KEY = ["network-internet"];

const FULL_SCALE_ROOM = 1.15;

function speedBarClass({ fair, source }: SpeedTestView) {
  if (!fair) return "speed-bar unfair";
  return source === SPEED_SOURCE.router ? "speed-bar" : "speed-bar own";
}

function SpeedChart({ view }: { view: NetworkInternetView }) {
  const { tests, contract } = view;
  const top = Math.max(1, contract?.downMbps ?? 0, ...tests.map(({ downMbps }) => downMbps)) * FULL_SCALE_ROOM;
  return (
    <div className="speed-chart" role="img" aria-label={text.internet.chartLabel}>
      {contract !== null && (
        <span className="speed-line" style={{ bottom: `${(contract.downMbps / top) * PERCENT}%` }}>
          <em>{text.internet.contractLine(contract.downMbps)}</em>
        </span>
      )}
      {tests.map((test) => (
        <span
          key={test.at}
          className={speedBarClass(test)}
          title={text.internet.barTitle(test.downMbps, new Date(test.at).toLocaleString(), test.fair)}
          style={{ height: `${(test.downMbps / top) * PERCENT}%` }}
        />
      ))}
    </div>
  );
}

export function Internet() {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: INTERNET_QUERY_KEY,
    queryFn: () => api<NetworkInternetView>("GET", API_ROUTES.networkInternet),
    refetchInterval: (query) =>
      query.state.data?.run.status === "running" ? ASKING_REFRESH_MILLISECONDS : REFRESH_MILLISECONDS,
  });
  const run = useMutation({
    mutationFn: () => api("POST", API_ROUTES.networkSpeedTest),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INTERNET_QUERY_KEY }),
  });
  const data = view.data;
  if (data === undefined) return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  const running = data.run.status === "running" || run.isPending;
  const latest = data.tests.at(-1);
  return (
    <div className="stack">
      <section className="card">
        <div className="row spread">
          <h3>{text.internet.speedTitle}</h3>
          <button type="button" className="primary" disabled={running} onClick={() => run.mutate()}>
            {text.internet.run}
          </button>
        </div>
        {running && (
          <p className="small" role="status">
            {text.internet.running}
          </p>
        )}
        {data.run.status === "failed" && (
          <p className="notice warning small">{text.internet.runFailed(data.run.error)}</p>
        )}
        <ErrorNotice error={run.error} />
        {latest !== undefined && (
          <p className="small">
            <strong>{text.internet.latest(latest.downMbps, latest.upMbps, latest.ping)}</strong>{" "}
            <span className="muted">
              {latest.source === SPEED_SOURCE.router ? text.internet.byRouter : text.internet.byThisMachine}
            </span>
          </p>
        )}
        <p className="small muted">{text.internet.fairNote}</p>
        {data.tests.length === 0 && <p className="muted">{text.internet.noTests}</p>}
        {data.tests.length > 0 && <SpeedChart view={data} />}
        {data.speedTestRefused && <p className="notice warning small">{text.internet.refused}</p>}
        <p className="small muted">{text.internet.serverNote}</p>
        <div className="row">
          <a className="button" href={API_ROUTES.networkInternetReport} download>
            {text.internet.download}
          </a>
        </div>
      </section>
      <div className="network-two">
        <section className="card">
          <h3>{text.internet.outages}</h3>
          {data.outages.length === 0 && <p className="muted">{text.internet.noOutages}</p>}
          {data.outages.map(({ from, to, state }) => (
            <p key={from} className="small">
              <strong>{new Date(from).toLocaleString()}</strong>{" "}
              {text.internet.lasted(to === null ? null : Math.round((to - from) / 60_000))}
              {TEXT.separator}
              <span className="muted">{INTERNET_STATE_WORDS[state as InternetState] ?? state}</span>
            </p>
          ))}
          <p className="small muted">{text.internet.notWatched}</p>
        </section>
        <section className="card">
          <h3>{text.internet.line}</h3>
          {data.lines.map(({ wan, up, latency }) => (
            <p key={wan} className="small">
              <strong>{wan}</strong> {up ? text.internet.lineUp : text.internet.lineDown}
              {latency !== null && ` ${TEXT.separator}${latency} ms`}
            </p>
          ))}
          {data.publicAddress !== null && <p className="small muted mono">{data.publicAddress}</p>}
        </section>
      </div>
    </div>
  );
}
