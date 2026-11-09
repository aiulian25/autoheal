import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { API_ROUTES, type SessionView, type ContainerView } from "../../src/shared/api.js";
import { HTTP_STATUS, ROLE_ADMIN } from "../../src/shared/constants.js";
import { ApiError, api, rememberCsrfToken } from "./api-client.js";
import {
  resourceAllowed,
  resourceGrantsSchema,
  type ResourceAction,
  type ResourcePermissionsView,
} from "../../src/shared/resource-permissions.js";
import { INVENTORY_REFRESH_MILLISECONDS, PATHS, SESSION_QUERY_KEY } from "./constants.js";

/** Every query but the session: what one person's sign-in fetched, which nobody signed in after them may see. */
export const forgetPrivateData = (queryClient: QueryClient) =>
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] });

async function loadSession({ client }: { client: QueryClient }): Promise<SessionView | null> {
  const before = client.getQueryData<SessionView | null>(SESSION_QUERY_KEY)?.user.id;
  try {
    const session = await api<SessionView>("GET", API_ROUTES.session);
    rememberCsrfToken(session.csrfToken);
    // Another person signed in meanwhile, from another tab: what the last one's pages fetched goes before theirs show.
    if (before !== undefined && before !== session.user.id) forgetPrivateData(client);
    return session;
  } catch (error) {
    if (error instanceof ApiError && error.status === HTTP_STATUS.unauthorized) {
      rememberCsrfToken(null);
      return null;
    }
    throw error;
  }
}

export const useSession = () => useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: loadSession });

export function useRefreshSession() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
}

/** Where a signed-in person must go before the dashboard opens, or null when nothing is left. */
export function requiredStep(session: SessionView | null): string | null {
  if (session === null) {
    return PATHS.login;
  }
  if (session.user.totpEnabled && !session.secondFactorDone) {
    return PATHS.secondFactor;
  }
  if (session.user.mustChangePassword) {
    return PATHS.changePassword;
  }
  if (!session.user.totpEnabled) {
    return PATHS.totpSetup;
  }
  return null;
}

export const isAdmin = (session: SessionView | null | undefined) => session?.user?.role === ROLE_ADMIN;

/** The session inside the signed-in app, where the router guarantees there is one. */
export const useSignedInSession = (): SessionView => useSession().data!;

/** Current delegated capabilities. A missing/failed response never grants an action. */
export function useResourcePermissions() {
  // The signed-in router owns session loading; subscribe without an extra sign-in request.
  const session = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: loadSession, enabled: false }).data;
  const permissions = useQuery({
    queryKey: ["resource-permissions", session?.user.id],
    queryFn: async () => {
      const view = await api<ResourcePermissionsView>("GET", API_ROUTES.accountPermissions);
      return { revision: view.revision, grants: resourceGrantsSchema.parse(view.grants) };
    },
    enabled: session != null && !isAdmin(session),
    retry: false,
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
  });
  const grants = session != null && !isAdmin(session) && permissions.isSuccess ? (permissions.data?.grants ?? []) : [];
  const allowed = (action: ResourceAction, container: Pick<ContainerView, "hostId" | "name" | "composeProject">) =>
    resourceAllowed(grants, action, container);
  return {
    allowed,
    hasDelegatedActions: !isAdmin(session) && grants.some((grant) => grant.actions.some((action) => action !== "read")),
  };
}
