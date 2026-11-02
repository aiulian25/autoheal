import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { proxyAddress } from "../../config/control-plane-config.js";
import { API_ERRORS, API_ROUTES, type TrustedProxiesView } from "../../shared/api.js";
import { ACCESS_ADMIN, TRUSTED_PROXY_MAXIMUM_ENTRIES, TRUSTED_PROXY_WIDEST_PREFIX } from "../../shared/constants.js";
import { DomainError } from "../domain-error.js";
import { actorOf, arrivalOf } from "../http/request-context.js";
import { partsOf, type TrustedProxiesService } from "./trusted-proxies-service.js";

// "10.0.0.0/8" is a network a proxy may sit in; "10.0.0.0/7", or "0.0.0.0/0", is most of the internet.
function narrowEnough(entry: string) {
  const { prefix, family } = partsOf(entry);
  return prefix === null || prefix >= TRUSTED_PROXY_WIDEST_PREFIX[family];
}

const trustedProxiesBody = z.object({
  addresses: z.array(z.string().trim().pipe(proxyAddress).refine(narrowEnough)).max(TRUSTED_PROXY_MAXIMUM_ENTRIES),
});

export function registerTrustedProxiesRoutes(app: FastifyInstance, trustedProxies: TrustedProxiesService) {
  app.put(
    API_ROUTES.trustedProxies,
    { config: { access: ACCESS_ADMIN } },
    async (request): Promise<TrustedProxiesView> => {
      // One answer for any entry it refuses, which the dashboard can say in plain words.
      const parsed = trustedProxiesBody.safeParse(request.body);
      if (!parsed.success) {
        throw new DomainError(API_ERRORS.trustedProxyInvalid);
      }
      trustedProxies.save(actorOf(request), [...new Set(parsed.data.addresses)]);
      return trustedProxies.view(arrivalOf(request));
    },
  );
}
