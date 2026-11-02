import { z } from "zod";
import {
  hasUpdate,
  type ContainerView,
  type HostView,
  type IncidentSummaryView,
  type JobView,
} from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  HOST_STATE,
  INCIDENT_STATUS,
  JOB_STATUS,
  OLD_CONTAINER_SUFFIX,
  PRIORITY_LIVE,
  REPAIR,
  REPAIR_JOBS,
  REPAIR_JSON_SCHEMA,
  REPAIR_LIMITS,
  REPAIR_SYSTEM_PROMPT,
  REPAIR_TEXT,
  REPAIRS,
  RESTART_CHOICE,
  THINKING_TRACE_LIMIT,
  TRACE,
  VERDICT_ESCALATED,
  VERDICT_REPAIRED,
  type Repair,
  type Verdict,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { buildPrompt, composeSystemPrompt } from "../../shared/prompt.js";
import type { HostModels } from "../ollama/ollama-pool.js";
import { isDatabaseImage } from "../host-control/host-control.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { JobsService } from "../jobs/jobs-service.js";
import { logAlertNotQueued, type Notifier } from "../notifications/notifier.js";
import type { RunbooksService } from "../runbooks/runbooks-service.js";
import type { TaskAuthor } from "../tasks/tasks-service.js";
import { isFine } from "./incident-reconciler.js";
import type { IncidentsService } from "./incidents-service.js";

export interface RepairWorkerDependencies {
  incidents: Pick<
    IncidentsService,
    "list" | "find" | "update" | "addEvent" | "reportOf" | "evidenceOf" | "latestEvent" | "latestKind" | "eventsSince"
  >;
  inventory: Pick<InventoryService, "hosts" | "containers">;
  jobs: Pick<JobsService, "request" | "view">;
  models: HostModels;
  runbooks: Pick<RunbooksService, "instructionsFor">;
  notifier: Pick<Notifier, "incidentHandled">;
  clock?: () => number;
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const OPEN_JOBS: ReadonlySet<string> = new Set([JOB_STATUS.pending, JOB_STATUS.delivered]);
// A repair's steps, in the order they are kept: which came last says where it stands.
const REPAIR_STEPS = [TRACE.repairStarted, TRACE.repairPlanned, TRACE.repairSkipped, TRACE.repairFinished];
// What makes an escalation due for Ollama: none of these yet, or a person's hand-over since the last answer.
const ANSWERS_AND_HAND_OVERS = [TRACE.dispatched, TRACE.repairPlanned, TRACE.repairSkipped];

const answerSchema = z.object({
  repair: z.enum(REPAIRS),
  findings: z.string(),
  cause: z.string(),
  steps: z.array(z.string()),
});

/** What Ollama made of it: the repair it chose, and the report that goes with any choice. */
interface Plan {
  repair: Repair;
  findings: string;
  cause: string;
  steps: string[];
  thinking?: string;
}

interface Candidate {
  host: HostView;
  container: ContainerView;
  // A person handed this incident to Ollama.
  dispatched: boolean;
}

const planOf = (answer: z.infer<typeof answerSchema>, thinking: string): Plan => ({
  repair: answer.repair,
  findings: answer.findings.trim().slice(0, REPAIR_LIMITS.findingsCharacters),
  cause: answer.cause.trim().slice(0, REPAIR_LIMITS.findingsCharacters),
  steps: answer.steps.slice(0, REPAIR_LIMITS.steps).map((step) => step.trim().slice(0, REPAIR_LIMITS.stepCharacters)),
  ...(thinking === "" ? {} : { thinking: thinking.slice(-THINKING_TRACE_LIMIT) }),
});

// What the trace kept of a plan: read back as the worker wrote it.
const storedPlanOf = (payload: Record<string, unknown>): Plan & { jobId: string | null } => ({
  repair: payload.repair as Repair,
  findings: String(payload.findings ?? ""),
  cause: String(payload.cause ?? ""),
  steps: Array.isArray(payload.steps) ? payload.steps.map(String) : [],
  jobId: typeof payload.jobId === "string" ? payload.jobId : null,
});

/**
 * Containers given to Ollama, and escalations a person hands to it: once a restart did not hold, and the incident
 * waits for a person, Ollama looks into it and picks one repair from a fixed list, carried out as a job the runner
 * checks again. The incident ends repaired when it holds; otherwise Ollama's report says how to fix it by hand, and
 * the incident waits for a person as before. One pass at a time, beside the other work: a model can take minutes.
 */
export class RepairWorker {
  private running = false;

  constructor(private readonly dependencies: RepairWorkerDependencies) {}

  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.finishRepairs();
      await this.startRepairs();
    } finally {
      this.running = false;
    }
  }

  private now() {
    return (this.dependencies.clock ?? Date.now)();
  }

  private hostsById() {
    return new Map(this.dependencies.inventory.hosts().map((host) => [host.id, host]));
  }

  /**
   * The repairs under way whose job has ended: done, failed, or never collected in time. One whose ask a restart cut
   * short goes back to the person, to be tried again; one a person approved is theirs.
   */
  private async finishRepairs() {
    const { incidents, jobs } = this.dependencies;
    const hosts = this.hostsById();
    for (const incident of incidents.list({ status: INCIDENT_STATUS.approved })) {
      const latest = incidents.latestKind(incident.id, REPAIR_STEPS);
      // No pass overlaps another, so no ask is under way now: one asked and never answered was cut short.
      if (latest === TRACE.repairStarted) {
        incidents.update(incident.id, { status: INCIDENT_STATUS.awaitingApproval });
        continue;
      }
      // Only a repair planned and not finished waits on its job: anything else approved is a person's.
      const stored = latest === TRACE.repairPlanned ? incidents.latestEvent(incident.id, TRACE.repairPlanned) : null;
      const plan = stored === null ? null : storedPlanOf(stored);
      if (plan === null || plan.jobId === null) {
        continue;
      }
      const job = jobs.view(plan.jobId);
      if (OPEN_JOBS.has(job.status)) {
        continue;
      }
      await this.finish(incident, hosts.get(incident.hostId)?.label ?? incident.hostLabel, plan, job);
    }
  }

  private async finish(incident: IncidentSummaryView, hostLabel: string, plan: Plan, job: JobView) {
    const { incidents } = this.dependencies;
    const succeeded = job.status === JOB_STATUS.succeeded;
    const done = job.outcome ?? job.status;
    incidents.addEvent(incident.id, TRACE.repairFinished, { succeeded, outcome: done });
    if (succeeded) {
      const outcome = REPAIR_TEXT.repaired(REPAIR_TEXT.verbs[plan.repair], done);
      incidents.update(incident.id, { status: INCIDENT_STATUS.resolved, verdict: VERDICT_REPAIRED, outcome });
      await this.tell(hostLabel, incident, VERDICT_REPAIRED, outcome, plan, REPAIR_TEXT.runningAgain);
      return;
    }
    const outcome = REPAIR_TEXT.notRepaired(plan.repair, done);
    incidents.update(incident.id, { status: INCIDENT_STATUS.awaitingApproval, verdict: VERDICT_ESCALATED, outcome });
    await this.tell(hostLabel, incident, VERDICT_ESCALATED, outcome, plan, this.failedState(incident.id));
  }

  private async startRepairs() {
    const hosts = this.hostsById();
    for (const incident of this.dependencies.incidents.list({ status: INCIDENT_STATUS.awaitingApproval })) {
      const candidate = this.candidateOf(incident, hosts);
      if (candidate === null) {
        continue;
      }
      await this.repair(incident, candidate).catch((error: unknown) => log(describeError(error)));
    }
  }

  /**
   * A container given to Ollama, or an incident a person handed to it, on a host that acts (online, out of
   * dry-run), still down, and not answered yet: once for a container's own answer, again after each hand-over. One
   * back on its own is left to settle by itself.
   */
  private candidateOf(incident: IncidentSummaryView, hosts: ReadonlyMap<string, HostView>): Candidate | null {
    const { incidents, inventory } = this.dependencies;
    const host = hosts.get(incident.hostId);
    if (host === undefined || host.state !== HOST_STATE.online || host.dryRun !== false) {
      return null;
    }
    const container = inventory
      .containers({ hostId: host.id })
      .find((candidate) => candidate.name === incident.containerName);
    const dispatched = incidents.latestEvent(incident.id, TRACE.dispatched) !== null;
    const given = container?.byItself.restart === RESTART_CHOICE.repair || dispatched;
    if (container === undefined || container.handsOff !== null || !given || isFine(container)) {
      return null;
    }
    const latest = incidents.latestKind(incident.id, ANSWERS_AND_HAND_OVERS);
    const due = latest === null || latest === TRACE.dispatched;
    return due ? { host, container, dispatched } : null;
  }

  private async repair(incident: IncidentSummaryView, { host, container, dispatched }: Candidate) {
    const { incidents } = this.dependencies;
    const since = this.now() - REPAIR_LIMITS.windowMilliseconds;
    const repaired = incidents
      .eventsSince(host.id, container.name, TRACE.repairPlanned, since)
      .filter((plan) => typeof plan.jobId === "string");
    // The daily limit holds back Autoheal's own repairs; a person's hand-over is theirs to make again.
    if (!dispatched && repaired.length >= REPAIR_LIMITS.perContainer) {
      incidents.addEvent(incident.id, TRACE.repairSkipped, {
        reason: REPAIR_TEXT.tooMany(container.name, repaired.length),
      });
      return;
    }
    const offered = this.offered(host, container, dispatched);
    // Off the person's list while Ollama works on it.
    incidents.addEvent(incident.id, TRACE.repairStarted, { offered });
    incidents.update(incident.id, { status: INCIDENT_STATUS.approved });
    const answer = await this.ask(incident, offered);
    if (answer.plan === null) {
      incidents.addEvent(incident.id, TRACE.repairSkipped, { reason: REPAIR_TEXT.unusableAnswer(answer.reason) });
      incidents.update(incident.id, { status: INCIDENT_STATUS.awaitingApproval });
      return;
    }
    const plan = answer.plan;
    if (plan.repair === REPAIR.report || !offered.includes(plan.repair)) {
      const outcome = plan.repair === REPAIR.report ? REPAIR_TEXT.reported : REPAIR_TEXT.unavailable(plan.repair);
      await this.report(incident, host, { ...plan, repair: REPAIR.report }, outcome);
      return;
    }
    const requested = this.request(host, container, plan.repair);
    if (typeof requested === "string") {
      await this.report(incident, host, { ...plan, repair: REPAIR.report }, requested);
      return;
    }
    incidents.addEvent(incident.id, TRACE.repairPlanned, { ...plan, jobId: requested.id });
  }

  // No repair it may make: the incident waits for a person again, with the report.
  private async report(incident: IncidentSummaryView, host: HostView, plan: Plan, outcome: string) {
    const { incidents } = this.dependencies;
    incidents.addEvent(incident.id, TRACE.repairPlanned, { ...plan });
    incidents.update(incident.id, { status: INCIDENT_STATUS.awaitingApproval, outcome });
    await this.tell(host.label, incident, VERDICT_ESCALATED, outcome, plan, this.failedState(incident.id));
  }

  // The job, or why it could not be asked for: its runner would refuse it.
  private request(host: HostView, container: ContainerView, repair: Exclude<Repair, typeof REPAIR.report>) {
    try {
      return this.dependencies.jobs.request(AUTOHEAL, host.id, container.name, REPAIR_JOBS[repair], null);
    } catch (error) {
      return describeError(error);
    }
  }

  /**
   * What may be done to it now: recreate it, always; roll it back while an update keeps its old container aside;
   * update it when a newer image is out and it is no database, unless a person handed it over; or report.
   */
  private offered(host: HostView, container: ContainerView, dispatched: boolean): Repair[] {
    const parked = `${container.name}${OLD_CONTAINER_SUFFIX}`;
    const keptAside = this.dependencies.inventory.containers({ hostId: host.id }).some(({ name }) => name === parked);
    const updatable = hasUpdate(container) && (dispatched || !isDatabaseImage(container.image));
    return [
      REPAIR.recreate,
      ...(keptAside ? [REPAIR.rollBack] : []),
      ...(updatable ? [REPAIR.update] : []),
      REPAIR.report,
    ];
  }

  /** Ollama's plan from the incident's report, its evidence, what was tried and the repairs on offer. */
  private async ask(incident: IncidentSummaryView, offered: readonly Repair[]) {
    const { incidents, models, runbooks } = this.dependencies;
    const report = incidents.reportOf(incident.id);
    if (report === null) {
      return { plan: null, reason: REPAIR_TEXT.noReport };
    }
    const { systemPrompt } = composeSystemPrompt(runbooks.instructionsFor(report), REPAIR_SYSTEM_PROMPT);
    const tried = incidents.find(incident.id).outcome ?? "";
    const sections = [...incidents.evidenceOf(incident.id), REPAIR_TEXT.tried(tried), REPAIR_TEXT.offered(offered)];
    try {
      const { content, thinking } = await models.askFor(
        incident.hostId,
        PRIORITY_LIVE,
        (server, signal) => {
          const { userPrompt } = buildPrompt(report, server.client.contextTokens, systemPrompt, sections);
          return server.client.chat(systemPrompt, userPrompt, signal, REPAIR_JSON_SCHEMA);
        },
        (from, reason) => incidents.addEvent(incident.id, TRACE.serverFellBack, { from, reason }),
      );
      const parsed = answerSchema.safeParse(JSON.parse(content));
      return parsed.success
        ? { plan: planOf(parsed.data, thinking), reason: "" }
        : { plan: null, reason: REPAIR_TEXT.notAPlan };
    } catch (error) {
      return { plan: null, reason: describeError(error) };
    }
  }

  private failedState(incidentId: string) {
    return this.dependencies.incidents.reportOf(incidentId)?.stateSummary ?? "";
  }

  private async tell(
    hostLabel: string,
    incident: IncidentSummaryView,
    verdict: Verdict,
    outcome: string,
    plan: Plan,
    state: string,
  ) {
    await this.dependencies.notifier
      .incidentHandled(hostLabel, {
        containerName: incident.containerName,
        verdict,
        outcome,
        diagnosis: REPAIR_TEXT.report(plan.findings, plan.cause, plan.steps),
        stateSummary: state,
        incidentId: incident.id,
      })
      .catch(logAlertNotQueued);
  }
}
