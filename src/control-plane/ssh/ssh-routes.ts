import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import { DomainError } from "../domain-error.js";
import {
  ACCESS_ADMIN,
  HOST_LABEL_PATTERN,
  HTTP_STATUS,
  ROOT_COMMANDS,
  SSH_FINGERPRINT_PREFIX,
  SSH_HOST_FIELDS,
  SSH_KEY,
  SSH_SESSION,
} from "../../shared/constants.js";
import { sshHostSettingsSchema } from "../../shared/ssh-hosts.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { EmbeddedRunners } from "./embedded-runners.js";
import type { SshHostsService } from "./ssh-hosts-service.js";
import type { SshKeysService } from "./ssh-keys-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;

const keyName = z.string().trim().min(1).max(SSH_KEY.nameCharacters);
const addKeyBody = z.object({
  name: keyName,
  privateKey: z.string().min(1).max(SSH_KEY.privateKeyCharacters),
  passphrase: z.string().max(SSH_KEY.passphraseCharacters).nullable().optional(),
});
// A passphrase encrypts the private half handed over, as ssh-keygen's would; empty or absent leaves it plain.
const makeKeyBody = z.object({
  name: keyName,
  passphrase: z.string().max(SSH_KEY.passphraseCharacters).nullable().optional(),
});
const keyParameters = z.object({ keyId: z.uuid() });
const reachBody = z.object({
  address: z.string().max(SSH_HOST_FIELDS.wordCharacters).regex(SSH_HOST_FIELDS.word),
  port: z
    .number()
    .int()
    .min(SSH_HOST_FIELDS.lowestPort)
    .max(SSH_HOST_FIELDS.highestPort)
    .default(SSH_SESSION.defaultPort),
  user: z.string().max(SSH_HOST_FIELDS.wordCharacters).regex(SSH_HOST_FIELDS.word),
  keyId: z.uuid(),
});
const addHostBody = reachBody.extend({ label: z.string().regex(HOST_LABEL_PATTERN) });
const pendingParameters = z.object({ pendingId: z.uuid() });
const hostParameters = z.object({ hostId: z.uuid() });
const trustBody = z.object({
  fingerprint: z.string().startsWith(SSH_FINGERPRINT_PREFIX).max(SSH_HOST_FIELDS.wordCharacters),
});
const replaceKeyBody = z.object({ keyId: z.uuid() });
const rootBody = z.object({ password: z.string().min(1).max(ROOT_COMMANDS.passwordCharacters) });

/** Keys and SSH hosts: an admin's alone, as every secret here is. */
export function registerSshRoutes(
  app: FastifyInstance,
  keys: SshKeysService,
  sshHosts: SshHostsService,
  embeddedRunners: EmbeddedRunners,
) {
  app.get(API_ROUTES.sshKeys, adminOnly, async () => keys.list());

  app.post(API_ROUTES.sshKeys, adminOnly, async (request) => {
    const { name, privateKey, passphrase } = parseBody(addKeyBody, request.body);
    return keys.add(actorOf(request), name, privateKey, passphrase || null);
  });

  app.post(API_ROUTES.sshKeysMake, adminOnly, async (request) => {
    const { name, passphrase } = parseBody(makeKeyBody, request.body);
    return keys.make(actorOf(request), name, passphrase || null);
  });

  app.delete(API_ROUTES.sshKey, adminOnly, async (request, reply) => {
    keys.remove(actorOf(request), parseBody(keyParameters, request.params).keyId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(API_ROUTES.sshHosts, adminOnly, async (request) =>
    sshHosts.add(actorOf(request), parseBody(addHostBody, request.body)),
  );

  app.post(API_ROUTES.sshHostSwitch, adminOnly, async (request) =>
    sshHosts.switchToSsh(
      actorOf(request),
      parseBody(hostParameters, request.params).hostId,
      parseBody(reachBody, request.body),
    ),
  );

  app.post(API_ROUTES.sshHostConfirm, adminOnly, async (request) =>
    sshHosts.confirm(actorOf(request), parseBody(pendingParameters, request.params).pendingId),
  );

  app.get(API_ROUTES.sshHost, adminOnly, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return sshHosts.detailsOf(hostId, embeddedRunners.offeredHostKeyOf(hostId));
  });

  app.post(API_ROUTES.sshHostTrustHostKey, adminOnly, async (request) =>
    sshHosts.trustHostKey(
      actorOf(request),
      parseBody(hostParameters, request.params).hostId,
      parseBody(trustBody, request.body).fingerprint,
    ),
  );

  app.put(API_ROUTES.sshHostKey, adminOnly, async (request) =>
    sshHosts.replaceKey(
      actorOf(request),
      parseBody(hostParameters, request.params).hostId,
      parseBody(replaceKeyBody, request.body).keyId,
    ),
  );

  // Checked as root on the host before it is kept: a password that works neither way is refused.
  app.put(API_ROUTES.sshHostRoot, adminOnly, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const { password } = parseBody(rootBody, request.body);
    const method = await embeddedRunners.rootMethodOf(hostId, password);
    if (method === null) {
      throw new DomainError(API_ERRORS.sshRootPasswordRefused);
    }
    sshHosts.saveRootPassword(actorOf(request), hostId, password, method);
    return sshHosts.detailsOf(hostId, embeddedRunners.offeredHostKeyOf(hostId));
  });

  app.delete(API_ROUTES.sshHostRoot, adminOnly, async (request, reply) => {
    sshHosts.removeRootPassword(actorOf(request), parseBody(hostParameters, request.params).hostId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.put(API_ROUTES.sshHostSettings, adminOnly, async (request) =>
    sshHosts.updateSettings(
      actorOf(request),
      parseBody(hostParameters, request.params).hostId,
      parseBody(sshHostSettingsSchema, request.body),
    ),
  );
}
