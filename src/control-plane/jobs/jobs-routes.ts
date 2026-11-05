import { stackJobSchema } from "../../shared/stacks.js";
import type { StackDriftService } from "../inventory/stack-drift-service.js";
import { newVolumeSchema, volumeRemovalSchema } from "../../shared/volumes.js";
import { networkRemovalSchema, newNetworkSchema } from "../../shared/networks.js";
import type { TopologyService } from "../inventory/topology-service.js";
import { DomainError } from "../domain-error.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES, JOB_QUERY } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  ACCESS_FULL,
  COMPOSE_PROJECT_PATTERN,
  DIGEST_PATTERN,
  HOST_PACKAGE_ACTIONS,
  HOST_PACKAGE_LIMIT,
  JOB_ACTION,
  JOB_ACTIONS,
  REPORT_LIMITS,
  WHOLE_HOST_ACTIONS,
  isHostPackageAction,
} from "../../shared/constants.js";
import { packageNameSchema } from "../../shared/protocol.js";
import type { HostPackagesService } from "../host-packages/host-packages-service.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { JobsService } from "./jobs-service.js";
import type { StackRestartsService } from "./stack-restarts-service.js";
import type { UpdateRunsService } from "./update-runs-service.js";

const hostParameters = z.object({ hostId: z.uuid() });
const containerParameters = hostParameters.extend({
  containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
});
const stackParameters = hostParameters.extend({
  stack: z.string().max(REPORT_LIMITS.nameCharacters).regex(COMPOSE_PROJECT_PATTERN),
});
const containerActionBody = z.object({
  // An edit carries its settings: it has its own route.
  action: z.enum(
    JOB_ACTIONS.filter(
      (action) => !WHOLE_HOST_ACTIONS.has(action) && !isHostPackageAction(action) && action !== JOB_ACTION.edit,
    ),
  ),
  taskId: z.uuid().optional(),
  previewId: z.uuid().optional(),
});
const STACK_JOB_ACTIONS = [
  JOB_ACTION.stackUp,
  JOB_ACTION.stackRebuild,
  JOB_ACTION.stackStop,
  JOB_ACTION.stackStart,
  JOB_ACTION.stackRemove,
] as const;
const hostActionBody = z.union([
  z.object({ action: z.literal(JOB_ACTION.checkUpdates) }),
  // No image: a runner only ever moves to the release its control plane runs.
  z.object({ action: z.literal(JOB_ACTION.updateRunner) }),
  z.object({
    action: z.literal(JOB_ACTION.removeImages),
    images: z.array(z.string().regex(DIGEST_PATTERN)).min(1).max(REPORT_LIMITS.unusedImages),
  }),
  z.object({ action: z.literal(JOB_ACTION.createNetwork), network: newNetworkSchema }),
  z.object({ action: z.literal(JOB_ACTION.removeNetworks), removal: networkRemovalSchema }),
  z.object({ action: z.enum(STACK_JOB_ACTIONS), stack: stackJobSchema }),
  z.object({ action: z.literal(JOB_ACTION.createVolume), volume: newVolumeSchema }),
  z.object({ action: z.literal(JOB_ACTION.removeVolumes), volumeRemoval: volumeRemovalSchema }),
  z.object({
    action: z.enum(HOST_PACKAGE_ACTIONS),
    packages: z.array(packageNameSchema).max(HOST_PACKAGE_LIMIT).default([]),
  }),
]);
const updateRunBody = z.object({
  previews: z.record(z.string().min(1).max(REPORT_LIMITS.nameCharacters), z.uuid()).optional(),
  names: z.array(z.string().min(1).max(REPORT_LIMITS.nameCharacters)).min(1).max(REPORT_LIMITS.containers),
});
const jobParameters = z.object({ jobId: z.uuid() });
const jobsQuery = z.object({
  [JOB_QUERY.hostId]: z.uuid(),
  [JOB_QUERY.containerName]: z.string().min(1).max(REPORT_LIMITS.nameCharacters).optional(),
});

export function registerJobsRoutes(
  app: FastifyInstance,
  jobsService: JobsService,
  hostPackages: HostPackagesService,
  updateRuns: UpdateRunsService,
  stackRestarts: StackRestartsService,
  stackDrift: StackDriftService,
  topology?: Pick<TopologyService, "consume">,
) {
  app.post(API_ROUTES.containerActions, { config: { access: ACCESS_FULL } }, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    const { action, taskId, previewId } = parseBody(containerActionBody, request.body);
    if (previewId && !topology) throw new DomainError(API_ERRORS.topologyUnavailable);
    const fingerprint = previewId
      ? topology!.consume(request.authSession!.tokenHash, hostId, containerName, action, previewId)
      : undefined;
    return jobsService.request(
      { kind: "user", actor: actorOf(request) },
      hostId,
      containerName,
      action,
      taskId ?? null,
      fingerprint ? { expectedResourcesFingerprint: fingerprint } : {},
    );
  });

  // About the host as a whole: its images, or its own packages. There is no one container to name.
  app.post(API_ROUTES.hostActions, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const body = parseBody(hostActionBody, request.body);
    const author = { kind: "user", actor: actorOf(request) } as const;
    if ("packages" in body) {
      return hostPackages.request(author, hostId, body.action, body.packages);
    }
    if ("images" in body) {
      return jobsService.request(author, hostId, "", body.action, null, { images: body.images });
    }
    if ("network" in body) {
      return jobsService.request(author, hostId, "", body.action, null, { network: body.network });
    }
    if ("stack" in body) {
      return jobsService.request(author, hostId, "", body.action, null, { stack: body.stack });
    }
    if ("volume" in body) {
      return jobsService.request(author, hostId, "", body.action, null, { volume: body.volume });
    }
    if ("volumeRemoval" in body) {
      return jobsService.request(author, hostId, "", body.action, null, { volumeRemoval: body.volumeRemoval });
    }
    if ("removal" in body) {
      return jobsService.request(author, hostId, "", body.action, null, { removal: body.removal });
    }
    return jobsService.request(author, hostId, "", body.action, null);
  });

  // Several containers' new images, one at a time; and the host's latest such run, going or ended.
  app.post(API_ROUTES.containerUpdates, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const { names, previews } = parseBody(updateRunBody, request.body);
    if (
      previews &&
      (!topology || Object.keys(previews).length !== new Set(names).size || names.some((name) => !previews[name]))
    )
      throw new DomainError(API_ERRORS.topologyPreviewExpired);
    const fingerprints = previews
      ? Object.fromEntries(
          [...new Set(names)].map((name) => [
            name,
            topology!.consume(request.authSession!.tokenHash, hostId, name, JOB_ACTION.update, previews[name]!),
          ]),
        )
      : undefined;
    return updateRuns.start(actorOf(request), hostId, names, fingerprints);
  });

  app.get(API_ROUTES.containerUpdates, async (request) =>
    updateRuns.latest(parseBody(hostParameters, request.params).hostId),
  );

  // Open to a viewer whose grants let them restart every container of the stack; the service checks each.
  app.post(API_ROUTES.stackRestart, { config: { access: ACCESS_FULL } }, async (request) => {
    const { hostId, stack } = parseBody(stackParameters, request.params);
    return stackRestarts.start(actorOf(request), hostId, stack);
  });

  app.get(API_ROUTES.stackDrift, { config: { access: ACCESS_ADMIN } }, async (request) =>
    stackDrift.ofHost(parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.stackRestarts, async (request) =>
    stackRestarts.latest(parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.jobs, async (request) => {
    const query = parseBody(jobsQuery, request.query);
    return jobsService.list(query[JOB_QUERY.hostId], query[JOB_QUERY.containerName]);
  });

  app.get(API_ROUTES.job, async (request) => jobsService.view(parseBody(jobParameters, request.params).jobId));
}
