import type { ResourcePermissions } from "../auth/resource-permissions.js";
import { resourceGrantsSchema } from "../../shared/resource-permissions.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, HTTP_STATUS, ROLES, USERNAME_PATTERN, USER_STATUSES } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { UsersService } from "./users-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const userParameters = z.object({ userId: z.uuid() });
const createBody = z.object({ username: z.string().regex(USERNAME_PATTERN), role: z.enum(ROLES) });
const updateBody = z
  .object({ role: z.enum(ROLES).optional(), status: z.enum(USER_STATUSES).optional() })
  .refine((change) => change.role !== undefined || change.status !== undefined);

export function registerUsersRoutes(
  app: FastifyInstance,
  usersService: UsersService,
  permissions?: ResourcePermissions,
) {
  if (permissions) {
    app.get(API_ROUTES.accountPermissions, async (request) => permissions.current(request.authSession!.user.id));
    app.get(API_ROUTES.userGrants, adminOnly, async (request) =>
      permissions.current(parseBody(userParameters, request.params).userId),
    );
    app.put(API_ROUTES.userGrants, adminOnly, async (request) =>
      permissions.replace(
        actorOf(request),
        parseBody(userParameters, request.params).userId,
        parseBody(
          z.object({ revision: z.number().int().nonnegative().safe(), grants: resourceGrantsSchema }).strict(),
          request.body,
        ),
      ),
    );
  }
  app.get(API_ROUTES.users, adminOnly, async () => usersService.list());

  app.post(API_ROUTES.users, adminOnly, async (request) =>
    usersService.create(actorOf(request), parseBody(createBody, request.body)),
  );

  app.patch(API_ROUTES.user, adminOnly, async (request) => {
    const { userId } = parseBody(userParameters, request.params);
    return usersService.update(actorOf(request), userId, parseBody(updateBody, request.body));
  });

  app.post(API_ROUTES.userResetPassword, adminOnly, async (request) => {
    const { userId } = parseBody(userParameters, request.params);
    return usersService.resetPassword(actorOf(request), userId);
  });

  app.post(API_ROUTES.userResetTotp, adminOnly, async (request, reply) => {
    const { userId } = parseBody(userParameters, request.params);
    usersService.resetTotp(actorOf(request), userId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.user, adminOnly, async (request, reply) => {
    const { userId } = parseBody(userParameters, request.params);
    usersService.remove(actorOf(request), userId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
