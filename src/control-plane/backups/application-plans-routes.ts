import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, HTTP_HEADERS, NO_STORE } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ApplicationPlansService } from "./application-plans-service.js";
const admin = { config: { access: ACCESS_ADMIN } } as const;
const plan = z.object({ planId: z.uuid() });
export function registerApplicationPlansRoutes(app: FastifyInstance, service: ApplicationPlansService) {
  app.get(API_ROUTES.applicationBackups, admin, async (_request, reply) => {
    reply.header(HTTP_HEADERS.cacheControl, NO_STORE);
    return service.view();
  });
  app.post(API_ROUTES.applicationBackups, admin, async (request) => service.save(actorOf(request), request.body));
  app.put(API_ROUTES.applicationBackupPlan, admin, async (request) => {
    const { planId } = parseBody(plan, request.params);
    return service.save(actorOf(request), { ...(request.body as object), id: planId });
  });
  app.post(API_ROUTES.applicationBackupRun, admin, async (request) =>
    service.run(
      actorOf(request),
      parseBody(plan, request.params).planId,
      parseBody(
        z
          .object({
            operation: z.enum(["capture", "drill", "boot-drill"]),
            artifactId: z.uuid().optional(),
            requestKey: z.uuid(),
          })
          .strict(),
        request.body,
      ),
    ),
  );
  app.post(API_ROUTES.applicationBackupPrepare, admin, async (request) =>
    service.prepareRestore(
      actorOf(request),
      request.authSession!.tokenHash,
      parseBody(plan, request.params).planId,
      parseBody(z.object({ artifactId: z.uuid() }).strict(), request.body).artifactId,
    ),
  );
  app.post(API_ROUTES.applicationBackupRestore, admin, async (request) =>
    service.restore(
      actorOf(request),
      request.authSession!.tokenHash,
      parseBody(plan, request.params).planId,
      parseBody(
        z.object({ artifactId: z.uuid(), previewRunId: z.uuid(), requestKey: z.uuid() }).strict(),
        request.body,
      ),
    ),
  );
  app.post(API_ROUTES.applicationBackupResume, admin, async (request) =>
    service.resume(actorOf(request), parseBody(z.object({ runId: z.uuid() }), request.params).runId),
  );
}
