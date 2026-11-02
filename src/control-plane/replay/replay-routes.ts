import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  OLLAMA_MODEL_NAME_LIMIT,
  REPLAY_DEFAULT_INCIDENTS,
  REPLAY_MAXIMUM_INCIDENTS,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ReplayService } from "./replay-service.js";

const startBody = z.object({
  draftVersionIds: z.array(z.uuid()).max(REPLAY_MAXIMUM_INCIDENTS).default([]),
  incidentCount: z.number().int().min(1).max(REPLAY_MAXIMUM_INCIDENTS).default(REPLAY_DEFAULT_INCIDENTS),
  // These incidents instead of the most recent ones: one incident against a draft, from its own page.
  incidentIds: z.array(z.uuid()).min(1).max(REPLAY_MAXIMUM_INCIDENTS).optional(),
  // Another model the same Ollama has, tried before switching to it; the one in use when left out.
  modelName: z.string().trim().min(1).max(OLLAMA_MODEL_NAME_LIMIT).optional(),
});
const replayParameters = z.object({ replayId: z.uuid() });

export function registerReplayRoutes(app: FastifyInstance, replayService: ReplayService) {
  app.get(API_ROUTES.replays, async () => replayService.list());

  app.post(API_ROUTES.replays, { config: { access: ACCESS_ADMIN } }, async (request) =>
    replayService.start(actorOf(request), parseBody(startBody, request.body)),
  );

  app.get(API_ROUTES.replay, async (request) =>
    replayService.get(parseBody(replayParameters, request.params).replayId),
  );
}
