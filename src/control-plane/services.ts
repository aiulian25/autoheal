import { splitTag } from "../shared/image-reference.js";
import { RUNNING_VERSION } from "../shared/build-version.js";
import { and, eq } from "drizzle-orm";
import { APP_VERSION, CONTAINER_STATE_RUNNING, HOST_STATUS_ACTIVE } from "../shared/constants.js";
import { hosts as hostsTable } from "./database/schema.js";
import { JarvisService } from "./jarvis/jarvis-service.js";
import { StackService } from "./container-access/stack-service.js";
import { VolumeLookService } from "./container-access/volume-look-service.js";
import { MetricRollups } from "./inventory/metric-rollups.js";
import { AnomalyDetector } from "./tasks/anomaly-detector.js";
import { ResourceAdvisor } from "./tasks/resource-advisor.js";
import { SshHostsService } from "./ssh/ssh-hosts-service.js";
import { EmbeddedRunners } from "./ssh/embedded-runners.js";
import { LocalHostRunner } from "./local-host/local-host-runner.js";
import { LocalHostService } from "./local-host/local-host-service.js";
import { SelfUpdateOutcomeFile } from "./self-update/self-update-outcome.js";
import { SelfUpdateService } from "./self-update/self-update-service.js";
import { PowerService } from "./power/power-service.js";
import { DockerClient } from "../runner/docker-client.js";
import { SshKeysService } from "./ssh/ssh-keys-service.js";
import { RolloutService } from "./jobs/rollout-service.js";
import { ApplicationPlansService } from "./backups/application-plans-service.js";
import { SearchService } from "./search/search-service.js";
import { DeliveryService } from "./notifications/delivery-service.js";
import { TopologyService } from "./inventory/topology-service.js";
import { PolicyRehearsalService } from "./replay/policy-rehearsal-service.js";
import { ResourcePermissions } from "./auth/resource-permissions.js";
import { DiagnosticsService } from "./incidents/diagnostics-service.js";
import {
  AUDIT_ACTIONS,
  ENV_ROUTER_LOG_PORT,
  HOME_ASSISTANT_CONFIG_MOUNT,
  PRIORITY_REPLAY,
} from "../shared/constants.js";
import { MaintenanceService } from "./maintenance/maintenance-service.js";
import { ResultReceipts } from "./runner-api/result-receipts.js";
import type { OllamaSettings } from "../config/shared-settings.js";
import {
  BRAND_ASSETS,
  DEFAULT_AUTOHEAL_IMAGE,
  EMBEDDED_RUNNER_URL,
  JOIN_DIRECTORY,
  INTEGRATION_KIND,
  LOCAL_PUBLIC_BASE_URL,
  SECRET_BOX_MESSAGES,
} from "../shared/constants.js";
import type { HeartbeatResponse } from "../shared/protocol.js";
import { ImageProvenanceReader } from "../runner/image-provenance.js";
import type { ProvenanceSource } from "../runner/image-updates.js";
import { RegistryClient } from "../runner/registry-client.js";
import { RegistryCredentialsService } from "./settings/registry-credentials-service.js";
import { ImageTrustService } from "./settings/image-trust-service.js";
import { AvailabilityGroupsService } from "./inventory/availability-groups-service.js";
import { joinUrl } from "../shared/urls.js";
import { OllamaClient } from "../ollama/ollama-client.js";
import { AccountService } from "./account/account-service.js";
import { ApprovalsService } from "./approvals/approvals-service.js";
import type { AuditLog } from "./audit/audit-log.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import { BackupPassphraseNotice } from "./backups/backup-passphrase.js";
import { BackupService, type BackupSettings } from "./backups/backup-service.js";
import { BoardService } from "./board/board-service.js";
import { RestoreService } from "./backups/restore-service.js";
import { AuthService } from "./auth/auth-service.js";
import { PasskeyService } from "./auth/passkey-service.js";
import { LoginThrottle } from "./auth/login-throttle.js";
import { SecondFactorService } from "./auth/second-factor-service.js";
import { SessionStore } from "./auth/sessions.js";
import type { DatabaseHandle } from "./database/connection.js";
import { SecretBox } from "./database/secret-box.js";
import { RetentionSweep } from "./database/retention-sweep.js";
import { sealStoredSecrets } from "./database/stored-secrets.js";
import { DecisionQueue } from "./decisions/decision-queue.js";
import { DecisionService } from "./decisions/decision-service.js";
import { HomeAssistantClient } from "./home-assistant/home-assistant-client.js";
import {
  HomeAssistantConnection,
  HomeAssistantInventory,
  type HomeAssistantTiming,
} from "./home-assistant/home-assistant-inventory.js";
import { HomeReview } from "./home-assistant/home-review.js";
import { NetworkReview } from "./network/network-review.js";
import { NetworkStore } from "./network/network-store.js";
import { NetworkWatch } from "./network/network-watch.js";
import { ProbeService } from "./probes/probe-service.js";
import { ViewPreferencesService } from "./account/view-preferences.js";
import { RebootPlansService } from "./power/reboot-plans-service.js";
import { NetworkSpeedRun } from "./network/network-speed.js";
import { ContainerBackupService } from "./container-access/container-backup-service.js";
import { RouterSettingsService } from "./network/router-settings-service.js";
import { OllamaPool } from "./ollama/ollama-pool.js";
import { OllamaServersService } from "./settings/ollama-servers-service.js";
import { HostsService } from "./hosts/hosts-service.js";
import { IncidentReconciler } from "./incidents/incident-reconciler.js";
import { RepairWorker } from "./incidents/repair-worker.js";
import { DispatchService } from "./agent/dispatch-service.js";
import { FailureReporter } from "./agent/failure-reporter.js";
import { BoardChanges } from "./live/board-changes.js";
import { LiveEvents } from "./live/live-events.js";
import { IncidentsService } from "./incidents/incidents-service.js";
import { InventoryService } from "./inventory/inventory-service.js";
import { ContainerTimeline } from "./inventory/timeline-service.js";
import { MetricsStore } from "./inventory/metrics-store.js";
import { JobsService } from "./jobs/jobs-service.js";
import { StackDriftService } from "./inventory/stack-drift-service.js";
import { StackRestartsService } from "./jobs/stack-restarts-service.js";
import { UpdateRunsService } from "./jobs/update-runs-service.js";
import { Notifier } from "./notifications/notifier.js";
import { OllamaMonitor } from "./ollama/ollama-monitor.js";
import { AutohealWorker } from "./tasks/autoheal-worker.js";
import { DetectorService } from "./tasks/detector-service.js";
import { incidentFinding } from "./tasks/detectors.js";
import { TasksService } from "./tasks/tasks-service.js";
import { UpdateAssessor } from "./tasks/update-assessor.js";
import { HostControlService } from "./host-control/host-control-service.js";
import { HostPackagesService } from "./host-packages/host-packages-service.js";
import { PackageKinds } from "./host-packages/package-kinds.js";
import { WidgetKeysService } from "./widget/widget-keys-service.js";
import { ReplayService } from "./replay/replay-service.js";
import { RunbookSuggestions } from "./runbooks/runbook-suggestions.js";
import { RunbooksService } from "./runbooks/runbooks-service.js";
import { IntegrationsService, type IntegrationOverrides } from "./settings/integrations-service.js";
import { OllamaSettingsService } from "./settings/ollama-settings-service.js";
import { TrustedProxiesService } from "./settings/trusted-proxies-service.js";
import { ContainerAccessService } from "./container-access/container-access-service.js";
import { FileService } from "./container-access/file-service.js";
import { HostProfileService } from "./container-access/host-profile-service.js";
import { InstallService } from "./container-access/install-service.js";
import { SettingsService } from "./container-access/settings-service.js";
import { TerminalService } from "./container-access/terminal-service.js";
import { WaitingRunners } from "./container-access/waiting-runners.js";
import { SettingsStore } from "./settings/settings-store.js";
import { UsersService } from "./users/users-service.js";

/** Everything the control plane runs on, built once; the application and the tests share it. */
export interface ControlPlaneServices {
  metricRollups: MetricRollups;
  rollouts: RolloutService;
  applicationBackups: ApplicationPlansService;
  search: SearchService;
  notificationDeliveries: DeliveryService;
  topology: TopologyService;
  policyRehearsal: PolicyRehearsalService;
  resourcePermissions: ResourcePermissions;
  diagnostics: DiagnosticsService;
  maintenance: MaintenanceService;
  resultReceipts: ResultReceipts;
  // Finished records past their window, removed once a day.
  retentionSweep: RetentionSweep;
  databaseHandle: DatabaseHandle;
  auditLog: AuditLog;
  sessions: SessionStore;
  authService: AuthService;
  secondFactor: SecondFactorService;
  // Who may open a shell, browse files or edit a container now.
  containerAccess: ContainerAccessService;
  terminals: TerminalService;
  files: FileService;
  containerSettings: SettingsService;
  hostProfiles: HostProfileService;
  volumeLooks: VolumeLookService;
  stackFiles: StackService;
  containerBackups: ContainerBackupService;
  installs: InstallService;
  // Runners waiting to hear of a shell or a file request for their host.
  waitingRunners: WaitingRunners;
  passkeys: PasskeyService;
  accountService: AccountService;
  viewPreferences: ViewPreferencesService;
  usersService: UsersService;
  hostsService: HostsService;
  inventoryService: InventoryService;
  containerTimeline: ContainerTimeline;
  resourceAdvisor: ResourceAdvisor;
  sshKeysService: SshKeysService;
  sshHostsService: SshHostsService;
  // Each SSH host's runner, inside this process; begun and stopped by the application.
  embeddedRunners: EmbeddedRunners;
  // The control plane's own machine as a host, looked after in place where the Docker socket is mounted.
  localHostService: LocalHostService;
  // Its runner, inside this process; begun and stopped by the application.
  localHostRunner: LocalHostRunner;
  // Autoheal updating itself, through a helper container of its new image.
  selfUpdate: SelfUpdateService;
  // Reboots and shutdowns, followed from what each host shows; ticked by the application.
  power: PowerService;
  metricsStore: MetricsStore;
  // Follows Settings (or the .env); started and stopped by the application.
  homeAssistant: HomeAssistantConnection;
  homeReview: HomeReview;
  settingsStore: SettingsStore;
  integrationsService: IntegrationsService;
  // What private registries each host may read and pull from, and the only place their passwords are kept.
  registryCredentials: RegistryCredentialsService;
  // Which publishers are trusted, and where an update waits for a signed image.
  imageTrust: ImageTrustService;
  // An application's replicas across the fleet, and how much of it must keep serving through a fleet operation.
  availabilityGroups: AvailabilityGroupsService;
  trustedProxies: TrustedProxiesService;
  notifier: Notifier;
  backupPassphraseNotice: BackupPassphraseNotice;
  // What every heartbeat answer tells runners: read at each answer, so a change in Settings reaches them.
  runnerSettings: (hostId: string) => HeartbeatResponse;
  // The runner API shows a new key, its certificate renewed with one: join codes from now on, and the runners in this
  // process, which read it once the old one stops matching, name it.
  keyChanged: (pin: string) => void;
  // The Ollama Autoheal asks: the .env's, unless Settings chose another.
  ollamaSettings: OllamaSettingsService;
  incidentsService: IncidentsService;
  ollamaPool: OllamaPool;
  routerSettings: RouterSettingsService;
  networkStore: NetworkStore;
  networkWatch: NetworkWatch;
  probes: ProbeService;
  rebootPlans: RebootPlansService;
  networkReview: NetworkReview;
  networkSpeed: NetworkSpeedRun;
  routerLogPort: number | null;
  ollamaServers: OllamaServersService;
  decisionService: DecisionService;
  approvalsService: ApprovalsService;
  runbooksService: RunbooksService;
  replayService: ReplayService;
  runbookSuggestions: RunbookSuggestions;
  backupService: BackupService;
  restoreService: RestoreService;
  tasksService: TasksService;
  boardService: BoardService;
  jobsService: JobsService;
  updateRuns: UpdateRunsService;
  stackRestarts: StackRestartsService;
  stackDrift: StackDriftService;
  hostPackages: HostPackagesService;
  hostControl: HostControlService;
  ollamaMonitor: OllamaMonitor;
  // Run on timers by the application; the tests call them directly.
  detectorService: DetectorService;
  incidentReconciler: IncidentReconciler;
  repairWorker: RepairWorker;
  autohealWorker: AutohealWorker;
  failureReporter: FailureReporter;
  // What changes, pushed to the dashboards open now.
  live: LiveEvents;
  // Looks each second whether the board's tasks or incidents changed, and tells the dashboards open.
  boardChanges: BoardChanges;
  // Work a person hands to the Ollama agent on Attention.
  dispatchService: DispatchService;
  widgetKeysService: WidgetKeysService;
  jarvis: JarvisService;
}

export interface ServiceSettings {
  ollama: OllamaSettings;
  backups: BackupSettings;
  // The passphrase Autoheal made, shown once to the first admin; null when the .env sets it.
  generatedBackupPassphrase?: string | null;
  // Notification channels and Home Assistant set in the .env; the dashboard sets the others.
  integrations?: Partial<IntegrationOverrides>;
  // The proxies the .env trusts: they win over a list set in Settings.
  trustedProxyAddresses?: string[];
  homeAssistantTiming?: HomeAssistantTiming;
  homeAssistantConfigFolder?: string;
  // The dashboard's address: in notification links, and in each authenticator entry's name.
  publicBaseUrl?: string;
  // The control plane's public key and the image new runners run: in join codes and install commands. Where SSH hosts'
  // runners reach the runner API, when not on loopback's 9443 (tests).
  runners?: { pin: string; image: string; apiUrl?: string };
  // The control plane's own environment, which looks after its machine in place when the Docker socket is mounted.
  // Absent (tests): it never does.
  environment?: NodeJS.ProcessEnv;
  clock?: () => number;
}

// A key no real certificate has, for tests that never connect a runner.
const NO_PIN = "A".repeat(43);

export function createControlPlaneServices(
  databaseHandle: DatabaseHandle,
  auditLog: AuditLog,
  {
    ollama,
    backups,
    generatedBackupPassphrase = null,
    integrations = {},
    trustedProxyAddresses = [],
    homeAssistantTiming,
    homeAssistantConfigFolder = HOME_ASSISTANT_CONFIG_MOUNT,
    publicBaseUrl = LOCAL_PUBLIC_BASE_URL,
    runners = { pin: NO_PIN, image: DEFAULT_AUTOHEAL_IMAGE },
    environment,
    clock = Date.now,
  }: ServiceSettings,
): ControlPlaneServices {
  const lifecycle = databaseHandle.restore;
  const tracked = <Service extends object>(service: Service, excluded: readonly string[] = []) =>
    lifecycle.wrap(service, excluded);
  auditLog = tracked(auditLog);
  // Whatever an older version kept in plain text is sealed before any service reads it.
  const secretBox = SecretBox.fromPassphrase(backups.backupPassphrase);
  const widgetKeysService = tracked(new WidgetKeysService(databaseHandle, auditLog, clock));
  const { sealed, unreadable } = sealStoredSecrets(databaseHandle.sqlite, secretBox);
  if (sealed > 0) log(SECRET_BOX_MESSAGES.sealed(sealed));
  if (unreadable > 0) log(SECRET_BOX_MESSAGES.unreadable(unreadable));
  const settingsStore = tracked(new SettingsStore(databaseHandle, clock));
  const integrationsService = tracked(
    new IntegrationsService(
      settingsStore,
      auditLog,
      {
        gotify: integrations.gotify ?? null,
        ntfy: integrations.ntfy ?? null,
        homeAssistant: integrations.homeAssistant ?? null,
      },
      secretBox,
    ),
  );
  // One host's row, for the few places that need what its runner can do rather than the whole inventory view.
  const hostRowOf = (hostId: string) =>
    databaseHandle.database
      .select()
      .from(hostsTable)
      .where(and(eq(hostsTable.id, hostId), eq(hostsTable.status, HOST_STATUS_ACTIVE)))
      .get();
  const imageTrust = tracked(new ImageTrustService(databaseHandle, auditLog, clock));
  const registryCredentialsService = tracked(
    new RegistryCredentialsService(databaseHandle, auditLog, secretBox, new RegistryClient(), clock),
  );
  const sshKeysService = tracked(new SshKeysService(databaseHandle, auditLog, secretBox, clock));
  const sshHostsService = tracked(
    new SshHostsService(
      databaseHandle,
      auditLog,
      secretBox,
      sshKeysService,
      clock,
      undefined,
      (hostId) => {
        void embeddedRunners.open(hostId);
      },
      (hostId) => hostsService.localHost(JOIN_DIRECTORY).hostId === hostId,
    ),
  );
  // Where the runners in this process reach the runner API, and the key it shows them, which `keyChanged` replaces.
  const runnerApi = { url: runners.apiUrl ?? EMBEDDED_RUNNER_URL, pin: runners.pin };
  const embeddedRunners = new EmbeddedRunners({
    hosts: sshHostsService,
    controlPlane: runnerApi,
    autohealImage: runners.image,
  });
  const trustedProxies = tracked(new TrustedProxiesService(settingsStore, auditLog, trustedProxyAddresses));
  const homeAssistant = tracked(
    new HomeAssistantConnection(
      (settings) => new HomeAssistantInventory(new HomeAssistantClient(settings), homeAssistantTiming, clock),
    ),
  );
  homeAssistant.use(integrationsService.homeAssistant());
  // A change in Settings takes effect at once: the old connector stops, a new one starts.
  integrationsService.onChange((kind) => {
    if (kind === INTEGRATION_KIND.homeAssistant && !lifecycle.shuttingDown) {
      homeAssistant.use(integrationsService.homeAssistant());
      homeAssistant.start();
    }
  });
  const notificationChannels = () => ({
    gotify: integrationsService.gotify(),
    ntfy: integrationsService.ntfy(),
    webhook: integrationsService.webhook(),
  });
  const notificationDeliveries = tracked(new DeliveryService(databaseHandle, auditLog, notificationChannels, clock));
  const notifier = tracked(new Notifier(notificationChannels, publicBaseUrl, undefined, clock, notificationDeliveries));
  integrationsService.onChange((kind) => {
    if (kind !== INTEGRATION_KIND.homeAssistant) notifier.reset(kind);
  });
  const sessions = tracked(new SessionStore(databaseHandle, clock));
  const throttle = tracked(new LoginThrottle(databaseHandle, clock));
  // The dashboard's host, in each authenticator entry's name, and its logo beside the entry.
  const accountHost = new URL(publicBaseUrl).host;
  const authenticatorImage = joinUrl(publicBaseUrl, BRAND_ASSETS.logo);
  // What join codes carry, the key among it, which `keyChanged` replaces.
  const joinSettings = { ...runners, publicBaseUrl };
  const hostsService = tracked(
    new HostsService(databaseHandle, auditLog, settingsStore, joinSettings, clock, (hostId) => {
      metricsStore.remove(hostId);
      void embeddedRunners.close(hostId);
      localHostRunner.tick();
      // Nothing more passes between it and the dashboard: its shells end, what waits on its runner is refused, and a
      // poll it has open goes back empty.
      services.terminals.endForHost(hostId);
      for (const relayed of [
        services.files,
        services.containerSettings,
        services.hostProfiles,
        services.volumeLooks,
        services.stackFiles,
        services.containerBackups,
        services.installs,
        topology,
      ]) {
        relayed.resetHost(hostId);
      }
      waitingRunners.wake(hostId);
    }),
  );
  const localHostService = tracked(new LocalHostService(databaseHandle, auditLog, secretBox, hostsService, clock));
  const localHostRunner = new LocalHostRunner({
    hosts: localHostService,
    controlPlane: runnerApi,
    environment: environment ?? null,
  });
  // ponytail: signatures read without registry credentials, as Autoheal's own image is public; pass the local host's
  // credentials here if a private registry ever holds it.
  const selfUpdateReader = new ImageProvenanceReader(new RegistryClient(), () => imageTrust.policy());
  const selfUpdateProvenance: ProvenanceSource = {
    policy: () => imageTrust.policy(),
    read: (reference, digest) => selfUpdateReader.read(reference, digest),
  };
  const selfUpdate = tracked(
    new SelfUpdateService({
      docker: localHostRunner.inPlace() ? new DockerClient(localHostRunner.socketPath) : null,
      socketPath: localHostRunner.socketPath,
      reference: runners.image,
      outcomes: new SelfUpdateOutcomeFile(backups.dataDirectory),
      auditLog,
      clock,
      provenance: selfUpdateProvenance,
    }),
  );
  const metricRollups = tracked(
    new MetricRollups({
      databaseHandle,
      auditLog,
      maintenance: (hostId) => maintenance.forRunner(hostId).windows,
      clock,
    }),
  );
  const metricsStore: MetricsStore = tracked(
    new MetricsStore(clock, undefined, (hostId) => hostsService.isActive(hostId), metricRollups),
  );
  const inventoryService = tracked(
    new InventoryService(
      databaseHandle,
      metricsStore,
      homeAssistant,
      clock,
      (hostId) => embeddedRunners.connectionOf(hostId),
      (hostId) => localHostRunner.inPlaceOf(hostId),
      (host) => power.powerOf(host),
    ),
  );
  const resourcePermissions = tracked(
    new ResourcePermissions(databaseHandle, auditLog, inventoryService, sessions, clock),
  );
  const tasksService = tracked(new TasksService(databaseHandle, auditLog, inventoryService, clock));
  const resourceAdvisor = tracked(
    new ResourceAdvisor({ databaseHandle, metricsStore, owner: () => tasksService.owner(), clock }),
  );
  // An incident opens its container's task, or joins the one already open.
  const incidentsService = tracked(
    new IncidentsService(databaseHandle, clock, (incident, host) => {
      tasksService.openOrJoin(incidentFinding(incident, host, tasksService.owner()));
    }),
  );
  const diagnostics = tracked(
    new DiagnosticsService(
      incidentsService,
      (actor, incidentId, metadata) => {
        auditLog.recordUserAction(
          actor,
          AUDIT_ACTIONS.diagnosticsExported,
          { kind: "incident", id: incidentId },
          metadata,
        );
      },
      clock,
    ),
  );
  const decisionQueue = tracked(new DecisionQueue());
  const ollamaSettings = tracked(new OllamaSettingsService(settingsStore, auditLog, ollama));
  const ollamaClient = tracked(new OllamaClient(() => ollamaSettings.current(), clock));
  const runbooksService = tracked(new RunbooksService(databaseHandle, auditLog, clock));
  const backupService = tracked(new BackupService(databaseHandle, auditLog, backups, clock));
  const live = tracked(new LiveEvents());
  const maintenance = tracked(new MaintenanceService(databaseHandle, auditLog, clock));
  const probes = tracked(
    new ProbeService({
      databaseHandle,
      maintenance,
      clock,
      vantages: {
        canCheck: (hostId) => hostRowOf(hostId)?.serviceProbes === true,
        lastReportAt: (hostId) => hostRowOf(hostId)?.lastHeartbeatAt ?? null,
        labelOf: (hostId) => hostRowOf(hostId)?.label ?? null,
      },
    }),
  );
  const jobsService = tracked(
    new JobsService(
      databaseHandle,
      auditLog,
      tasksService,
      inventoryService,
      live,
      clock,
      (hostId, name) => maintenance.held(hostId, name),
      resourcePermissions,
    ),
  );
  const power: PowerService = tracked(
    new PowerService({
      databaseHandle,
      metricsStore,
      jobs: jobsService,
      sshConnectionOf: (hostId) => embeddedRunners.connectionOf(hostId),
      redialSoon: (hostId, until) => embeddedRunners.redialSoon(hostId, until),
      clock,
    }),
  );
  const ollamaMonitor = tracked(new OllamaMonitor(ollamaClient, clock));
  const ollamaServers = tracked(new OllamaServersService(databaseHandle, settingsStore, auditLog, clock));
  const ollamaPool = tracked(
    new OllamaPool(
      { id: null, name: null, client: ollamaClient, queue: decisionQueue, monitor: ollamaMonitor },
      () => ollamaSettings.current(),
      ollamaServers,
      clock,
    ),
  );
  ollamaServers.onChange(() => void ollamaPool.checkAll());
  const routerLogPort = Number(environment?.[ENV_ROUTER_LOG_PORT]) || null;
  const routerSettings = tracked(new RouterSettingsService(settingsStore, secretBox, auditLog));
  const networkStore = tracked(new NetworkStore(databaseHandle));
  const networkWatch = tracked(
    new NetworkWatch({ store: networkStore, settings: routerSettings, clock, logPort: routerLogPort }),
  );
  const networkSpeed = tracked(
    new NetworkSpeedRun({
      store: networkStore,
      adapter: () => routerSettings.adapter(),
      contractDownMbps: () => routerSettings.contract()?.downMbps ?? null,
      quietBusyMbps: () => networkWatch.quietBusyMbps(),
      clock,
    }),
  );
  const networkReview = tracked(
    new NetworkReview({
      store: networkStore,
      watch: networkWatch,
      ask: async (system, user, format) => {
        const server = ollamaPool.routerServer();
        const { content } = await server.queue.enqueue(PRIORITY_REPLAY, (signal) =>
          server.client.chat(system, user, signal, format),
        );
        return { content, server: server.name };
      },
      notify: (title, body) => notifier.networkReport(title, body),
      clock,
    }),
  );
  const homeReview = tracked(
    new HomeReview({
      root: homeAssistantConfigFolder,
      connected: () => homeAssistant.connected(),
      facts: () => homeAssistant.facts(),
      systemLog: () => homeAssistant.systemLog(),
      ask: async (system, user, format) => {
        const server = ollamaPool.reviewServer();
        const { content } = await server.queue.enqueue(PRIORITY_REPLAY, (signal) =>
          server.client.chat(system, user, signal, format),
        );
        return content;
      },
      contextTokens: () => ollamaPool.reviewServer().client.contextTokens,
      clock,
    }),
  );
  // A model chosen in Settings shows in the Ollama status at once, not at the next minute's check.
  ollamaSettings.onChange(() => void ollamaMonitor.check());
  const hostPackages = tracked(
    new HostPackagesService({
      databaseHandle,
      auditLog,
      jobs: jobsService,
      tasks: tasksService,
      inventory: inventoryService,
      settings: settingsStore,
      kinds: tracked(new PackageKinds(databaseHandle, ollamaClient, decisionQueue, clock)),
      clock,
    }),
  );
  const rebootPlans: RebootPlansService = tracked(
    new RebootPlansService({
      databaseHandle,
      audit: auditLog,
      permissions: resourcePermissions,
      hostPackages,
      power,
      probes,
      rebootRequired: (hostId) =>
        inventoryService.hosts().find(({ id }) => id === hostId)?.health?.rebootRequired ?? null,
      availability: { problemFor: (asking) => availabilityGroups.problemFor(asking) },
      clock,
    }),
  );
  const availabilityGroups: AvailabilityGroupsService = tracked(
    new AvailabilityGroupsService({
      databaseHandle,
      auditLog,
      replica: (hostId, containerName) => {
        const host = inventoryService.hosts().find(({ id }) => id === hostId);
        if (host === undefined) return { hostLabel: null, reportedAt: null, running: null };
        const container = inventoryService.containers({ hostId }).find(({ name }) => name === containerName);
        return {
          hostLabel: host.label,
          reportedAt: host.lastHeartbeatAt,
          running: container === undefined ? null : container.state === CONTAINER_STATE_RUNNING,
        };
      },
      probeProblem: (probeId, since) => probes.evidence(probeId, since),
      underWay: () => [{ hostIds: rebootPlans.hostsDownNow() }, { containers: rollouts.containersStillToReplace() }],
      clock,
    }),
  );
  const hostControl = tracked(
    new HostControlService({
      maintenance,
      databaseHandle,
      auditLog,
      inventory: inventoryService,
      jobs: jobsService,
      window: () => hostPackages.settings(),
      clock,
    }),
  );
  const secondFactor = tracked(
    new SecondFactorService(
      databaseHandle,
      auditLog,
      throttle,
      sessions,
      accountHost,
      authenticatorImage,
      secretBox,
      clock,
    ),
  );
  const containerAccess = tracked(
    new ContainerAccessService(databaseHandle, inventoryService, resourcePermissions, sessions),
  );
  const waitingRunners = tracked(new WaitingRunners());
  const topology = tracked(
    new TopologyService(databaseHandle, inventoryService, resourcePermissions, waitingRunners, clock),
  );
  const rollouts: RolloutService = tracked(
    new RolloutService(
      databaseHandle,
      auditLog,
      resourcePermissions,
      inventoryService,
      topology,
      jobsService,
      (hostId, name) => maintenance.held(hostId, name),
      clock,
      { problemFor: (asking) => availabilityGroups.problemFor(asking) },
    ),
  );
  const applicationBackups = tracked(
    new ApplicationPlansService(databaseHandle, backups, waitingRunners, auditLog, clock),
  );
  const repairWorker = tracked(
    new RepairWorker({
      incidents: incidentsService,
      inventory: inventoryService,
      jobs: jobsService,
      models: ollamaPool,
      runbooks: runbooksService,
      notifier,
      clock,
    }),
  );
  const autohealWorker = tracked(
    new AutohealWorker({
      tasks: tasksService,
      jobs: jobsService,
      inventory: inventoryService,
      assessor: tracked(new UpdateAssessor(ollamaPool)),
      notifier,
      clock,
    }),
  );
  const logged = (error: unknown) => log(describeError(error));
  const replayService = tracked(
    new ReplayService(
      databaseHandle,
      auditLog,
      {
        incidents: incidentsService,
        runbooks: runbooksService,
        models: ollamaPool,
      },
      clock,
    ),
  );
  const services: ControlPlaneServices = {
    metricRollups,
    rollouts,
    applicationBackups,
    search: tracked(new SearchService(databaseHandle, clock)),
    containerTimeline: tracked(
      new ContainerTimeline(databaseHandle, incidentsService, inventoryService, tasksService, notificationDeliveries),
    ),
    notificationDeliveries,
    topology,
    policyRehearsal: tracked(
      new PolicyRehearsalService({ databaseHandle, hostControl, inventory: inventoryService, maintenance, clock }),
    ),
    resourcePermissions,
    diagnostics,
    maintenance,
    resultReceipts: tracked(new ResultReceipts(databaseHandle, clock)),
    retentionSweep: tracked(new RetentionSweep(databaseHandle, auditLog, clock)),
    databaseHandle,
    auditLog,
    sessions,
    authService: tracked(new AuthService(databaseHandle, auditLog, sessions, throttle, clock)),
    secondFactor,
    containerAccess,
    terminals: tracked(new TerminalService(containerAccess, auditLog, waitingRunners, sessions, clock)),
    files: tracked(new FileService(containerAccess, auditLog, waitingRunners)),
    containerSettings: tracked(
      new SettingsService(containerAccess, jobsService, auditLog, waitingRunners, databaseHandle, secretBox),
    ),
    hostProfiles: tracked(new HostProfileService(containerAccess, waitingRunners)),
    volumeLooks: tracked(new VolumeLookService(containerAccess, waitingRunners)),
    stackFiles: tracked(new StackService(containerAccess, waitingRunners, auditLog)),
    containerBackups: tracked(
      new ContainerBackupService(
        databaseHandle,
        containerAccess,
        waitingRunners,
        jobsService,
        settingsStore,
        auditLog,
        backups.backupPassphrase,
      ),
    ),
    installs: tracked(
      new InstallService(containerAccess, jobsService, auditLog, waitingRunners, databaseHandle, secretBox),
    ),
    waitingRunners,
    passkeys: tracked(new PasskeyService(databaseHandle, auditLog, sessions, publicBaseUrl, clock)),
    accountService: tracked(new AccountService(databaseHandle, auditLog, sessions, accountHost, throttle)),
    viewPreferences: tracked(new ViewPreferencesService(databaseHandle, clock)),
    usersService: tracked(new UsersService(databaseHandle, auditLog, clock)),
    hostsService,
    inventoryService,
    metricsStore,
    homeAssistant,
    homeReview,
    settingsStore,
    integrationsService,
    trustedProxies,
    notifier,
    backupPassphraseNotice: tracked(new BackupPassphraseNotice(settingsStore, generatedBackupPassphrase, clock)),
    // A host no credential names is told nothing about registries, as every control plane before them was.
    runnerSettings: (hostId) => {
      const registries = registryCredentialsService.accessFor(hostId);
      const trust = imageTrust.policy();
      return {
        publicBaseUrl,
        ollama: ollamaPool.settingsFor(hostId),
        // The exact release this control plane runs, which a sidecar runner moves to when a person asks.
        release: { image: `${splitTag(runners.image).name}:${APP_VERSION}`, version: RUNNING_VERSION },
        ...(registries.length === 0 ? {} : { registries }),
        // A fleet asking proof of nobody is told nothing about it, as every control plane before it was.
        ...(trust.required.length === 0 && trust.publishers.length === 0 ? {} : { imageTrust: trust }),
      };
    },
    keyChanged: (pin) => {
      runnerApi.pin = pin;
      joinSettings.pin = pin;
    },
    registryCredentials: registryCredentialsService,
    imageTrust,
    availabilityGroups,
    ollamaSettings,
    incidentsService,
    ollamaPool,
    ollamaServers,
    routerSettings,
    networkStore,
    networkWatch,
    probes,
    rebootPlans,
    networkReview,
    networkSpeed,
    routerLogPort,
    decisionService: tracked(
      new DecisionService(incidentsService, ollamaPool, runbooksService, networkWatch, metricsStore, inventoryService),
    ),
    approvalsService: tracked(new ApprovalsService(databaseHandle, incidentsService, auditLog, clock)),
    runbooksService,
    replayService,
    runbookSuggestions: tracked(
      new RunbookSuggestions({ databaseHandle, runbooks: runbooksService, replays: replayService, clock }),
    ),
    backupService,
    restoreService: tracked(
      new RestoreService(databaseHandle, auditLog, backupService, backups.backupPassphrase, secretBox, clock),
      ["confirm"],
    ),
    tasksService,
    boardService: tracked(new BoardService(incidentsService, tasksService, clock)),
    jobsService,
    updateRuns: tracked(
      new UpdateRunsService({
        databaseHandle,
        auditLog,
        jobs: jobsService,
        inventory: inventoryService,
        tasks: tasksService,
        topology,
        clock,
      }),
    ),
    stackDrift: tracked(new StackDriftService(databaseHandle)),
    stackRestarts: tracked(
      new StackRestartsService({
        auditLog,
        databaseHandle,
        jobs: jobsService,
        inventory: inventoryService,
        topology,
        permissions: resourcePermissions,
        clock,
      }),
    ),
    hostPackages,
    hostControl,
    ollamaMonitor,
    resourceAdvisor,
    sshKeysService,
    sshHostsService,
    embeddedRunners,
    localHostService,
    localHostRunner,
    selfUpdate,
    power,
    detectorService: tracked(
      new DetectorService({
        anomalies: tracked(new AnomalyDetector({ rollups: metricRollups, owner: () => tasksService.owner() })),
        resources: resourceAdvisor,
        tasks: tasksService,
        inventory: inventoryService,
        packages: hostPackages,
        hostControl,
        metrics: metricsStore,
        homeAssistant,
        ollama: ollamaMonitor,
        ollamaExtras: () => ollamaPool.extraStatuses(),
        network: networkWatch,
        probes,
        rebootPlans,
        notifier,
        deliveries: notificationDeliveries,
        clock,
      }),
    ),
    incidentReconciler: tracked(
      new IncidentReconciler({
        incidents: incidentsService,
        inventory: inventoryService,
        notifier,
        clock,
      }),
    ),
    repairWorker,
    autohealWorker,
    live,
    boardChanges: new BoardChanges(databaseHandle, live),
    failureReporter: tracked(
      new FailureReporter({
        tasks: tasksService,
        jobs: jobsService,
        models: ollamaPool,
      }),
    ),
    dispatchService: tracked(
      new DispatchService({
        tasks: tasksService,
        incidents: incidentsService,
        inventory: inventoryService,
        hostPackages,
        auditLog,
        databaseHandle,
        wake: () => {
          void autohealWorker.run().catch(logged);
          void repairWorker.run().catch(logged);
        },
      }),
    ),
    widgetKeysService,
    jarvis: tracked(
      new JarvisService(
        databaseHandle,
        settingsStore,
        integrationsService,
        widgetKeysService,
        secretBox,
        auditLog,
        inventoryService,
        publicBaseUrl,
        clock,
      ),
    ),
  };
  hostsService.onRename((hostId, before, after) => services.jarvis.rememberOldName(hostId, before, after));
  lifecycle.onPause(() => {
    metricRollups.flush();
    topology.reset();
    diagnostics.reset();
    homeAssistant.stop();
    ollamaPool.cancelAll();
    services.terminals.resetForRestore();
    services.files.reset();
    services.containerSettings.reset();
    services.hostProfiles.reset();
    services.volumeLooks.reset();
    services.stackFiles.reset();
    services.containerBackups.reset();
    services.installs.reset();
    embeddedRunners.pause();
    localHostRunner.pause();
    waitingRunners.wakeAll();
  });
  lifecycle.onResume(() => {
    if (lifecycle.shuttingDown) return;
    rebootPlans.pauseAfterRestore();
    ollamaPool.resume();
    trustedProxies.reload();
    jobsService.resetProgress();
    services.detectorService.reset();
    services.incidentReconciler.reset();
    metricsStore.clear();
    metricRollups.reset();
    services.search.reset();
    notifier.reset();
    notificationDeliveries.reset();
    ollamaPool.reset();
    networkWatch.reset();
    probes.reset();
    networkReview.reset();
    homeAssistant.use(integrationsService.homeAssistant());
    homeAssistant.start();
    embeddedRunners.resume();
    localHostRunner.resume();
  });
  return services;
}
