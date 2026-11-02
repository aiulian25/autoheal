import type { ContainerUsageView, HostMetricsView } from "../../shared/api.js";
import {
  METRICS_FRESH_MILLISECONDS,
  METRICS_FLEET_LIMITS,
  METRICS_HISTORY_MILLISECONDS,
  METRICS_HISTORY_POINTS,
  REPORT_LIMITS,
} from "../../shared/constants.js";
import { log } from "../../shared/log.js";
import type { MetricsReport } from "../../shared/protocol.js";

interface HostSeries {
  host: HostMetricsView[];
  containers: Map<string, ContainerUsageView[]>;
  reportedAt: number;
  points: number;
}

// Inside the history window, and never more points than a runner reporting on time would send.
const trimmed = <Point extends { at: number }>(points: Point[], now: number) =>
  points
    .filter((point) => point.at >= now - METRICS_HISTORY_MILLISECONDS && point.at <= now)
    .slice(-METRICS_HISTORY_POINTS);

const newestFirst = ([, first]: [string, ContainerUsageView[]], [, second]: [string, ContainerUsageView[]]) =>
  (second.at(-1)?.at ?? 0) - (first.at(-1)?.at ?? 0);

/**
 * The last half hour of live stats for every host and container, as their runners report them.
 * Each runner gets a fixed budget of series and points, however often or widely it reports.
 */
export class MetricsStore {
  private readonly hosts = new Map<string, HostSeries>();

  private points = 0;
  private pressureNoted = false;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly limits: Readonly<{ hosts: number; points: number }> = METRICS_FLEET_LIMITS,
    private readonly isActive: (hostId: string) => boolean = () => true,
    private readonly durable?: { record(hostId: string, report: MetricsReport): void; sweep(): void },
  ) {
    if (![limits.hosts, limits.points].every((limit) => Number.isSafeInteger(limit) && limit > 0))
      throw new RangeError("Metrics retention limits must be positive integers.");
  }

  get retained() {
    return { hosts: this.hosts.size, points: this.points };
  }

  remove(hostId: string) {
    const series = this.hosts.get(hostId);
    if (series !== undefined) this.points -= series.points;
    this.hosts.delete(hostId);
  }

  /** Reclaims dormant and revoked series even when their runners and dashboards are quiet. */
  sweep() {
    const now = this.clock();
    for (const hostId of this.hosts.keys()) this.current(hostId, now);
    this.durable?.sweep();
  }

  clear() {
    this.hosts.clear();
    this.points = 0;
    this.pressureNoted = false;
  }

  record(hostId: string, report: MetricsReport) {
    if (!this.isActive(hostId)) {
      this.remove(hostId);
      return;
    }
    const at = this.clock();
    const series: HostSeries = this.hosts.get(hostId) ?? { host: [], containers: new Map(), reportedAt: at, points: 0 };
    if (report.host !== null) series.host.push({ ...report.host, at });
    for (const { name, ...usage } of report.containers) {
      series.containers.set(name, [...(series.containers.get(name) ?? []), { ...usage, at }]);
    }
    series.reportedAt = at;
    this.trim(series, at);
    // Report recency controls budget eviction; merely viewing a chart never renews its retention.
    this.hosts.delete(hostId);
    this.hosts.set(hostId, series);
    if (series.points === 0) this.remove(hostId);
    this.limitFleet();
    this.durable?.record(hostId, report);
  }

  private resize(series: HostSeries) {
    const points = series.host.length + [...series.containers.values()].reduce((sum, rows) => sum + rows.length, 0);
    this.points += points - series.points;
    series.points = points;
  }

  private trim(series: HostSeries, now: number) {
    series.host = trimmed(series.host, now);
    // Stopped or renamed containers keep history only until it ages out.
    series.containers = new Map(
      [...series.containers]
        .map(([name, points]): [string, ContainerUsageView[]] => [name, trimmed(points, now)])
        .filter(([, points]) => points.length > 0)
        .sort(newestFirst)
        .slice(0, REPORT_LIMITS.containers),
    );
    this.resize(series);
  }

  private current(hostId: string, now: number): HostSeries | undefined {
    const series = this.hosts.get(hostId);
    if (series === undefined) return undefined;
    if (!this.isActive(hostId)) {
      this.remove(hostId);
      return undefined;
    }
    this.trim(series, now);
    if (series.points === 0) {
      this.remove(hostId);
      return undefined;
    }
    return series;
  }

  private limitFleet() {
    if (this.hosts.size <= this.limits.hosts && this.points <= this.limits.points) return;
    if (!this.pressureNoted) {
      log("Live metrics retention budget reached; older histories may be shortened or evicted.");
      this.pressureNoted = true;
    }
    while (this.hosts.size > this.limits.hosts || (this.points > this.limits.points && this.hosts.size > 1))
      this.remove(this.hosts.keys().next().value!);
    if (this.points <= this.limits.points) return;
    // One wide host must still retain its latest samples instead of repeatedly losing all its dials.
    const [hostId, series] = this.hosts.entries().next().value!;
    const perSeries = Math.floor(this.limits.points / (series.containers.size + Number(series.host.length > 0)));
    if (perSeries === 0) {
      this.remove(hostId);
      return;
    }
    series.host = series.host.slice(-perSeries);
    series.containers = new Map([...series.containers].map(([name, points]) => [name, points.slice(-perSeries)]));
    this.resize(series);
  }

  hostHistory(hostId: string): HostMetricsView[] {
    return [...(this.current(hostId, this.clock())?.host ?? [])];
  }

  containerHistory(hostId: string, containerName: string): ContainerUsageView[] {
    return [...(this.current(hostId, this.clock())?.containers.get(containerName) ?? [])];
  }

  /** When the host last sent its live stats, however long ago; null when it never did since the control plane started. */
  reportedAt(hostId: string): number | null {
    return this.hosts.get(hostId)?.reportedAt ?? null;
  }

  /** The host's latest stats, unless they are too old to stand for now. */
  latestHost(hostId: string): HostMetricsView | null {
    const now = this.clock();
    const latest = this.current(hostId, now)?.host.at(-1);
    return latest !== undefined && this.isFresh(latest.at, now) ? latest : null;
  }

  /** Usage of the containers in the host's latest report; one missing from it was not running. */
  latestContainers(hostId: string): Map<string, ContainerUsageView> {
    const now = this.clock();
    const series = this.current(hostId, now);
    if (series === undefined || !this.isFresh(series.reportedAt, now)) {
      return new Map();
    }
    const latest = [...series.containers].flatMap(([name, points]): [string, ContainerUsageView][] => {
      const point = points.at(-1);
      return point?.at === series.reportedAt ? [[name, point]] : [];
    });
    return new Map(latest);
  }

  private isFresh(at: number, now: number) {
    return now >= at && now - at <= METRICS_FRESH_MILLISECONDS;
  }
}
