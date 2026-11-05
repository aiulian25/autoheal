import { registerApplicationPlansRoutes } from "./backups/application-plans-routes.js";
import { registerMetricTrendRoutes } from "./inventory/metric-trend-routes.js";
import { registerRolloutRoutes } from "./jobs/rollout-routes.js";
import { registerSearchRoutes } from "./search/search-routes.js";
import { registerNotificationDeliveryRoutes } from "./notifications/delivery-routes.js";
import { registerTopologyRoutes } from "./inventory/topology-routes.js";
import { registerPolicyRehearsalRoutes } from "./replay/policy-rehearsal-routes.js";
import { registerDiagnosticsRoutes } from "./incidents/diagnostics-routes.js";
import { registerMaintenanceRoutes } from "./maintenance/maintenance-routes.js";
import { registerRestoreMaintenance } from "./http/restore-maintenance.js";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ACCESS_ADMIN,
  HEALTH_PATH,
  HTTP_STATUS,
  SSH_SESSIONS_PATH,
  ROLE_ADMIN,
  USER_INTERFACE_BODY_LIMIT_BYTES,
} from "../shared/constants.js";
import type { SettingsView, SshSessionReport } from "../shared/api.js";
import { API_ROUTES } from "../shared/api.js";
import { registerApprovalsRoutes } from "./approvals/approvals-routes.js";
import { registerAuditRoutes } from "./audit/audit-routes.js";
import { registerBackupsRoutes } from "./backups/backups-routes.js";
import { registerRestoreRoutes } from "./backups/restore-routes.js";
import { registerAccessControl, registerSessionResolution } from "./auth/access.js";
import { registerAuthRoutes } from "./auth/auth-routes.js";
import { registerPasskeyRoutes } from "./auth/passkey-routes.js";
import { registerSecondFactorRoutes } from "./auth/second-factor-routes.js";
import { registerCsrfProtection } from "./http/csrf.js";
import { registerErrorHandling } from "./http/errors.js";
import { createServer, type TlsMaterial } from "./http/fastify.js";
import { registerSecurity } from "./http/security.js";
import { registerWebAssets } from "./http/web-assets.js";
import { registerHostsRoutes } from "./hosts/hosts-routes.js";
import { registerSshRoutes } from "./ssh/ssh-routes.js";
import { registerSelfUpdateRoutes } from "./self-update/self-update-routes.js";
import { registerIncidentsRoutes } from "./incidents/incidents-routes.js";
import { registerInventoryRoutes } from "./inventory/inventory-routes.js";
import { registerNetworkRoutes } from "./network/network-routes.js";
import { registerProbeRoutes } from "./probes/probe-routes.js";
import { registerRebootPlanRoutes } from "./power/reboot-plans-routes.js";
import { registerHostControlRoutes } from "./host-control/host-control-routes.js";
import { registerHostPackagesRoutes } from "./host-packages/host-packages-routes.js";
import { registerJobsRoutes } from "./jobs/jobs-routes.js";
import { registerAgentRoutes } from "./agent/agent-routes.js";
import { registerLiveRoutes } from "./live/live-routes.js";
import { registerReplayRoutes } from "./replay/replay-routes.js";
import { registerRunbooksRoutes } from "./runbooks/runbooks-routes.js";
import { registerTasksRoutes } from "./tasks/tasks-routes.js";
import { registerBoardRoutes } from "./board/board-routes.js";
import { registerAccountRoutes } from "./account/account-routes.js";
import { registerIntegrationsRoutes } from "./settings/integrations-routes.js";
import { registerOllamaSettingsRoutes } from "./settings/ollama-settings-routes.js";
import { registerRegistryCredentialRoutes } from "./settings/registry-credentials-routes.js";
import { registerImageTrustRoutes } from "./settings/image-trust-routes.js";
import { registerAvailabilityGroupRoutes } from "./inventory/availability-groups-routes.js";
import { registerTrustedProxiesRoutes } from "./settings/trusted-proxies-routes.js";
import { registerFileRoutes } from "./container-access/file-routes.js";
import {
  registerHostProfileRoutes,
  registerVolumeLookRoutes,
  registerContainerBackupRoutes,
  registerStackRoutes,
  registerInstallRoutes,
  registerSettingsRoutes,
} from "./container-access/settings-routes.js";
import { registerTerminalRoutes } from "./container-access/terminal-routes.js";
import { arrivalOf } from "./http/request-context.js";
import type { ControlPlaneServices } from "./services.js";
import { registerUsersRoutes } from "./users/users-routes.js";
import { registerJarvisRoutes } from "./jarvis/jarvis-routes.js";
import { registerWidgetRoutes } from "./widget/widget-routes.js";

// The settings fixed at start; where "Add a host" points runners, and whose word on a client counts, are read
// when asked.
export type StaticSettingsView = Omit<SettingsView, "runnerAddress" | "trustedProxies" | "invalidSettings">;

export interface UserInterfaceServerOptions {
  publicHost: string;
  publicOrigin: string;
  tls: TlsMaterial | null;
  services: ControlPlaneServices;
  settings: StaticSettingsView;
  // The React build, or null (tests, or a build without the dashboard).
  webAssetsDirectory: string | null;
}

/** The dashboard and its API, reached by browsers through the reverse proxy. */
export async function buildUserInterfaceServer(options: UserInterfaceServerOptions): Promise<FastifyInstance> {
  const app = createServer({
    tls: options.tls,
    isTrustedProxy: options.services.trustedProxies.isTrusted,
    bodyLimit: USER_INTERFACE_BODY_LIMIT_BYTES,
  });
  registerErrorHandling(app);
  registerRestoreMaintenance(app, options.services.databaseHandle.restore);
  await registerSecurity(app, options.publicHost);
  await app.register(cookie);
  registerSessionResolution(app, options.services.sessions);
  registerCsrfProtection(app, options.publicOrigin);
  registerAccessControl(app);
  registerAuthRoutes(app, options.services.authService);
  registerSecondFactorRoutes(app, options.services.secondFactor, options.services.backupPassphraseNotice);
  registerAccountRoutes(
    app,
    options.services.accountService,
    options.services.secondFactor,
    options.services.viewPreferences,
  );
  registerPasskeyRoutes(app, options.services.passkeys, options.services.secondFactor);
  registerTerminalRoutes(app, options.services.terminals);
  registerFileRoutes(app, options.services.files);
  registerSettingsRoutes(app, options.services.containerSettings);
  registerHostProfileRoutes(app, options.services.hostProfiles);
  registerVolumeLookRoutes(app, options.services.volumeLooks);
  registerStackRoutes(app, options.services.stackFiles);
  registerContainerBackupRoutes(app, options.services.containerBackups);
  registerInstallRoutes(app, options.services.installs);
  registerUsersRoutes(app, options.services.usersService, options.services.resourcePermissions);
  registerHostsRoutes(app, options.services.hostsService, options.services.localHostService);
  registerSelfUpdateRoutes(app, options.services.selfUpdate);
  registerSshRoutes(
    app,
    options.services.sshKeysService,
    options.services.sshHostsService,
    options.services.embeddedRunners,
  );
  registerInventoryRoutes(app, options.services);
  registerNetworkRoutes(app, options.services);
  registerProbeRoutes(app, options.services);
  registerRebootPlanRoutes(app, options.services);
  registerApplicationPlansRoutes(app, options.services.applicationBackups);
  registerMetricTrendRoutes(app, options.services.metricRollups);
  registerRolloutRoutes(app, options.services.rollouts);
  registerSearchRoutes(app, options.services.search);
  registerNotificationDeliveryRoutes(app, options.services.notificationDeliveries);
  registerTopologyRoutes(app, options.services.topology);
  registerPolicyRehearsalRoutes(app, options.services.policyRehearsal);
  registerTasksRoutes(app, options.services.tasksService);
  registerBoardRoutes(app, options.services.boardService);
  registerJobsRoutes(
    app,
    options.services.jobsService,
    options.services.hostPackages,
    options.services.updateRuns,
    options.services.stackRestarts,
    options.services.stackDrift,
    options.services.topology,
  );
  registerAgentRoutes(app, options.services.dispatchService);
  registerLiveRoutes(app, options.services.live, options.services.sessions);
  registerHostPackagesRoutes(app, options.services.hostPackages);
  registerHostControlRoutes(app, options.services.hostControl);
  registerMaintenanceRoutes(app, options.services.maintenance);
  registerWidgetRoutes(app, options.services);
  registerJarvisRoutes(app, options.services);
  registerIncidentsRoutes(app, options.services.incidentsService);
  registerDiagnosticsRoutes(app, options.services.diagnostics);
  registerApprovalsRoutes(app, options.services.approvalsService);
  registerRunbooksRoutes(app, options.services.runbooksService, options.services.runbookSuggestions);
  registerReplayRoutes(app, options.services.replayService);
  registerAuditRoutes(app, options.services.auditLog);
  registerBackupsRoutes(app, options.services.backupService);
  registerRestoreRoutes(app, options.services.restoreService);
  registerIntegrationsRoutes(app, options.services);
  registerOllamaSettingsRoutes(app, options.services);
  registerRegistryCredentialRoutes(app, options.services);
  registerImageTrustRoutes(app, options.services);
  registerAvailabilityGroupRoutes(app, options.services);
  registerTrustedProxiesRoutes(app, options.services.trustedProxies);
  app.get(API_ROUTES.settings, async (request): Promise<SettingsView> => {
    const view: SettingsView = {
      ...options.settings,
      runnerAddress: options.services.hostsService.runnerAddress(),
      trustedProxies: options.services.trustedProxies.view(arrivalOf(request)),
    };
    if (request.authSession!.user.role === ROLE_ADMIN) {
      const invalid = options.services.settingsStore.invalidKeys();
      if (invalid.length > 0) view.invalidSettings = invalid;
    }
    return view;
  });
  app.get(API_ROUTES.dataHousekeeping, { config: { access: ACCESS_ADMIN } }, async () =>
    options.services.retentionSweep.view(),
  );
  await registerWebAssets(app, options.webAssetsDirectory);
  return app;
}

/** Plain HTTP on the container's loopback only, for Docker's HEALTHCHECK and the self-test command. */
export function buildHealthServer(isHealthy: () => boolean, sshSessions: () => SshSessionReport[]) {
  const server = Fastify({ logger: false });
  server.get(HEALTH_PATH, async (_request, reply) => {
    const healthy = isHealthy();
    return reply.code(healthy ? HTTP_STATUS.ok : HTTP_STATUS.serviceUnavailable).send({ healthy });
  });
  server.get(SSH_SESSIONS_PATH, async () => sshSessions());
  return server;
}
