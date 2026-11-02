import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES, TASK_FILTERS, TASK_QUERY } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  AGENTS,
  TASK_LABEL_PATTERN,
  TASK_LIMITS,
  TASK_PRIORITIES,
  TASK_SNOOZES,
  TASK_STATUSES,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { TasksService } from "./tasks-service.js";

const taskParameters = z.object({ taskId: z.uuid() });
const blockerParameters = taskParameters.extend({ blockerId: z.uuid() });
const assignee = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), id: z.uuid() }),
    z.object({ kind: z.literal("agent"), id: z.enum(AGENTS) }),
  ])
  .nullable();
const labels = z
  .array(z.string().regex(TASK_LABEL_PATTERN))
  .max(TASK_LIMITS.labels)
  .transform((list) => [...new Set(list)]);
const title = z.string().trim().min(1).max(TASK_LIMITS.titleCharacters);
const description = z.string().max(TASK_LIMITS.descriptionCharacters);
const createBody = z.object({
  title,
  description: description.optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignee: assignee.optional(),
  labels: labels.optional(),
  parentId: z.uuid().nullable().optional(),
});
const changeBody = z.object({
  title: title.optional(),
  description: description.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignee: assignee.optional(),
  labels: labels.optional(),
  parentId: z.uuid().nullable().optional(),
  snoozed: z.union([z.literal(false), z.enum(TASK_SNOOZES)]).optional(),
});
const commentBody = z.object({ body: z.string().trim().min(1).max(TASK_LIMITS.commentCharacters) });
const blockerBody = z.object({ blockedById: z.uuid() });
const listQuery = z.object({
  [TASK_QUERY.status]: z.union([z.enum(TASK_STATUSES), z.enum([TASK_FILTERS.open, TASK_FILTERS.closed])]).optional(),
  [TASK_QUERY.assignee]: z
    .union([z.enum([TASK_FILTERS.me, TASK_FILTERS.unassigned]), z.enum(AGENTS), z.uuid()])
    .optional(),
  [TASK_QUERY.priority]: z.enum(TASK_PRIORITIES).optional(),
  [TASK_QUERY.label]: z.string().regex(TASK_LABEL_PATTERN).optional(),
  [TASK_QUERY.hostId]: z.uuid().optional(),
  [TASK_QUERY.search]: z
    .string()
    .trim()
    .max(TASK_LIMITS.searchCharacters)
    .transform((text) => text || undefined)
    .optional(),
});

export function registerTasksRoutes(app: FastifyInstance, tasksService: TasksService) {
  app.get(API_ROUTES.tasks, async (request) =>
    tasksService.list(parseBody(listQuery, request.query), request.authSession!.user.id),
  );

  app.post(API_ROUTES.tasks, { config: { access: ACCESS_ADMIN } }, async (request) =>
    tasksService.create(actorOf(request), parseBody(createBody, request.body)),
  );

  app.get(API_ROUTES.assignees, async () => tasksService.assignableTo());

  app.get(API_ROUTES.task, async (request) => tasksService.detail(parseBody(taskParameters, request.params).taskId));

  app.patch(API_ROUTES.task, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { taskId } = parseBody(taskParameters, request.params);
    return tasksService.change(actorOf(request), taskId, parseBody(changeBody, request.body));
  });

  app.post(API_ROUTES.taskComments, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { taskId } = parseBody(taskParameters, request.params);
    tasksService.comment({ kind: "user", actor: actorOf(request) }, taskId, parseBody(commentBody, request.body).body);
    return tasksService.detail(taskId);
  });

  app.post(API_ROUTES.taskBlockers, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { taskId } = parseBody(taskParameters, request.params);
    return tasksService.addBlocker(actorOf(request), taskId, parseBody(blockerBody, request.body).blockedById);
  });

  app.delete(API_ROUTES.taskBlocker, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { taskId, blockerId } = parseBody(blockerParameters, request.params);
    return tasksService.removeBlocker(actorOf(request), taskId, blockerId);
  });
}
