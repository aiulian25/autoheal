import type { HomeAssistantConnection } from "../home-assistant/home-assistant-inventory.js";
import type { HostControlService } from "../host-control/host-control-service.js";
import type { HostPackagesService } from "../host-packages/host-packages-service.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { MetricsStore } from "../inventory/metrics-store.js";
import { logAlertNotQueued, type Notifier } from "../notifications/notifier.js";
import type { NetworkWatch } from "../network/network-watch.js";
import type { ProbeService } from "../probes/probe-service.js";
import type { RebootPlansService } from "../power/reboot-plans-service.js";
import type { OllamaMonitor } from "../ollama/ollama-monitor.js";
import type { AnomalyDetector } from "./anomaly-detector.js";
import { detect, type DetectorInputs } from "./detectors.js";
import type { ResourceAdvisor } from "./resource-advisor.js";
import type { TasksService } from "./tasks-service.js";

export interface DetectorDependencies {
  tasks: TasksService;
  inventory: Pick<InventoryService, "hosts" | "containers" | "unusedImages">;
  metrics: Pick<MetricsStore, "hostHistory">;
  homeAssistant: Pick<HomeAssistantConnection, "view"> | null;
  ollama: Pick<OllamaMonitor, "status">;
  // The servers beside the default.
  ollamaExtras?: () => DetectorInputs["ollamaExtras"];
  // What the router's watch finds.
  network?: Pick<NetworkWatch, "findings" | "judging">;
  probes?: Pick<ProbeService, "findings" | "judges">;
  rebootPlans?: Pick<RebootPlansService, "findings">;
  notifier: Pick<Notifier, "taskOpened" | "taskResolved">;
  packages: Pick<HostPackagesService, "plan">;
  hostControl: Pick<HostControlService, "imageCleanupOf">;
  clock?: () => number;
  anomalies?: Pick<AnomalyDetector, "detect">;
  // Containers that keep running out of memory.
  resources?: Pick<ResourceAdvisor, "detect">;
}

/**
 * Runs the rules every 30 seconds: a problem that lasted its grace period opens or joins a task,
 * and a task whose problem cleared is closed. When each problem started is kept in memory, so
 * after a restart grace periods start over.
 */
export class DetectorService {
  private readonly firstSeen = new Map<string, number>();
  private running = false;

  constructor(private readonly dependencies: DetectorDependencies) {}

  reset() {
    this.firstSeen.clear();
  }

  /** One pass; skipped while the previous one is still notifying. */
  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass() {
    const { tasks, inventory, metrics, homeAssistant, ollama, notifier, packages, hostControl } = this.dependencies;
    const now = (this.dependencies.clock ?? Date.now)();
    const fixed = detect({
      now,
      hosts: inventory.hosts(),
      containers: inventory.containers(),
      history: (hostId) => metrics.hostHistory(hostId),
      homeAssistant: homeAssistant?.view() ?? null,
      ollama: ollama.status(),
      ollamaExtras: this.dependencies.ollamaExtras?.() ?? [],
      network: this.dependencies.network ?? { findings: () => [], judging: false },
      probes: this.dependencies.probes ?? { findings: () => [], judges: () => false },
      rebootPlans: this.dependencies.rebootPlans ?? { findings: () => [] },
      owner: tasks.owner(),
      packagePlan: (host) => packages.plan(host),
      unusedImages: (hostId) => inventory.unusedImages(hostId),
      imageCleanup: (hostId) => hostControl.imageCleanupOf(hostId),
    });
    const more = [this.dependencies.anomalies, this.dependencies.resources].flatMap((detector) =>
      detector === undefined ? [] : [detector.detect()],
    );
    const problems = [...fixed.problems, ...more.flatMap((detection) => detection.problems)];
    const judges = (key: string) => fixed.judges(key) || more.some((detection) => detection.judges(key));
    const active = new Set(problems.map((problem) => problem.key));
    for (const problem of problems) {
      const since = this.firstSeen.get(problem.key) ?? now;
      this.firstSeen.set(problem.key, since);
      if (now - since < problem.graceMilliseconds) {
        continue;
      }
      const { task, outcome } = tasks.openOrJoin(problem);
      if (outcome === "created" || outcome === "reopened") {
        await notifier.taskOpened(task, outcome === "reopened").catch(logAlertNotQueued);
      }
    }
    for (const key of [...this.firstSeen.keys()].filter((candidate) => !active.has(candidate))) {
      this.firstSeen.delete(key);
    }
    for (const key of tasks.openDetectorKeys().filter((candidate) => !active.has(candidate) && judges(candidate))) {
      const cleared = tasks.clear(key);
      if (cleared?.closed) {
        await notifier.taskResolved(cleared.task).catch(logAlertNotQueued);
      }
    }
  }
}
