import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import { ATTACHMENT, HTTP_HEADERS, HTTP_STATUS, JSON_CONTENT_TYPE, NO_STORE } from "../../shared/constants.js";
import { diagnosticSectionsSchema } from "../../shared/diagnostics.js";
import { DomainError } from "../domain-error.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import { DiagnosticError, type DiagnosticsService } from "./diagnostics-service.js";
const incident = z.object({ incidentId: z.uuid() });
const prepared = incident.extend({ previewId: z.uuid() });
function translate(error: unknown): never {
  if (error instanceof DiagnosticError)
    throw new DomainError(error.reason === "full" ? API_ERRORS.diagnosticsFull : API_ERRORS.diagnosticsExpired);
  throw error;
}
export function registerDiagnosticsRoutes(app: FastifyInstance, diagnostics: DiagnosticsService) {
  app.post(API_ROUTES.diagnosticsPreview, async (request, reply) => {
    reply.header(HTTP_HEADERS.cacheControl, NO_STORE);
    const { incidentId } = parseBody(incident, request.params);
    const { sections } = parseBody(z.object({ sections: diagnosticSectionsSchema }).strict(), request.body);
    try {
      return diagnostics.preview(request.authSession!.tokenHash, incidentId, sections);
    } catch (error) {
      translate(error);
    }
  });
  app.post(API_ROUTES.diagnosticsDownload, async (request, reply) => {
    const { incidentId, previewId } = parseBody(prepared, request.params);
    try {
      const file = diagnostics.download(actorOf(request), request.authSession!.tokenHash, incidentId, previewId);
      return reply
        .header(HTTP_HEADERS.cacheControl, NO_STORE)
        .header(HTTP_HEADERS.contentType, JSON_CONTENT_TYPE)
        .header(HTTP_HEADERS.contentDisposition, ATTACHMENT(file.fileName))
        .code(HTTP_STATUS.ok)
        .send(Readable.from([file.text]));
    } catch (error) {
      translate(error);
    }
  });
}
