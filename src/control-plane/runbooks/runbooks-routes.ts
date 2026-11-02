import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  RUNBOOK_PATTERN_LIMIT,
  RUNBOOK_SCOPES,
  RUNBOOK_TITLE_LIMIT,
  SHA256_HEX_PATTERN,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { RunbookSuggestions } from "./runbook-suggestions.js";
import type { RunbooksService } from "./runbooks-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
// Length is checked by the service, so a long runbook gets a clear "too long" instead of a 400.
const body = z.string().min(1);
const runbookParameters = z.object({ runbookId: z.uuid() });
const versionParameters = runbookParameters.extend({ versionId: z.uuid() });
const createBody = z.object({
  scope: z.enum(RUNBOOK_SCOPES),
  pattern: z.string().max(RUNBOOK_PATTERN_LIMIT).optional(),
  title: z.string().min(1).max(RUNBOOK_TITLE_LIMIT),
  body,
});
const promptParameters = z.object({ promptHash: z.string().regex(SHA256_HEX_PATTERN) });
const suggestionParameters = z.object({ key: z.string().regex(SHA256_HEX_PATTERN) });

export function registerRunbooksRoutes(
  app: FastifyInstance,
  runbooksService: RunbooksService,
  suggestions: RunbookSuggestions,
) {
  app.get(API_ROUTES.runbookSuggestions, adminOnly, async () => suggestions.list());

  app.post(API_ROUTES.runbookSuggestionDraft, adminOnly, async (request) =>
    suggestions.draft(actorOf(request), parseBody(suggestionParameters, request.params).key),
  );

  app.get(API_ROUTES.runbooks, async () => runbooksService.list());

  app.post(API_ROUTES.runbooks, adminOnly, async (request) =>
    runbooksService.create(actorOf(request), parseBody(createBody, request.body)),
  );

  app.get(API_ROUTES.runbook, async (request) =>
    runbooksService.get(parseBody(runbookParameters, request.params).runbookId),
  );

  app.post(API_ROUTES.runbookVersions, adminOnly, async (request) => {
    const { runbookId } = parseBody(runbookParameters, request.params);
    return runbooksService.saveVersion(actorOf(request), runbookId, parseBody(z.object({ body }), request.body).body);
  });

  app.post(API_ROUTES.runbookPublish, adminOnly, async (request) => {
    const { runbookId, versionId } = parseBody(versionParameters, request.params);
    return runbooksService.publish(actorOf(request), runbookId, versionId);
  });

  app.post(API_ROUTES.runbookArchive, adminOnly, async (request) =>
    runbooksService.archive(actorOf(request), parseBody(runbookParameters, request.params).runbookId),
  );

  app.get(API_ROUTES.prompt, async (request) =>
    runbooksService.promptSnapshot(parseBody(promptParameters, request.params).promptHash),
  );
}
