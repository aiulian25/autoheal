import { describe, expect, it } from "vitest";
import { JOB_STATUS, POWER, POWER_PHASE } from "../../shared/constants.js";
import { powerPhase, type PowerHost, type PowerJob } from "./power-phase.js";

const ASKED = 1_000_000;
const DELIVERED = ASKED + 1_000;
const LATER = POWER.silentAfterMilliseconds;
const reboot: PowerJob = {
  id: "j1",
  action: "reboot",
  status: JOB_STATUS.delivered,
  requestedBy: "admin",
  createdAt: ASKED,
  deliveredAt: DELIVERED,
  completedAt: null,
  outcome: null,
  deliveredBootId: "boot-1",
};
const shutdown: PowerJob = { ...reboot, action: "shutdown" };
// Still on the boot it had, reporting a moment ago, Docker and its events up.
const host: PowerHost = {
  bootId: "boot-1",
  lastSeenAt: DELIVERED + 2_000,
  docker: true,
  eventStreamConnected: true,
  connectedSince: null,
};
const phaseOf = (job: PowerJob, shown: Partial<PowerHost>, now: number) =>
  powerPhase(job, { ...host, ...shown }, now)?.phase ?? null;

describe("where a reboot stands", () => {
  it("is asked until its runner takes it, then going down while the host still reports", () => {
    expect(phaseOf({ ...reboot, status: JOB_STATUS.pending, deliveredAt: null }, {}, ASKED + 500)).toBe(
      POWER_PHASE.asked,
    );
    expect(phaseOf(reboot, {}, DELIVERED + 3_000)).toBe(POWER_PHASE.goingDown);
  });

  it("is offline once the host is quiet, and starting when its SSH session answers again before any report", () => {
    const quiet = DELIVERED + 2_000 + LATER;
    expect(phaseOf(reboot, {}, quiet)).toBe(POWER_PHASE.offline);
    expect(phaseOf(reboot, { connectedSince: quiet - 1_000 }, quiet)).toBe(POWER_PHASE.starting);
    // A session connected since before the reboot is not the host coming back.
    expect(phaseOf(reboot, { connectedSince: ASKED - 60_000 }, quiet)).toBe(POWER_PHASE.offline);
    // Its stats come again before its first report on the new boot: still starting, never going down again.
    expect(phaseOf(reboot, { connectedSince: quiet - 1_000, lastSeenAt: quiet }, quiet)).toBe(POWER_PHASE.starting);
  });

  it("is starting on a new boot until Docker's events are back, then ready, then over", () => {
    const back = DELIVERED + 60_000;
    const newBoot = { bootId: "boot-2", lastSeenAt: back };
    expect(phaseOf(reboot, { ...newBoot, eventStreamConnected: false }, back)).toBe(POWER_PHASE.starting);
    const done = { ...reboot, status: JOB_STATUS.succeeded, completedAt: back };
    expect(powerPhase(done, { ...host, ...newBoot }, back + 1_000)).toMatchObject({
      phase: POWER_PHASE.ready,
      finishedAt: back,
    });
    expect(phaseOf(done, newBoot, back + POWER.shownMilliseconds + 1)).toBeNull();
    // Without Docker, back is ready at once.
    expect(phaseOf(reboot, { ...newBoot, docker: false, eventStreamConnected: false }, back)).toBe(POWER_PHASE.ready);
  });

  it("says why it was refused while the host stays up, for a while", () => {
    const refusedAt = DELIVERED + 5_000;
    const refused = {
      ...reboot,
      status: JOB_STATUS.failed,
      completedAt: refusedAt,
      outcome: "Not rebooting: a Proxmox backup is running on this node.",
    };
    expect(powerPhase(refused, { ...host, lastSeenAt: refusedAt }, refusedAt + 1_000)).toMatchObject({
      phase: POWER_PHASE.failed,
      outcome: refused.outcome,
    });
    expect(
      phaseOf(refused, { lastSeenAt: refusedAt + POWER.shownMilliseconds }, refusedAt + POWER.shownMilliseconds + 1),
    ).toBeNull();
  });

  it("follows the host back even when its runner could only say it was interrupted", () => {
    const interrupted = { ...reboot, status: JOB_STATUS.failed, completedAt: DELIVERED + 70_000 };
    expect(phaseOf(interrupted, { bootId: "boot-2", lastSeenAt: DELIVERED + 70_000 }, DELIVERED + 71_000)).toBe(
      POWER_PHASE.ready,
    );
  });
});

describe("where a shutdown stands", () => {
  it("is going down while the host reports, off once it is quiet, and over once it is powered on again", () => {
    expect(phaseOf(shutdown, {}, DELIVERED + 3_000)).toBe(POWER_PHASE.goingDown);
    expect(phaseOf(shutdown, {}, DELIVERED + 2_000 + LATER)).toBe(POWER_PHASE.off);
    // Days later, still off: no alarm, the page says it was shut down.
    expect(
      phaseOf(
        { ...shutdown, status: JOB_STATUS.succeeded, completedAt: DELIVERED + 20_000 },
        {},
        DELIVERED + 86_400_000,
      ),
    ).toBe(POWER_PHASE.off);
    expect(
      phaseOf(shutdown, { bootId: "boot-2", lastSeenAt: DELIVERED + 86_400_000 }, DELIVERED + 86_400_000),
    ).toBeNull();
  });
});
