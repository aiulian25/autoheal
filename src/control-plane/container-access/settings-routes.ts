import {
  backupAskBodySchema,
  backupRestoreBodySchema,
  backupSettingsSchema,
  backupStartBodySchema,
} from "../../shared/container-backups.js";
import type { ContainerBackupService } from "./container-backup-service.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  ACCESS_FULL,
  HTTP_STATUS,
  NETWORK_NAME,
  REPORT_LIMITS,
  STACK_LIMITS,
  VOLUME_NAME,
} from "../../shared/constants.js";
import { STACK_PROJECT, stackAskSchema } from "../../shared/stacks.js";
import { ownCheckBodySchema, ownFilesSchema } from "../../shared/own-compose.js";
import { containerSettingsSchema } from "../../shared/protocol.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import { installDraftBodySchema, installSpecSchema } from "../../shared/install.js";
import type { HostProfileService } from "./host-profile-service.js";
import type { InstallService } from "./install-service.js";
import type { SettingsService } from "./settings-service.js";
import type { StackService } from "./stack-service.js";
import type { VolumeLookService } from "./volume-look-service.js";

const containerParameters = z.object({
  hostId: z.uuid(),
  containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
});
const hostParameters = z.object({ hostId: z.uuid() });
const networkBody = z.object({
  name: z.string().regex(NETWORK_NAME),
  joined: z.boolean(),
});
const stackParameters = z.object({ hostId: z.uuid(), project: z.string().regex(STACK_PROJECT) });
const volumeLookBody = z.object({ name: z.string().regex(VOLUME_NAME) });
const readQuery = z.object({ details: z.literal("true").optional() });
const scopedAccess = { config: { access: ACCESS_FULL } } as const;

const installBody = z.object({ spec: installSpecSchema });
const undoBody = z.object({ name: z.string().min(1).max(REPORT_LIMITS.nameCharacters), removeData: z.boolean() });

/** Putting a new app on a host: what it would be, whether it can, then doing it, and taking it back. */
export function registerInstallRoutes(app: FastifyInstance, installs: InstallService) {
  app.post(API_ROUTES.hostInstallDraft, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return installs.draft(actorOf(request), hostId, parseBody(installDraftBodySchema, request.body));
  });
  app.post(API_ROUTES.hostInstallCheck, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return installs.check(actorOf(request), hostId, parseBody(installBody, request.body).spec);
  });
  app.post(API_ROUTES.hostInstall, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return installs.install(actorOf(request), hostId, parseBody(installBody, request.body).spec);
  });
  const ownRoute = { ...scopedAccess, bodyLimit: STACK_LIMITS.bodyBytes } as const;
  app.post(API_ROUTES.hostInstallOwnCheck, ownRoute, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return installs.checkOwn(actorOf(request), hostId, parseBody(ownCheckBodySchema, request.body));
  });
  app.post(API_ROUTES.hostInstallOwn, ownRoute, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return installs.installOwn(actorOf(request), hostId, parseBody(ownFilesSchema, request.body));
  });
  app.post(API_ROUTES.hostInstallUndo, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const { name, removeData } = parseBody(undoBody, request.body);
    return installs.undo(actorOf(request), hostId, name, removeData);
  });
}

/** A stack's Compose file and settings: read, checked and written by its runner, kept nowhere on the way. */
export function registerStackRoutes(app: FastifyInstance, stacks: StackService) {
  const route = { ...scopedAccess, bodyLimit: STACK_LIMITS.bodyBytes } as const;
  app.post(API_ROUTES.hostStackAsk, route, async (request) => {
    const { hostId, project } = parseBody(stackParameters, request.params);
    return stacks.ask(actorOf(request), hostId, project, parseBody(stackAskSchema, request.body));
  });
}

/** A container's backups, listed and made by its runner, in a plain folder on its host. */
export function registerContainerBackupRoutes(app: FastifyInstance, backups: ContainerBackupService) {
  app.post(API_ROUTES.hostBackupAsk, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const { kind, target } = parseBody(backupAskBodySchema, request.body);
    return backups.ask(actorOf(request), hostId, kind, target);
  });
  app.post(API_ROUTES.hostBackupStart, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const { target, include } = parseBody(backupStartBodySchema, request.body);
    return backups.backUp(actorOf(request), hostId, target, include);
  });
  app.post(API_ROUTES.hostBackupRestore, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const { target, id } = parseBody(backupRestoreBodySchema, request.body);
    return backups.restore(actorOf(request), hostId, target, id);
  });
  app.get(API_ROUTES.containerBackupSettings, { config: { access: ACCESS_ADMIN } }, async () => backups.settings());
  app.put(API_ROUTES.containerBackupSettings, { config: { access: ACCESS_ADMIN } }, async (request, reply) => {
    backups.saveSettings(actorOf(request), parseBody(backupSettingsSchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });
}

/** What a volume holds, as its runner reads it when an admin looks. */
export function registerVolumeLookRoutes(app: FastifyInstance, looks: VolumeLookService) {
  app.post(API_ROUTES.hostVolumeLook, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const { name } = parseBody(volumeLookBody, request.body);
    return looks.read(actorOf(request), hostId, name);
  });
}

/** How a host is set up, as its runner works it out when an admin looks. */
export function registerHostProfileRoutes(app: FastifyInstance, profiles: HostProfileService) {
  app.get(API_ROUTES.hostProfile, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return profiles.read(actorOf(request), hostId);
  });
}

/** A container's own settings: read through its runner, and changed by recreating it. */
export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsService) {
  app.get(API_ROUTES.containerSettings, scopedAccess, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    const { details } = parseBody(readQuery, request.query);
    return settings.read(actorOf(request), hostId, containerName, request.authSession!.tokenHash, details === "true");
  });

  // One click on a network: joined or left live. It answers with the container's details, as they are now.
  app.post(API_ROUTES.containerNetwork, scopedAccess, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    const network = parseBody(networkBody, request.body);
    return settings.read(actorOf(request), hostId, containerName, request.authSession!.tokenHash, true, network);
  });

  app.put(API_ROUTES.containerSettings, scopedAccess, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    const changed = parseBody(containerSettingsSchema, request.body);
    return settings.apply(actorOf(request), hostId, containerName, changed);
  });
}
