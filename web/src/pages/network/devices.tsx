import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath } from "../../../../src/shared/api.js";
import { sizeText } from "../../../../src/shared/constants.js";
import { type NetworkDeviceDetailView, type NetworkDeviceView } from "../../../../src/shared/network.js";
import { api } from "../../api-client.js";
import { useAskInPlace } from "../../components/ask-in-place.js";
import { ErrorNotice, Loading, TimeAgo } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { ASKING_REFRESH_MILLISECONDS, REFRESH_MILLISECONDS, MINIMUM_BAR_PERCENT, PERCENT } from "./network-refresh.js";

const text = TEXT.network;

const PERIODS = ["day", "week", "month"] as const;

function DeviceDetail({ mac, onClose }: { mac: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
  const key = ["network-device", mac];
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api<NetworkDeviceDetailView>("GET", apiPath(API_ROUTES.networkDevice, { mac })),
    refetchInterval: (query) =>
      query.state.data?.run.status === "running" ? ASKING_REFRESH_MILLISECONDS : REFRESH_MILLISECONDS,
  });
  const refresh = () => void queryClient.invalidateQueries();
  const change = useMutation({
    mutationFn: (body: object) => api("PUT", apiPath(API_ROUTES.networkDevice, { mac }), body),
    onSuccess: refresh,
  });
  const ask = useMutation({
    mutationFn: () => api("POST", API_ROUTES.networkAsk, { mac }),
    onSuccess: refresh,
  });
  const view = detail.data;
  if (view === undefined) return detail.error ? <ErrorNotice error={detail.error} /> : <Loading />;
  const { device, run } = view;
  // Left empty, it goes back to the name the router knows it by.
  const askAboutName = () =>
    asking.askName(text.device.namePrompt, device.name, (name) => change.mutate({ givenName: name }), {
      required: false,
    });
  return (
    <section className="network-detail" aria-label={device.name}>
      <header className="row spread">
        <strong>{device.name}</strong>
        <button type="button" className="quiet" onClick={onClose}>
          {text.close}
        </button>
      </header>
      <p className="small muted">{text.device.facts(device)}</p>
      <p className="small">{text.device.dropped(view.dropTimes.length)}</p>
      {view.dropTimes.length > 0 && (
        <p className="small muted">
          {view.dropTimes
            .slice(-5)
            .map((at) => new Date(at).toLocaleString())
            .join(TEXT.separator)}
        </p>
      )}
      {view.talks.length > 0 && (
        <ul className="small">
          {view.talks.slice(0, 8).map(({ other, port, lines, blocked }) => (
            <li key={`${other}:${port}:${blocked}`}>{text.device.talk(other, port, lines, blocked)}</li>
          ))}
        </ul>
      )}
      {run.status === "running" && <p className="small muted">{text.thinking}</p>}
      {run.status === "failed" && <p className="notice warning small">{text.askFailed(run.error)}</p>}
      {run.status === "done" && (
        <div className="network-answer">
          <span className="small muted">{text.answeredBy(run.server)}</span>
          <p>{run.text}</p>
        </div>
      )}
      <div className="row">
        <button type="button" disabled={run.status === "running"} onClick={() => ask.mutate()}>
          {run.status === "idle" ? text.device.ask : text.device.askAgain}
        </button>
        {!device.known && (
          <button type="button" className="primary" onClick={() => change.mutate({ known: true })}>
            {text.device.known}
          </button>
        )}
        <button type="button" onClick={askAboutName}>
          {text.device.name}
        </button>
        <button type="button" onClick={() => change.mutate({ muted: !device.muted })}>
          {device.muted ? text.device.unmute : text.device.mute}
        </button>
      </div>
      {!device.known && <p className="small muted">{text.device.notMine}</p>}
      {asking.question}
      <ErrorNotice error={change.error ?? ask.error} />
    </section>
  );
}

const DEVICE_FILTERS = {
  all: () => true,
  new: (device: NetworkDeviceView) => !device.known,
  dropping: (device: NetworkDeviceView) => device.oftenDrops,
  unusual: (device: NetworkDeviceView) => device.unusual,
  offline: (device: NetworkDeviceView) => !device.online,
};

type DeviceFilter = keyof typeof DEVICE_FILTERS;

const DEVICE_FILTER_NAMES = Object.keys(DEVICE_FILTERS) as DeviceFilter[];

function DeviceTags({ device }: { device: NetworkDeviceView }) {
  return (
    <>
      {!device.known && <span className="badge good">{text.device.tagNew}</span>}
      {device.unusual && <span className="badge warning">{text.device.tagUnusual}</span>}
      {device.oftenDrops && <span className="badge warning">{text.device.tagDrops}</span>}
      {device.privateAddress && <span className="badge neutral">{text.device.tagPrivate}</span>}
      {device.muted && <span className="badge neutral">{text.device.tagMuted}</span>}
    </>
  );
}

export function Devices() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("day");
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const [opened, setOpened] = useState<string | null>(null);
  const devices = useQuery({
    queryKey: ["network-devices", period],
    queryFn: () => api<NetworkDeviceView[]>("GET", `${API_ROUTES.networkDevices}?period=${period}`),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  const list = devices.data ?? [];
  const shown = list.filter(DEVICE_FILTERS[filter]);
  const largest = Math.max(1, ...list.map(({ periodBytes }) => periodBytes));
  return (
    <div className="stack">
      <div className="row spread">
        <div className="show-chips" role="group" aria-label={text.device.filterLabel}>
          {DEVICE_FILTER_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className={name === filter ? "chip-button active" : "chip-button"}
              aria-pressed={name === filter}
              onClick={() => setFilter(name)}
            >
              {text.device.filters[name]} <span className="tab-count">{list.filter(DEVICE_FILTERS[name]).length}</span>
            </button>
          ))}
        </div>
        <div className="show-chips" role="group" aria-label={text.device.periodLabel}>
          {PERIODS.map((name) => (
            <button
              key={name}
              type="button"
              className={name === period ? "chip-button active" : "chip-button"}
              aria-pressed={name === period}
              onClick={() => setPeriod(name)}
            >
              {text.device.periods[name]}
            </button>
          ))}
        </div>
      </div>
      {devices.data === undefined && !devices.error && <Loading />}
      <ErrorNotice error={devices.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{text.device.columns.device}</th>
              <th>{text.device.columns.network}</th>
              <th>{text.device.columns.used}</th>
              <th>{text.device.columns.usual}</th>
              <th>{text.device.columns.drops}</th>
              <th>{text.device.columns.now}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && devices.data !== undefined && (
              <tr>
                <td colSpan={6} className="muted">
                  {text.nothingYet}
                </td>
              </tr>
            )}
            {shown.flatMap((device) => [
              <tr key={device.mac}>
                <td>
                  <span className="row">
                    <button
                      type="button"
                      className="link"
                      aria-expanded={opened === device.mac}
                      onClick={() => setOpened(opened === device.mac ? null : device.mac)}
                    >
                      {device.name}
                    </button>
                    <DeviceTags device={device} />
                  </span>
                </td>
                <td className="muted">{device.network ?? TEXT.none}</td>
                <td>
                  <span className="network-bar-cell">
                    <span>{sizeText(device.periodBytes)}</span>
                    <span className="network-bar">
                      <i
                        className={device.unusual ? "warning" : undefined}
                        style={{ width: `${Math.max(MINIMUM_BAR_PERCENT, (device.periodBytes / largest) * PERCENT)}%` }}
                      />
                    </span>
                  </span>
                </td>
                <td className="muted">
                  {device.usualBytes === null ? text.device.learning : sizeText(device.usualBytes)}
                </td>
                <td>{device.drops}</td>
                <td className={device.online ? "text-good" : "muted"}>
                  {device.online ? text.device.online : <TimeAgo timestamp={device.lastSeen} />}
                </td>
              </tr>,
              ...(opened === device.mac
                ? [
                    <tr key={`${device.mac}-open`}>
                      <td colSpan={6}>
                        <DeviceDetail mac={device.mac} onClose={() => setOpened(null)} />
                      </td>
                    </tr>,
                  ]
                : []),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}
