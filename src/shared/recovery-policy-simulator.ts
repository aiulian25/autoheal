import { z } from "zod";
import {
  DELIBERATE_STOP_WINDOW_SECONDS,
  HANDLE_COOLDOWN_SECONDS,
  HEARTBEAT_INTERVAL_MILLISECONDS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_SECONDS,
  RESTART_CHOICES,
  type RestartChoice,
} from "./constants.js";
import { MAINTENANCE_FRESH_MILLISECONDS, maintenanceWindowSchema, type MaintenancePolicy } from "./maintenance.js";

export interface RecoveryGuardState {
  lastKill: number | null;
  lastHandled: number | null;
  restartTimes: readonly number[];
}
export const emptyRecoveryState = (): RecoveryGuardState => ({ lastKill: null, lastHandled: null, restartTimes: [] });
export type RecoveryGuardReason =
  | "allowed"
  | "empty-name"
  | "safety-state"
  | "protected"
  | "operation-held"
  | "maintenance"
  | "deliberate-stop"
  | "cooldown"
  | "restart-budget";
export interface RecoveryGuardFlags {
  name: string;
  now: number;
  safetyBlocked: boolean;
  protected: boolean;
  held: boolean;
  maintenance: boolean;
}
export const recentRestartTimes = (times: readonly number[], now: number) =>
  times.filter((at) => now - at < RESTART_WINDOW_SECONDS);

/** The runner and rehearsal share exactly these claim/credit transitions, on a seconds clock. */
export function recoveryGuardTransition(
  phase: "claim" | "restart",
  state: RecoveryGuardState,
  flags: RecoveryGuardFlags,
): { allowed: boolean; reason: RecoveryGuardReason; state: RecoveryGuardState } {
  const unchanged = { ...state, restartTimes: [...state.restartTimes] };
  const deny = (reason: RecoveryGuardReason, next = unchanged) => ({ allowed: false, reason, state: next });
  if (phase === "claim" && flags.name.length === 0) return deny("empty-name");
  if (flags.safetyBlocked) return deny("safety-state");
  if (phase === "claim" && flags.protected) return deny("protected");
  if (flags.maintenance) return deny("maintenance");
  if (phase === "claim") {
    if (flags.held) return deny("operation-held");
    if (state.lastKill !== null && flags.now - state.lastKill < DELIBERATE_STOP_WINDOW_SECONDS)
      return deny("deliberate-stop");
    if (state.lastHandled !== null && flags.now - state.lastHandled < HANDLE_COOLDOWN_SECONDS) return deny("cooldown");
    return { allowed: true, reason: "allowed", state: { ...unchanged, lastHandled: flags.now } };
  }
  const recent = recentRestartTimes(state.restartTimes, flags.now);
  if (recent.length >= MAX_RESTARTS_PER_WINDOW) return deny("restart-budget", { ...unchanged, restartTimes: recent });
  return {
    allowed: true,
    reason: "allowed",
    state: { ...unchanged, lastKill: flags.now, restartTimes: [...recent, flags.now] },
  };
}

/** The same bounded policy lease is used by MaintenanceGate; clock drift cannot expire a window early. */
export function maintenanceGuardReason(
  policy: MaintenancePolicy | null,
  valid: boolean,
  elapsed: number,
  wallDrift: number,
  name: string,
): "policy-unavailable" | "maintenance" | null {
  if (
    !valid ||
    policy === null ||
    elapsed < 0 ||
    elapsed > MAINTENANCE_FRESH_MILLISECONDS ||
    Math.abs(wallDrift) > 60_000
  )
    return "policy-unavailable";
  const now = policy.observedAt + elapsed;
  return policy.windows.some(
    (window) =>
      (name === "" || window.containerName === null || window.containerName === name) &&
      window.startsAt <= now &&
      now < window.expiresAt,
  )
    ? "maintenance"
    : null;
}

const name = z.string().min(1).max(256);
const at = z.number().int().nonnegative().safe();
const named = z.object({ at, name });
export const rehearsalEventSchema = z.discriminatedUnion("kind", [
  named.extend({ kind: z.literal("failure"), target: name.optional() }).strict(),
  named.extend({ kind: z.literal("stop") }).strict(),
  named.extend({ kind: z.enum(["operation-start", "operation-end"]) }).strict(),
  z.object({ at, kind: z.enum(["host-operation-start", "host-operation-end", "offline", "online"]) }).strict(),
  z.object({ at, kind: z.literal("runner-restart"), statePreserved: z.boolean().default(true) }).strict(),
  z
    .object({
      at,
      kind: z.literal("clock-change"),
      offsetMilliseconds: z.number().int().min(-86_400_000).max(86_400_000),
    })
    .strict(),
]);
export type RehearsalEvent = z.infer<typeof rehearsalEventSchema>;
const seconds = z.number().finite();
export const recoveryScenarioSchema = z
  .object({
    startedAt: at,
    restartDefault: z.enum(RESTART_CHOICES),
    containers: z.record(name, z.enum(RESTART_CHOICES)).default({}),
    protectedContainers: z.array(name).max(512).default([]),
    dryRun: z.boolean(),
    maintenance: z.array(maintenanceWindowSchema).max(128).default([]),
    groups: z
      .array(z.array(name).min(1).max(512))
      .max(64)
      .refine((groups) => groups.reduce((sum, group) => sum + group.length, 0) <= 512)
      .default([]),
    initial: z
      .array(
        z
          .object({
            name,
            lastKill: seconds.nullable(),
            lastHandled: seconds.nullable(),
            restartTimes: z.array(seconds).max(MAX_RESTARTS_PER_WINDOW),
          })
          .strict(),
      )
      .max(512)
      .default([]),
    events: z.array(rehearsalEventSchema).min(1).max(500),
  })
  .strict()
  .refine(
    ({ startedAt, events, initial }) =>
      events.every((event) => event.at >= startedAt && event.at - startedAt <= 7 * 86_400_000) &&
      new Set(initial.map((entry) => entry.name)).size === initial.length,
  );
export type RecoveryScenario = z.infer<typeof recoveryScenarioSchema>;
export type RehearsalReason =
  | RecoveryGuardReason
  | "policy-unavailable"
  | "policy-ask"
  | "policy-tell"
  | "policy-ignore"
  | "dry-run"
  | "runner-restart"
  | "clock-change"
  | "state-updated";
export interface RehearsalDecision {
  at: number;
  name: string | null;
  event: RehearsalEvent["kind"];
  result: "restart" | "would-restart" | "wait" | "suppress" | "escalate" | "observe";
  reason: RehearsalReason;
  restartsUsed: number;
}
export interface RecoveryRehearsal {
  decisions: RehearsalDecision[];
  states: { name: string; lastKill: number | null; lastHandled: number | null; restartTimes: number[] }[];
  assumptions: string[];
}

/** Pure counterfactual: no timers, model, filesystem, database or Docker dependency. */
export function simulateRecovery(input: RecoveryScenario): RecoveryRehearsal {
  const scenario = recoveryScenarioSchema.parse(input);
  const states = new Map<string, RecoveryGuardState>(scenario.initial.map(({ name, ...state }) => [name, state]));
  const holds = new Map<string, number>();
  const protectedNames = new Set(scenario.protectedContainers);
  let hostHolds = 0;
  let connected = true;
  let localOffset = 0;
  let receivedOffset = 0;
  let policyAt = scenario.startedAt;
  let lastAttemptAt = scenario.startedAt;
  let policyValid = true;
  let safetyBlockedUntil = -Infinity;
  const decisions: RehearsalDecision[] = [];
  const stateOf = (container: string) => states.get(container) ?? emptyRecoveryState();
  const groupOf = (container: string) => {
    const names = new Set([container]);
    for (let changed = true; changed;) {
      changed = false;
      for (const group of scenario.groups)
        if (group.some((member) => names.has(member)))
          for (const member of group)
            if (!names.has(member)) {
              names.add(member);
              changed = true;
            }
    }
    return [...names];
  };
  const choice = (container: string): RestartChoice => {
    if (!Object.hasOwn(scenario.containers, container)) return scenario.restartDefault;
    const known = scenario.containers[container]!;
    return known === "repair" ? "restart" : known;
  };
  const refresh = (time: number) => {
    if (!connected) return;
    const tick =
      scenario.startedAt +
      Math.floor((time - scenario.startedAt) / HEARTBEAT_INTERVAL_MILLISECONDS) * HEARTBEAT_INTERVAL_MILLISECONDS;
    if (tick <= lastAttemptAt) return;
    lastAttemptAt = tick;
    policyValid = Math.abs(localOffset) <= 60_000;
    if (policyValid) {
      policyAt = tick;
      receivedOffset = localOffset;
    }
  };
  const maintenance = (container: string, time: number) =>
    maintenanceGuardReason(
      { generation: 1, observedAt: policyAt, windows: scenario.maintenance },
      policyValid,
      time - policyAt,
      localOffset - receivedOffset,
      container,
    );
  const held = (container: string) =>
    hostHolds > 0 || groupOf(container).some((member) => (holds.get(member) ?? 0) > 0);
  const emit = (
    event: RehearsalEvent,
    result: RehearsalDecision["result"],
    reason: RehearsalReason,
    container: string | null = "name" in event ? event.name : null,
  ) =>
    decisions.push({
      at: event.at,
      name: container,
      event: event.kind,
      result,
      reason,
      restartsUsed:
        container === null ? 0 : recentRestartTimes(stateOf(container).restartTimes, event.at / 1000).length,
    });
  for (const event of [...scenario.events].sort((a, b) => a.at - b.at)) {
    refresh(event.at);
    const now = event.at / 1000;
    if (event.kind === "offline") {
      connected = false;
      emit(event, "observe", "state-updated");
      continue;
    }
    if (event.kind === "online") {
      connected = true;
      lastAttemptAt = event.at;
      policyValid = Math.abs(localOffset) <= 60_000;
      if (policyValid) {
        policyAt = event.at;
        receivedOffset = localOffset;
      }
      emit(event, "observe", "state-updated");
      continue;
    }
    if (event.kind === "clock-change") {
      localOffset = event.offsetMilliseconds;
      emit(event, "observe", "clock-change");
      continue;
    }
    if (event.kind === "runner-restart") {
      policyValid = false;
      lastAttemptAt = event.at;
      if (!event.statePreserved) {
        states.clear();
        safetyBlockedUntil = event.at + RESTART_WINDOW_SECONDS * 1000;
      }
      emit(event, "observe", "runner-restart");
      continue;
    }
    if (event.kind === "host-operation-start") {
      hostHolds++;
      emit(event, "observe", "state-updated");
      continue;
    }
    if (event.kind === "host-operation-end") {
      hostHolds = Math.max(0, hostHolds - 1);
      emit(event, "observe", "state-updated");
      continue;
    }
    if (event.kind === "operation-start" || event.kind === "operation-end") {
      const increment = event.kind === "operation-start" ? 1 : -1;
      for (const member of groupOf(event.name)) {
        holds.set(member, Math.max(0, (holds.get(member) ?? 0) + increment));
        states.set(member, { ...stateOf(member), lastKill: now });
      }
      emit(event, "observe", "state-updated");
      continue;
    }
    if (event.kind === "stop") {
      states.set(event.name, { ...stateOf(event.name), lastKill: now });
      emit(event, "observe", "state-updated");
      continue;
    }
    if (event.kind !== "failure") continue;
    const policyBlock = maintenance(event.name, event.at);
    const flags: RecoveryGuardFlags = {
      name: event.name,
      now,
      safetyBlocked: event.at < safetyBlockedUntil,
      protected: protectedNames.has(event.name),
      held: held(event.name),
      maintenance: policyBlock !== null,
    };
    const claimed = recoveryGuardTransition("claim", stateOf(event.name), flags);
    if (!claimed.allowed) {
      emit(
        event,
        claimed.reason === "operation-held" || claimed.reason === "cooldown" ? "wait" : "suppress",
        claimed.reason === "maintenance" ? policyBlock! : claimed.reason,
      );
      continue;
    }
    states.set(event.name, claimed.state);
    const policy = choice(event.name);
    if (policy === "ignore" || policy === "tell") {
      emit(event, "suppress", policy === "ignore" ? "policy-ignore" : "policy-tell");
      continue;
    }
    const target = event.target ?? event.name;
    if (protectedNames.has(target)) {
      emit(event, "escalate", "protected", target);
      continue;
    }
    if (choice(target) !== "restart") {
      emit(event, "escalate", "policy-ask", target);
      continue;
    }
    const targetPolicyBlock = maintenance(target, event.at);
    if (held(target) || targetPolicyBlock !== null) {
      emit(event, "wait", targetPolicyBlock ?? "operation-held", target);
      continue;
    }
    const reserved = recoveryGuardTransition("restart", stateOf(target), {
      ...flags,
      name: target,
      protected: protectedNames.has(target),
      held: held(target),
      maintenance: targetPolicyBlock !== null,
    });
    states.set(target, reserved.state);
    emit(
      event,
      reserved.allowed ? (scenario.dryRun ? "would-restart" : "restart") : "escalate",
      reserved.allowed ? (scenario.dryRun ? "dry-run" : "allowed") : reserved.reason,
      target,
    );
  }
  return {
    decisions,
    states: [...states]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, state]) => ({ name, ...state, restartTimes: [...state.restartTimes] })),
    assumptions: [
      "This rehearses guard and policy decisions only; a restart decision is assumed. No model or host action runs.",
      "Connected runners receive policy heartbeats every 30 seconds; outages, restarts and clock changes must be represented explicitly.",
      "Declared dependency groups are assumed complete. Unobserved operations, earlier budget use and deliberate stops can change real decisions.",
      "A dry-run reserves restart credits when it reaches the restart stage, matching the runner; it does not change Docker.",
      "Checkpoint availability, application health, data compatibility and successful recovery are not established by this rehearsal.",
    ],
  };
}

export const policyRehearsalRequestSchema = z
  .object({
    hostId: z.uuid(),
    proposedRestartDefault: z.enum(["restart", "ask", "tell"]),
    source: z.enum(["synthetic", "history"]),
    events: z.array(rehearsalEventSchema).min(1).max(500).optional(),
    groups: z
      .array(z.array(name).min(1).max(512))
      .max(64)
      .refine((groups) => groups.reduce((sum, group) => sum + group.length, 0) <= 512)
      .default([]),
  })
  .strict()
  .refine(({ source, events }) => (source === "synthetic" ? events !== undefined : events === undefined))
  .refine(
    ({ events }) =>
      events === undefined ||
      Math.max(...events.map(({ at }) => at)) - Math.min(...events.map(({ at }) => at)) <= 7 * 86_400_000,
  );
export type PolicyRehearsalRequest = z.infer<typeof policyRehearsalRequestSchema>;
export interface PolicyRehearsalContext {
  hostId: string;
  hostLabel: string;
  now: number;
  restartDefault: RestartChoice;
  dryRun: boolean;
  lastHeartbeatAt: number | null;
  containers: { name: string; restart: RestartChoice; inherited: boolean; protected: boolean }[];
  restartBudget: Record<string, number>;
  protectedContainers: string[];
  maintenance: MaintenancePolicy["windows"];
}
export interface PolicyRehearsalResult {
  hostId: string;
  source: "synthetic" | "history";
  change: {
    before: PolicyRehearsalContext["restartDefault"];
    after: PolicyRehearsalContext["restartDefault"];
    containers: { name: string; before: RestartChoice; after: RestartChoice }[];
  };
  current: RecoveryRehearsal;
  proposed: RecoveryRehearsal;
  evidence: { incidentIds: string[]; assumptions: string[] };
}
