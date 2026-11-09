import { maintenanceGuardReason } from "../shared/recovery-policy-simulator.js";
import { MILLISECONDS_PER_SECOND } from "../shared/constants.js";
import {
  MAINTENANCE_CLOCK_TOLERANCE_MILLISECONDS,
  maintenancePolicySchema,
  type MaintenancePolicy,
} from "../shared/maintenance.js";

/** A short policy lease: offline/restarted runners cannot assume no maintenance was requested. */
export class MaintenanceGate {
  private valid = false;
  private policy: MaintenancePolicy | null = null;
  private receivedAt = 0;
  private wallAt = 0;
  // How far this runner's clock was from the control plane's, in seconds (ahead is positive), when that kept the last
  // policy out; null otherwise.
  clockOffSeconds: number | null = null;
  constructor(
    private readonly wall = Date.now,
    private readonly monotonic = () => performance.now(),
  ) {}
  get generation() {
    return this.policy?.generation ?? 0;
  }
  apply(value: unknown) {
    this.valid = false;
    this.clockOffSeconds = null;
    const policy = maintenancePolicySchema.parse(value);
    const offset = this.wall() - policy.observedAt;
    if (Math.abs(offset) > MAINTENANCE_CLOCK_TOLERANCE_MILLISECONDS) {
      this.clockOffSeconds = Math.round(offset / MILLISECONDS_PER_SECOND);
    }
    if (policy.generation < this.generation || this.clockOffSeconds !== null) {
      throw new Error("Maintenance policy generation or clock is invalid; automatic actions remain paused.");
    }
    this.policy = policy;
    this.valid = true;
    this.receivedAt = this.monotonic();
    this.wallAt = this.wall();
  }
  held(name: string) {
    const elapsed = this.monotonic() - this.receivedAt;
    return maintenanceGuardReason(this.policy, this.valid, elapsed, this.wall() - this.wallAt - elapsed, name) !== null;
  }
}
