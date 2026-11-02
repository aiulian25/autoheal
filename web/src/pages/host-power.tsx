import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ROUTES, apiPath, type HostPowerView, type HostView, type JobView } from "../../../src/shared/api.js";
import {
  HOST_KIND,
  JOB_ACTION,
  MILLISECONDS_PER_SECOND,
  PACKAGES_UNSUPPORTED,
  POWER_PHASE,
  POWER_SETTLED,
  type PowerAction,
  type PowerPhase,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { POWER_TEXT } from "../constants.js";
import { duration, stopwatch, timeOfDay } from "../format.js";
import { hostsQuery, localHostQuery } from "../queries.js";

export const powerUnderWay = (power: HostPowerView | undefined) =>
  power !== undefined && !POWER_SETTLED.includes(power.phase);

// Its systemd can be asked: a host that reports its packages, with or without a package manager.
const canPower = (host: HostView) => {
  const packages = host.health?.packages ?? null;
  return (
    packages !== null &&
    (packages.unsupported === null || packages.unsupported === PACKAGES_UNSUPPORTED.noPackageManager)
  );
};

// Each step's place in the strip; past the last, every step is done.
const STEP_OF: Record<PowerPhase, number> = {
  [POWER_PHASE.asked]: 0,
  [POWER_PHASE.goingDown]: 1,
  [POWER_PHASE.offline]: 2,
  [POWER_PHASE.starting]: 3,
  [POWER_PHASE.ready]: 5,
  [POWER_PHASE.off]: 3,
  [POWER_PHASE.failed]: 0,
};

/** The colour of each phase: going down warns (a shutdown more so), away is grey, coming back blue, back green. */
function toneOf(power: HostPowerView): string {
  if (power.phase === POWER_PHASE.asked || power.phase === POWER_PHASE.goingDown) {
    return power.action === JOB_ACTION.shutdown ? "danger" : "warning";
  }
  const tones: Partial<Record<PowerPhase, string>> = {
    [POWER_PHASE.starting]: "blue",
    [POWER_PHASE.ready]: "good",
    [POWER_PHASE.failed]: "danger",
  };
  return tones[power.phase] ?? "neutral";
}

/** What the host's badge says while it is followed; null when its own state says it, back and ready included. */
export function powerBadge(power: HostPowerView | undefined): { tone: string; text: string; moving: boolean } | null {
  if (power === undefined || power.phase === POWER_PHASE.ready || power.phase === POWER_PHASE.failed) {
    return null;
  }
  const texts: Partial<Record<PowerPhase, string>> = {
    [POWER_PHASE.offline]: POWER_TEXT.badge.offline,
    [POWER_PHASE.starting]: POWER_TEXT.badge.starting,
    [POWER_PHASE.off]: POWER_TEXT.badge.off,
  };
  return {
    tone: toneOf(power),
    text: texts[power.phase] ?? POWER_TEXT.badge[power.action],
    moving: powerUnderWay(power),
  };
}

/** Whether the host's dials stand for nothing now: it is away, or off. */
export const powerAway = (power: HostPowerView | undefined) =>
  power?.phase === POWER_PHASE.offline || power?.phase === POWER_PHASE.off;

// Every second while the host is followed, for the stopwatch and "last heard from".
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), MILLISECONDS_PER_SECOND);
    return () => clearInterval(timer);
  }, [ticking]);
  return ticking ? now : Date.now();
}

// A step before the one reached is done; the one reached is under way.
function stepClass(index: number, reached: number): string | undefined {
  if (index < reached) return "done";
  return index === reached ? "active" : undefined;
}

const secondsSince = (at: number | null, now: number) =>
  Math.max(0, Math.round((now - (at ?? now)) / MILLISECONDS_PER_SECOND));

function titleOf(power: HostPowerView, label: string): string {
  if (power.phase === POWER_PHASE.ready) return POWER_TEXT.title.ready(label);
  if (power.phase === POWER_PHASE.off) return POWER_TEXT.title.off(label);
  if (power.phase === POWER_PHASE.failed) return POWER_TEXT.title.failed(label);
  return POWER_TEXT.title[power.action](label);
}

function seenOf(power: HostPowerView, host: HostView, now: number): string {
  const seen = POWER_TEXT.seen;
  switch (power.phase) {
    case POWER_PHASE.asked:
      return seen.asked;
    case POWER_PHASE.goingDown:
      return seen.goingDown(secondsSince(power.lastSeenAt, now));
    case POWER_PHASE.offline:
      return seen.offline(secondsSince(power.lastSeenAt, now));
    case POWER_PHASE.starting:
      return seen.starting;
    case POWER_PHASE.ready: {
      const took = duration(secondsSince(power.requestedAt, power.finishedAt ?? now));
      return host.docker === false
        ? seen.readyWithoutDocker(took)
        : seen.ready(took, host.runningCount, host.containerCount);
    }
    case POWER_PHASE.off:
      return seen.off(timeOfDay(power.finishedAt ?? power.lastSeenAt ?? power.requestedAt), power.requestedBy);
    case POWER_PHASE.failed:
      return power.outcome ?? "";
  }
}

/** A reboot or a shutdown as it goes: its steps, how long it has taken, and what Autoheal sees of the host. */
export function PowerStrip({ host }: { host: HostView }) {
  const power = host.power;
  const now = useNow(powerUnderWay(power));
  if (power === undefined) return null;
  const tone = toneOf(power);
  const steps = POWER_TEXT.steps[power.action];
  const reached = STEP_OF[power.phase];
  const showSteps = power.phase !== POWER_PHASE.failed;
  const along = (Math.min(reached, steps.length - 1) / (steps.length - 1)) * 100;
  const moving = powerUnderWay(power);
  return (
    <section className={`power-strip power-${tone}`} aria-label={titleOf(power, host.label)} role="status">
      <div className="power-top">
        <span className={moving ? "power-icon power-spin" : "power-icon"} aria-hidden>
          <Icon name={power.action === JOB_ACTION.shutdown ? "power" : "rotateCw"} />
        </span>
        <strong>{titleOf(power, host.label)}</strong>
        <span className="power-clock">{stopwatch(secondsSince(power.requestedAt, power.finishedAt ?? now))}</span>
      </div>
      {showSteps && (
        <>
          <ol className="power-steps">
            {steps.map((step, index) => (
              <li key={step} className={stepClass(index, reached)}>
                <span className="power-mark" aria-hidden>
                  {index < reached && <Icon name="check" />}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <div className="power-track" aria-hidden>
            <div className="power-track-fill" style={{ width: `${along}%` }} />
          </div>
        </>
      )}
      <p className="power-seen">{seenOf(power, host, now)}</p>
    </section>
  );
}

/** Reboot and Shut down, each confirmed in place: any admin, any host whose systemd can be asked. */
export function PowerButtons({ host }: { host: HostView }) {
  const queryClient = useQueryClient();
  const local = useQuery(localHostQuery);
  const [asking, setAsking] = useState<PowerAction | null>(null);
  const ask = useMutation({
    mutationFn: (action: PowerAction) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId: host.id }), { action }),
    onSuccess: () => {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
    },
  });
  if (!canPower(host)) return null;
  const busy = powerUnderWay(host.power) || ask.isPending;
  const dashboardHere = host.kind === HOST_KIND.local || local.data?.hostId === host.id;
  const confirmText = (action: PowerAction) => {
    const asked =
      action === JOB_ACTION.reboot
        ? POWER_TEXT.confirm.reboot(host.label, host.containerCount)
        : POWER_TEXT.confirm.shutdown(host.label);
    return dashboardHere ? `${asked} ${POWER_TEXT.confirm.dashboardToo}` : asked;
  };
  return (
    <div className="power-actions">
      {asking === null && (
        <>
          <button type="button" disabled={busy} onClick={() => setAsking(JOB_ACTION.reboot)}>
            <Icon name="rotateCw" />
            {POWER_TEXT.reboot}
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => setAsking(JOB_ACTION.shutdown)}>
            <Icon name="power" />
            {POWER_TEXT.shutdown}
          </button>
        </>
      )}
      {asking !== null && (
        <div className="power-confirm" role="group" aria-label={POWER_TEXT.confirm.go[asking]}>
          <p>{confirmText(asking)}</p>
          <div className="power-confirm-buttons">
            <button
              type="button"
              className={asking === JOB_ACTION.shutdown ? "primary danger" : "primary"}
              disabled={ask.isPending}
              onClick={() => ask.mutate(asking)}
            >
              {POWER_TEXT.confirm.go[asking]}
            </button>
            <button type="button" className="quiet" onClick={() => setAsking(null)}>
              {POWER_TEXT.cancel}
            </button>
          </div>
        </div>
      )}
      <ErrorNotice error={ask.error} />
    </div>
  );
}
