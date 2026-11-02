import type {
  ContainerSnapshot,
  ContainerUsage,
  Heartbeat,
  HostHealth,
  HostMetrics,
} from "../../src/shared/protocol.js";

const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;

export const containerSnapshot = (overrides: Partial<ContainerSnapshot> = {}): ContainerSnapshot => ({
  name: "paperless",
  containerId: "0123456789ab",
  image: "ghcr.io/paperless-ngx/paperless-ngx:2.13",
  state: "running",
  health: "healthy",
  startedAt: Date.UTC(2026, 9, 20, 9),
  finishedAt: null,
  exitCode: null,
  oomKilled: false,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  composeProject: "paperless",
  composeService: "webserver",
  link: null,
  updatePolicy: null,
  update: null,
  ...overrides,
});

export const hostHealth = (overrides: Partial<HostHealth> = {}): HostHealth => ({
  cpuCount: 8,
  loadAverage: [0.5, 0.4, 0.3],
  memoryTotalBytes: 16 * GIBIBYTE,
  memoryAvailableBytes: 9 * GIBIBYTE,
  uptimeSeconds: 86_400,
  disks: [{ path: "/", totalBytes: 500 * GIBIBYTE, usedBytes: 210 * GIBIBYTE, availableBytes: 265 * GIBIBYTE }],
  rebootRequired: false,
  pendingUpdates: 3,
  operatingSystem: "Ubuntu 24.04.3 LTS",
  kernel: "6.8.0-85-generic",
  ...overrides,
});

export const heartbeatWith = (overrides: Partial<Heartbeat> = {}): Heartbeat => ({
  runnerVersion: "2.0.0",
  dryRun: true,
  eventStreamConnected: true,
  protectedContainers: ["autoheal", "npm"],
  restartBudget: { paperless: 1 },
  host: hostHealth(),
  containers: [containerSnapshot()],
  ...overrides,
});

export const hostMetrics = (overrides: Partial<HostMetrics> = {}): HostMetrics => ({
  cpu: {
    busyPercent: 14.2,
    userPercent: 9.4,
    systemPercent: 3.8,
    ioWaitPercent: 0.8,
    stealPercent: 0,
    frequencyMegahertz: 4218,
    temperatureCelsius: 48.5,
  },
  memory: {
    totalBytes: 16 * GIBIBYTE,
    usedBytes: 7 * GIBIBYTE,
    cacheBytes: 5 * GIBIBYTE,
    swapTotalBytes: 2 * GIBIBYTE,
    swapUsedBytes: 0,
  },
  disk: { devices: ["nvme0n1"], readBytesPerSecond: 32 * MEBIBYTE, writeBytesPerSecond: 12 * MEBIBYTE },
  network: {
    interfaces: [{ name: "eth0", speedMegabitsPerSecond: 1000 }],
    receiveBytesPerSecond: 100 * 1024,
    transmitBytesPerSecond: 7 * 1024,
    droppedPackets: 0,
  },
  gpus: [],
  ...overrides,
});

export const containerUsage = (overrides: Partial<ContainerUsage> = {}): ContainerUsage => ({
  name: "paperless",
  cpuPercent: 3.5,
  cpuLimitCores: null,
  throttledPercent: null,
  memoryBytes: 512 * MEBIBYTE,
  memoryPercent: 3.1,
  memoryLimitBytes: null,
  cacheBytes: 64 * MEBIBYTE,
  readBytesPerSecond: 0,
  writeBytesPerSecond: 4096,
  receiveBytesPerSecond: 1024,
  transmitBytesPerSecond: 512,
  droppedPackets: 0,
  processes: 14,
  ...overrides,
});
