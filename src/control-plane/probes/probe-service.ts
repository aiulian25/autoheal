import { createHash, randomUUID } from "node:crypto";
import type { ProbeReport, RemoteProbe } from "../../shared/protocol.js";
import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import { DETECTOR_KEYS, HOST_STATUS_ACTIVE } from "../../shared/constants.js";
import {
  CERTIFICATE_STATUS,
  PROBE_KIND,
  PROBE_LIMITS,
  PROBE_OUTCOME,
  PROBE_STATE,
  PROBE_TEXT,
  PROBE_WINDOWS,
  certificateStatusOf,
  probeBodySchema,
  type ProbeAvailability,
  type ProbeCertificate,
  type ProbeBody,
  type ProbeOutcome,
  type ProbeView,
} from "../../shared/probes.js";
import { REBOOT_PLAN_TEXT } from "../../shared/reboot-plans.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { MaintenanceService } from "../maintenance/maintenance-service.js";
import { destinationAllowed, runCheck, type ProbeResult } from "./probe-checks.js";
import { serviceProbeHours, serviceProbeSamples, serviceProbes } from "./probe-schema.js";

const HOUR_MILLISECONDS = 60 * 60 * 1000;
const MILLISECONDS_PER_SECOND = 1000;
const PERCENT = 100;
// A check may miss one turn and still count as recent.
const FRESH_INTERVALS = 2;

const certificateOf = (row: { certificateJson: string | null }) =>
  row.certificateJson === null ? null : (JSON.parse(row.certificateJson) as ProbeCertificate);
// One task per check and certificate: seeing it again joins that task, and a new certificate starts afresh.
const certificateKey = (probeId: string, { fingerprint }: ProbeCertificate) =>
  `${DETECTOR_KEYS.certificate}${probeId}-${fingerprint.replaceAll(":", "")}`;
const warnDaysOf = ({ target }: ProbeBody) => (target.kind === PROBE_KIND.tls ? target.warnDays : 0);

export interface ProbeFinding {
  urgent: boolean;
  key: string;
  probeId: string;
  name: string;
  hostId: string;
  title: string;
  description: string;
}

interface Streak {
  state: ProbeView["state"];
  failures: number;
  answers: number;
}

/** A state changes only on what lasted: the failures a check asks for, or answers in a row to come back. */
export function nextStreak(current: Streak, ok: boolean, failuresBeforeDown: number): Streak {
  if (!ok) {
    const failures = current.failures + 1;
    return { state: failures >= failuresBeforeDown ? PROBE_STATE.down : current.state, failures, answers: 0 };
  }
  const answers = current.answers + 1;
  const isBack = current.state !== PROBE_STATE.down || answers >= PROBE_LIMITS.answersBeforeUp;
  return { state: isBack ? PROBE_STATE.up : current.state, failures: 0, answers };
}

interface ProbeDependencies {
  databaseHandle: DatabaseHandle;
  maintenance: Pick<MaintenanceService, "view">;
  clock: () => number;
  check?: typeof runCheck;
  // What each host's runner can do and when it last reported: a check made from a host needs both.
  vantages?: Vantages;
}

/** What the fleet can tell about a host that is to make its own checks. */
export interface Vantages {
  canCheck(hostId: string): boolean;
  lastReportAt(hostId: string): number | null;
  labelOf(hostId: string): string | null;
}

/** A check handed to a host, and when: the deadline its runner has to answer within. */
interface HandedOut {
  generation: string;
  at: number;
}

/**
 * Which version of a check was handed out, from the check itself: a changed body is a changed question, so a result
 * for the old one is not an answer to the new one.
 */
const generationOf = (bodyJson: string) => createHash("sha256").update(bodyJson).digest("base64url").slice(0, 16);

/**
 * Checks made from Autoheal itself, by HTTP, TCP or DNS, and what they saw. A sustained change opens or closes a task
 * through the detectors, and that is all it does: no container or host is touched because of a check.
 */
export class ProbeService {
  private readonly inFlight = new Set<string>();
  // The checks handed to a host's runner and not yet answered.
  private readonly waiting = new Map<string, HandedOut>();
  private stopping = new AbortController();

  constructor(private readonly dependencies: ProbeDependencies) {}

  private get database() {
    return this.dependencies.databaseHandle.database;
  }

  private activeHost(hostId: string) {
    const host = this.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host === undefined) throw new DomainError(API_ERRORS.hostNotFound);
    if (host.status !== HOST_STATUS_ACTIVE) throw new DomainError(API_ERRORS.hostRevoked);
    return host;
  }

  private checkFull(hostId: string) {
    const countOf = (where?: ReturnType<typeof eq>) =>
      this.database.select({ total: count() }).from(serviceProbes).where(where).get()!.total;
    const isFull = countOf(eq(serviceProbes.hostId, hostId)) >= PROBE_LIMITS.perHost || countOf() >= PROBE_LIMITS.total;
    if (isFull) throw new DomainError(API_ERRORS.probeLimitReached);
  }

  async create(hostId: string, body: ProbeBody) {
    // Said early, so a request that was never going to be taken hears why before the name is looked up.
    this.activeHost(hostId);
    this.checkFull(hostId);
    // Looking the destination up is not the database's to wait on, so it happens outside what follows.
    if (!(await destinationAllowed(body))) throw new DomainError(API_ERRORS.probeDestinationRefused);
    const now = this.dependencies.clock();
    const id = randomUUID();
    // What was true before that wait is asked again here, in the same breath as the insert. Two requests that both
    // saw room take their turn one after the other, and the one that no longer has room is refused rather than
    // taking the place of a check that is already there; a host revoked meanwhile gains nothing either.
    this.database.transaction(() => {
      this.activeHost(hostId);
      this.checkFull(hostId);
      this.database
        .insert(serviceProbes)
        .values({
          id,
          hostId,
          bodyJson: JSON.stringify(body),
          state: PROBE_STATE.unknown,
          stateSince: now,
          failures: 0,
          answers: 0,
          createdAt: now,
        })
        .run();
    });
    return id;
  }

  remove(hostId: string, probeId: string) {
    const { changes } = this.database
      .delete(serviceProbes)
      .where(and(eq(serviceProbes.hostId, hostId), eq(serviceProbes.id, probeId)))
      .run();
    if (changes === 0) throw new DomainError(API_ERRORS.probeNotFound);
  }

  private rowsOnActiveHosts() {
    return this.database
      .select({ probe: serviceProbes, hostLabel: hosts.label })
      .from(serviceProbes)
      .innerJoin(hosts, eq(hosts.id, serviceProbes.hostId))
      .where(eq(hosts.status, HOST_STATUS_ACTIVE))
      .all();
  }

  // Only a window over the whole host: one for a single container says nothing of a service.
  private inMaintenance(hostId: string) {
    const now = this.dependencies.clock();
    return this.dependencies.maintenance
      .view(hostId)
      .windows.some(({ containerName, startsAt }) => containerName === null && startsAt <= now);
  }

  /** Starts what is due, as many as are allowed at once, and waits for those it started. */
  async tick() {
    const now = this.dependencies.clock();
    const due = this.rowsOnActiveHosts()
      .map(({ probe }) => ({ probe, body: probeBodySchema.parse(JSON.parse(probe.bodyJson)) }))
      .filter(({ probe, body }) => {
        const next = (probe.lastCheckedAt ?? 0) + body.intervalSeconds * MILLISECONDS_PER_SECOND;
        return next <= now && !this.inFlight.has(probe.id);
      })
      .toSorted((one, other) => (one.probe.lastCheckedAt ?? 0) - (other.probe.lastCheckedAt ?? 0));
    // A check made from a host is not made here: its runner is given it, and silence past the deadline is unknown.
    for (const { probe, body } of due.filter(({ body }) => body.vantage !== null)) {
      const waiting = this.waiting.get(probe.id);
      const overdue =
        waiting !== undefined && now - waiting.at >= PROBE_LIMITS.vantageDeadlineSeconds * MILLISECONDS_PER_SECOND;
      const cannot = waiting === undefined && this.dependencies.vantages?.canCheck(body.vantage!) !== true;
      if (overdue || cannot) {
        this.waiting.delete(probe.id);
        this.noteUnknown(probe.id, body.vantage!);
      }
    }
    const here = due.filter(({ body }) => body.vantage === null);
    const free = Math.max(0, PROBE_LIMITS.atOnce - this.inFlight.size);
    await Promise.all(here.slice(0, free).map(({ probe, body }) => this.checkOne(probe.id, probe.hostId, body)));
  }

  /**
   * The checks a host is to make from where it is, due now. Handing one out starts its deadline: a runner that does
   * not answer within it leaves the check not known, never answering or not.
   */
  probesFor(hostId: string): RemoteProbe[] {
    // A runner that has not said it can make checks is given none: one that cannot would never answer, and the
    // waiting would read as silence rather than as the version it runs.
    if (this.dependencies.vantages?.canCheck(hostId) !== true) return [];
    const now = this.dependencies.clock();
    const due = this.rowsOnActiveHosts().filter(({ probe }) => {
      const body = this.bodyOf(probe.bodyJson);
      if (body === null || body.vantage !== hostId) return false;
      const waiting = this.waiting.get(probe.id);
      if (waiting !== undefined && now - waiting.at < PROBE_LIMITS.vantageDeadlineSeconds * MILLISECONDS_PER_SECOND) {
        return false;
      }
      return (probe.lastCheckedAt ?? 0) + body.intervalSeconds * MILLISECONDS_PER_SECOND <= now;
    });
    return due.slice(0, PROBE_LIMITS.atOnce).flatMap(({ probe }) => {
      const body = this.bodyOf(probe.bodyJson);
      if (body === null) return [];
      const generation = generationOf(probe.bodyJson);
      this.waiting.set(probe.id, { generation, at: now });
      return [{ id: probe.id, generation, body }];
    });
  }

  /**
   * What a host saw for the checks it was given. A report for a check that is not that host's to make, or for a
   * version of it that has since changed, is no answer to anything asked and is left alone.
   */
  recordReports(hostId: string, reports: readonly ProbeReport[]) {
    for (const report of reports.slice(0, PROBE_LIMITS.resultsPerReport)) {
      const row = this.database.select().from(serviceProbes).where(eq(serviceProbes.id, report.id)).get();
      const body = row === undefined ? null : this.bodyOf(row.bodyJson);
      if (row === undefined || body === null || body.vantage !== hostId) continue;
      if (generationOf(row.bodyJson) !== report.generation) continue;
      this.waiting.delete(report.id);
      const { id: _id, generation: _generation, ...result } = report;
      this.record(report.id, body, this.inMaintenance(hostId) ? null : result);
    }
  }

  /**
   * A check made from a host whose runner has not answered: not known, with why. Never taken as answering, and
   * never as not answering either, so no sample is kept and no failure counts towards down.
   */
  private noteUnknown(probeId: string, hostId: string) {
    const vantages = this.dependencies.vantages;
    const label = vantages?.labelOf(hostId) ?? null;
    const silent = vantages?.canCheck(hostId) === true;
    const problem =
      label === null
        ? PROBE_TEXT.vantageGone
        : silent
          ? PROBE_TEXT.vantageSilent(label)
          : PROBE_TEXT.vantageUnsupported(label);
    const at = this.dependencies.clock();
    const row = this.database.select().from(serviceProbes).where(eq(serviceProbes.id, probeId)).get();
    if (row === undefined) return;
    this.database
      .update(serviceProbes)
      .set({
        state: PROBE_STATE.unknown,
        stateSince: row.state === PROBE_STATE.unknown ? row.stateSince : at,
        failures: 0,
        answers: 0,
        lastCheckedAt: at,
        lastLatencyMilliseconds: null,
        lastProblem: problem,
      })
      .where(eq(serviceProbes.id, probeId))
      .run();
  }

  private bodyOf(bodyJson: string): ProbeBody | null {
    const parsed = probeBodySchema.safeParse(JSON.parse(bodyJson));
    return parsed.success ? parsed.data : null;
  }

  private async checkOne(probeId: string, hostId: string, body: ProbeBody) {
    const { signal } = this.stopping;
    this.inFlight.add(probeId);
    try {
      const held = this.inMaintenance(hostId);
      const result = held ? null : await (this.dependencies.check ?? runCheck)(body, signal);
      if (!signal.aborted) this.record(probeId, body, result);
    } finally {
      this.inFlight.delete(probeId);
    }
  }

  // No result means a maintenance window: nothing was asked, and what came before stays as it was.
  private record(probeId: string, body: ProbeBody, result: ProbeResult | null) {
    const at = this.dependencies.clock();
    const outcome = outcomeOf(result);
    this.database.transaction(() => {
      const row = this.database.select().from(serviceProbes).where(eq(serviceProbes.id, probeId)).get();
      if (row === undefined) return;
      const next =
        result === null
          ? { state: row.state, failures: 0, answers: 0 }
          : nextStreak(row, result.ok, body.failuresBeforeDown);
      const before = certificateOf(row);
      const observed = result?.certificate;
      const certificate: ProbeCertificate | null =
        observed === undefined
          ? before
          : {
              ...observed,
              observedAt: at,
              firstSeenAt: before?.fingerprint === observed.fingerprint ? before.firstSeenAt : at,
            };
      this.database
        .update(serviceProbes)
        .set({
          ...next,
          stateSince: next.state === row.state ? row.stateSince : at,
          lastCheckedAt: at,
          lastLatencyMilliseconds: result?.latencyMilliseconds ?? null,
          lastProblem: result?.problem ?? null,
          certificateJson: certificate === null ? null : JSON.stringify(certificate),
        })
        .where(eq(serviceProbes.id, probeId))
        .run();
      this.remember(probeId, at, outcome, result?.latencyMilliseconds ?? null);
    });
  }

  private remember(probeId: string, at: number, outcome: ProbeOutcome, latencyMilliseconds: number | null) {
    this.database
      .insert(serviceProbeSamples)
      .values({ probeId, at, outcome, latencyMilliseconds })
      .onConflictDoNothing()
      .run();
    const oldestKept = this.database
      .select({ at: serviceProbeSamples.at })
      .from(serviceProbeSamples)
      .where(eq(serviceProbeSamples.probeId, probeId))
      .orderBy(desc(serviceProbeSamples.at))
      .limit(1)
      .offset(PROBE_LIMITS.samplesKept - 1)
      .get();
    if (oldestKept !== undefined) {
      this.database
        .delete(serviceProbeSamples)
        .where(and(eq(serviceProbeSamples.probeId, probeId), lt(serviceProbeSamples.at, oldestKept.at)))
        .run();
    }
    const hour = Math.floor(at / HOUR_MILLISECONDS) * HOUR_MILLISECONDS;
    const added = { up: 0, down: 0, maintenance: 0, [outcome]: 1 };
    this.database
      .insert(serviceProbeHours)
      .values({ probeId, hour, ...added })
      .onConflictDoUpdate({
        target: [serviceProbeHours.probeId, serviceProbeHours.hour],
        set: {
          up: sql`${serviceProbeHours.up} + ${added.up}`,
          down: sql`${serviceProbeHours.down} + ${added.down}`,
          maintenance: sql`${serviceProbeHours.maintenance} + ${added.maintenance}`,
        },
      })
      .run();
    this.database
      .delete(serviceProbeHours)
      .where(
        and(
          eq(serviceProbeHours.probeId, probeId),
          lt(serviceProbeHours.hour, at - PROBE_LIMITS.hoursKept * HOUR_MILLISECONDS),
        ),
      )
      .run();
  }

  /** What is down now and has lasted. During maintenance nothing new is said. */
  findings(): ProbeFinding[] {
    return this.rowsOnActiveHosts().flatMap(({ probe, hostLabel }) => {
      if (this.inMaintenance(probe.hostId)) return [];
      const body = probeBodySchema.parse(JSON.parse(probe.bodyJson));
      const certificate = certificateOf(probe);
      const certificateFindings =
        certificate === null ? [] : this.certificateFinding(probe, body, hostLabel, certificate);
      if (probe.state !== PROBE_STATE.down) return certificateFindings;
      const { name } = body;
      return [
        ...certificateFindings,
        {
          urgent: true,
          key: `${DETECTOR_KEYS.probe}${probe.id}`,
          probeId: probe.id,
          name,
          hostId: probe.hostId,
          title: PROBE_TEXT.down(name, hostLabel, probe.lastProblem),
          description: PROBE_TEXT.downDetails(probe.lastProblem, probe.failures),
        },
      ];
    });
  }

  nameOf(probeId: string) {
    const row = this.database.select().from(serviceProbes).where(eq(serviceProbes.id, probeId)).get();
    return row === undefined ? null : probeBodySchema.parse(JSON.parse(row.bodyJson)).name;
  }

  /**
   * Why this check does not show its service answering right now; null when it does. Only a real answer counts, never
   * a remembered state: it must be since `since` when given, and otherwise recent for how often the check runs.
   */
  evidence(probeId: string, since: number | null) {
    const row = this.database.select().from(serviceProbes).where(eq(serviceProbes.id, probeId)).get();
    if (row === undefined) return REBOOT_PLAN_TEXT.checkGone;
    const { name, intervalSeconds } = probeBodySchema.parse(JSON.parse(row.bodyJson));
    if (this.inMaintenance(row.hostId)) return REBOOT_PLAN_TEXT.checkHeld(name);
    // A check made from a host whose runner has gone quiet is not known, which is not the same as not answering.
    if (row.state === PROBE_STATE.unknown) return REBOOT_PLAN_TEXT.checkUnknown(name);
    if (row.state !== PROBE_STATE.up) return REBOOT_PLAN_TEXT.checkDown(name);
    const recent = this.dependencies.clock() - FRESH_INTERVALS * intervalSeconds * MILLISECONDS_PER_SECOND;
    const answered = row.lastCheckedAt !== null && row.lastLatencyMilliseconds !== null;
    if (!answered || row.lastCheckedAt! < (since ?? recent)) return REBOOT_PLAN_TEXT.checkStale(name);
    return null;
  }

  private certificateFinding(
    probe: typeof serviceProbes.$inferSelect,
    body: ProbeBody,
    hostLabel: string,
    certificate: ProbeCertificate,
  ): ProbeFinding[] {
    const status = certificateStatusOf(certificate, warnDaysOf(body), this.dependencies.clock());
    if (status === CERTIFICATE_STATUS.valid) return [];
    return [
      {
        urgent: status !== CERTIFICATE_STATUS.expiring,
        key: certificateKey(probe.id, certificate),
        probeId: probe.id,
        name: body.name,
        hostId: probe.hostId,
        title: PROBE_TEXT.certificate(body.name, hostLabel, status, certificate),
        description: PROBE_TEXT.certificateDetails(certificate),
      },
    ];
  }

  // A certificate's own task stays for as long as it was the last one seen, reachable or not, so only a certificate
  // seen since can clear it. What a window holds back stays as it is.
  private judgesCertificate(key: string) {
    const found = this.rowsOnActiveHosts().find(({ probe }) =>
      key.startsWith(`${DETECTOR_KEYS.certificate}${probe.id}-`),
    );
    return found === undefined || !this.inMaintenance(found.probe.hostId);
  }

  /** A task about a check under maintenance is left as it is: closing and reopening it would only notify twice. */
  judges(key: string) {
    if (key.startsWith(DETECTOR_KEYS.certificate)) return this.judgesCertificate(key);
    if (!key.startsWith(DETECTOR_KEYS.probe)) return false;
    const held = this.rowsOnActiveHosts().some(
      ({ probe }) => `${DETECTOR_KEYS.probe}${probe.id}` === key && this.inMaintenance(probe.hostId),
    );
    return !held;
  }

  private availability(probeId: string, body: ProbeBody, createdAt: number, window: number): ProbeAvailability {
    const now = this.dependencies.clock();
    const totals = this.database
      .select({
        up: sql<number>`coalesce(sum(${serviceProbeHours.up}), 0)`,
        down: sql<number>`coalesce(sum(${serviceProbeHours.down}), 0)`,
        maintenance: sql<number>`coalesce(sum(${serviceProbeHours.maintenance}), 0)`,
      })
      .from(serviceProbeHours)
      .where(and(eq(serviceProbeHours.probeId, probeId), gte(serviceProbeHours.hour, now - window)))
      .get()!;
    const counted = totals.up + totals.down;
    const seen = counted + totals.maintenance;
    const expected = Math.min(window, now - createdAt) / (body.intervalSeconds * MILLISECONDS_PER_SECOND);
    return {
      percent: counted === 0 ? null : (totals.up / counted) * PERCENT,
      down: totals.down,
      maintenance: totals.maintenance,
      unknownPercent: expected <= 0 ? 0 : Math.max(0, 1 - seen / expected) * PERCENT,
    };
  }

  ofHost(hostId: string): ProbeView[] {
    this.activeHost(hostId);
    const held = this.inMaintenance(hostId);
    return this.database
      .select()
      .from(serviceProbes)
      .where(eq(serviceProbes.hostId, hostId))
      .orderBy(asc(serviceProbes.createdAt))
      .all()
      .map((probe) => {
        const body = probeBodySchema.parse(JSON.parse(probe.bodyJson));
        const certificate = certificateOf(probe);
        const samples = this.database
          .select({
            at: serviceProbeSamples.at,
            outcome: serviceProbeSamples.outcome,
            latencyMilliseconds: serviceProbeSamples.latencyMilliseconds,
          })
          .from(serviceProbeSamples)
          .where(eq(serviceProbeSamples.probeId, probe.id))
          .orderBy(desc(serviceProbeSamples.at))
          .limit(PROBE_LIMITS.samplesShown)
          .all();
        return {
          ...body,
          id: probe.id,
          hostId: probe.hostId,
          state: probe.state,
          stateSince: probe.stateSince,
          inMaintenance: held,
          lastCheckedAt: probe.lastCheckedAt,
          lastLatencyMilliseconds: probe.lastLatencyMilliseconds,
          lastProblem: probe.lastProblem,
          certificate,
          certificateStatus:
            certificate === null ? null : certificateStatusOf(certificate, warnDaysOf(body), this.dependencies.clock()),
          day: this.availability(probe.id, body, probe.createdAt, PROBE_WINDOWS.day),
          month: this.availability(probe.id, body, probe.createdAt, PROBE_WINDOWS.month),
          samples: samples.toReversed(),
        };
      });
  }

  /** What is under way is dropped: its answer would land on a database that may have been replaced. */
  reset() {
    this.stopping.abort();
    this.stopping = new AbortController();
  }

  stop() {
    this.stopping.abort();
  }
}

function outcomeOf(result: ProbeResult | null): ProbeOutcome {
  if (result === null) return PROBE_OUTCOME.maintenance;
  return result.ok ? PROBE_OUTCOME.up : PROBE_OUTCOME.down;
}
