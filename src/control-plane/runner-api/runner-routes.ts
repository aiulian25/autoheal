import { STACK_LIMITS } from "../../shared/constants.js";
import { backupAnswerSchema, backupKeyRequestSchema } from "../../shared/container-backups.js";
import { stackAnswerSchema } from "../../shared/stacks.js";
import { volumeLookAnswerSchema } from "../../shared/volumes.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  APPLICATION_ARTIFACT_ERRORS,
  APPLICATION_BACKUPS,
  applicationBackupResultSchema,
} from "../../shared/application-backups.js";
import { applicationArtifactStream } from "../../shared/application-artifact-stream.js";
import { operationPreviewAnswerSchema } from "../../shared/topology.js";
import { resourceAuthorizationSchema } from "../../shared/resource-permissions.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  FILE_BODY_LIMIT_BYTES,
  TAR_CONTENT_TYPE,
  HTTP_STATUS,
  HTTP_HEADERS,
  NO_STORE,
  LIVE_EVENT,
  RUNNER_CAPABILITY,
  TERMINAL_INPUT_WAIT_MILLISECONDS,
} from "../../shared/constants.js";
import { API_ERRORS } from "../../shared/api.js";
import {
  RUNNER_ROUTES,
  handledIncidentSchema,
  heartbeatSchema,
  incidentNoticeSchema,
  incidentSubmissionSchema,
  joinRequestSchema,
  type HeartbeatResponse,
  jobProgressSchema,
  jobResultSchema,
  metricsReportSchema,
  outcomeSchema,
  fileAnswerSchema,
  hostProfileAnswerSchema,
  settingsAnswerSchema,
  terminalEndSchema,
  terminalOutputSchema,
  type ContainerAccessWork,
} from "../../shared/protocol.js";
import { installAnswerSchema } from "../../shared/install.js";
import { terminalParameters, terminalRateLimit } from "../container-access/terminal-routes.js";
import { parseBody } from "../http/errors.js";
import type { ControlPlaneServices } from "../services.js";

const incidentParameters = z.object({ incidentId: z.uuid() });
const workItemParameters = z.object({ workItemId: z.uuid() });
const jobParameters = z.object({ jobId: z.uuid() });
const terminalRoute = { config: { rateLimit: terminalRateLimit } } as const;
const requestParameters = z.object({ requestId: z.uuid() });

// A stored heartbeat can outlive a process downgrade. The current poller must explicitly understand
// delegated authorization/review markers before any such request is handed over.
function deliveryHost(request: FastifyRequest) {
  const header = request.headers[HTTP_HEADERS.runnerCapabilities];
  const capabilities = new Set(
    (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((value) => value.trim()),
  );
  const host = request.runnerHost!;
  return {
    ...host,
    rollouts: host.rollouts && capabilities.has(RUNNER_CAPABILITY.rollouts),
    applicationBackups: host.applicationBackups && capabilities.has(RUNNER_CAPABILITY.applicationBackups),
    applicationBootDrills: capabilities.has(RUNNER_CAPABILITY.applicationBootDrills),
    resourcePermissions: host.resourcePermissions && capabilities.has(RUNNER_CAPABILITY.resourcePermissions),
    operationPreviews: host.operationPreviews && capabilities.has(RUNNER_CAPABILITY.operationPreviews),
  };
}

export function registerRunnerRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  app.post(RUNNER_ROUTES.join, async (request, reply) => {
    const { enrolment, token } = parseBody(joinRequestSchema, request.body);
    if (!services.hostsService.redeemJoinCode(enrolment, token)) {
      return reply.code(HTTP_STATUS.unauthorized).send({ error: API_ERRORS.joinCodeRefused });
    }
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.get(RUNNER_ROUTES.resultDelivery, async () => ({ version: 1 }));

  const applicationTask = z.object({ taskId: z.uuid() });
  const applicationArtifact = applicationTask.extend({ artifactId: z.uuid() });
  const applicationAttempt = z.object({ attempt: z.coerce.number().int().nonnegative().safe() }).strict();
  app.get(RUNNER_ROUTES.applicationBackupWork, async (request) => ({
    tasks: await services.applicationBackups.take(deliveryHost(request)),
  }));
  app.post(RUNNER_ROUTES.applicationBackupAuthorization, async (request) => {
    const { taskId } = parseBody(applicationTask, request.params);
    const { attempt } = parseBody(z.object({ attempt: z.number().int().nonnegative().safe() }).strict(), request.body);
    const host = deliveryHost(request);
    return host.dryRun === true ? { allowed: false } : services.applicationBackups.authorize(host, taskId, attempt);
  });
  app.post(RUNNER_ROUTES.applicationBackupResult, async (request) =>
    services.applicationBackups.complete(deliveryHost(request), parseBody(applicationBackupResultSchema, request.body)),
  );

  // The parser hands through a backpressured stream; no application artifact is buffered as a JSON body.
  void app.register(async (scoped) => {
    scoped.addContentTypeParser(TAR_CONTENT_TYPE, (_request, payload, done) => done(null, payload));
    scoped.post(
      RUNNER_ROUTES.applicationBackupUpload,
      { bodyLimit: APPLICATION_BACKUPS.payloadBytes },
      async (request) => {
        const { taskId, artifactId } = parseBody(applicationArtifact, request.params);
        const { attempt } = parseBody(applicationAttempt, request.query);
        const source = request.body as Readable;
        if (!(source instanceof Readable)) throw new Error(APPLICATION_ARTIFACT_ERRORS.notAStream);
        const timeout = setTimeout(
          () => source.destroy(new Error(APPLICATION_ARTIFACT_ERRORS.uploadTimedOut)),
          APPLICATION_BACKUPS.transferMilliseconds,
        );
        timeout.unref();
        try {
          return await services.applicationBackups.upload(deliveryHost(request), taskId, artifactId, source, attempt);
        } finally {
          clearTimeout(timeout);
          if (!source.readableEnded) source.destroy();
        }
      },
    );
  });
  app.get(RUNNER_ROUTES.applicationBackupDownload, async (request, reply) => {
    const { taskId, artifactId } = parseBody(applicationArtifact, request.params);
    const { attempt } = parseBody(applicationAttempt, request.query);
    const source = services.applicationBackups.download(deliveryHost(request), taskId, artifactId, attempt);
    const verified = applicationArtifactStream();
    const timeout = setTimeout(
      () => source.destroy(new Error(APPLICATION_ARTIFACT_ERRORS.downloadTimedOut)),
      APPLICATION_BACKUPS.transferMilliseconds,
    );
    timeout.unref();
    const close = () => {
      clearTimeout(timeout);
      source.destroy();
      verified.destroy();
    };
    reply.raw.once("close", close);
    void pipeline(source, verified)
      .catch((error) => verified.destroy(error as Error))
      .finally(() => clearTimeout(timeout));
    reply.header(HTTP_HEADERS.cacheControl, NO_STORE);
    return reply.type(TAR_CONTENT_TYPE).send(verified);
  });

  app.post(RUNNER_ROUTES.jobAuthorization, async (request) => {
    const { jobId } = parseBody(jobParameters, request.params);
    const { members } = parseBody(resourceAuthorizationSchema, request.body);
    return { authorized: services.jobsService.authorizeOperator(request.runnerHost!, jobId, members) };
  });
  for (const [path, service] of [
    [RUNNER_ROUTES.terminalAuthorization, services.terminals],
    [RUNNER_ROUTES.fileAuthorization, services.files],
    [RUNNER_ROUTES.settingsAuthorization, services.containerSettings],
  ] as const) {
    app.post(path, async (request) => {
      const { requestId } = parseBody(requestParameters, request.params);
      const { members } = parseBody(resourceAuthorizationSchema, request.body);
      return { authorized: service.authorizeOperator(request.runnerHost!, requestId, members) };
    });
  }

  // The answer tells the runner where Ollama and the dashboard are: its .env needs neither.
  app.post(RUNNER_ROUTES.heartbeat, async (request): Promise<HeartbeatResponse> => {
    const heartbeat = parseBody(heartbeatSchema, request.body);
    services.hostsService.adoptReportedLabel(request.runnerHost!, heartbeat.hostLabel);
    services.inventoryService.recordHeartbeat(request.runnerHost!, heartbeat);
    if (heartbeat.stackDrift !== undefined) services.stackDrift.record(request.runnerHost!.id, heartbeat.stackDrift);
    services.live.publish({ kind: LIVE_EVENT.inventory, hostId: request.runnerHost!.id });
    services.jobsService.noteBoot(request.runnerHost!, heartbeat.host?.bootId);
    if (heartbeat.probeResults !== undefined) {
      services.probes.recordReports(request.runnerHost!.id, heartbeat.probeResults);
    }
    const probes = services.probes.probesFor(request.runnerHost!.id);
    return {
      ...services.runnerSettings(request.runnerHost!.id),
      control: services.hostControl.forRunner(request.runnerHost!.id),
      ...(probes.length === 0 ? {} : { probes }),
    };
  });

  // A handled incident, told on the channels set up here. Sent in the background: the runner
  // need not wait on Gotify or ntfy.
  app.post(RUNNER_ROUTES.notifications, async (request, reply) => {
    const notice = parseBody(incidentNoticeSchema, request.body);
    await services.notifier.incidentHandled(request.runnerHost!.label, notice, {
      hostId: request.runnerHost!.id,
      notificationKey: notice.notificationId,
    });
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.metrics, async (request, reply) => {
    services.metricsStore.record(request.runnerHost!.id, parseBody(metricsReportSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  // Answers when the model has decided; the runner waits, and falls back to Ollama itself if it can't.
  app.post(RUNNER_ROUTES.incidents, async (request, reply) => {
    const submission = parseBody(incidentSubmissionSchema, request.body);
    const runnerGone = new AbortController();
    // The response's "close" before it finished means the runner hung up (its deadline passed).
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) {
        runnerGone.abort();
      }
    });
    return services.decisionService.decide(request.runnerHost!, submission, runnerGone.signal);
  });

  app.post(RUNNER_ROUTES.incidentOutcome, async (request, reply) => {
    const { incidentId } = parseBody(incidentParameters, request.params);
    const result = parseBody(outcomeSchema, request.body);
    services.resultReceipts.accept(request.runnerHost!.id, "incident", incidentId, result, () =>
      services.incidentsService.takeOutcome(request.runnerHost!, incidentId, result),
    );
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.get(RUNNER_ROUTES.work, async (request) => ({
    items: services.approvalsService.takeWork(request.runnerHost!),
    jobs: services.jobsService.take(deliveryHost(request)),
  }));

  // Shells to open and files to reach: answered at once when some wait, else as soon as one is asked for.
  app.get(RUNNER_ROUTES.containerAccess, terminalRoute, async (request): Promise<ContainerAccessWork> => {
    const host = deliveryHost(request);
    const take = () => ({
      terminals: services.terminals.starts(host),
      files: services.files.take(host),
      settings: services.containerSettings.take(host),
      profiles: services.hostProfiles.take(host),
      volumeLooks: services.volumeLooks.take(host),
      stacks: services.stackFiles.take(host),
      backups: services.containerBackups.take(host),
      installs: services.installs.take(host),
      ...(host.operationPreviews ? { previews: services.topology.take(host) } : {}),
    });
    const ready = take();
    if (
      ready.terminals.length > 0 ||
      ready.files.length > 0 ||
      ready.settings.length > 0 ||
      ready.profiles.length > 0 ||
      ready.volumeLooks.length > 0 ||
      ready.stacks.length > 0 ||
      ready.backups.length > 0 ||
      ready.installs.length > 0 ||
      (ready.previews?.length ?? 0) > 0
    ) {
      return ready;
    }
    await services.waitingRunners.wait(host.id, TERMINAL_INPUT_WAIT_MILLISECONDS);
    // A runner that gave up meanwhile would never hear of what is handed to it: it is left for the next one.
    if (request.raw.socket?.destroyed === true) {
      return { terminals: [], files: [], settings: [] };
    }
    return take();
  });

  app.post(RUNNER_ROUTES.operationPreviewAnswer, async (request, reply) => {
    const { requestId } = parseBody(requestParameters, request.params);
    services.topology.answer(request.runnerHost!, requestId, parseBody(operationPreviewAnswerSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.fileAnswer, { ...terminalRoute, bodyLimit: FILE_BODY_LIMIT_BYTES }, async (request, reply) => {
    const { requestId } = parseBody(requestParameters, request.params);
    services.files.answer(request.runnerHost!, requestId, parseBody(fileAnswerSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.hostProfileAnswer, terminalRoute, async (request, reply) => {
    const { requestId } = parseBody(requestParameters, request.params);
    services.hostProfiles.answer(request.runnerHost!, requestId, parseBody(hostProfileAnswerSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(
    RUNNER_ROUTES.stackAnswer,
    { ...terminalRoute, bodyLimit: STACK_LIMITS.bodyBytes },
    async (request, reply) => {
      const { requestId } = parseBody(requestParameters, request.params);
      services.stackFiles.answer(request.runnerHost!, requestId, parseBody(stackAnswerSchema, request.body));
      return reply.code(HTTP_STATUS.noContent).send();
    },
  );

  app.post(RUNNER_ROUTES.backupAnswer, terminalRoute, async (request, reply) => {
    const { requestId } = parseBody(requestParameters, request.params);
    services.containerBackups.answer(request.runnerHost!, requestId, parseBody(backupAnswerSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.jobBackupKey, terminalRoute, async (request) => {
    const { jobId } = parseBody(jobParameters, request.params);
    const { sealedKey } = parseBody(backupKeyRequestSchema, request.body);
    return services.containerBackups.openKey(request.runnerHost!, jobId, sealedKey);
  });

  app.post(RUNNER_ROUTES.volumeLookAnswer, terminalRoute, async (request, reply) => {
    const { requestId } = parseBody(requestParameters, request.params);
    services.volumeLooks.answer(request.runnerHost!, requestId, parseBody(volumeLookAnswerSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.installAnswer, terminalRoute, async (request, reply) => {
    const { requestId } = parseBody(requestParameters, request.params);
    services.installs.answer(request.runnerHost!, requestId, parseBody(installAnswerSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.get(RUNNER_ROUTES.jobInstall, async (request) => {
    const { jobId } = parseBody(jobParameters, request.params);
    return services.installs.forJob(request.runnerHost!, jobId);
  });

  // Settings carry every environment value: as big as a file may be.
  app.post(
    RUNNER_ROUTES.settingsAnswer,
    { ...terminalRoute, bodyLimit: FILE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const { requestId } = parseBody(requestParameters, request.params);
      const answer = parseBody(settingsAnswerSchema, request.body);
      services.containerSettings.answer(request.runnerHost!, requestId, answer);
      return reply.code(HTTP_STATUS.noContent).send();
    },
  );

  app.get(RUNNER_ROUTES.jobSettings, async (request) => {
    const { jobId } = parseBody(jobParameters, request.params);
    return services.containerSettings.forJob(request.runnerHost!, jobId);
  });

  // A shell's keystrokes: the question waits until some are typed, or a while.
  app.get(RUNNER_ROUTES.terminalInput, terminalRoute, async (request) => {
    const { terminalId } = parseBody(terminalParameters, request.params);
    return services.terminals.takeInput(request.runnerHost!, terminalId);
  });

  app.post(RUNNER_ROUTES.terminalOutput, terminalRoute, async (request, reply) => {
    const { terminalId } = parseBody(terminalParameters, request.params);
    services.terminals.printed(request.runnerHost!, terminalId, parseBody(terminalOutputSchema, request.body).data);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.terminalEnd, terminalRoute, async (request, reply) => {
    const { terminalId } = parseBody(terminalParameters, request.params);
    services.terminals.ended(request.runnerHost!, terminalId, parseBody(terminalEndSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.jobResult, async (request, reply) => {
    const { jobId } = parseBody(jobParameters, request.params);
    const result = parseBody(jobResultSchema, request.body);
    services.resultReceipts.accept(request.runnerHost!.id, "job", jobId, result, () => {
      services.jobsService.complete(request.runnerHost!, jobId, result);
      services.hostPackages.afterResult(request.runnerHost!, jobId, result);
    });
    return reply.code(HTTP_STATUS.noContent).send();
  });

  // A running job's log (a package job's) or its progress (an update's), each time it moved on.
  app.post(RUNNER_ROUTES.jobProgress, async (request, reply) => {
    const { jobId } = parseBody(jobParameters, request.params);
    services.jobsService.progress(request.runnerHost!, jobId, parseBody(jobProgressSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.workResult, async (request, reply) => {
    const { workItemId } = parseBody(workItemParameters, request.params);
    const result = parseBody(outcomeSchema, request.body);
    services.resultReceipts.accept(request.runnerHost!.id, "work", workItemId, result, () =>
      services.approvalsService.completeWork(request.runnerHost!, workItemId, result),
    );
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(RUNNER_ROUTES.handledIncidents, async (request) => {
    const handled = parseBody(handledIncidentSchema, request.body);
    const apply = () => ({ incidentId: services.incidentsService.recordHandled(request.runnerHost!, handled).id });
    return handled.resultId === undefined
      ? apply()
      : services.resultReceipts.accept(request.runnerHost!.id, "handled", handled.resultId, handled, apply);
  });
}
