import {
  ACTION_ESCALATE,
  DECIDED_BY,
  DECISION_MESSAGES,
  HOST_CHANGE_PROMPT,
  INCIDENT_STATUS,
  PRIORITY_LIVE,
  PRIORITY_REPLAY,
  RAW_ANSWER_TRACE_LIMIT,
  RESTART_CHOICE,
  THINKING_TRACE_LIMIT,
  TRACE,
} from "../../shared/constants.js";
import { isRestart, parseDecision, type Decision } from "../../shared/decision.js";
import { describeError } from "../../shared/errors.js";
import type { DecisionResponse, IncidentSubmission } from "../../shared/protocol.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { IncidentsService } from "../incidents/incidents-service.js";
import type { NetworkWatch } from "../network/network-watch.js";
import type { HostModels, ModelServer } from "../ollama/ollama-pool.js";
import type { JobPriority } from "./decision-queue.js";
import { buildPrompt, composeSystemPrompt } from "../../shared/prompt.js";
import {
  renderChanges,
  renderEarlierIncidents,
  renderUsage,
  sampledUsage,
  type EarlierIncident,
} from "../../shared/prompt-sections.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { MetricsStore } from "../inventory/metrics-store.js";
import type { RunbooksService } from "../runbooks/runbooks-service.js";

/** The runner stopped waiting (its deadline passed) before the decision could be delivered. */
class RunnerGoneError extends Error {}

/**
 * One incident through the model: build the prompt, wait for the fleet-wide queue, ask Ollama,
 * and let parseDecision turn the answer into something from the menu. Every step is traced.
 */
export class DecisionService {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly models: HostModels,
    private readonly runbooks: RunbooksService,
    private readonly network: Pick<NetworkWatch, "evidenceFor">,
    private readonly metrics: Pick<MetricsStore, "containerHistory">,
    private readonly inventory: Pick<InventoryService, "recentChanges" | "hostAddress" | "containers">,
  ) {}

  /**
   * `runnerGone` aborts when the runner's request ends before an answer went out: it then decides on
   * its own and reports that later, so this incident is closed as cancelled rather than left open.
   */
  async decide(host: HostRow, submission: IncidentSubmission, runnerGone: AbortSignal): Promise<DecisionResponse> {
    const { report } = submission;
    const incident = this.incidents.create(host, submission, INCIDENT_STATUS.deciding);
    const earlier = this.earlierIncidents(host.id, report.containerName, incident.createdAt);
    const history = this.metrics.containerHistory(host.id, report.containerName);
    this.incidents.saveUsage(incident.id, sampledUsage(history));
    // The failed container's, its compose neighbours' and the host's own: what can explain this failure.
    const concerned = new Set([report.containerName, ...(report.neighbours ?? []).map(({ name }) => name)]);
    const since = incident.createdAt - HOST_CHANGE_PROMPT.windowMilliseconds;
    const changes = this.inventory.recentChanges(host.id, concerned, since, HOST_CHANGE_PROMPT.entries);
    const networkEvidence = this.network.evidenceFor(this.addressOf(host), report.containerName, incident.createdAt);
    const sections = [
      renderEarlierIncidents(earlier),
      renderUsage(history),
      renderChanges(changes),
      networkEvidence,
    ].filter((section) => section !== null);
    this.incidents.saveEvidence(incident.id, sections);
    const { systemPrompt, included } = composeSystemPrompt(this.runbooks.instructionsFor(report));
    const server = this.models.serverFor(host.id);
    const prompt = buildPrompt(report, server.client.contextTokens, systemPrompt, sections);
    this.runbooks.savePromptSnapshot(prompt.promptHash, prompt.systemPrompt);
    this.incidents.addEvent(incident.id, TRACE.promptBuilt, {
      promptHash: prompt.promptHash,
      model: server.client.model,
      ...(server.name === null ? {} : { server: server.name }),
      runbooks: included.map(({ title, version }) => ({ title, version })),
      logCharacters: report.logs.length,
      earlierIncidents: earlier.length,
    });
    const answered: { server: ModelServer; promptHash: string } = { server, promptHash: prompt.promptHash };
    // Another server may read another amount: its prompt is made for it.
    const promptFor = (asked: ModelServer) => {
      answered.server = asked;
      if (asked === server) return prompt;
      const rebuilt = buildPrompt(report, asked.client.contextTokens, systemPrompt, sections);
      this.runbooks.savePromptSnapshot(rebuilt.promptHash, rebuilt.systemPrompt);
      answered.promptHash = rebuilt.promptHash;
      return rebuilt;
    };
    let decision: Decision;
    try {
      decision = await this.askModel(
        incident.id,
        host.id,
        promptFor,
        submission,
        runnerGone,
        this.priorityOf(host, report.containerName),
      );
    } catch (error) {
      if (!(error instanceof RunnerGoneError)) {
        throw error;
      }
      this.incidents.cancelAbandoned(incident.id);
      throw error;
    }
    this.incidents.addEvent(incident.id, TRACE.decided, { ...decision });
    // Before the check below: the runner may give up while this is fetched.
    const modelDigest = await answered.server.client.modelDigest();
    if (runnerGone.aborted) {
      this.incidents.cancelAbandoned(incident.id);
      throw new RunnerGoneError();
    }
    this.incidents.update(incident.id, {
      status: isRestart(decision) ? INCIDENT_STATUS.decided : INCIDENT_STATUS.awaitingApproval,
      decidedBy: DECIDED_BY.model,
      action: decision.action,
      target: decision.target,
      diagnosis: decision.diagnosis,
      promptHash: answered.promptHash,
      modelName: answered.server.client.model,
      modelDigest,
    });
    return { incidentId: incident.id, decision };
  }

  /**
   * A container set only to tell is never restarted, and nobody waits on its answer: Ollama is asked about it behind
   * every live incident, and is stopped and asked again later should one come meanwhile. Its word still comes.
   */
  private priorityOf(host: HostRow, containerName: string): JobPriority {
    const container = this.inventory.containers({ hostId: host.id }).find(({ name }) => name === containerName);
    return container?.byItself.restart === RESTART_CHOICE.tell ? PRIORITY_REPLAY : PRIORITY_LIVE;
  }

  private addressOf(host: HostRow): string | null {
    return this.inventory.hostAddress(host.id);
  }

  // Facts and the owner's words only: the model's own earlier diagnoses never come back to it as facts.
  private earlierIncidents(hostId: string, containerName: string, before: number): EarlierIncident[] {
    return this.incidents.earlierRows(hostId, containerName, before).map((row) => ({
      detectedAt: row.detectedAt,
      trigger: row.triggerEvent,
      action: row.action,
      target: row.target,
      verdict: row.verdict,
      status: row.status,
      outcome: row.outcome,
      approvals: this.incidents.approvalsOf(row.id),
    }));
  }

  private async askModel(
    incidentId: string,
    hostId: string,
    promptFor: (server: ModelServer) => { systemPrompt: string; userPrompt: string },
    { report }: IncidentSubmission,
    runnerGone: AbortSignal,
    priority: JobPriority,
  ): Promise<Decision> {
    try {
      const { content, thinking } = await this.models.askFor(
        hostId,
        priority,
        (server, signal) => {
          const { systemPrompt, userPrompt } = promptFor(server);
          return server.client.chat(systemPrompt, userPrompt, AbortSignal.any([signal, runnerGone]));
        },
        (from, reason) => this.incidents.addEvent(incidentId, TRACE.serverFellBack, { from, reason }),
      );
      this.incidents.addEvent(incidentId, TRACE.modelAnswered, {
        raw: content.slice(0, RAW_ANSWER_TRACE_LIMIT),
        ...(thinking === "" ? {} : { thinking: thinking.slice(-THINKING_TRACE_LIMIT) }),
      });
      return parseDecision(content, report);
    } catch (error) {
      if (runnerGone.aborted) {
        throw new RunnerGoneError();
      }
      const reason = describeError(error);
      this.incidents.addEvent(incidentId, TRACE.modelFailed, { error: reason });
      return {
        action: ACTION_ESCALATE,
        target: report.containerName,
        diagnosis: DECISION_MESSAGES.ollamaFailed(reason),
      };
    }
  }
}
