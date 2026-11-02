import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, AUDIT_ACTIONS, HTTP_STATUS, TARGET_INTEGRATION } from "../../shared/constants.js";
import {
  networkAskBodySchema,
  networkDeviceBodySchema,
  routerContractBodySchema,
  routerCertificateBodySchema,
  routerSettingsBodySchema,
  type RouterSettingsView,
} from "../../shared/network.js";
import { DomainError } from "../domain-error.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";
import { NETWORK_PERIODS, type NetworkPeriod } from "./network-watch.js";

// Device names, addresses and who talks to whom are a home's private details: for admins.
const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const macParameters = z.object({ mac: z.string().regex(/^[0-9a-f:]{17}$/) });
const periodQuery = z.object({ period: z.enum(Object.keys(NETWORK_PERIODS) as [NetworkPeriod]).optional() });
const REPORT_FILE = "network-report.csv";

export function registerNetworkRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const { routerSettings, networkWatch, networkReview, networkSpeed, ollamaServers, auditLog, routerLogPort } =
    services;

  app.get(API_ROUTES.routerSettings, adminOnly, async (): Promise<RouterSettingsView> => ({
    ...routerSettings.view(),
    logPort: routerLogPort,
    ollamaServerId: ollamaServers.routerServerId(),
  }));
  app.post(API_ROUTES.routerCertificate, adminOnly, async (request) =>
    routerSettings.certificateAt(parseBody(routerCertificateBodySchema, request.body).url),
  );
  app.post(API_ROUTES.routerProbe, adminOnly, async (request) =>
    routerSettings.probe(parseBody(routerSettingsBodySchema, request.body)),
  );
  app.put(API_ROUTES.routerSettings, adminOnly, async (request, reply) => {
    await routerSettings.save(actorOf(request), parseBody(routerSettingsBodySchema, request.body));
    // Its first reading, not waited for; the next tick tries again should this one fail.
    void networkWatch.tick().catch(() => undefined);
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.delete(API_ROUTES.routerSettings, adminOnly, async (request, reply) => {
    routerSettings.remove(actorOf(request));
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.put(API_ROUTES.routerContract, adminOnly, async (request, reply) => {
    routerSettings.saveContract(actorOf(request), parseBody(routerContractBodySchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.get(API_ROUTES.network, adminOnly, async () => networkWatch.overview());
  app.get(API_ROUTES.networkDevices, adminOnly, async (request) =>
    networkWatch.devices(parseBody(periodQuery, request.query).period),
  );
  app.get(API_ROUTES.networkDevice, adminOnly, async (request) => {
    const { mac } = parseBody(macParameters, request.params);
    const detail = networkWatch.deviceDetail(mac);
    if (detail === null) throw new DomainError(API_ERRORS.networkDeviceNotFound);
    return { ...detail, run: networkReview.runOf(mac) };
  });
  app.put(API_ROUTES.networkDevice, adminOnly, async (request, reply) => {
    const { mac } = parseBody(macParameters, request.params);
    const change = parseBody(networkDeviceBodySchema, request.body);
    if (services.networkStore.device(mac) === undefined) throw new DomainError(API_ERRORS.networkDeviceNotFound);
    services.networkStore.changeDevice(mac, change);
    auditLog.recordUserAction(
      actorOf(request),
      AUDIT_ACTIONS.networkDeviceChanged,
      { kind: TARGET_INTEGRATION, id: "router" },
      { mac, ...change },
    );
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.get(API_ROUTES.networkInternet, adminOnly, async () => ({
    ...networkWatch.internet(),
    run: networkSpeed.status(),
  }));
  app.post(API_ROUTES.networkSpeedTest, adminOnly, async (request, reply) => {
    networkSpeed.start();
    auditLog.recordUserAction(actorOf(request), AUDIT_ACTIONS.networkSpeedTestStarted, {
      kind: TARGET_INTEGRATION,
      id: "router",
    });
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.get(API_ROUTES.networkInternetReport, adminOnly, async (_request, reply) =>
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${REPORT_FILE}"`)
      .send(networkWatch.internetReport()),
  );
  app.get(API_ROUTES.networkFirewall, adminOnly, async () => networkWatch.firewall());
  app.post(API_ROUTES.networkFirewallConfirm, adminOnly, async (request, reply) => {
    networkWatch.confirmExposure();
    auditLog.recordUserAction(actorOf(request), AUDIT_ACTIONS.networkExposureConfirmed, {
      kind: TARGET_INTEGRATION,
      id: "router",
    });
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.get(API_ROUTES.networkMap, adminOnly, async () => networkWatch.map());
  app.get(API_ROUTES.networkReports, adminOnly, async () => networkReview.reports());
  app.post(API_ROUTES.networkAsk, adminOnly, async (request) => ({
    started: networkReview.explain(parseBody(networkAskBodySchema, request.body).mac),
  }));
}
