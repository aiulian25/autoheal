import { useQuery } from "@tanstack/react-query";
import type { HomeAssistantView, WatchedDeviceView } from "../../../src/shared/api.js";
import {
  SAFETY_PROBLEMS,
  WATCHED_PROBLEMS,
  ZIGBEE_PROBLEMS,
  ZIGBEE_ROLES,
  wordsOf,
} from "../../../src/shared/constants.js";
import { Badge, ErrorNotice, Loading, PageHeader, TimeAgo } from "../components/common.js";
import { ProblemsOnlyToggle, useFilters } from "../components/filters.js";
import { QUERY_TRUE, SEARCH_PARAMETERS, TEXT } from "../constants.js";
import { percent } from "../format.js";
import { homeAssistantQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { HomeAssistantSystem } from "./home-assistant-system.js";
import { HomeReviewSection } from "./home-review.js";

function Missing() {
  return <span className="muted">{TEXT.none}</span>;
}

function HomeAssistantNotice({ view }: { view: HomeAssistantView }) {
  if (view.status.connected) {
    return null;
  }
  const text = view.status.configured
    ? TEXT.homeAssistant.disconnected(view.status.error)
    : TEXT.homeAssistant.notConfigured;
  return <p className="notice warning">{text}</p>;
}

function Availability({
  available,
  offlineLabel = ZIGBEE_PROBLEMS.unavailable,
}: {
  available: boolean | null;
  offlineLabel?: string;
}) {
  if (available === null) {
    return <Missing />;
  }
  return <Badge value={available ? TEXT.zigbee.online : offlineLabel} />;
}

function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) {
    return <Missing />;
  }
  return (
    <span className="row">
      {problems.map((problem) => (
        <Badge key={problem} value={problem} />
      ))}
    </span>
  );
}

// true is the bad state for alarms, faults and low batteries; null means the device has no such sensor.
function Flag({ value, bad }: { value: boolean | null; bad: string }) {
  if (value === null) {
    return <Missing />;
  }
  return <Badge value={value ? bad : TEXT.safety.ok} />;
}

function SafetySection({ view }: { view: HomeAssistantView }) {
  return (
    <details className="fold" open>
      <summary>
        <h2>{TEXT.safety.title}</h2>
      </summary>
      <p className="muted">{TEXT.safety.explanation}</p>
      {view.safety.length === 0 && <p className="muted">{TEXT.safety.empty}</p>}
      {view.safety.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.safety.device}</th>
                <th>{TEXT.safety.area}</th>
                <th>{TEXT.safety.alarm}</th>
                <th>{TEXT.safety.online}</th>
                <th>{TEXT.safety.battery}</th>
                <th>{TEXT.safety.fault}</th>
              </tr>
            </thead>
            <tbody>
              {view.safety.map((device) => (
                <tr key={device.id}>
                  <td>
                    <strong>{device.name}</strong>
                    <div className="muted small">{device.model ?? ""}</div>
                  </td>
                  <td>{device.area ?? <Missing />}</td>
                  <td>
                    <Flag value={device.alarm} bad={SAFETY_PROBLEMS.alarm} />
                  </td>
                  <td>
                    <Availability available={device.online} offlineLabel={SAFETY_PROBLEMS.offline} />
                  </td>
                  <td>
                    <Flag value={device.batteryLow} bad={SAFETY_PROBLEMS.batteryLow} />
                  </td>
                  <td>
                    <Flag value={device.fault} bad={SAFETY_PROBLEMS.fault} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

const countWith = (problems: readonly (readonly string[])[], problem: string) =>
  problems.filter((list) => list.includes(problem)).length;

function ZigbeeSection({ view }: { view: HomeAssistantView }) {
  const filters = useFilters();
  const meshDevices = view.zigbee.filter((device) => device.role !== ZIGBEE_ROLES.coordinator);
  const problemLists = meshDevices.map((device) => device.problems);
  const shown = view.zigbee.filter((device) => !filters.problemsOnly || device.problems.length > 0);
  return (
    <details className="fold" open>
      <summary>
        <h2>{TEXT.zigbee.title}</h2>
      </summary>
      {meshDevices.length > 0 && (
        <p className="muted">
          {TEXT.zigbee.summary(
            meshDevices.length,
            countWith(problemLists, ZIGBEE_PROBLEMS.unavailable),
            countWith(problemLists, ZIGBEE_PROBLEMS.lowBattery),
            countWith(problemLists, ZIGBEE_PROBLEMS.weakLink),
          )}
        </p>
      )}
      <div className="filters">
        <ProblemsOnlyToggle
          checked={filters.problemsOnly}
          onChange={(checked) => filters.set(SEARCH_PARAMETERS.problemsOnly, checked ? QUERY_TRUE : "")}
        />
      </div>
      {shown.length === 0 && <p className="muted">{TEXT.zigbee.empty}</p>}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.zigbee.device}</th>
                <th>{TEXT.zigbee.area}</th>
                <th>{TEXT.zigbee.role}</th>
                <th>{TEXT.zigbee.status}</th>
                <th>{TEXT.zigbee.battery}</th>
                <th>{TEXT.zigbee.linkQuality}</th>
                <th>{TEXT.zigbee.lastSeen}</th>
                <th>{TEXT.containers.problem}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((device) => (
                <tr key={device.id}>
                  <td>
                    <strong>{device.name}</strong>
                    <div className="muted small">{[device.manufacturer, device.model].filter(Boolean).join(" ")}</div>
                  </td>
                  <td>{device.area ?? <Missing />}</td>
                  <td className="small">{wordsOf(device.role)}</td>
                  <td>
                    <Availability available={device.available} />
                  </td>
                  <td>{device.batteryPercent === null ? <Missing /> : percent(device.batteryPercent)}</td>
                  <td>{device.linkQuality ?? <Missing />}</td>
                  <td>
                    <TimeAgo timestamp={device.lastSeen} />
                  </td>
                  <td>
                    <Problems problems={device.problems} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function groupByIntegration(devices: readonly WatchedDeviceView[]): [string, WatchedDeviceView[]][] {
  const groups = new Map<string, WatchedDeviceView[]>();
  for (const device of devices) {
    groups.set(device.integration, [...(groups.get(device.integration) ?? []), device]);
  }
  return [...groups.entries()];
}

function WatchedProblems({ device }: { device: WatchedDeviceView }) {
  if (device.available === false) {
    return <Badge value={WATCHED_PROBLEMS.unavailable} />;
  }
  if (device.problems.length === 0) {
    return <Missing />;
  }
  return (
    <span className="stack">
      {device.problems.map((entry) => (
        <span key={`${entry.entity}/${entry.problem}`} className="row">
          <Badge value={entry.problem} />
          <span className="small">{entry.entity}</span>
        </span>
      ))}
    </span>
  );
}

function WatchedSection({ view }: { view: HomeAssistantView }) {
  const groups = groupByIntegration(view.watched);
  return (
    <details className="fold" open>
      <summary>
        <h2>{TEXT.watched.title}</h2>
      </summary>
      <p className="muted">{TEXT.watched.explanation}</p>
      {groups.length === 0 && <p className="muted">{TEXT.watched.empty}</p>}
      {groups.map(([integration, devices]) => (
        <section key={integration} className="section">
          <h3>{TEXT.integrations[integration] ?? integration}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{TEXT.watched.device}</th>
                  <th>{TEXT.watched.area}</th>
                  <th>{TEXT.watched.problems}</th>
                  <th>{TEXT.watched.updates}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <strong>{device.name}</strong>
                    </td>
                    <td>{device.area ?? <Missing />}</td>
                    <td>
                      <WatchedProblems device={device} />
                    </td>
                    <td className="small">
                      {device.updatesAvailable === 0 ? (
                        <Missing />
                      ) : (
                        TEXT.watched.updatesAvailable(device.updatesAvailable)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </details>
  );
}

/** What Home Assistant knows, read-only, in one place: life safety first. */
export function HomeAssistantPage() {
  const homeAssistant = useQuery(homeAssistantQuery);
  const admin = isAdmin(useSignedInSession());
  return (
    <div className="page">
      <PageHeader title={TEXT.homeAssistant.title} lede={TEXT.homeAssistant.lede} />
      {homeAssistant.data === undefined && <Loading />}
      {homeAssistant.data !== undefined && (
        <>
          <HomeAssistantNotice view={homeAssistant.data} />
          {homeAssistant.data.status.configured && <HomeAssistantSystem view={homeAssistant.data} />}
          {admin && <HomeReviewSection />}
          <SafetySection view={homeAssistant.data} />
          <ZigbeeSection view={homeAssistant.data} />
          <WatchedSection view={homeAssistant.data} />
        </>
      )}
      <ErrorNotice error={homeAssistant.error} />
    </div>
  );
}
