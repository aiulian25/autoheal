import { z } from "zod";
import type { JobView } from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AGENT_NAMES,
  FAILURE_REPORT_JSON_SCHEMA,
  FAILURE_REPORT_SYSTEM_PROMPT,
  FAILURE_REPORT_TEXT,
  PRIORITY_LIVE,
  REPAIR_LIMITS,
  REPAIR_TEXT,
  TASK_ACTIVITY,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { charactersLeft } from "../../shared/prompt.js";
import { fencedLogs } from "../../shared/report.js";
import type { HostModels } from "../ollama/ollama-pool.js";
import type { JobsService } from "../jobs/jobs-service.js";
import type { TaskAuthor, TaskRow, TasksService } from "../tasks/tasks-service.js";

export interface FailureReporterDependencies {
  tasks: Pick<TasksService, "dispatchedTasks" | "latestActivity" | "comment" | "addActivity">;
  jobs: Pick<JobsService, "view">;
  models: HostModels;
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
// Since a task's latest hand-over: its job's end, and Ollama's report on it.
const HAND_OVER_STEPS = [TASK_ACTIVITY.dispatched, TASK_ACTIVITY.jobFinished, TASK_ACTIVITY.reported];

const reportSchema = z.object({ findings: z.string(), cause: z.string(), steps: z.array(z.string()) });

const trimmed = (text: string) => text.trim().slice(0, REPAIR_LIMITS.findingsCharacters);

/**
 * Ollama steps in when work a person handed to it failed: it reads what the host's runner said and the job's last
 * output (an update's new container's logs, the package manager's), and writes on the task what happened and how
 * to fix it by hand. Asked once per failure, and only then: what goes well needs no model.
 */
export class FailureReporter {
  private running = false;

  constructor(private readonly dependencies: FailureReporterDependencies) {}

  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (const task of this.dependencies.tasks.dispatchedTasks()) {
        await this.reportOn(task).catch((error: unknown) => log(describeError(error)));
      }
    } finally {
      this.running = false;
    }
  }

  // The agent's own job since the hand-over failed, and Ollama has not said why yet.
  private async reportOn(task: TaskRow) {
    const { tasks, jobs } = this.dependencies;
    const latest = tasks.latestActivity(task.id, HAND_OVER_STEPS);
    const jobId = latest?.data.jobId;
    if (latest?.kind !== TASK_ACTIVITY.jobFinished || latest.data.succeeded !== false || typeof jobId !== "string") {
      return;
    }
    const job = jobs.view(jobId);
    if (job.requestedBy !== AGENT_NAMES[AGENT_AUTOHEAL]) {
      return;
    }
    tasks.comment(AUTOHEAL, task.id, await this.ask(job));
    tasks.addActivity(task.id, TASK_ACTIVITY.reported, AUTOHEAL, { jobId });
  }

  private async ask(job: JobView): Promise<string> {
    const { models } = this.dependencies;
    const target = job.containerName === "" ? FAILURE_REPORT_TEXT.packages : job.containerName;
    const facts = [
      FAILURE_REPORT_TEXT.what(job.action, target, job.hostLabel),
      FAILURE_REPORT_TEXT.outcome(job.outcome ?? job.status),
    ].join("\n\n");
    try {
      const { content } = await models.askFor(job.hostId, PRIORITY_LIVE, (server, signal) => {
        // The newest lines matter most: what does not fit goes from the start.
        const room = charactersLeft(server.client.contextTokens, FAILURE_REPORT_SYSTEM_PROMPT, facts);
        const output = (job.output ?? "").slice(-room);
        const said = output === "" ? FAILURE_REPORT_TEXT.noOutput : FAILURE_REPORT_TEXT.output(fencedLogs(output));
        return server.client.chat(
          FAILURE_REPORT_SYSTEM_PROMPT,
          `${facts}\n\n${said}`,
          signal,
          FAILURE_REPORT_JSON_SCHEMA,
        );
      });
      const parsed = reportSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        return FAILURE_REPORT_TEXT.unavailable(FAILURE_REPORT_TEXT.notAReport);
      }
      const steps = parsed.data.steps
        .slice(0, REPAIR_LIMITS.steps)
        .map((step) => step.trim().slice(0, REPAIR_LIMITS.stepCharacters));
      return REPAIR_TEXT.report(trimmed(parsed.data.findings), trimmed(parsed.data.cause), steps);
    } catch (error) {
      return FAILURE_REPORT_TEXT.unavailable(describeError(error));
    }
  }
}
