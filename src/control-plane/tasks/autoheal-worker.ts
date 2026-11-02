import { hasUpdate, type ContainerView, type HostView } from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AUTOHEAL_TEXT,
  DETECTOR_THRESHOLDS,
  JOB_ACTION,
  TASK_ACTIVITY,
  TASK_RESOURCE,
  TASK_STATUS,
  UPDATE_ASSESSMENT,
  UPDATE_POLICY,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { JobsService } from "../jobs/jobs-service.js";
import type { Notifier } from "../notifications/notifier.js";
import { imageDiskOf, percentFullOf } from "./detectors.js";
import type { UpdateAssessor } from "./update-assessor.js";
import type { TaskAuthor, TaskRow, TasksService } from "./tasks-service.js";

export interface AutohealWorkerDependencies {
  tasks: TasksService;
  jobs: Pick<JobsService, "request">;
  inventory: Pick<InventoryService, "containers" | "hosts">;
  assessor: Pick<UpdateAssessor, "assess">;
  notifier: Pick<Notifier, "taskResolved">;
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };

// What starts Autoheal's turn on a task: it was opened, came back, or was handed over.
const TURN_STARTS = [TASK_ACTIVITY.created, TASK_ACTIVITY.reopened, TASK_ACTIVITY.assigned] as const;
// A person's hand-over to the Ollama agent comes right after its assignment: still the latest, it is this turn's.
const HAND_OVER_TURN = [...TURN_STARTS, TASK_ACTIVITY.dispatched] as const;

/**
 * Autoheal working its own queue: the open tasks assigned to it. That is two kinds of work: image
 * updates, and full disks. For an update it asks Ollama first; the model can only hold it back and
 * hand the task to a person, never start one the container's label didn't allow.
 */
export class AutohealWorker {
  private running = false;
  private advising = false;

  constructor(private readonly dependencies: AutohealWorkerDependencies) {}

  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (const task of this.dependencies.tasks.autohealQueue()) {
        await this.work(task).catch((error: unknown) => log(describeError(error)));
      }
    } finally {
      this.running = false;
    }
  }

  private async work(task: TaskRow) {
    if (task.resourceKind === TASK_RESOURCE.disk) {
      await this.freeDisk(task);
      return;
    }
    const { tasks, jobs } = this.dependencies;
    const container = this.containerOf(task);
    // Nothing to do (yet): the update is gone, or the host has not reported the container.
    if (container === null || !hasUpdate(container) || !tasks.checkout(task.id, AGENT_AUTOHEAL)) {
      return;
    }
    // Given to Autoheal by hand, or the host's rules changed since: its runner would refuse.
    if (container.handsOff !== null) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.handsOff(container.handsOff, container.name, container.hostLabel));
      this.giveBack(task);
      return;
    }
    try {
      const proceed = await this.decide(task, container);
      if (!proceed) {
        this.giveBack(task);
        return;
      }
      // Its runner puts it back at once when the new container does not come back healthy, where its owner chose so.
      const undoIfUnhealthy = this.handedOver(task) || container.update.policy === UPDATE_POLICY.always;
      // Its result releases the task, and closes it or hands it to a person.
      jobs.request(AUTOHEAL, container.hostId, container.name, JOB_ACTION.update, task.id, { undoIfUnhealthy });
    } catch (error) {
      tasks.release(task.id);
      throw error;
    }
  }

  /**
   * Ollama's view on each image update a person holds, shown beside it: safe to apply, or hold. Nothing
   * is changed. Asked once per task; when Ollama can't be asked, the rest wait for the next run.
   */
  async adviseUpdates() {
    if (this.advising) {
      return;
    }
    this.advising = true;
    try {
      for (const task of this.dependencies.tasks.updatesToAdvise()) {
        if (!(await this.advise(task))) {
          return;
        }
      }
    } finally {
      this.advising = false;
    }
  }

  // False when Ollama gave no usable answer: worth asking again later.
  private async advise(task: TaskRow): Promise<boolean> {
    const { tasks, assessor } = this.dependencies;
    const container = this.containerOf(task);
    if (container === null || !hasUpdate(container)) {
      return true;
    }
    const assessment = await assessor.assess(container, this.neighboursOf(container));
    if (assessment.decision === null) {
      return false;
    }
    tasks.addActivity(task.id, TASK_ACTIVITY.assessed, AUTOHEAL, { ...assessment });
    tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.advised(assessment.decision, assessment.reason));
    return true;
  }

  /**
   * A full disk: Autoheal removes the images no container uses (never one kept for rolling back) at once,
   * then reads the host's next report: below the threshold it closes the task, else gives it to a person.
   */
  private async freeDisk(task: TaskRow) {
    const { tasks, inventory, notifier } = this.dependencies;
    const host = inventory.hosts().find((candidate) => candidate.id === task.hostId);
    const path = task.resourceId ?? "";
    const latest = tasks.latestActivity(task.id, [...TURN_STARTS, TASK_ACTIVITY.jobFinished]);
    if (host === undefined) {
      return;
    }
    if (latest?.kind !== TASK_ACTIVITY.jobFinished) {
      this.cleanUp(task, host, path);
      return;
    }
    // Only a report sent after the clean-up says what it left.
    if ((host.lastHeartbeatAt ?? 0) <= latest.createdAt) {
      return;
    }
    const disk = host.health?.disks.find((candidate) => candidate.path === path);
    if (disk === undefined) {
      this.giveBack(task);
      return;
    }
    const percent = percentFullOf(disk.usedBytes, disk.availableBytes);
    if (percent < DETECTOR_THRESHOLDS.diskPercent) {
      const freed = AUTOHEAL_TEXT.diskFreed(path, percent);
      tasks.comment(AUTOHEAL, task.id, freed);
      await notifier.taskResolved(tasks.closeCleared(task.id), freed);
      return;
    }
    tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.diskStillFull(path, percent));
    this.giveBack(task);
  }

  // The host's own clean-up, asked for now: its result releases the task, and a failed one goes to a person.
  private cleanUp(task: TaskRow, host: HostView, path: string) {
    const { tasks, jobs } = this.dependencies;
    if (!tasks.checkout(task.id, AGENT_AUTOHEAL)) {
      return;
    }
    // Removing images frees only the disk they are on.
    if (imageDiskOf(host.health) !== path) {
      const unknown = (host.health?.imageStore ?? null) === null;
      tasks.comment(
        AUTOHEAL,
        task.id,
        unknown ? AUTOHEAL_TEXT.diskStoreUnknown(host.label) : AUTOHEAL_TEXT.diskWithoutImages(path),
      );
      this.giveBack(task);
      return;
    }
    try {
      jobs.request(AUTOHEAL, host.id, "", JOB_ACTION.pruneImages, task.id);
    } catch (error) {
      tasks.release(task.id);
      throw error;
    }
  }

  private giveBack(task: TaskRow) {
    const { tasks } = this.dependencies;
    tasks.setByAutoheal(task.id, { status: TASK_STATUS.todo, assignee: tasks.owner() });
    tasks.release(task.id);
  }

  // A person handed it to the Ollama agent this turn: they decided, whatever held it.
  private handedOver(task: TaskRow): boolean {
    return this.dependencies.tasks.latestActivity(task.id, HAND_OVER_TURN)?.kind === TASK_ACTIVITY.dispatched;
  }

  /** Whether to update now; says why in the task either way. */
  private async decide(task: TaskRow, container: ContainerView): Promise<boolean> {
    const { tasks, assessor } = this.dependencies;
    // Its hand-over already said so in the task.
    if (this.handedOver(task)) {
      return true;
    }
    // Given back by a person after Autoheal held it: they decided.
    if (tasks.hasActivity(task.id, TASK_ACTIVITY.assessed)) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.overridden);
      return true;
    }
    // Its owner chose each new image: its runner undoes one that does not come back healthy.
    if (container.update.policy === UPDATE_POLICY.always) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.alwaysApplied);
      return true;
    }
    const neighbours = this.neighboursOf(container);
    const assessment = await assessor.assess(container, neighbours);
    tasks.addActivity(task.id, TASK_ACTIVITY.assessed, AUTOHEAL, { ...assessment });
    if (assessment.decision === UPDATE_ASSESSMENT.hold) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.assessedHold(assessment.reason));
      return false;
    }
    const said =
      assessment.decision === null
        ? AUTOHEAL_TEXT.noAssessment(assessment.reason)
        : AUTOHEAL_TEXT.assessedUpdate(assessment.reason);
    tasks.comment(AUTOHEAL, task.id, said);
    return true;
  }

  private containerOf(task: TaskRow): ContainerView | null {
    if (task.hostId === null) {
      return null;
    }
    const found = this.dependencies.inventory
      .containers({ hostId: task.hostId })
      .find((container) => container.name === task.resourceId);
    return found ?? null;
  }

  private neighboursOf(container: ContainerView): ContainerView[] {
    if (container.composeProject === null) {
      return [];
    }
    return this.dependencies.inventory
      .containers({ hostId: container.hostId })
      .filter((other) => other.composeProject === container.composeProject && other.name !== container.name);
  }
}
