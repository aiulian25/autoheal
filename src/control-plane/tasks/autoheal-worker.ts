import { hasUpdate, type ContainerView, type HostView } from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AUTOHEAL_ASSESSMENT,
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
import { DomainError } from "../domain-error.js";
import { imageDiskOf, isNewerVersionTaskKey, percentFullOf, tagOfNewerVersionKey } from "./detectors.js";
import type { Assessment, UpdateAssessor } from "./update-assessor.js";
import type { TaskAuthor, TaskRow, TasksService } from "./tasks-service.js";

export interface AutohealWorkerDependencies {
  tasks: TasksService;
  jobs: Pick<JobsService, "request">;
  inventory: Pick<InventoryService, "containers" | "hosts">;
  assessor: Pick<UpdateAssessor, "assess">;
  notifier: Pick<Notifier, "taskResolved">;
  clock?: () => number;
}

// What becomes of an update now: applied, given to a person, or left waiting for Ollama's word.
const UPDATE_STEP = { apply: "apply", giveBack: "give_back", wait: "wait" } as const;
type UpdateStep = (typeof UPDATE_STEP)[keyof typeof UPDATE_STEP];

// An update waiting for Ollama's word: since when, when Ollama was last asked, and what it said once it answered.
interface AwaitingAssessment {
  since: number;
  askedAt: number;
  answer: Assessment | null;
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
  private readonly awaiting = new Map<string, AwaitingAssessment>();

  constructor(private readonly dependencies: AutohealWorkerDependencies) {}

  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const queue = this.dependencies.tasks.autohealQueue();
      // One no longer Autoheal's waits for nothing.
      const queued = new Set(queue.map((task) => task.id));
      for (const taskId of [...this.awaiting.keys()].filter((taskId) => !queued.has(taskId))) {
        this.awaiting.delete(taskId);
      }
      for (const task of queue) {
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
    if (isNewerVersionTaskKey(task.detectorKey)) {
      this.changeTag(task);
      return;
    }
    const { tasks, jobs } = this.dependencies;
    const container = this.containerOf(task);
    // Nothing to do (yet): the update is gone, the host has not reported the container, or Ollama has not answered.
    if (container === null || !hasUpdate(container) || !(await this.readyToDecide(task, container))) {
      return;
    }
    if (!tasks.checkout(task.id, AGENT_AUTOHEAL)) {
      return;
    }
    // Given to Autoheal by hand, or the host's rules changed since: its runner would refuse.
    if (container.handsOff !== null) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.handsOff(container.handsOff, container.name, container.hostLabel));
      this.giveBack(task);
      return;
    }
    try {
      const step = await this.decide(task, container);
      if (step === UPDATE_STEP.wait) {
        tasks.release(task.id);
        return;
      }
      if (step === UPDATE_STEP.giveBack) {
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
   * A newer version a person handed to the agent: its runner changes the tag where the files write it. Nothing else
   * ever moves a container to a new version: one only assigned here goes back.
   */
  private changeTag(task: TaskRow) {
    const { tasks, jobs } = this.dependencies;
    const container = this.containerOf(task);
    const tag = tagOfNewerVersionKey(task.detectorKey!);
    // The version moved on, or is reached already: its detector says so of the task.
    if (container === null || container.update.newerTag !== tag || !tasks.checkout(task.id, AGENT_AUTOHEAL)) {
      return;
    }
    if (!this.handedOver(task)) {
      this.giveBack(task);
      return;
    }
    if (container.handsOff !== null) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.handsOff(container.handsOff, container.name, container.hostLabel));
      this.giveBack(task);
      return;
    }
    try {
      // Its result releases the task: done when it went well, back to a person with Ollama's report when not.
      jobs.request(AUTOHEAL, container.hostId, container.name, JOB_ACTION.changeTag, task.id, { tag });
    } catch (error) {
      if (!(error instanceof DomainError)) {
        tasks.release(task.id);
        throw error;
      }
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.notAsked(error.code));
      this.giveBack(task);
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

  private now() {
    return (this.dependencies.clock ?? Date.now)();
  }

  /**
   * Whether to take the task and decide now. One that waits for Ollama's word is asked about again, holding nothing,
   * so its page shows the wait once and not each try: only once Ollama answers, or once the wait is over.
   */
  private async readyToDecide(task: TaskRow, container: ContainerView): Promise<boolean> {
    const waiting = this.awaiting.get(task.id);
    const now = this.now();
    if (waiting === undefined || now - waiting.since >= AUTOHEAL_ASSESSMENT.handOverMilliseconds) {
      return true;
    }
    if (now - waiting.askedAt < AUTOHEAL_ASSESSMENT.askAgainMilliseconds) {
      return false;
    }
    waiting.askedAt = now;
    const answer = await this.dependencies.assessor.assess(container, this.neighboursOf(container));
    waiting.answer = answer.decision === null ? null : answer;
    return waiting.answer !== null;
  }

  /** Whether to update now; says why in the task either way. */
  private async decide(task: TaskRow, container: ContainerView): Promise<UpdateStep> {
    const { tasks, assessor } = this.dependencies;
    // Its hand-over already said so in the task.
    if (this.handedOver(task)) {
      return this.settled(task, UPDATE_STEP.apply);
    }
    // Given back by a person after Autoheal held it: they decided.
    if (tasks.hasActivity(task.id, TASK_ACTIVITY.assessed)) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.overridden);
      return this.settled(task, UPDATE_STEP.apply);
    }
    // Its owner chose each new image: its runner undoes one that does not come back healthy.
    if (container.update.policy === UPDATE_POLICY.always) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.alwaysApplied);
      return this.settled(task, UPDATE_STEP.apply);
    }
    const assessment =
      this.awaiting.get(task.id)?.answer ?? (await assessor.assess(container, this.neighboursOf(container)));
    if (assessment.decision === null) {
      return this.withoutAssessment(task, assessment.reason);
    }
    tasks.addActivity(task.id, TASK_ACTIVITY.assessed, AUTOHEAL, { ...assessment });
    if (assessment.decision === UPDATE_ASSESSMENT.hold) {
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.assessedHold(assessment.reason));
      return this.settled(task, UPDATE_STEP.giveBack);
    }
    tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.assessedUpdate(assessment.reason));
    return this.settled(task, UPDATE_STEP.apply);
  }

  // Decided: nothing waits for Ollama's word any more.
  private settled(task: TaskRow, step: UpdateStep): UpdateStep {
    this.awaiting.delete(task.id);
    return step;
  }

  /**
   * Ollama could not be asked: the update never goes ahead without its word. It waits, saying so once, and once the
   * wait is over it goes to a person, as an assessment that held it would: their giving it back is their go-ahead.
   */
  private withoutAssessment(task: TaskRow, reason: string): UpdateStep {
    const { tasks } = this.dependencies;
    if (!this.awaiting.has(task.id)) {
      const now = this.now();
      this.awaiting.set(task.id, { since: now, askedAt: now, answer: null });
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.awaitingAssessment(reason));
      return UPDATE_STEP.wait;
    }
    tasks.addActivity(task.id, TASK_ACTIVITY.assessed, AUTOHEAL, { decision: null, reason });
    tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.noAssessment(reason));
    return this.settled(task, UPDATE_STEP.giveBack);
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
