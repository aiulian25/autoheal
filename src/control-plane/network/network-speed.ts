import { describeError } from "../../shared/errors.js";
import { SPEED_SOURCE, SPEED_TEST_LIMITS, type NetworkSpeedRunView } from "../../shared/network.js";
import { isFairTest } from "./network-rules.js";
import type { NetworkStore } from "./network-store.js";
import { measureSpeed, type MeasuredSpeed } from "./own-speed-test.js";
import type { RouterAdapter } from "./router-adapter.js";

const IDLE: NetworkSpeedRunView = { status: "idle", error: null };

export interface NetworkSpeedDependencies {
  store: Pick<NetworkStore, "addSpeedTest">;
  adapter: () => RouterAdapter | null;
  contractDownMbps: () => number | null;
  // How busy the line was before this test made it busy.
  quietBusyMbps: () => number | null;
  clock: () => number;
  measure?: () => Promise<MeasuredSpeed>;
  routerPollMilliseconds?: number;
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A speed test a person asks for: the router's own if it will run one, otherwise from this machine, and says which. */
export class NetworkSpeedRun {
  private run = IDLE;

  constructor(private readonly dependencies: NetworkSpeedDependencies) {}

  status() {
    return this.run;
  }

  reset() {
    this.run = IDLE;
  }

  start() {
    if (this.run.status === "running") return;
    this.run = { status: "running", error: null };
    void this.test().then(
      () => {
        this.run = IDLE;
      },
      (error: unknown) => {
        this.run = { status: "failed", error: describeError(error) };
      },
    );
  }

  private async test() {
    const { store, contractDownMbps, quietBusyMbps, clock, measure = measureSpeed } = this.dependencies;
    const busy = quietBusyMbps();
    const fair = isFairTest(busy, contractDownMbps());
    const byRouter = await this.routerResult().catch(() => null);
    if (byRouter !== null) {
      store.addSpeedTest(byRouter, busy, fair, SPEED_SOURCE.router);
      return;
    }
    const measured = await measure();
    store.addSpeedTest({ ...measured, at: clock(), ping: null }, busy, fair, SPEED_SOURCE.thisMachine);
  }

  // Null when this router user may not, or the router accepted and never said how it went.
  private async routerResult() {
    const { adapter: adapterOf, routerPollMilliseconds = SPEED_TEST_LIMITS.routerPollMilliseconds } = this.dependencies;
    const adapter = adapterOf();
    if (adapter === null) return null;
    const previous = (await adapter.internet()).lastTest?.at ?? 0;
    if (!(await adapter.startSpeedTest())) return null;
    for (let poll = 0; poll < SPEED_TEST_LIMITS.routerPolls; poll += 1) {
      await pause(routerPollMilliseconds);
      const { lastTest } = await adapter.internet();
      if (lastTest !== null && lastTest.at > previous) return lastTest;
    }
    return null;
  }
}
