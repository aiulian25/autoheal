import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  API_ERRORS,
  TASK_FILTERS,
  autohealCanTake,
  type AssigneeChoice,
  type AssigneeView,
  type ContainerView,
  type TaskActivityView,
  type TaskChangeRequest,
  type TaskCommentView,
  type TaskCreateRequest,
  type TaskDetailView,
  type TaskSummaryView,
  type TimelineTaskView,
} from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AGENT_NAMES,
  AUDIT_ACTIONS,
  CLOSED_TASK_STATUSES,
  DETECTOR_EPISODE_GAP_MILLISECONDS,
  DETECTOR_KEY_SEPARATOR,
  DETECTOR_KEYS,
  FORMER_USER_LABEL,
  JOB_LIST_LIMIT,
  OPEN_TASK_STATUSES,
  ROLE_ADMIN,
  TARGET_TASK,
  TASK_ACTIVITY,
  TASK_CHECKOUT_MILLISECONDS,
  TASK_LIMITS,
  TASK_PRIORITIES,
  TASK_PRIORITY,
  TASK_REOPEN_WINDOW_MILLISECONDS,
  TASK_RESOURCE,
  TASK_SNOOZE_MILLISECONDS,
  TASK_SOURCE,
  TASK_STATUS,
  UPDATE_ASSESSMENTS,
  USER_STATUS_ACTIVE,
  WORKED_TASK_STATUSES,
  type AgentKey,
  type TaskActivityKind,
  type TaskPriority,
  type TaskResourceKind,
  type TaskSource,
  type TaskStatus,
  type UpdateAssessment,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jobs, taskActivity, taskBlockers, taskComments, tasks, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import { jobViews } from "../jobs/job-views.js";

export type TaskRow = typeof tasks.$inferSelect;

/** A problem a detector (or an incident) reports; tasks are opened, joined or reopened from it. */
export interface TaskFinding {
  key: string;
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  hostId: string | null;
  resource: { kind: TaskResourceKind; id: string; label: string } | null;
  assignee: AssigneeChoice | null;
  source: TaskSource;
  incidentId?: string | null;
}

// A task opened before its finding named what it is about (a disk, since 24 October 2026) learns it.
function resourceLearned(task: TaskRow, finding: TaskFinding): Partial<TaskRow> | null {
  if (task.resourceKind !== null || finding.resource === null) {
    return null;
  }
  return {
    resourceKind: finding.resource.kind,
    resourceId: finding.resource.id,
    resourceLabel: finding.resource.label,
  };
}

export type FindingOutcome = "created" | "reopened" | "joined" | "happened_again" | "suppressed";

export interface TaskListFilter {
  status?: string | undefined;
  assignee?: string | undefined;
  priority?: TaskPriority | undefined;
  label?: string | undefined;
  hostId?: string | undefined;
  search?: string | undefined;
}

// Who did something to a task: a person, or Autoheal (its detectors and automation).
export type TaskAuthor = { kind: "user"; actor: Actor } | { kind: "agent"; agent: AgentKey };

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const isOpen = (status: TaskStatus) => OPEN_TASK_STATUSES.includes(status);
const labelOf = (author: TaskAuthor) => (author.kind === "user" ? author.actor.username : AGENT_NAMES[author.agent]);
const priorityRank = (priority: TaskPriority) => TASK_PRIORITIES.indexOf(priority);
const PRIORITY_ORDER = sql.join(
  [
    sql`case ${tasks.priority}`,
    ...TASK_PRIORITIES.map((priority, rank) => sql`when ${priority} then ${rank}`),
    sql`end`,
  ],
  sql` `,
);
// What an assessment's activity keeps: Ollama's decision, null when it could not be asked.
const assessed = z.object({ decision: z.enum(UPDATE_ASSESSMENTS).nullable() });
const activityView = (entry: typeof taskActivity.$inferSelect): TaskActivityView => ({
  id: entry.id,
  kind: entry.kind as TaskActivityKind,
  actor: entry.actorLabel,
  data: JSON.parse(entry.dataJson) as Record<string, unknown>,
  createdAt: entry.createdAt,
});
const LIKE_SPECIAL_CHARACTERS = /[\\%_]/g;
const LIKE_ESCAPE = "\\";
const escapeLike = (text: string) => text.replace(LIKE_SPECIAL_CHARACTERS, (character) => `${LIKE_ESCAPE}${character}`);

/**
 * Tasks: the shared unit of work. People create and work them; detectors and incidents open
 * them, join the open one for the same problem, and close them when the problem clears.
 */
export class TasksService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly inventory: Pick<InventoryService, "containers">,
    private readonly clock: () => number = Date.now,
  ) {}

  private get database() {
    return this.databaseHandle.database;
  }

  // --- people --------------------------------------------------------------------------------------

  create(actor: Actor, request: TaskCreateRequest): TaskDetailView {
    const labels = request.labels ?? [];
    this.assertAssignable(request.assignee ?? null, labels, null);
    if (request.parentId) {
      this.find(request.parentId);
    }
    const task = this.insert({
      title: request.title,
      description: request.description ?? "",
      priority: request.priority ?? TASK_PRIORITY.medium,
      labels,
      hostId: null,
      resource: null,
      assignee: request.assignee ?? null,
      source: TASK_SOURCE.manual,
      key: null,
      parentId: request.parentId ?? null,
      createdByUserId: actor.userId,
      author: { kind: "user", actor },
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.taskCreated,
      { kind: TARGET_TASK, id: task.id },
      { number: task.number },
    );
    return this.detail(task.id);
  }

  change(actor: Actor, taskId: string, change: TaskChangeRequest): TaskDetailView {
    const task = this.find(taskId);
    const author: TaskAuthor = { kind: "user", actor };
    const labels = change.labels ?? (JSON.parse(task.labelsJson) as string[]);
    if (change.assignee !== undefined) {
      this.assertAssignable(change.assignee, labels, task.resourceKind);
    }
    if (change.parentId) {
      this.assertNoLoop(taskId, change.parentId);
    }
    const now = this.clock();
    const fields: Partial<TaskRow> = { updatedAt: now };
    const activities: [TaskActivityKind, Record<string, unknown>][] = [];
    if (change.title !== undefined && change.title !== task.title) {
      fields.title = change.title;
      activities.push([TASK_ACTIVITY.edited, { title: change.title }]);
    }
    if (change.description !== undefined && change.description !== task.description) {
      fields.description = change.description;
      activities.push([TASK_ACTIVITY.edited, { description: true }]);
    }
    if (change.priority !== undefined && change.priority !== task.priority) {
      fields.priority = change.priority;
      activities.push([TASK_ACTIVITY.priorityChanged, { from: task.priority, to: change.priority }]);
    }
    if (change.labels !== undefined) {
      fields.labelsJson = JSON.stringify(change.labels);
      activities.push([TASK_ACTIVITY.labelled, { labels: change.labels }]);
    }
    if (change.parentId !== undefined && change.parentId !== task.parentId) {
      fields.parentId = change.parentId;
      activities.push([TASK_ACTIVITY.parentChanged, { parentId: change.parentId }]);
    }
    if (change.assignee !== undefined) {
      Object.assign(fields, this.assigneeFields(change.assignee));
      activities.push([TASK_ACTIVITY.assigned, { to: this.assigneeName(change.assignee) }]);
    }
    if (change.status !== undefined && change.status !== task.status) {
      Object.assign(fields, this.statusFields(change.status, now));
      activities.push([TASK_ACTIVITY.statusChanged, { from: task.status, to: change.status }]);
    }
    if (change.snoozed !== undefined) {
      fields.snoozedUntil = change.snoozed === false ? null : now + TASK_SNOOZE_MILLISECONDS[change.snoozed];
      activities.push([TASK_ACTIVITY.snoozed, { until: fields.snoozedUntil }]);
    }
    this.database.update(tasks).set(fields).where(eq(tasks.id, taskId)).run();
    for (const [kind, data] of activities) {
      this.addActivity(taskId, kind, author, data);
    }
    if (activities.length > 0) {
      const changed = activities.map(([kind]) => kind);
      this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.taskChanged, { kind: TARGET_TASK, id: taskId }, { changed });
    }
    return this.detail(taskId);
  }

  comment(author: TaskAuthor, taskId: string, body: string): TaskCommentView {
    this.find(taskId);
    const now = this.clock();
    const comment = this.database
      .insert(taskComments)
      .values({
        id: randomUUID(),
        taskId,
        authorUserId: author.kind === "user" ? author.actor.userId : null,
        authorAgent: author.kind === "agent" ? author.agent : null,
        body,
        createdAt: now,
      })
      .returning()
      .get();
    this.database.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, taskId)).run();
    if (author.kind === "user") {
      this.auditLog.recordUserAction(author.actor, AUDIT_ACTIONS.taskCommented, { kind: TARGET_TASK, id: taskId });
    }
    return { id: comment.id, author: labelOf(author), fromAgent: author.kind === "agent", body, createdAt: now };
  }

  addBlocker(actor: Actor, taskId: string, blockedById: string): TaskDetailView {
    this.find(taskId);
    this.find(blockedById);
    if (taskId === blockedById || this.blockerChainReaches(blockedById, taskId)) {
      throw new DomainError(API_ERRORS.taskLoop);
    }
    const added = this.database.insert(taskBlockers).values({ taskId, blockedById }).onConflictDoNothing().run();
    if (added.changes > 0) {
      this.recordPersonChange(actor, taskId, TASK_ACTIVITY.blockerAdded, { blockedById });
    }
    return this.detail(taskId);
  }

  removeBlocker(actor: Actor, taskId: string, blockedById: string): TaskDetailView {
    this.find(taskId);
    const removed = this.database
      .delete(taskBlockers)
      .where(and(eq(taskBlockers.taskId, taskId), eq(taskBlockers.blockedById, blockedById)))
      .run();
    if (removed.changes > 0) {
      this.recordPersonChange(actor, taskId, TASK_ACTIVITY.blockerRemoved, { blockedById });
    }
    return this.detail(taskId);
  }

  // In the task's timeline, and in the audit log as any change a person makes to a task.
  private recordPersonChange(actor: Actor, taskId: string, kind: TaskActivityKind, data: Record<string, unknown>) {
    this.addActivity(taskId, kind, { kind: "user", actor }, data);
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.taskChanged,
      { kind: TARGET_TASK, id: taskId },
      { changed: [kind] },
    );
  }

  // --- detectors and incidents --------------------------------------------------------------------

  /**
   * A problem seen now: join its open task, reopen the one Autoheal closed lately, or open a new
   * one. A task a person closed while the problem went on stays closed until the problem has
   * ended and come back: closing it is how a person says "I know".
   */
  openOrJoin(finding: TaskFinding): { task: TaskRow; outcome: FindingOutcome } {
    const now = this.clock();
    const latest = this.latestFor(finding.key);
    if (latest !== null && isOpen(latest.status)) {
      return { task: latest, outcome: this.join(latest, finding, now) };
    }
    const sameEpisode = latest !== null && now - latest.lastSeenAt <= DETECTOR_EPISODE_GAP_MILLISECONDS;
    if (latest !== null && !latest.closedByDetector && sameEpisode) {
      this.database.update(tasks).set({ lastSeenAt: now }).where(eq(tasks.id, latest.id)).run();
      return { task: latest, outcome: "suppressed" };
    }
    const closedLately = latest !== null && now - (latest.closedAt ?? 0) <= TASK_REOPEN_WINDOW_MILLISECONDS;
    if (latest !== null && latest.closedByDetector && closedLately) {
      return { task: this.reopen(latest, finding, now), outcome: "reopened" };
    }
    const task = this.insert({
      ...finding,
      key: finding.key,
      parentId: null,
      createdByUserId: null,
      author: AUTOHEAL,
    });
    return { task, outcome: "created" };
  }

  /**
   * The problem behind this key has cleared. Autoheal closes the task, unless someone is working
   * on it: then it only says so, once, and leaves the task to them. An image update that waits no
   * more is done whoever was on it: nothing is left to do.
   */
  clear(key: string): { task: TaskRow; closed: boolean } | null {
    const task = this.latestFor(key);
    if (task === null || !isOpen(task.status)) {
      return null;
    }
    const updateGone = key.startsWith(`${DETECTOR_KEYS.update}${DETECTOR_KEY_SEPARATOR}`);
    if (WORKED_TASK_STATUSES.has(task.status) && !updateGone) {
      if (!this.clearedSinceSeen(task)) {
        this.addActivity(task.id, TASK_ACTIVITY.cleared, AUTOHEAL, { closed: false });
      }
      return { task, closed: false };
    }
    return { task: this.closeCleared(task.id), closed: true };
  }

  /** Closes the task as its problem gone, as a detector does: the problem coming back soon reopens it. */
  closeCleared(taskId: string): TaskRow {
    const now = this.clock();
    this.database
      .update(tasks)
      .set({ ...this.statusFields(TASK_STATUS.done, now), closedByDetector: true, updatedAt: now })
      .where(eq(tasks.id, taskId))
      .run();
    this.addActivity(taskId, TASK_ACTIVITY.cleared, AUTOHEAL, { closed: true });
    return this.find(taskId);
  }

  /** The open task a detector keeps under this key, if there is one. */
  openFor(key: string): TaskRow | null {
    const task = this.latestFor(key);
    return task !== null && isOpen(task.status) ? task : null;
  }

  /** Open tasks a detector opened, by key: the ones whose problems may have cleared. */
  openDetectorKeys(): string[] {
    return this.database
      .select({ key: tasks.detectorKey })
      .from(tasks)
      .where(and(inArray(tasks.status, [...OPEN_TASK_STATUSES]), sql`${tasks.detectorKey} is not null`))
      .all()
      .map(({ key }) => key!);
  }

  // --- Autoheal at work -------------------------------------------------------------------------------

  /** Takes the task for `holder` unless someone else holds it; a hold that outlived its run is stale. */
  checkout(taskId: string, holder: string): boolean {
    const now = this.clock();
    const free = or(isNull(tasks.checkedOutBy), lt(tasks.checkedOutAt, now - TASK_CHECKOUT_MILLISECONDS));
    const taken = this.database
      .update(tasks)
      .set({ checkedOutBy: holder, checkedOutAt: now })
      .where(and(eq(tasks.id, taskId), free))
      .run();
    if (taken.changes > 0) {
      this.addActivity(taskId, TASK_ACTIVITY.checkedOut, AUTOHEAL, {});
    }
    return taken.changes > 0;
  }

  release(taskId: string) {
    const released = this.database
      .update(tasks)
      .set({ checkedOutBy: null, checkedOutAt: null })
      .where(and(eq(tasks.id, taskId), sql`${tasks.checkedOutBy} is not null`))
      .run();
    if (released.changes > 0) {
      this.addActivity(taskId, TASK_ACTIVITY.released, AUTOHEAL, {});
    }
  }

  /** Changes made by Autoheal itself: no audit entry of a person, an activity entry instead. */
  setByAutoheal(taskId: string, change: { status?: TaskStatus; assignee?: AssigneeChoice | null }) {
    const task = this.find(taskId);
    const now = this.clock();
    const fields: Partial<TaskRow> = { updatedAt: now };
    if (change.assignee !== undefined) {
      Object.assign(fields, this.assigneeFields(change.assignee));
      this.addActivity(taskId, TASK_ACTIVITY.assigned, AUTOHEAL, { to: this.assigneeName(change.assignee) });
    }
    if (change.status !== undefined && change.status !== task.status) {
      Object.assign(fields, this.statusFields(change.status, now));
      this.addActivity(taskId, TASK_ACTIVITY.statusChanged, AUTOHEAL, { from: task.status, to: change.status });
    }
    this.database.update(tasks).set(fields).where(eq(tasks.id, taskId)).run();
  }

  addActivity(taskId: string, kind: TaskActivityKind, author: TaskAuthor, data: Record<string, unknown>) {
    this.database
      .insert(taskActivity)
      .values({
        taskId,
        kind,
        actorLabel: labelOf(author),
        dataJson: JSON.stringify(data),
        createdAt: this.clock(),
      })
      .run();
  }

  /** Open tasks assigned to Autoheal, oldest first: its queue. */
  autohealQueue(): TaskRow[] {
    return this.database
      .select()
      .from(tasks)
      .where(and(eq(tasks.assigneeAgent, AGENT_AUTOHEAL), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
      .orderBy(asc(tasks.createdAt))
      .all();
  }

  /** Open image updates a person holds that Ollama has not given its view on yet, oldest first. */
  updatesToAdvise(): TaskRow[] {
    const updateKeys = `${escapeLike(`${DETECTOR_KEYS.update}${DETECTOR_KEY_SEPARATOR}`)}%`;
    return this.database
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, [...OPEN_TASK_STATUSES]),
          isNull(tasks.assigneeAgent),
          sql`${tasks.detectorKey} like ${updateKeys} escape ${LIKE_ESCAPE}`,
        ),
      )
      .orderBy(asc(tasks.createdAt))
      .all()
      .filter((task) => !this.hasActivity(task.id, TASK_ACTIVITY.assessed));
  }

  hasActivity(taskId: string, kind: TaskActivityKind): boolean {
    const found = this.database
      .select({ id: taskActivity.id })
      .from(taskActivity)
      .where(and(eq(taskActivity.taskId, taskId), eq(taskActivity.kind, kind)))
      .get();
    return found !== undefined;
  }

  /** The task's latest activity of any of these kinds: which one, when, and what it said. */
  latestActivity(
    taskId: string,
    kinds: readonly TaskActivityKind[],
  ): { kind: TaskActivityKind; createdAt: number; data: Record<string, unknown> } | null {
    const latest = this.database
      .select({ kind: taskActivity.kind, createdAt: taskActivity.createdAt, dataJson: taskActivity.dataJson })
      .from(taskActivity)
      .where(and(eq(taskActivity.taskId, taskId), inArray(taskActivity.kind, [...kinds])))
      .orderBy(desc(taskActivity.id))
      .get();
    if (latest === undefined) {
      return null;
    }
    const data = JSON.parse(latest.dataJson) as Record<string, unknown>;
    return { kind: latest.kind as TaskActivityKind, createdAt: latest.createdAt, data };
  }

  /** Open tasks a person ever handed to the Ollama agent. */
  dispatchedTasks(): TaskRow[] {
    const dispatched = this.database
      .selectDistinct({ taskId: taskActivity.taskId })
      .from(taskActivity)
      .where(eq(taskActivity.kind, TASK_ACTIVITY.dispatched));
    return this.database
      .select()
      .from(tasks)
      .where(and(inArray(tasks.id, dispatched), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
      .all();
  }

  /** The first active admin: who gets a task nobody else can take. */
  owner(): AssigneeChoice | null {
    const admin = this.database
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, ROLE_ADMIN), eq(users.status, USER_STATUS_ACTIVE)))
      .orderBy(asc(users.createdAt))
      .get();
    return admin === undefined ? null : { kind: "user", id: admin.id };
  }

  // --- reading ---------------------------------------------------------------------------------------

  find(taskId: string): TaskRow {
    const task = this.database.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (task === undefined) {
      throw new DomainError(API_ERRORS.taskNotFound);
    }
    return task;
  }

  list(filter: TaskListFilter, viewerId: string): TaskSummaryView[] {
    return this.summaries(and(...this.conditions(filter, viewerId)), TASK_LIMITS.listItems);
  }

  summary(viewerId: string): { open: number; byPriority: Record<TaskPriority, number>; mine: number } {
    const open = this.database
      .select({ priority: tasks.priority, assignee: tasks.assigneeUserId })
      .from(tasks)
      .where(inArray(tasks.status, [...OPEN_TASK_STATUSES]))
      .all();
    const byPriority = Object.fromEntries(
      TASK_PRIORITIES.map((priority) => [priority, open.filter((task) => task.priority === priority).length]),
    ) as Record<TaskPriority, number>;
    return { open: open.length, byPriority, mine: open.filter((task) => task.assignee === viewerId).length };
  }

  detail(taskId: string): TaskDetailView {
    const [summary] = this.summaries(eq(tasks.id, taskId), 1);
    if (summary === undefined) {
      throw new DomainError(API_ERRORS.taskNotFound);
    }
    const task = this.find(taskId);
    const creator =
      task.createdByUserId === null
        ? null
        : this.database
            .select({ username: users.username })
            .from(users)
            .where(eq(users.id, task.createdByUserId))
            .get();
    const blockedByIds = this.database
      .select({ id: taskBlockers.blockedById })
      .from(taskBlockers)
      .where(eq(taskBlockers.taskId, taskId))
      .all()
      .map(({ id }) => id);
    const blockingIds = this.database
      .select({ id: taskBlockers.taskId })
      .from(taskBlockers)
      .where(eq(taskBlockers.blockedById, taskId))
      .all()
      .map(({ id }) => id);
    return {
      ...summary,
      description: task.description,
      createdBy:
        task.source === TASK_SOURCE.manual ? (creator?.username ?? FORMER_USER_LABEL) : AGENT_NAMES[AGENT_AUTOHEAL],
      comments: this.commentsOf(taskId),
      activity: this.activityOf(taskId),
      subtasks: this.summaries(eq(tasks.parentId, taskId), TASK_LIMITS.listItems),
      blockedBy:
        blockedByIds.length === 0 ? [] : this.summaries(inArray(tasks.id, blockedByIds), TASK_LIMITS.listItems),
      blocking: blockingIds.length === 0 ? [] : this.summaries(inArray(tasks.id, blockingIds), TASK_LIMITS.listItems),
      jobs: jobViews(this.databaseHandle, eq(jobs.taskId, taskId), JOB_LIST_LIMIT),
      container: this.containerOf(task),
    };
  }

  assignableTo(): { users: { id: string; name: string }[]; agents: { id: AgentKey; name: string }[] } {
    const active = this.database
      .select({ id: users.id, name: users.username })
      .from(users)
      .where(eq(users.status, USER_STATUS_ACTIVE))
      .orderBy(asc(users.username))
      .all();
    return { users: active, agents: [{ id: AGENT_AUTOHEAL, name: AGENT_NAMES[AGENT_AUTOHEAL] }] };
  }

  // --- inside ----------------------------------------------------------------------------------------

  private insert(values: {
    title: string;
    description: string;
    priority: TaskPriority;
    labels: string[];
    hostId: string | null;
    resource: TaskFinding["resource"];
    assignee: AssigneeChoice | null;
    source: TaskSource;
    key: string | null;
    parentId: string | null;
    createdByUserId: string | null;
    author: TaskAuthor;
    incidentId?: string | null;
  }): TaskRow {
    const now = this.clock();
    const task = this.database.transaction((transaction) => {
      const highest = transaction
        .select({ number: sql<number | null>`max(${tasks.number})` })
        .from(tasks)
        .get();
      return transaction
        .insert(tasks)
        .values({
          id: randomUUID(),
          number: (highest?.number ?? 0) + 1,
          title: values.title,
          description: values.description,
          status: TASK_STATUS.todo,
          priority: values.priority,
          source: values.source,
          detectorKey: values.key,
          ...this.assigneeFields(values.assignee),
          createdByUserId: values.createdByUserId,
          parentId: values.parentId,
          hostId: values.hostId,
          resourceKind: values.resource?.kind ?? null,
          resourceId: values.resource?.id ?? null,
          resourceLabel: values.resource?.label ?? null,
          labelsJson: JSON.stringify(values.labels),
          incidentId: values.incidentId ?? null,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        })
        .returning()
        .get();
    });
    this.addActivity(task.id, TASK_ACTIVITY.created, values.author, { source: values.source });
    return task;
  }

  // An open task seen again: it happened again if it had cleared meanwhile; it may have worsened.
  private join(task: TaskRow, finding: TaskFinding, now: number): FindingOutcome {
    const again = this.clearedSinceSeen(task);
    const fields: Partial<TaskRow> = { lastSeenAt: now };
    if (again) {
      fields.occurrences = task.occurrences + 1;
      fields.updatedAt = now;
      this.addActivity(task.id, TASK_ACTIVITY.happenedAgain, AUTOHEAL, { occurrences: task.occurrences + 1 });
    }
    if (priorityRank(finding.priority) < priorityRank(task.priority)) {
      fields.priority = finding.priority;
      fields.updatedAt = now;
      this.addActivity(task.id, TASK_ACTIVITY.priorityChanged, AUTOHEAL, { from: task.priority, to: finding.priority });
    }
    // Each new incident about it is linked: the newest one is shown, every one is in the timeline.
    const incidentId = finding.incidentId ?? null;
    if (incidentId !== null && incidentId !== task.incidentId) {
      fields.incidentId = incidentId;
      this.addActivity(task.id, TASK_ACTIVITY.incidentLinked, AUTOHEAL, { incidentId });
    }
    Object.assign(fields, this.currentText(task, finding), resourceLearned(task, finding));
    this.database.update(tasks).set(fields).where(eq(tasks.id, task.id)).run();
    return again ? "happened_again" : "joined";
  }

  private reopen(task: TaskRow, finding: TaskFinding, now: number): TaskRow {
    this.database
      .update(tasks)
      .set({
        status: TASK_STATUS.todo,
        closedAt: null,
        closedByDetector: false,
        occurrences: task.occurrences + 1,
        priority: finding.priority,
        incidentId: finding.incidentId ?? task.incidentId,
        ...this.currentText(task, finding),
        ...resourceLearned(task, finding),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id))
      .run();
    this.addActivity(task.id, TASK_ACTIVITY.reopened, AUTOHEAL, { occurrences: task.occurrences + 1 });
    return this.find(task.id);
  }

  // Numbers move (a battery drains, an outage grows): the text says what is true now. Only the
  // source that wrote it rewrites it, so an incident's words don't flip with a detector's, and
  // never once a person edited the task.
  private currentText(task: TaskRow, finding: TaskFinding): Pick<TaskRow, "title" | "description"> | null {
    const ownText = finding.source === task.source && !this.hasActivity(task.id, TASK_ACTIVITY.edited);
    return ownText ? { title: finding.title, description: finding.description } : null;
  }

  private latestFor(key: string): TaskRow | null {
    return (
      this.database.select().from(tasks).where(eq(tasks.detectorKey, key)).orderBy(desc(tasks.createdAt)).get() ?? null
    );
  }

  // Cleared, and not seen since: the last "cleared" note is no older than the last sighting.
  private clearedSinceSeen(task: TaskRow): boolean {
    const cleared = this.database
      .select({ at: taskActivity.createdAt })
      .from(taskActivity)
      .where(and(eq(taskActivity.taskId, task.id), eq(taskActivity.kind, TASK_ACTIVITY.cleared)))
      .orderBy(desc(taskActivity.id))
      .get();
    return cleared !== undefined && cleared.at >= task.lastSeenAt;
  }

  private statusFields(status: TaskStatus, now: number): Partial<TaskRow> {
    const closing = CLOSED_TASK_STATUSES.includes(status);
    // Whatever Autoheal held it for is over once the task is closed.
    return closing
      ? { status, closedAt: now, closedByDetector: false, checkedOutBy: null, checkedOutAt: null }
      : { status, closedAt: null };
  }

  private assigneeFields(assignee: AssigneeChoice | null): Pick<TaskRow, "assigneeUserId" | "assigneeAgent"> {
    return {
      assigneeUserId: assignee?.kind === "user" ? assignee.id : null,
      assigneeAgent: assignee?.kind === "agent" ? assignee.id : null,
    };
  }

  private assigneeName(assignee: AssigneeChoice | null): string | null {
    if (assignee === null) {
      return null;
    }
    if (assignee.kind === "agent") {
      return AGENT_NAMES[assignee.id];
    }
    return (
      this.database.select({ name: users.username }).from(users).where(eq(users.id, assignee.id)).get()?.name ?? null
    );
  }

  private assertAssignable(
    assignee: AssigneeChoice | null,
    labels: readonly string[],
    resourceKind: TaskResourceKind | null,
  ) {
    if (assignee?.kind === "agent" && !autohealCanTake(labels, resourceKind)) {
      throw new DomainError(API_ERRORS.agentCannotTake);
    }
    if (assignee?.kind !== "user") {
      return;
    }
    const user = this.database.select({ status: users.status }).from(users).where(eq(users.id, assignee.id)).get();
    if (user?.status !== USER_STATUS_ACTIVE) {
      throw new DomainError(API_ERRORS.assigneeNotFound);
    }
  }

  // A parent may not be the task itself or one of its own sub-tasks.
  private assertNoLoop(taskId: string, parentId: string) {
    const seen = new Set<string>();
    for (let current: string | null = parentId; current !== null; current = this.find(current).parentId) {
      if (current === taskId || seen.has(current)) {
        throw new DomainError(API_ERRORS.taskLoop);
      }
      seen.add(current);
    }
  }

  // Would "taskId waits for blockedById" close a circle? Only if blockedById already waits for taskId.
  private blockerChainReaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      const next = this.database
        .select({ id: taskBlockers.blockedById })
        .from(taskBlockers)
        .where(eq(taskBlockers.taskId, current))
        .all();
      queue.push(...next.map(({ id }) => id));
    }
    return false;
  }

  private conditions(filter: TaskListFilter, viewerId: string): SQL[] {
    const conditions: (SQL | undefined)[] = [
      this.statusCondition(filter.status),
      this.assigneeCondition(filter.assignee, viewerId),
    ];
    if (filter.priority !== undefined) {
      conditions.push(eq(tasks.priority, filter.priority));
    }
    if (filter.label !== undefined) {
      // The quotes make it a whole-label match; "_" would otherwise match any character.
      const label = `%${escapeLike(JSON.stringify(filter.label))}%`;
      conditions.push(sql`${tasks.labelsJson} like ${label} escape ${LIKE_ESCAPE}`);
    }
    if (filter.hostId !== undefined) {
      conditions.push(eq(tasks.hostId, filter.hostId));
    }
    if (filter.search !== undefined) {
      const words = `%${escapeLike(filter.search.toLowerCase())}%`;
      conditions.push(sql`lower(${tasks.title}) like ${words} escape ${LIKE_ESCAPE}`);
    }
    return conditions.filter((condition) => condition !== undefined);
  }

  private statusCondition(status: string | undefined): SQL | undefined {
    if (status === undefined || status === TASK_FILTERS.open) {
      return inArray(tasks.status, [...OPEN_TASK_STATUSES]);
    }
    if (status === TASK_FILTERS.closed) {
      return notInArray(tasks.status, [...OPEN_TASK_STATUSES]);
    }
    return eq(tasks.status, status as TaskStatus);
  }

  private assigneeCondition(assignee: string | undefined, viewerId: string): SQL | undefined {
    if (assignee === undefined) {
      return undefined;
    }
    if (assignee === TASK_FILTERS.me) {
      return eq(tasks.assigneeUserId, viewerId);
    }
    if (assignee === TASK_FILTERS.unassigned) {
      return and(isNull(tasks.assigneeUserId), isNull(tasks.assigneeAgent));
    }
    if (assignee === AGENT_AUTOHEAL) {
      return eq(tasks.assigneeAgent, AGENT_AUTOHEAL);
    }
    return eq(tasks.assigneeUserId, assignee);
  }

  private summaries(condition: SQL | undefined, limit: number): TaskSummaryView[] {
    const rows = this.database
      .select({ task: tasks, assigneeName: users.username, hostLabel: hosts.label })
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assigneeUserId))
      .leftJoin(hosts, eq(hosts.id, tasks.hostId))
      .where(condition)
      .orderBy(PRIORITY_ORDER, desc(tasks.updatedAt))
      .limit(limit)
      .all();
    const advice = this.adviceOf(rows.map(({ task }) => task.id));
    const now = this.clock();
    return rows.map(({ task, assigneeName, hostLabel }) => ({
      id: task.id,
      number: task.number,
      title: task.title,
      status: task.status,
      priority: task.priority,
      source: task.source,
      assignee: assigneeOf(task, assigneeName),
      labels: JSON.parse(task.labelsJson) as string[],
      hostId: task.hostId,
      hostLabel,
      resource:
        task.resourceKind === null
          ? null
          : { kind: task.resourceKind, id: task.resourceId ?? "", label: task.resourceLabel ?? "" },
      parentId: task.parentId,
      occurrences: task.occurrences,
      checkedOut: task.checkedOutBy !== null,
      advice: advice.get(task.id) ?? null,
      snoozedUntil: task.snoozedUntil !== null && task.snoozedUntil > now ? task.snoozedUntil : null,
      incidentId: task.incidentId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      lastSeenAt: task.lastSeenAt,
      closedAt: task.closedAt,
    }));
  }

  // Ollama's latest word on each of these tasks' updates: the newest assessment that got an answer.
  private adviceOf(taskIds: readonly string[]): Map<string, UpdateAssessment> {
    if (taskIds.length === 0) {
      return new Map();
    }
    const advice = new Map<string, UpdateAssessment>();
    const assessments = this.database
      .select({ taskId: taskActivity.taskId, dataJson: taskActivity.dataJson })
      .from(taskActivity)
      .where(and(inArray(taskActivity.taskId, [...taskIds]), eq(taskActivity.kind, TASK_ACTIVITY.assessed)))
      .orderBy(asc(taskActivity.id))
      .all();
    for (const { taskId, dataJson } of assessments) {
      const decision = assessed.safeParse(JSON.parse(dataJson)).data?.decision ?? null;
      if (decision !== null) {
        advice.set(taskId, decision);
      }
    }
    return advice;
  }

  private commentsOf(taskId: string): TaskCommentView[] {
    return this.database
      .select({ comment: taskComments, username: users.username })
      .from(taskComments)
      .leftJoin(users, eq(users.id, taskComments.authorUserId))
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt))
      .all()
      .map(({ comment, username }) => ({
        id: comment.id,
        author: comment.authorAgent === null ? (username ?? FORMER_USER_LABEL) : AGENT_NAMES[comment.authorAgent],
        fromAgent: comment.authorAgent !== null,
        body: comment.body,
        createdAt: comment.createdAt,
      }));
  }

  /** The steps taken on a container's tasks, newest first, each with the task it was taken on. */
  containerActivity(
    hostId: string,
    containerName: string,
    limit: number,
  ): { task: TimelineTaskView; activity: TaskActivityView }[] {
    return this.database
      .select({ entry: taskActivity, id: tasks.id, number: tasks.number, title: tasks.title })
      .from(taskActivity)
      .innerJoin(tasks, eq(tasks.id, taskActivity.taskId))
      .where(
        and(
          eq(tasks.hostId, hostId),
          eq(tasks.resourceKind, TASK_RESOURCE.container),
          eq(tasks.resourceId, containerName),
        ),
      )
      .orderBy(desc(taskActivity.createdAt), desc(taskActivity.id))
      .limit(limit)
      .all()
      .map(({ entry, id, number, title }) => ({ task: { id, number, title }, activity: activityView(entry) }));
  }

  private activityOf(taskId: string): TaskActivityView[] {
    return this.database
      .select()
      .from(taskActivity)
      .where(eq(taskActivity.taskId, taskId))
      .orderBy(asc(taskActivity.id))
      .all()
      .map(activityView);
  }

  private containerOf(task: TaskRow): ContainerView | null {
    if (task.resourceKind !== TASK_RESOURCE.container || task.hostId === null) {
      return null;
    }
    const found = this.inventory
      .containers({ hostId: task.hostId })
      .find((container) => container.name === task.resourceId);
    return found ?? null;
  }
}

function assigneeOf(task: TaskRow, username: string | null): AssigneeView | null {
  if (task.assigneeAgent !== null) {
    return { kind: "agent", id: task.assigneeAgent, name: AGENT_NAMES[task.assigneeAgent] };
  }
  if (task.assigneeUserId !== null) {
    return { kind: "user", id: task.assigneeUserId, name: username ?? FORMER_USER_LABEL };
  }
  return null;
}
