import { hasUpdate, type DiskUsageView, type HostView } from "../../shared/api.js";
import {
  FLEET_METRICS,
  HOST_STATE,
  INCIDENT_STATUS,
  METRIC_LABELS,
  PERCENT,
  TASK_PRIORITIES,
} from "../../shared/constants.js";
import type { ControlPlaneServices } from "../services.js";
import type { MetricFamily } from "./open-metrics.js";

interface Metric {
  name: string;
  help: string;
}

const LOAD_AVERAGES = [FLEET_METRICS.load1, FLEET_METRICS.load5, FLEET_METRICS.load15];
const FILESYSTEM_SPACE: [Metric, (disk: DiskUsageView) => number][] = [
  [FLEET_METRICS.filesystemSize, (disk) => disk.totalBytes],
  [FLEET_METRICS.filesystemUsed, (disk) => disk.usedBytes],
  [FLEET_METRICS.filesystemAvailable, (disk) => disk.availableBytes],
];

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * What /api/metrics tells: open tasks, incidents waiting for a person, and each host's state and use. Host names and
 * mount paths label it, never container names. A host that is not reporting says only that, not its last report.
 */
export function fleetMetrics(services: ControlPlaneServices): MetricFamily[] {
  const hosts = services.inventoryService.hosts().filter((host) => host.state !== HOST_STATE.revoked);
  const reporting = hosts.filter((host) => host.state === HOST_STATE.online);
  const containers = services.inventoryService.containers();
  const tasks = services.tasksService.summary("");
  const perHost = (metric: Metric, valueOf: (host: HostView) => number | null | undefined): MetricFamily => ({
    ...metric,
    samples: reporting.flatMap((host) => {
      const value = valueOf(host);
      return value === null || value === undefined ? [] : [{ labels: { [METRIC_LABELS.host]: host.label }, value }];
    }),
  });
  const perFilesystem = ([metric, valueOf]: [Metric, (disk: DiskUsageView) => number]): MetricFamily => ({
    ...metric,
    samples: reporting.flatMap((host) =>
      (host.health?.disks ?? []).map((disk) => ({
        labels: { [METRIC_LABELS.host]: host.label, [METRIC_LABELS.path]: disk.path },
        value: valueOf(disk),
      })),
    ),
  });
  return [
    {
      ...FLEET_METRICS.tasksOpen,
      samples: TASK_PRIORITIES.map((priority) => ({
        labels: { [METRIC_LABELS.priority]: priority },
        value: tasks.byPriority[priority],
      })),
    },
    {
      ...FLEET_METRICS.incidentsAwaitingApproval,
      samples: [
        { labels: {}, value: services.incidentsService.list({ status: INCIDENT_STATUS.awaitingApproval }).length },
      ],
    },
    {
      ...FLEET_METRICS.hostUp,
      samples: hosts.map((host) => ({
        labels: { [METRIC_LABELS.host]: host.label },
        value: Number(host.state === HOST_STATE.online),
      })),
    },
    perHost(FLEET_METRICS.cpuBusy, (host) => (host.metrics === null ? null : host.metrics.cpu.busyPercent / PERCENT)),
    perHost(FLEET_METRICS.memoryUsed, (host) => host.metrics?.memory.usedBytes),
    perHost(FLEET_METRICS.memoryTotal, (host) => host.metrics?.memory.totalBytes),
    ...FILESYSTEM_SPACE.map(perFilesystem),
    ...LOAD_AVERAGES.map((metric, index) => perHost(metric, (host) => host.health?.loadAverage[index])),
    perHost(FLEET_METRICS.containers, (host) => host.containerCount),
    perHost(FLEET_METRICS.containersRunning, (host) => host.runningCount),
    perHost(FLEET_METRICS.containersWithProblems, (host) => host.problemCount),
    perHost(
      FLEET_METRICS.imageUpdates,
      (host) => containers.filter((container) => container.hostId === host.id && hasUpdate(container)).length,
    ),
    perHost(FLEET_METRICS.osUpdates, (host) => host.health?.pendingUpdates),
    perHost(FLEET_METRICS.restartsThisHour, (host) => sum(Object.values(host.restartBudget))),
  ];
}
