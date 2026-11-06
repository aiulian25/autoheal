import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { API_ERRORS, type ApiErrorCode } from "../../shared/api.js";
import { HTTP_CLIENT_ERRORS, HTTP_STATUS } from "../../shared/constants.js";
import { log } from "../../shared/log.js";
import { DomainError } from "../domain-error.js";

const DOMAIN_ERROR_STATUS: Partial<Record<ApiErrorCode, number>> = {
  [API_ERRORS.anomalyNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.anomalyChanged]: HTTP_STATUS.conflict,
  [API_ERRORS.rolloutUnavailable]: HTTP_STATUS.conflict,
  [API_ERRORS.rolloutNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.rolloutBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.rolloutGate]: HTTP_STATUS.conflict,
  [API_ERRORS.applicationBackupUnavailable]: HTTP_STATUS.conflict,
  [API_ERRORS.applicationBackupBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.applicationBackupNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.applicationBackupInvalid]: HTTP_STATUS.conflict,
  [API_ERRORS.applicationBackupRecoveryRequired]: HTTP_STATUS.conflict,
  [API_ERRORS.topologyUnavailable]: HTTP_STATUS.conflict,
  [API_ERRORS.topologyBusy]: HTTP_STATUS.tooManyRequests,
  [API_ERRORS.topologyPreviewExpired]: HTTP_STATUS.conflict,
  [API_ERRORS.notificationQueueFull]: HTTP_STATUS.serviceUnavailable,
  [API_ERRORS.notificationDeliveryNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.resourceForbidden]: HTTP_STATUS.forbidden,
  [API_ERRORS.resourceRunnerRequired]: HTTP_STATUS.conflict,
  [API_ERRORS.permissionConflict]: HTTP_STATUS.conflict,
  [API_ERRORS.userNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.usernameTaken]: HTTP_STATUS.conflict,
  [API_ERRORS.lastAdmin]: HTTP_STATUS.conflict,
  [API_ERRORS.deactivateInstead]: HTTP_STATUS.conflict,
  [API_ERRORS.diagnosticsFull]: HTTP_STATUS.tooManyRequests,
  [API_ERRORS.diagnosticsExpired]: HTTP_STATUS.notFound,
  [API_ERRORS.maintenanceUnsupported]: HTTP_STATUS.conflict,
  [API_ERRORS.maintenanceFull]: HTTP_STATUS.conflict,
  [API_ERRORS.installRetryRefused]: HTTP_STATUS.conflict,
  [API_ERRORS.savedViewLimitReached]: HTTP_STATUS.conflict,
  [API_ERRORS.savedViewNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.rebootPlanBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.rebootPlanUnreadable]: HTTP_STATUS.conflict,
  [API_ERRORS.rebootPlanNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.rebootPlanUnavailable]: HTTP_STATUS.conflict,
  [API_ERRORS.rebootPlanNotReady]: HTTP_STATUS.conflict,
  [API_ERRORS.probeLimitReached]: HTTP_STATUS.conflict,
  [API_ERRORS.probeDestinationRefused]: HTTP_STATUS.badRequest,
  [API_ERRORS.probeNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.maintenanceNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.maintenanceActive]: HTTP_STATUS.conflict,
  [API_ERRORS.hostNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.hostLabelTaken]: HTTP_STATUS.conflict,
  [API_ERRORS.jarvisNameTaken]: HTTP_STATUS.conflict,
  [API_ERRORS.sshKeyUnreadable]: HTTP_STATUS.badRequest,
  [API_ERRORS.sshKeyNotPrivate]: HTTP_STATUS.badRequest,
  [API_ERRORS.sshKeyUnsupported]: HTTP_STATUS.badRequest,
  [API_ERRORS.sshKeyNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.sshKeyInUse]: HTTP_STATUS.conflict,
  [API_ERRORS.sshKeyNameTaken]: HTTP_STATUS.conflict,
  [API_ERRORS.sshHostRefusedKey]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.sshHostUnreachable]: HTTP_STATUS.gatewayTimeout,
  [API_ERRORS.sshHostKeyMismatch]: HTTP_STATUS.conflict,
  [API_ERRORS.sshPendingNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.sshHostNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.sshSwitchLocalHost]: HTTP_STATUS.conflict,
  [API_ERRORS.hostHasNoDocker]: HTTP_STATUS.conflict,
  [API_ERRORS.selfUpdateUnavailable]: HTTP_STATUS.conflict,
  [API_ERRORS.selfUpdateNewest]: HTTP_STATUS.conflict,
  [API_ERRORS.selfUpdateRunning]: HTTP_STATUS.conflict,
  [API_ERRORS.selfUpdateRecoveryBlocked]: HTTP_STATUS.conflict,
  [API_ERRORS.selfUpdateUnsigned]: HTTP_STATUS.conflict,
  [API_ERRORS.sshRootPasswordRefused]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.sshHostNotConnected]: HTTP_STATUS.conflict,
  [API_ERRORS.hostRevoked]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.notLocalRunner]: HTTP_STATUS.conflict,
  [API_ERRORS.incidentNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.notAwaitingApproval]: HTTP_STATUS.conflict,
  [API_ERRORS.invalidTarget]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.workItemNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.runbookNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.runbookVersionNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.runbookTooLong]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.runbookPatternInvalid]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.runbookArchived]: HTTP_STATUS.conflict,
  [API_ERRORS.runbookSuggestionNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.promptNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.replayNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.backupNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.backupUnreadable]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.notAutohealDatabase]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.backupTooNew]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.backupSecretsUnreadable]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.storedSecretUnreadable]: HTTP_STATUS.conflict,
  [API_ERRORS.restoreDrainBusy]: HTTP_STATUS.serviceUnavailable,
  [API_ERRORS.restoreBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.restoreMaintenance]: HTTP_STATUS.serviceUnavailable,
  [API_ERRORS.restoreNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.taskNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.taskLoop]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.assigneeNotFound]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.agentCannotTake]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.notDispatchable]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.containerNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.restartResetUnsupported]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.resultConflict]: HTTP_STATUS.conflict,
  [API_ERRORS.jobNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.jobUnavailable]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.handsOff]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.updateRunBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.stackRestartBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.stackNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.backupKeyRefused]: HTTP_STATUS.forbidden,
  [API_ERRORS.noUpdate]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.widgetKeyNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.sessionNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.integrationFromEnvironment]: HTTP_STATUS.conflict,
  [API_ERRORS.trustedProxiesFromEnvironment]: HTTP_STATUS.conflict,
  [API_ERRORS.trustedProxyInvalid]: HTTP_STATUS.badRequest,
  [API_ERRORS.containerAccessOff]: HTTP_STATUS.conflict,
  [API_ERRORS.hostTerminalOff]: HTTP_STATUS.conflict,
  [API_ERRORS.hostDeployOff]: HTTP_STATUS.conflict,
  [API_ERRORS.containerNotRunning]: HTTP_STATUS.conflict,
  [API_ERRORS.terminalNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.terminalsFull]: HTTP_STATUS.conflict,
  [API_ERRORS.runnerNoAnswer]: HTTP_STATUS.gatewayTimeout,
  [API_ERRORS.runnerRequestNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.editBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.ollamaUnreachable]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.modelNotFound]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.routerUnreachable]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.routerLoginRefused]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.routerCertificateChanged]: HTTP_STATUS.conflict,
  [API_ERRORS.routerCertificateUnconfirmed]: HTTP_STATUS.conflict,
  [API_ERRORS.networkDeviceNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.ollamaServerNameTaken]: HTTP_STATUS.conflict,
  [API_ERRORS.ollamaServerNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.modelCannotAnswer]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.contextTooLarge]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.integrationTokenRequired]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.integrationNotSet]: HTTP_STATUS.notFound,
  [API_ERRORS.hostPackagesNotAllowed]: HTTP_STATUS.conflict,
  [API_ERRORS.hostPackagesUnsupported]: HTTP_STATUS.conflict,
  [API_ERRORS.hostPackagesBusy]: HTTP_STATUS.conflict,
  [API_ERRORS.packagesNotOffered]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.controlLocked]: HTTP_STATUS.conflict,
  [API_ERRORS.imageNotFound]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.passkeysUnavailable]: HTTP_STATUS.conflict,
  [API_ERRORS.passkeyRefused]: HTTP_STATUS.unauthorized,
  [API_ERRORS.passkeyNotAdded]: HTTP_STATUS.unprocessableContent,
  [API_ERRORS.passkeyNotFound]: HTTP_STATUS.notFound,
  [API_ERRORS.passkeyLimit]: HTTP_STATUS.conflict,
  [API_ERRORS.wrongPassword]: HTTP_STATUS.badRequest,
};

/** An expected failure with a status and a stable error code the dashboard can act on. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export function parseBody<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const result = schema.safeParse(body);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  throw new HttpError(HTTP_STATUS.badRequest, API_ERRORS.invalidRequest, { issues });
}

const isClientError = (statusCode: unknown): statusCode is number =>
  typeof statusCode === "number" && statusCode >= HTTP_CLIENT_ERRORS.from && statusCode <= HTTP_CLIENT_ERRORS.through;

/** Callers see a status and an error code, never a stack trace or a library's message. 404s: web-assets.ts. */
export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, ...error.extra });
    }
    if (error instanceof DomainError) {
      return reply.code(DOMAIN_ERROR_STATUS[error.code] ?? HTTP_STATUS.badRequest).send({ error: error.code });
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === HTTP_STATUS.payloadTooLarge) {
      return reply.code(statusCode).send({ error: API_ERRORS.payloadTooLarge });
    }
    if (isClientError(statusCode)) {
      return reply.code(statusCode).send({ error: API_ERRORS.invalidRequest });
    }
    log(`request ${request.id} failed: ${error instanceof Error ? error.stack : String(error)}`);
    return reply.code(HTTP_STATUS.internalServerError).send({ error: API_ERRORS.internalError });
  });
}
