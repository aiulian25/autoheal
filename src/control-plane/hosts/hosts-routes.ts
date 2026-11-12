import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  HOST_LABEL_PATTERN,
  HTTPS_PROTOCOL_PATTERN,
  JOIN_DIRECTORY,
  RUNNER_NAS_FOLDER_PATTERN,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { HostsService } from "./hosts-service.js";
import type { LocalHostService } from "../local-host/local-host-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
// Without an address, the one used last. A Synology, or any host whose own files the runner should not read: its
// containers only, in the folder named.
const joinCodeBody = z.object({
  address: z.url({ protocol: HTTPS_PROTOCOL_PATTERN }).optional(),
  nasFolder: z.string().regex(RUNNER_NAS_FOLDER_PATTERN).optional(),
});
// Without a label the host takes the name its runner reports.
const enrollBody = joinCodeBody.extend({ label: z.string().regex(HOST_LABEL_PATTERN).optional() });
const hostParameters = z.object({ hostId: z.uuid() });
// The same rules as a name given when the host was added.
const renameBody = z.object({ label: z.string().regex(HOST_LABEL_PATTERN) });

export function registerHostsRoutes(
  app: FastifyInstance,
  hostsService: HostsService,
  localHostService: Pick<LocalHostService, "inPlace" | "reenroll">,
) {
  app.post(API_ROUTES.hosts, adminOnly, async (request) => {
    const { label, address, nasFolder } = parseBody(enrollBody, request.body);
    return hostsService.enroll(
      actorOf(request),
      label ?? null,
      address ?? hostsService.runnerAddress(),
      nasFolder ?? null,
    );
  });

  app.patch(API_ROUTES.host, adminOnly, async (request) =>
    hostsService.rename(
      actorOf(request),
      parseBody(hostParameters, request.params).hostId,
      parseBody(renameBody, request.body).label,
    ),
  );

  app.post(API_ROUTES.hostJoinCode, adminOnly, async (request) => {
    const { address, nasFolder } = parseBody(joinCodeBody, request.body ?? {});
    return hostsService.newJoinCode(
      actorOf(request),
      parseBody(hostParameters, request.params).hostId,
      address ?? hostsService.runnerAddress(),
      nasFolder ?? null,
      JOIN_DIRECTORY,
    );
  });

  app.post(API_ROUTES.hostRevoke, adminOnly, async (request) =>
    hostsService.revoke(actorOf(request), parseBody(hostParameters, request.params).hostId),
  );

  app.post(API_ROUTES.hostCancelEnrollment, adminOnly, async (request) =>
    hostsService.cancelEnrollment(actorOf(request), parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.localHost, async () => hostsService.localHost(JOIN_DIRECTORY));

  // This machine's revoked host: looked after in place, or by its runner container.
  app.post(API_ROUTES.localHostReenroll, adminOnly, async (request) =>
    localHostService.inPlace()
      ? localHostService.reenroll(actorOf(request))
      : hostsService.reenrollLocalRunner(actorOf(request), JOIN_DIRECTORY),
  );
}
