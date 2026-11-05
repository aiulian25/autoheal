import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  API_ERRORS,
  type HostPackagesView,
  type HostUpdateSettingsView,
  type HostView,
  type JobView,
} from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AUDIT_ACTIONS,
  AUTOMATIC_UPDATE_MINIMUM_FREE_BYTES,
  BOOT_FILESYSTEM,
  CONTAINER_PROBLEMS,
  CONTAINER_RUNTIME_PACKAGES,
  CORE_SYSTEM_PACKAGES,
  DATA_PACKAGE_PREFIXES,
  DETECTOR_KEY_SEPARATOR,
  DETECTOR_KEYS,
  FALLBACK_TIME_ZONE,
  HOST_PACKAGE_ACTIONS,
  HOST_PACKAGE_FIRST_CHECK_RETRY_MILLISECONDS,
  HOST_PACKAGE_RECENT_JOBS,
  HOST_PACKAGE_TASK_TEXT,
  HOST_PACKAGES,
  HOST_STATE,
  HOST_UPDATE_DEFAULTS,
  isChangingPackageAction,
  isPowerAction,
  JOB_ACTION,
  JOB_STATUS,
  KERNEL_PACKAGE_PREFIXES,
  LIBRARY_PACKAGE_PREFIX,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  PACKAGES_UNSUPPORTED,
  ROOT_FILESYSTEM,
  SETTING_KEYS,
  TARGET_HOST,
  TIME_OF_DAY_PATTERN,
  type HostPackageAction,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { packageCheckSchema, type JobResult, type PackageCheck } from "../../shared/protocol.js";
import { wallClock } from "../../shared/time-zones.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hostPackageChecks, jobs } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import { jobViews, packagesOf } from "../jobs/job-views.js";
import type { JobsService } from "../jobs/jobs-service.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { TaskAuthor, TasksService } from "../tasks/tasks-service.js";
import { lifecycleOf } from "./lifecycle.js";
import type { PackageKinds } from "./package-kinds.js";
import { planFor, type PackagePlan } from "./package-rules.js";

export interface HostPackagesDependencies {
  databaseHandle: DatabaseHandle;
  auditLog: AuditLog;
  jobs: Pick<JobsService, "request">;
  tasks: Pick<TasksService, "openFor" | "comment">;
  inventory: Pick<InventoryService, "hosts" | "containers">;
  settings: SettingsStore;
  kinds: Pick<PackageKinds, "known" | "learn">;
  clock?: () => number;
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const OPEN_JOB_STATUSES = [JOB_STATUS.pending, JOB_STATUS.delivered];
const SEVERE_PROBLEMS: ReadonlySet<string> = new Set([
  CONTAINER_PROBLEMS.restarting,
  CONTAINER_PROBLEMS.dead,
  CONTAINER_PROBLEMS.outOfMemory,
]);

export const hostUpdateSettingsSchema = z.object({
  securityInWindow: z.boolean(),
  windowStart: z.string().regex(TIME_OF_DAY_PATTERN),
  windowEnd: z.string().regex(TIME_OF_DAY_PATTERN),
});

export const minuteOfDay = (time: string) => {
  const [, hours = "0", minutes = "0"] = TIME_OF_DAY_PATTERN.exec(time) ?? [];
  return Number(hours) * MINUTES_PER_HOUR + Number(minutes);
};

/** Whether a clock in `timeZone` is inside the window now; a window may run past midnight. */
export function insideWindow(settings: HostUpdateSettingsView, timeZone: string, now: number): boolean {
  const { hour, minute } = wallClock(now, timeZone);
  const current = hour * MINUTES_PER_HOUR + minute;
  const start = minuteOfDay(settings.windowStart);
  const end = minuteOfDay(settings.windowEnd);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export const windowMilliseconds = (settings: HostUpdateSettingsView) =>
  ((minuteOfDay(settings.windowEnd) - minuteOfDay(settings.windowStart) + MINUTES_PER_DAY) % MINUTES_PER_DAY) *
  MILLISECONDS_PER_MINUTE;

// Libraries, and what the rules' own lists already sort, are never worth a question to Ollama.
const worthAsking = (name: string) =>
  !name.startsWith(LIBRARY_PACKAGE_PREFIX) &&
  !CONTAINER_RUNTIME_PACKAGES.has(name) &&
  !CORE_SYSTEM_PACKAGES.has(name) &&
  ![...DATA_PACKAGE_PREFIXES, ...KERNEL_PACKAGE_PREFIXES].some((prefix) => name.startsWith(prefix));

export const osUpdatesKey = (hostId: string) => [DETECTOR_KEYS.osUpdates, hostId].join(DETECTOR_KEY_SEPARATOR);

type LatestCheck = { checkedAt: number; check: PackageCheck };

// When the host last booted, by its own uptime at its last report.
const bootedAt = (host: HostView) =>
  (host.lastHeartbeatAt ?? 0) - (host.health?.uptimeSeconds ?? 0) * MILLISECONDS_PER_SECOND;

/**
 * A host's own packages: what its files and its checks say, who takes care of each package, and the
 * package jobs asked for. Every job is checked here first and again by the host's runner, whose .env
 * has the last word.
 */
export class HostPackagesService {
  private readonly clock: () => number;

  constructor(private readonly dependencies: HostPackagesDependencies) {
    this.clock = dependencies.clock ?? Date.now;
  }

  private get database() {
    return this.dependencies.databaseHandle.database;
  }

  // --- what a runner reported -------------------------------------------------------------------

  /** After a package job's result: keep a check, and check again after anything changed packages. */
  afterResult(host: HostRow, jobId: string, result: JobResult) {
    const job = this.database.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (job === undefined) {
      return;
    }
    if (result.packages !== undefined) {
      this.recordCheck(host.id, jobId, result.packages);
    } else if (result.succeeded) {
      this.forgetDone(host.id, job.action, packagesOf(job.packagesJson));
    }
    const autohealsNightly =
      job.action === JOB_ACTION.upgradePackages && job.requestedByAgent === AGENT_AUTOHEAL && job.taskId === null;
    const task = autohealsNightly ? this.dependencies.tasks.openFor(osUpdatesKey(host.id)) : null;
    if (task !== null) {
      this.dependencies.tasks.comment(AUTOHEAL, task.id, HOST_PACKAGE_TASK_TEXT.nightly(result.outcome));
    }
    if (isChangingPackageAction(job.action) && result.succeeded && this.openJob(host.id) === null) {
      this.dependencies.jobs.request(AUTOHEAL, host.id, "", JOB_ACTION.checkPackages, null);
    }
  }

  /**
   * What a job just did leaves the last check at once, so the lists clear as it ends rather than with the check
   * asked for after it; that check, a minute on, has the last word on the rest.
   */
  private forgetDone(hostId: string, action: string, upgraded: readonly string[]) {
    const latest = this.latestCheck(hostId);
    if (latest === null) return;
    const done = new Set(upgraded);
    const notDone = (update: { name: string }) => !done.has(update.name);
    const check: PackageCheck = {
      ...latest.check,
      upgradable: latest.check.upgradable.filter(notDone),
      keptBack: latest.check.keptBack.filter(notDone),
    };
    if (action === JOB_ACTION.autoremovePackages) check.removable = [];
    if (action === JOB_ACTION.repairPackages) check.needsRepair = false;
    this.database
      .update(hostPackageChecks)
      .set({ checkJson: JSON.stringify(check) })
      .where(eq(hostPackageChecks.hostId, hostId))
      .run();
  }

  private recordCheck(hostId: string, jobId: string, check: PackageCheck) {
    const values = { hostId, jobId, checkedAt: this.clock(), checkJson: JSON.stringify(check) };
    this.database
      .insert(hostPackageChecks)
      .values(values)
      .onConflictDoUpdate({ target: hostPackageChecks.hostId, set: values })
      .run();
    const names = [...check.upgradable, ...check.keptBack].map(({ name }) => name);
    void this.dependencies.kinds.learn(names.filter(worthAsking)).catch((error: unknown) => log(describeError(error)));
  }

  // --- reading ----------------------------------------------------------------------------------

  private hostView(hostId: string): HostView {
    const host = this.dependencies.inventory.hosts().find((candidate) => candidate.id === hostId);
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    return host;
  }

  private latestCheck(hostId: string): LatestCheck | null {
    const row = this.database.select().from(hostPackageChecks).where(eq(hostPackageChecks.hostId, hostId)).get();
    const parsed = row === undefined ? null : packageCheckSchema.safeParse(JSON.parse(row.checkJson));
    return parsed?.success === true ? { checkedAt: row!.checkedAt, check: parsed.data } : null;
  }

  // dnf's word that a reboot is needed holds only until the host boots again.
  private planOf(host: HostView, latest: LatestCheck, settings: HostUpdateSettingsView): PackagePlan {
    const sinceBoot = latest.checkedAt >= bootedAt(host);
    const check = sinceBoot ? latest.check : { ...latest.check, rebootRequired: null };
    const names = [...check.upgradable, ...check.keptBack].map(({ name }) => name);
    const known = this.dependencies.kinds.known(names);
    const facts = host.health?.packages ?? null;
    return planFor(check, facts, settings.securityInWindow, (name) => known.get(name) === true);
  }

  /** Who takes care of what is pending on the host; null before its first check. */
  plan(host: HostView): PackagePlan | null {
    const latest = this.latestCheck(host.id);
    return latest === null ? null : this.planOf(host, latest, this.settings());
  }

  private packageJobs(hostId: string): JobView[] {
    const condition = and(eq(jobs.hostId, hostId), inArray(jobs.action, HOST_PACKAGE_ACTIONS));
    return jobViews(this.dependencies.databaseHandle, condition, HOST_PACKAGE_RECENT_JOBS);
  }

  private openJob(hostId: string) {
    const condition = and(
      eq(jobs.hostId, hostId),
      inArray(jobs.action, HOST_PACKAGE_ACTIONS),
      inArray(jobs.status, OPEN_JOB_STATUSES),
    );
    return this.database.select().from(jobs).where(condition).get() ?? null;
  }

  view(hostId: string): HostPackagesView {
    const host = this.hostView(hostId);
    const latest = this.latestCheck(hostId);
    const window = this.settings();
    const plan = latest === null ? null : this.planOf(host, latest, window);
    const recent = this.packageJobs(hostId);
    const facts = host.health?.packages ?? null;
    return {
      hostId,
      facts,
      rebootRequired: host.health?.rebootRequired === true || plan?.rebootRequired === true,
      lifecycle: lifecycleOf(facts, this.clock()),
      checkedAt: latest?.checkedAt ?? null,
      refreshed: latest?.check.refreshed ?? null,
      refreshProblem: latest?.check.refreshProblem ?? null,
      needsRepair: latest?.check.needsRepair ?? false,
      packages: plan?.packages ?? [],
      keptBack: plan?.keptBack ?? [],
      removable: plan?.removable ?? [],
      automatic: plan?.automatic ?? [],
      unattended: plan?.unattended ?? [],
      forPerson: plan?.forPerson ?? [],
      running: recent.find(({ status }) => OPEN_JOB_STATUSES.some((open) => open === status)) ?? null,
      recent,
      window,
    };
  }

  // --- asking for a package job --------------------------------------------------------------------

  /** Refused here when the host's runner would refuse it anyway, so the person hears why at once. */
  request(
    author: TaskAuthor,
    hostId: string,
    action: HostPackageAction,
    packages: readonly string[],
    taskId: string | null = null,
  ): JobView {
    this.requireJob(hostId, action, packages);
    const named = action === JOB_ACTION.upgradePackages ? packages : [];
    return this.dependencies.jobs.request(author, hostId, "", action, taskId, { packages: named });
  }

  /** What `request` checks before an upgrade of these packages, without asking for it. */
  requireUpgrade(hostId: string, packages: readonly string[]) {
    this.requireJob(hostId, JOB_ACTION.upgradePackages, packages);
  }

  private requireJob(hostId: string, action: HostPackageAction, packages: readonly string[]) {
    const facts = this.hostView(hostId).health?.packages ?? null;
    // A reboot or a shutdown needs the host's systemd, not a package manager, and any admin may ask for one.
    const powering = isPowerAction(action);
    const reachable =
      facts !== null &&
      (facts.unsupported === null || (powering && facts.unsupported === PACKAGES_UNSUPPORTED.noPackageManager));
    if (facts === null || !reachable) {
      throw new DomainError(API_ERRORS.hostPackagesUnsupported);
    }
    const allowed =
      powering ||
      (action === JOB_ACTION.checkPackages
        ? facts.setting !== HOST_PACKAGES.off
        : facts.setting === HOST_PACKAGES.apply);
    if (!allowed) {
      throw new DomainError(API_ERRORS.hostPackagesNotAllowed);
    }
    if (this.openJob(hostId) !== null) {
      throw new DomainError(API_ERRORS.hostPackagesBusy);
    }
    if (action === JOB_ACTION.upgradePackages) {
      this.requireOffered(hostId, packages);
    }
  }

  // An upgrade names only what the last check offered, so it changes exactly what was shown.
  private requireOffered(hostId: string, packages: readonly string[]) {
    const offered = new Set(this.latestCheck(hostId)?.check.upgradable.map(({ name }) => name) ?? []);
    if (packages.length === 0 || packages.some((name) => !offered.has(name))) {
      throw new DomainError(API_ERRORS.packagesNotOffered);
    }
  }

  // --- the nightly window --------------------------------------------------------------------------

  settings(): HostUpdateSettingsView {
    return (
      this.dependencies.settings.read(SETTING_KEYS.hostUpdates, hostUpdateSettingsSchema) ?? {
        ...HOST_UPDATE_DEFAULTS,
      }
    );
  }

  saveSettings(actor: Actor, settings: HostUpdateSettingsView): HostUpdateSettingsView {
    this.dependencies.settings.write(SETTING_KEYS.hostUpdates, settings);
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostUpdatesSaved,
      { kind: TARGET_HOST, id: "" },
      {
        ...settings,
      },
    );
    return settings;
  }

  /**
   * Each minute: a host's first check as soon as its .env allows it, then in its window its nightly check
   * and the security fixes Autoheal may take. Each happens once per window, and never while another
   * package job is on its way.
   */
  tick() {
    const settings = this.settings();
    for (const host of this.dependencies.inventory.hosts()) {
      try {
        this.firstCheck(host);
        this.nightly(host, settings);
      } catch (error) {
        log(describeError(error));
      }
    }
  }

  // Online, and its .env lets Autoheal at least check its packages.
  private checkable(host: HostView): boolean {
    const facts = host.health?.packages ?? null;
    const allowed = facts !== null && facts.unsupported === null && facts.setting !== HOST_PACKAGES.off;
    return allowed && host.state === HOST_STATE.online;
  }

  // Its page lists its updates at once rather than after the night; an hour apart while that check fails.
  private firstCheck(host: HostView) {
    const retryAfter = this.clock() - HOST_PACKAGE_FIRST_CHECK_RETRY_MILLISECONDS;
    const due =
      this.checkable(host) &&
      this.latestCheck(host.id) === null &&
      this.openJob(host.id) === null &&
      !this.askedByAutohealSince(host.id, JOB_ACTION.checkPackages, retryAfter);
    if (due) {
      this.dependencies.jobs.request(AUTOHEAL, host.id, "", JOB_ACTION.checkPackages, null);
    }
  }

  private nightly(host: HostView, settings: HostUpdateSettingsView) {
    const now = this.clock();
    const timeZone = host.health?.packages?.timeZone ?? FALLBACK_TIME_ZONE;
    if (!this.checkable(host) || !insideWindow(settings, timeZone, now)) {
      return;
    }
    if (this.openJob(host.id) !== null) {
      return;
    }
    const windowOpened = now - windowMilliseconds(settings);
    if (!this.askedByAutohealSince(host.id, JOB_ACTION.checkPackages, windowOpened)) {
      this.dependencies.jobs.request(AUTOHEAL, host.id, "", JOB_ACTION.checkPackages, null);
      return;
    }
    const latest = this.latestCheck(host.id);
    // Tonight's check has not answered yet.
    if (latest === null || latest.checkedAt < windowOpened) {
      return;
    }
    const plan = this.planOf(host, latest, settings);
    const due =
      plan.automatic.length > 0 &&
      !this.askedByAutohealSince(host.id, JOB_ACTION.upgradePackages, windowOpened) &&
      this.fitForUpdate(host, latest.check);
    if (due) {
      this.dependencies.jobs.request(AUTOHEAL, host.id, "", JOB_ACTION.upgradePackages, null, {
        packages: plan.automatic,
      });
    }
  }

  private askedByAutohealSince(hostId: string, action: HostPackageAction, since: number): boolean {
    const asked = this.database
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.hostId, hostId),
          eq(jobs.action, action),
          eq(jobs.requestedByAgent, AGENT_AUTOHEAL),
          gte(jobs.createdAt, since),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .get();
    return asked !== undefined;
  }

  // A host in trouble is left to a person: a container in a crash loop, too little disk, dpkg half-done.
  private fitForUpdate(host: HostView, check: PackageCheck): boolean {
    const freeOn = (path: string) => host.health?.disks.find((disk) => disk.path === path)?.availableBytes ?? null;
    const root = freeOn(ROOT_FILESYSTEM);
    const boot = freeOn(BOOT_FILESYSTEM);
    const troubled = this.dependencies.inventory
      .containers({ hostId: host.id })
      .some(({ problem }) => problem !== null && SEVERE_PROBLEMS.has(problem));
    return (
      check.refreshed &&
      !check.needsRepair &&
      !troubled &&
      (root === null || root >= AUTOMATIC_UPDATE_MINIMUM_FREE_BYTES.root) &&
      (boot === null || boot >= AUTOMATIC_UPDATE_MINIMUM_FREE_BYTES.boot)
    );
  }
}
