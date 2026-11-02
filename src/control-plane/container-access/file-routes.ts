import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_FULL,
  FILE_BODY_LIMIT_BYTES,
  FILE_CONTENT_CHARACTERS,
  FILE_OPERATION,
  FILE_PATH_CHARACTERS,
  REPORT_LIMITS,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { FileService } from "./file-service.js";

const containerParameters = z.object({
  hostId: z.uuid(),
  containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
});

// An absolute path written plainly: no empty, "." or ".." parts, no NUL, no slash at its end but the root's.
const isPlainPath = (path: string) =>
  path === "/" ||
  (path.startsWith("/") &&
    !path.includes("\0") &&
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."));
const filePath = z.string().min(1).max(FILE_PATH_CHARACTERS).refine(isPlainPath);
// What can be changed: anything but the container's root itself.
const changedPath = filePath.refine((path) => path !== "/");
const content = z.base64().max(FILE_CONTENT_CHARACTERS);

const fileBody = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal(FILE_OPERATION.list), path: filePath }),
  z.object({ operation: z.literal(FILE_OPERATION.read), path: filePath }),
  z.object({ operation: z.literal(FILE_OPERATION.write), path: changedPath, content }),
  z.object({ operation: z.literal(FILE_OPERATION.makeFolder), path: changedPath }),
  z.object({ operation: z.literal(FILE_OPERATION.rename), path: changedPath, to: changedPath }),
  z.object({ operation: z.literal(FILE_OPERATION.remove), path: changedPath }),
]);

/** A container's files: one route for each thing asked of them, answered by the container's runner. */
export function registerFileRoutes(app: FastifyInstance, files: FileService) {
  const route = { config: { access: ACCESS_FULL }, bodyLimit: FILE_BODY_LIMIT_BYTES } as const;
  app.post(API_ROUTES.containerFiles, route, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    const body = parseBody(fileBody, request.body);
    const ask = {
      operation: body.operation,
      path: body.path,
      to: "to" in body ? body.to : null,
      content: "content" in body ? body.content : null,
    };
    return files.ask(actorOf(request), hostId, containerName, ask, request.authSession!.tokenHash);
  });
}
