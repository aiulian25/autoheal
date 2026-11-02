import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, ATTACHMENT, BACKUP_ORIGIN, HTTP_HEADERS, OCTET_STREAM } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { BackupService } from "./backup-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const fileParameters = z.object({ fileName: z.string().min(1) });

export function registerBackupsRoutes(app: FastifyInstance, backups: BackupService) {
  app.get(API_ROUTES.backups, adminOnly, async () => backups.list());

  app.post(API_ROUTES.backups, adminOnly, async (request) => backups.create(BACKUP_ORIGIN.manual, actorOf(request)));

  app.get(API_ROUTES.backupDownload, adminOnly, async (request, reply) => {
    const { fileName } = parseBody(fileParameters, request.params);
    const path = await backups.pathOf(fileName);
    return reply
      .header(HTTP_HEADERS.contentType, OCTET_STREAM)
      .header(HTTP_HEADERS.contentDisposition, ATTACHMENT(fileName))
      .send(createReadStream(path));
  });
}
