import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, HTTP_STATUS, OCTET_STREAM, RESTORE_UPLOAD_LIMIT_BYTES } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { RestoreService } from "./restore-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const fileParameters = z.object({ fileName: z.string().min(1) });
const restoreParameters = z.object({ restoreId: z.uuid() });

export function registerRestoreRoutes(app: FastifyInstance, restores: RestoreService) {
  app.post(API_ROUTES.backupRestore, adminOnly, async (request) =>
    restores.prepareStored(actorOf(request), parseBody(fileParameters, request.params).fileName),
  );

  // Raw bytes only on this route: an uploaded backup is untrusted until it decrypts and checks out.
  void app.register(async (uploads) => {
    uploads.addContentTypeParser(
      OCTET_STREAM,
      { parseAs: "buffer", bodyLimit: RESTORE_UPLOAD_LIMIT_BYTES },
      (_request, body, done) => done(null, body),
    );
    uploads.post(API_ROUTES.restoreUpload, adminOnly, async (request) =>
      restores.prepareUploaded(actorOf(request), parseBody(z.instanceof(Buffer), request.body)),
    );
  });

  app.post(API_ROUTES.restoreConfirm, adminOnly, async (request) =>
    restores.confirm(actorOf(request), parseBody(restoreParameters, request.params).restoreId),
  );

  app.delete(API_ROUTES.restore, adminOnly, async (request, reply) => {
    await restores.cancel(actorOf(request), parseBody(restoreParameters, request.params).restoreId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
