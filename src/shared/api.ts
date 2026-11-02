import type { VolumeReport } from "./volumes.js";
import type { NetworkReport } from "./networks.js";
import { ROLLOUT_ROUTES } from "./rollouts.js";
import { NOTIFICATION_DELIVERY_ROUTES, type NotificationEventView } from "./notification-deliveries.js";
// The HTTP contract between the dashboard and the control plane, imported by both sides.

import { DIAGNOSTIC_ROUTES } from "./diagnostics.js";
import type { SshHostSettings } from "./ssh-hosts.js";
import {
  RESTART_CHOICE,
  TASK_LABEL,
  TASK_RESOURCE,
  UPDATE_CHOICE,
  UPDATE_POLICY,
  UPDATE_STATUS,
  type ActorKind,
  type AgentKey,
  type AllowedAction,
  type ApprovalChoice,
  type BOARD_CARD,
  type BackupOrigin,
  type ContainerHealthName,
  type ContainerProblem,
  type ContainerStateName,
  type HandsOff,
  type HostChangeDetails,
  type HostChangeKind,
  type HostState,
  type IntegrationKind,
  type IntegrationSource,
  type ControlLock,
  type ImageCleanup,
  type JobAction,
  type LifecycleStatus,
  type SecretSource,
  type SettingKey,
  type JobStatus,
  type ReplayStatus,
  type RestartChoice,
  type RESTORE_SOURCE,
  type RestoreSource,
  type Role,
  type RunbookScope,
  type SafetyProblem,
  type TaskActivityKind,
  type TaskPriority,
  type TaskResourceKind,
  type TaskSource,
  type WebhookFormat,
  type AnyKeyScope,
  type TaskStatus,
  type Trigger,
  type UpdateAssessment,
  type UpdateChoice,
  type UpdatePolicy,
  type UpdateRunStatus,
  type UpdateStatus,
  type UserStatus,
  type WatchedProblem,
  type ZigbeeProblem,
  type ZigbeeRole,
  type PackageKind,
  type HostKind,
  type SshState,
  type RootMethod,
  type SelfUpdateStatus,
  type PowerAction,
  type PowerPhase,
} from "./constants.js";
import type {
  ContainerUsage,
  DriveHealth,
  HostMetrics,
  ImageLabels,
  PackageFacts,
  PublishedPort,
  RecoveryHold,
  RestartWait,
  UnusedImage,
  UpdateProgress,
} from "./protocol.js";

export const API_ROUTES = {
  ...ROLLOUT_ROUTES,
  hostTrends: "/api/inventory/hosts/:hostId/trends",
  containerTrends: "/api/inventory/hosts/:hostId/containers/:containerName/trends",
  containerTimeline: "/api/inventory/hosts/:hostId/containers/:containerName/timeline",
  containerResourceAdvice: "/api/inventory/hosts/:hostId/containers/:containerName/resource-advice",
  metricAnomalies: "/api/metric-anomalies",
  metricAnomalyFeedback: "/api/metric-anomalies/:anomalyId/feedback",
  applicationBackups: "/api/application-backups",
  applicationBackupPlan: "/api/application-backups/plans/:planId",
  applicationBackupRun: "/api/application-backups/plans/:planId/runs",
  applicationBackupPrepare: "/api/application-backups/plans/:planId/prepare-restore",
  applicationBackupRestore: "/api/application-backups/plans/:planId/restore",
  applicationBackupResume: "/api/application-backups/runs/:runId/resume",
  ...NOTIFICATION_DELIVERY_ROUTES,
  ...DIAGNOSTIC_ROUTES,
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  session: "/api/session",
  changePassword: "/api/auth/change-password",
  totpSetup: "/api/auth/totp/setup",
  totpConfirm: "/api/auth/totp/confirm",
  secondFactor: "/api/auth/second-factor",
  // The signed-in person's own account: name, authenticator, recovery codes and sessions.
  account: "/api/account",
  accountAuthenticator: "/api/account/authenticator",
  accountAuthenticatorConfirm: "/api/account/authenticator/confirm",
  accountRecoveryCodes: "/api/account/recovery-codes",
  accountViewPreferences: "/api/account/view-preferences",
  accountSavedViews: "/api/account/view-preferences/views",
  accountSavedView: "/api/account/view-preferences/views/:viewId",
  accountBoardArrangement: "/api/account/view-preferences/board",
  accountSession: "/api/account/sessions/:sessionId",
  accountOtherSessions: "/api/account/sessions/others",
  // The signed-in person's own passkeys: listed, added once a code says it is them, renamed, removed.
  accountPasskeys: "/api/account/passkeys",
  accountPasskeyOptions: "/api/account/passkeys/options",
  accountPasskey: "/api/account/passkeys/:passkeyId",
  // Signing in with a passkey alone: whether the sign-in page offers it, the browser's challenge, its answer.
  passkeyStatus: "/api/auth/passkeys",
  passkeySignInOptions: "/api/auth/passkeys/sign-in/options",
  passkeySignIn: "/api/auth/passkeys/sign-in",
  policyRehearsalContext: "/api/replays/policy/hosts/:hostId",
  policyRehearsal: "/api/replays/policy",
  search: "/api/search",
  topology: "/api/inventory/hosts/:hostId/topology",
  operationPreview: "/api/inventory/hosts/:hostId/containers/:containerName/impact",
  userGrants: "/api/users/:userId/grants",
  accountPermissions: "/api/account/permissions",
  users: "/api/users",
  user: "/api/users/:userId",
  userResetPassword: "/api/users/:userId/reset-password",
  userResetTotp: "/api/users/:userId/reset-totp",
  hosts: "/api/hosts",
  host: "/api/hosts/:hostId",
  hostRevoke: "/api/hosts/:hostId/revoke",
  // The runner on the dashboard's own machine, which joins through the volume both share: revoked or not.
  localHost: "/api/hosts/local",
  localHostReenroll: "/api/hosts/local/reenroll",
  // Hosts reached over SSH: the keys the control plane signs in with, adding a host, and each host's own.
  sshKeys: "/api/ssh-keys",
  sshKeysMake: "/api/ssh-keys/make",
  sshKey: "/api/ssh-keys/:keyId",
  sshHosts: "/api/hosts/ssh",
  sshHostConfirm: "/api/hosts/ssh/:pendingId/confirm",
  sshHost: "/api/hosts/:hostId/ssh",
  sshHostTrustHostKey: "/api/hosts/:hostId/ssh/trust-host-key",
  sshHostKey: "/api/hosts/:hostId/ssh/key",
  sshHostSettings: "/api/hosts/:hostId/ssh/settings",
  // The password Autoheal runs root commands with on the host, saved or removed; never read back.
  sshHostRoot: "/api/hosts/:hostId/ssh/root",
  // A runner host reached over SSH from now on, as the same host: dialled first, then confirmed as a new one is.
  sshHostSwitch: "/api/hosts/:hostId/ssh/switch",
  // Autoheal updating itself: how it stands (GET), and the update started (POST).
  selfUpdate: "/api/system/update",
  containers: "/api/inventory/containers",
  hostMetrics: "/api/inventory/hosts/:hostId/metrics",
  containerMetrics: "/api/inventory/hosts/:hostId/containers/:containerName/metrics",
  containerActions: "/api/inventory/hosts/:hostId/containers/:containerName/actions",
  // Actions on a whole host: checking every image for updates, removing unused ones, and its own packages.
  hostActions: "/api/inventory/hosts/:hostId/actions",
  hostBackupAsk: "/api/inventory/hosts/:hostId/backups/ask",
  hostBackupStart: "/api/inventory/hosts/:hostId/backups",
  hostBackupRestore: "/api/inventory/hosts/:hostId/backups/restore",
  containerBackupSettings: "/api/settings/container-backup",
  jarvis: "/api/settings/jarvis",
  jarvisConnect: "/api/settings/jarvis/connect",
  jarvisPause: "/api/settings/jarvis/pause",
  jarvisTest: "/api/settings/jarvis/test",
  // Home Assistant's own way in, on its own key.
  jarvisAliases: "/api/settings/jarvis/aliases",
  jarvisStatus: "/api/jarvis/status",
  jarvisSummary: "/api/jarvis/summary",
  jarvisMessages: "/api/jarvis/messages",
  jarvisHeard: "/api/jarvis/heard",
  // What Autoheal may do on its own on one host, and on each of its containers.
  maintenance: "/api/maintenance",
  hostMaintenance: "/api/inventory/hosts/:hostId/maintenance",
  maintenanceWindow: "/api/inventory/hosts/:hostId/maintenance/:maintenanceId",
  hostControl: "/api/inventory/hosts/:hostId/control",
  containerControls: "/api/inventory/hosts/:hostId/containers/control",
  // An admin clears a container's restarts this hour and Autoheal's wait on it.
  restartsReset: "/api/inventory/hosts/:hostId/containers/:containerName/restarts/reset",
  // Several containers' new images, one at a time: the rest wait if one does not come back healthy.
  containerUpdates: "/api/inventory/hosts/:hostId/containers/updates",
  // A Compose stack's containers restarted one at a time, those the others depend on first.
  stackRestart: "/api/inventory/hosts/:hostId/stacks/:stack/restart",
  // The host's latest stack restart, going or ended.
  stackRestarts: "/api/inventory/hosts/:hostId/stacks/restart",
  stackDrift: "/api/inventory/hosts/:hostId/stacks/drift",
  hostProbes: "/api/inventory/hosts/:hostId/probes",
  hostProbe: "/api/inventory/hosts/:hostId/probes/:probeId",
  // The images no container on a host uses, and the last removal of some of them.
  hostImages: "/api/inventory/hosts/:hostId/images",
  hostNetworks: "/api/inventory/hosts/:hostId/networks",
  hostVolumes: "/api/inventory/hosts/:hostId/volumes",
  hostVolumeLook: "/api/inventory/hosts/:hostId/volumes/look",
  hostStackAsk: "/api/inventory/hosts/:hostId/stacks/:project/files",
  hostChanges: "/api/inventory/hosts/:hostId/changes",
  // The host's packages: what its files say, its last check, who takes care of what, its package jobs.
  hostPackages: "/api/inventory/hosts/:hostId/packages",
  jobs: "/api/jobs",
  job: "/api/jobs/:jobId",
  tasks: "/api/tasks",
  task: "/api/tasks/:taskId",
  taskComments: "/api/tasks/:taskId/comments",
  taskBlockers: "/api/tasks/:taskId/blockers",
  taskBlocker: "/api/tasks/:taskId/blockers/:blockerId",
  // Who a task can be given to: active people, and Autoheal.
  assignees: "/api/assignees",
  ollama: "/api/ollama",
  widgetKeys: "/api/widget-keys",
  widgetKey: "/api/widget-keys/:keyId",
  // Read with a widget key instead of a session: counts only, for Homepage's custom API widget.
  widget: "/api/widget",
  metrics: "/api/metrics",
  homeAssistant: "/api/inventory/home-assistant",
  homeReview: "/api/inventory/home-assistant/review",
  homeReviewRescan: "/api/inventory/home-assistant/review/rescan",
  homeReviewFix: "/api/inventory/home-assistant/review/fix",
  homeReviewRoom: "/api/inventory/home-assistant/review/room",
  overview: "/api/overview",
  // Every open problem in the column of who has it now: noticed, Autoheal, needs you, done.
  board: "/api/board",
  incidents: "/api/incidents",
  incident: "/api/incidents/:incidentId",
  incidentApproval: "/api/incidents/:incidentId/approval",
  // Updates, a host's packages and escalated incidents a person hands to the Ollama agent.
  agentDispatch: "/api/agent/dispatch",
  // What changes as it changes: a host's containers, jobs, an update's progress.
  live: "/api/live",
  runbooks: "/api/runbooks",
  runbook: "/api/runbooks/:runbookId",
  runbookVersions: "/api/runbooks/:runbookId/versions",
  runbookPublish: "/api/runbooks/:runbookId/versions/:versionId/publish",
  runbookArchive: "/api/runbooks/:runbookId/archive",
  // Recurring escalations a runbook could answer, and the way to draft one and try it on them.
  runbookSuggestions: "/api/runbooks/suggestions",
  runbookSuggestionDraft: "/api/runbooks/suggestions/:key/draft",
  prompt: "/api/prompts/:promptHash",
  replays: "/api/replays",
  replay: "/api/replays/:replayId",
  audit: "/api/audit",
  settings: "/api/settings",
  // What the database holds, and how long it keeps each kind of record.
  dataHousekeeping: "/api/settings/data",
  // Notification channels and Home Assistant, set here unless the .env sets them.
  integrations: "/api/integrations",
  ollamaSettings: "/api/settings/ollama",
  ollamaSettingsModels: "/api/settings/ollama/models",
  ollamaServers: "/api/settings/ollama/servers",
  ollamaServer: "/api/settings/ollama/servers/:serverId",
  ollamaServerHosts: "/api/settings/ollama/servers/:serverId/hosts",
  ollamaReviewServer: "/api/settings/ollama/review-server",
  ollamaDefaultName: "/api/settings/ollama/default-name",
  ollamaRouterServer: "/api/settings/ollama/router-server",
  routerSettings: "/api/settings/router",
  routerProbe: "/api/settings/router/probe",
  routerCertificate: "/api/settings/router/certificate",
  routerContract: "/api/settings/router/contract",
  network: "/api/network",
  networkDevices: "/api/network/devices",
  networkDevice: "/api/network/devices/:mac",
  networkInternet: "/api/network/internet",
  networkInternetReport: "/api/network/internet/report",
  networkFirewall: "/api/network/firewall",
  networkFirewallConfirm: "/api/network/firewall/confirm",
  networkMap: "/api/network/map",
  networkSpeedTest: "/api/network/internet/speed-test",
  networkReports: "/api/network/reports",
  networkAsk: "/api/network/ask",
  integration: "/api/integrations/:kind",
  integrationTest: "/api/integrations/:kind/test",
  // Each host's nightly window, and whether Autoheal takes security fixes in it.
  hostUpdateSettings: "/api/settings/host-updates",
  trustedProxies: "/api/settings/trusted-proxies",
  // A shell in a container: opened here, then followed, typed into, resized and closed by its id.
  terminals: "/api/inventory/hosts/:hostId/containers/:containerName/terminals",
  hostTerminals: "/api/inventory/hosts/:hostId/terminals",
  terminal: "/api/terminals/:terminalId",
  terminalStream: "/api/terminals/:terminalId/stream",
  terminalInput: "/api/terminals/:terminalId/input",
  terminalResize: "/api/terminals/:terminalId/resize",
  // A container's files: list a folder, read, write, make a folder, rename, remove.
  containerFiles: "/api/inventory/hosts/:hostId/containers/:containerName/files",
  // Its settings: GET reads them through its runner, PUT applies changed ones by recreating it.
  containerSettings: "/api/inventory/hosts/:hostId/containers/:containerName/settings",
  containerNetwork: "/api/inventory/hosts/:hostId/containers/:containerName/networks",
  hostProfile: "/api/inventory/hosts/:hostId/profile",
  hostInstall: "/api/inventory/hosts/:hostId/install",
  hostInstallOwn: "/api/inventory/hosts/:hostId/install/own",
  hostInstallOwnCheck: "/api/inventory/hosts/:hostId/install/own/check",
  hostInstallDraft: "/api/inventory/hosts/:hostId/install/draft",
  hostInstallCheck: "/api/inventory/hosts/:hostId/install/check",
  hostInstallUndo: "/api/inventory/hosts/:hostId/install/undo",
  backups: "/api/backups",
  backupDownload: "/api/backups/:fileName/download",
  backupRestore: "/api/backups/:fileName/restore",
  restoreUpload: "/api/restores/upload",
  restore: "/api/restores/:restoreId",
  restoreConfirm: "/api/restores/:restoreId/confirm",
} as const;

// Query-string names the list endpoints accept.
export const CONTAINER_QUERY = { hostId: "hostId", problemsOnly: "problemsOnly", search: "search" } as const;
export const INCIDENT_QUERY = {
  hostId: "hostId",
  containerName: "containerName",
  status: "status",
  limit: "limit",
} as const;
// The audit log pages back from the last event seen: its time, and its id for events in the same millisecond.
export const AUDIT_QUERY = { limit: "limit", before: "before", beforeId: "beforeId" } as const;
export const TASK_QUERY = {
  status: "status",
  assignee: "assignee",
  priority: "priority",
  label: "label",
  hostId: "hostId",
  search: "search",
} as const;
// Shortcuts the task list understands besides a single status or a user's id.
export const TASK_FILTERS = { open: "open", closed: "closed", me: "me", unassigned: "unassigned" } as const;
export const JOB_QUERY = { hostId: "hostId", containerName: "containerName" } as const;

/** Fill a route template's :parameters, for the dashboard. */
export const apiPath = (template: string, parameters: Record<string, string>) =>
  template.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(parameters[name] ?? ""));

export const API_ERRORS = {
  invalidRequest: "invalid_request",
  notSignedIn: "not_signed_in",
  passwordChangeRequired: "password_change_required",
  secondFactorRequired: "second_factor_required",
  totpSetupRequired: "totp_setup_required",
  totpAlreadyEnabled: "totp_already_enabled",
  totpSetupNotStarted: "totp_setup_not_started",
  wrongCode: "wrong_code",
  codeAlreadyUsed: "code_already_used",
  clockDrift: "clock_drift",
  storedSecretUnreadable: "stored_secret_unreadable",
  userNotFound: "user_not_found",
  usernameTaken: "username_taken",
  lastAdmin: "last_admin",
  deactivateInstead: "deactivate_instead",
  anomalyNotFound: "anomaly_not_found",
  anomalyChanged: "anomaly_changed",
  rolloutUnavailable: "rollout_unavailable",
  rolloutNotFound: "rollout_not_found",
  rolloutBusy: "rollout_busy",
  rolloutGate: "rollout_gate",
  applicationBackupUnavailable: "application_backup_unavailable",
  applicationBackupBusy: "application_backup_busy",
  applicationBackupNotFound: "application_backup_not_found",
  applicationBackupInvalid: "application_backup_invalid",
  applicationBackupRecoveryRequired: "application_backup_recovery_required",
  topologyUnavailable: "topology_unavailable",
  topologyBusy: "topology_busy",
  topologyPreviewExpired: "topology_preview_expired",
  notificationQueueFull: "notification_queue_full",
  notificationDeliveryNotFound: "notification_delivery_not_found",
  resourceForbidden: "resource_forbidden",
  resourceRunnerRequired: "resource_runner_required",
  permissionConflict: "permission_conflict",
  diagnosticsFull: "diagnostics_full",
  diagnosticsExpired: "diagnostics_expired",
  maintenanceUnsupported: "maintenance_unsupported",
  maintenanceFull: "maintenance_full",
  installRetryRefused: "install_retry_refused",
  savedViewLimitReached: "saved_view_limit_reached",
  savedViewNotFound: "saved_view_not_found",
  rebootPlanBusy: "reboot_plan_busy",
  rebootPlanNotFound: "reboot_plan_not_found",
  rebootPlanUnavailable: "reboot_plan_unavailable",
  rebootPlanNotReady: "reboot_plan_not_ready",
  probeLimitReached: "probe_limit_reached",
  probeDestinationRefused: "probe_destination_refused",
  probeNotFound: "probe_not_found",
  maintenanceNotFound: "maintenance_not_found",
  maintenanceActive: "maintenance_active",
  hostNotFound: "host_not_found",
  hostLabelTaken: "host_label_taken",
  sshKeyUnreadable: "ssh_key_unreadable",
  sshKeyNotPrivate: "ssh_key_not_private",
  sshKeyUnsupported: "ssh_key_unsupported",
  sshKeyNotFound: "ssh_key_not_found",
  sshKeyInUse: "ssh_key_in_use",
  sshKeyNameTaken: "ssh_key_name_taken",
  sshHostRefusedKey: "ssh_host_refused_key",
  sshHostUnreachable: "ssh_host_unreachable",
  sshHostKeyMismatch: "ssh_host_key_mismatch",
  sshPendingNotFound: "ssh_pending_not_found",
  sshHostNotFound: "ssh_host_not_found",
  sshSwitchLocalHost: "ssh_switch_local_host",
  hostHasNoDocker: "host_has_no_docker",
  selfUpdateUnavailable: "self_update_unavailable",
  selfUpdateNewest: "self_update_newest",
  selfUpdateRunning: "self_update_running",
  sshRootPasswordRefused: "ssh_root_password_refused",
  sshHostNotConnected: "ssh_host_not_connected",
  hostRevoked: "host_revoked",
  // Only a revoked runner on the dashboard's own machine can be added again from the dashboard.
  notLocalRunner: "not_local_runner",
  unknownRunner: "unknown_runner",
  incidentNotFound: "incident_not_found",
  notAwaitingApproval: "not_awaiting_approval",
  invalidTarget: "invalid_target",
  workItemNotFound: "work_item_not_found",
  taskNotFound: "task_not_found",
  taskLoop: "task_loop",
  assigneeNotFound: "assignee_not_found",
  // Autoheal only takes work it can do: image updates, and freeing a full disk of unused images.
  agentCannotTake: "agent_cannot_take",
  // The Ollama agent takes updates, a host's packages and escalated incidents, on hosts out of dry-run.
  notDispatchable: "not_dispatchable",
  containerNotFound: "container_not_found",
  restartResetUnsupported: "restart_reset_unsupported",
  resultConflict: "result_conflict",
  jobNotFound: "job_not_found",
  jobUnavailable: "job_unavailable",
  handsOff: "hands_off",
  // Several containers updated one at a time: one run per host at once, and only images that wait.
  updateRunBusy: "update_run_busy",
  // A stack restarted one container at a time: one restart per host at once, of the containers Autoheal may change.
  stackRestartBusy: "stack_restart_busy",
  stackNotFound: "stack_not_found",
  backupKeyRefused: "backup_key_refused",
  noUpdate: "no_update",
  widgetKeyNotFound: "widget_key_not_found",
  sessionNotFound: "session_not_found",
  // The .env sets it, so the dashboard may not change it.
  integrationFromEnvironment: "integration_from_environment",
  // A new address needs its token again: a stored token never follows a changed address.
  integrationTokenRequired: "integration_token_required",
  integrationNotSet: "integration_not_set",
  jarvisNameTaken: "jarvis_name_taken",
  // The .env names the trusted proxies, so the dashboard may not change them.
  trustedProxiesFromEnvironment: "trusted_proxies_from_environment",
  // Not an address or a range, one too wide, or too many: a list Settings will not keep.
  trustedProxyInvalid: "trusted_proxy_invalid",
  // The host's .env does not let anyone reach inside its containers.
  containerAccessOff: "container_access_off",
  hostTerminalOff: "host_terminal_off",
  hostDeployOff: "host_deploy_off",
  // A shell needs the container running.
  containerNotRunning: "container_not_running",
  terminalNotFound: "terminal_not_found",
  // As many shells as a host takes at once are open there.
  terminalsFull: "terminals_full",
  // The host's runner did not answer a request for files or settings in time; or it answered one not asked of it.
  runnerNoAnswer: "runner_no_answer",
  runnerRequestNotFound: "runner_request_not_found",
  // An edit of the container is already on its way: one at a time.
  editBusy: "edit_busy",
  // Before an Ollama is saved: it must answer, have the model, the model must answer chats, and read that much.
  ollamaUnreachable: "ollama_unreachable",
  modelNotFound: "model_not_found",
  routerUnreachable: "router_unreachable",
  routerLoginRefused: "router_login_refused",
  routerCertificateChanged: "router_certificate_changed",
  routerCertificateUnconfirmed: "router_certificate_unconfirmed",
  networkDeviceNotFound: "network_device_not_found",
  ollamaServerNameTaken: "ollama_server_name_taken",
  ollamaServerNotFound: "ollama_server_not_found",
  modelCannotAnswer: "model_cannot_answer",
  contextTooLarge: "context_too_large",
  // Only the host's own .env can allow package jobs; the dashboard says so instead of sending them.
  hostPackagesNotAllowed: "host_packages_not_allowed",
  hostPackagesUnsupported: "host_packages_unsupported",
  hostPackagesBusy: "host_packages_busy",
  // An upgrade may name only what the host's last check offered.
  packagesNotOffered: "packages_not_offered",
  // A tick the host's .env, the container's label or the database rule fixes.
  controlLocked: "control_locked",
  // A removal may name only images the host's runner last reported unused.
  imageNotFound: "image_not_found",
  networkNotFound: "network_not_found",
  networkNameTaken: "network_name_taken",
  volumeNotFound: "volume_not_found",
  volumeNameTaken: "volume_name_taken",
  // Browsers keep passkeys to a site reached by name: not at an IP address.
  passkeysUnavailable: "passkeys_unavailable",
  // Signing in: a passkey this dashboard doesn't know, or an answer that didn't check out.
  passkeyRefused: "passkey_refused",
  // Adding one: the browser's answer didn't check out.
  passkeyNotAdded: "passkey_not_added",
  passkeyNotFound: "passkey_not_found",
  passkeyLimit: "passkey_limit",
  runbookNotFound: "runbook_not_found",
  runbookVersionNotFound: "runbook_version_not_found",
  runbookTooLong: "runbook_too_long",
  runbookPatternInvalid: "runbook_pattern_invalid",
  runbookArchived: "runbook_archived",
  runbookSuggestionNotFound: "runbook_suggestion_not_found",
  promptNotFound: "prompt_not_found",
  replayNotFound: "replay_not_found",
  backupNotFound: "backup_not_found",
  backupUnreadable: "backup_unreadable",
  notAutohealDatabase: "not_an_autoheal_database",
  backupTooNew: "backup_too_new",
  backupSecretsUnreadable: "backup_secrets_unreadable",
  restoreDrainBusy: "restore_drain_busy",
  restoreBusy: "restore_busy",
  restoreMaintenance: "restore_maintenance",
  restoreNotFound: "restore_not_found",
  payloadTooLarge: "payload_too_large",
  adminOnly: "admin_only",
  wrongCredentials: "wrong_credentials",
  tooManyAttempts: "too_many_attempts",
  wrongPassword: "wrong_password",
  samePassword: "same_password",
  passwordPolicy: "password_policy",
  csrfFailed: "csrf_failed",
  misdirectedRequest: "misdirected_request",
  notFound: "not_found",
  internalError: "internal_error",
} as const;
export type ApiErrorCode = (typeof API_ERRORS)[keyof typeof API_ERRORS];

export const CSRF_HEADER = "x-csrf-token";

export interface UserView {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  totpEnabled: boolean;
}

export interface SessionView {
  user: UserView;
  csrfToken: string;
  secondFactorDone: boolean;
}

export interface TotpSetupView {
  secret: string;
  otpauthUri: string;
}

export interface RecoveryCodesView {
  recoveryCodes: string[];
}

/** The end of a first sign-in: recovery codes, and the backup passphrase Autoheal made, once, for the first admin. */
export interface TotpEnabledView extends RecoveryCodesView {
  backupPassphrase: string | null;
}

export interface AccountSessionView {
  // Not the session's token, nor enough of its hash to find it: only enough to end it.
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
}

/** The signed-in person's own account, as the account page shows it. */
export interface OwnAccountView {
  username: string;
  role: Role;
  // The entry's name in the authenticator app, as it was set up.
  authenticatorName: string;
  recoveryCodesLeft: number;
  sessions: AccountSessionView[];
}

export interface AccountView extends UserView {
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface TemporaryPasswordView {
  temporaryPassword: string;
}

export interface CreatedAccountView extends TemporaryPasswordView {
  account: AccountView;
}

export interface DiskUsageView {
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface HostHealthView {
  cpuCount: number;
  loadAverage: number[];
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  uptimeSeconds: number;
  disks: DiskUsageView[];
  rebootRequired: boolean | null;
  pendingUpdates: number | null;
  operatingSystem: string | null;
  kernel: string;
  // Absent from runners older than these.
  bootId?: string | null;
  packages?: PackageFacts | null;
  hostname?: string | null;
  architecture?: string;
  cpuModel?: string | null;
  processes?: number | null;
  driveTemperatures?: { device: string; celsius: number; maximumCelsius?: number | null }[];
  drives?: DriveHealth[];
  dockerVersion?: string | null;
  imageStore?: string | null;
  address?: string | null;
  gpuNotGiven?: boolean;
  cpuTemperatures?: { label: string; celsius: number }[];
}

// Live stats as sampled by a runner, stamped with when they arrived. Histories run oldest first.
export type HostMetricsView = HostMetrics & { at: number };
export type ContainerUsageView = Omit<ContainerUsage, "name"> & { at: number };

export interface ContainerUpdateView {
  // Null until its runner has checked.
  status: UpdateStatus | null;
  checkedAt: number | null;
  policy: UpdatePolicy;
  // What the newer image says it is; null until its runner has read it, and with no update.
  remote: ImageLabels | null;
  // Why its runner's last check failed; null when it did not.
  reason: string | null;
}

/** An SSH host's session: where it is, since when, and why when it is not connected. */
export interface SshConnectionView {
  state: SshState;
  since: number;
  reason: string | null;
}

/** A reboot or a shutdown, as the dashboard follows it. */
export interface HostPowerView {
  action: PowerAction;
  jobId: string;
  phase: PowerPhase;
  requestedAt: number;
  requestedBy: string;
  // When the host was last heard from: its last report, or its live stats.
  lastSeenAt: number | null;
  // When it finished: back up, off, or refused.
  finishedAt: number | null;
  // What the host said, for a refusal.
  outcome: string | null;
}

/** How an update of Autoheal itself went, as its helper writes it into the data volume. */
export interface SelfUpdateOutcome {
  status: SelfUpdateStatus;
  // The image ids it went from and to, and the name the new one was asked for by.
  from: string;
  to: string;
  reference: string;
  startedAt: number;
  finishedAt: number | null;
  message: string;
}

export interface SelfUpdateView {
  // Null when Autoheal can update itself here; otherwise why not.
  unavailable: string | null;
  // The image the control plane runs, and the one an update would run: AUTOHEAL_IMAGE.
  runningImage: string | null;
  reference: string;
  last: SelfUpdateOutcome | null;
}

/** An active SSH host's session, as the self-test command reports it: its name, and null before a session opened. */
export interface SshSessionReport {
  label: string;
  session: SshConnectionView | null;
}

export interface HostView {
  id: string;
  label: string;
  // Absent from views made before hosts could be reached over SSH.
  kind?: HostKind;
  // Null for a runner host, and for an SSH host whose session the control plane has not opened.
  ssh?: SshConnectionView | null;
  // A reboot or a shutdown a person asked for, while it is followed: absent otherwise.
  power?: HostPowerView;
  // The control plane's own machine, looked after in place: why its runner has not started, or null once it has.
  // Absent for other hosts.
  inPlace?: { problem: string | null };
  // False for an SSH host without Docker: its system is watched, it has no containers. Absent from older views.
  docker?: boolean;
  state: HostState;
  tokenHint: string;
  enrolledAt: number;
  lastHeartbeatAt: number | null;
  runnerVersion: string | null;
  dryRun: boolean | null;
  eventStreamConnected: boolean;
  protectedContainers: string[];
  restartBudget: Record<string, number>;
  // Why its runner restarts nothing on its own just now; null or absent while it may.
  recoveryHold?: RecoveryHold | null;
  // When each container's used-up restarts free again and its wait ends; null from a runner before it, which
  // takes no reset.
  restartWait?: Record<string, RestartWait> | null;
  // When an admin reset each container's restarts, within the hour.
  restartResets?: Record<string, number>;
  // Whether its .env lets a person open shells, browse files and edit containers; null until its runner says.
  containerAccess: boolean | null;
  // Whether its .env lets an admin open a shell on the host itself; null or absent from a runner that cannot.
  hostTerminal?: boolean | null;
  hostDeploy?: boolean | null;
  // From the runner's latest report; null until it has sent one.
  health: HostHealthView | null;
  // The latest live stats; null when none arrived lately.
  metrics: HostMetricsView | null;
  containerCount: number;
  runningCount: number;
  problemCount: number;
}

export interface ContainerView {
  recovery?: { owner: string };
  hostId: string;
  hostLabel: string;
  // A silent host's containers are as they were at its last report.
  hostState: HostView["state"];
  name: string;
  containerId: string;
  image: string;
  state: ContainerStateName;
  health: ContainerHealthName;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  oomKilled: boolean;
  restartCount: number;
  restartPolicy: string;
  composeProject: string | null;
  composeService: string | null;
  // Its web interface, from a homepage.href label.
  link: string | null;
  // The version its image's labels name; null when they name none.
  version: string | null;
  // What it publishes on its host; null from a runner from before ports were reported.
  ports: PublishedPort[] | null;
  // On the host's own network it publishes nothing: it uses the host's ports as they are.
  hostNetwork: boolean;
  // Whether a newer image waits behind its tag, and who may update it.
  update: ContainerUpdateView;
  // The latest live stats while it runs; null otherwise.
  usage: ContainerUsageView | null;
  // What its host's page lets Autoheal do to it without asking a person first.
  byItself: ContainerControlView;
  protected: boolean;
  // Why its host's runner won't let Autoheal restart, stop or update it; null when it will.
  handsOff: HandsOff | null;
  problem: ContainerProblem | null;
}

/** What Autoheal may do to a container on its own; a lock says why a tick can't change. */
export interface ContainerControlView {
  restart: RestartChoice;
  update: UpdateChoice;
  restartLock: ControlLock | null;
  updateLock: ControlLock | null;
}

/** What a host's page lets Autoheal do there on its own, besides each container's own choices. */
export interface HostControlView {
  hostId: string;
  restartDefault: RestartChoice;
  updateDefault: UpdateChoice;
  imageCleanup: ImageCleanup;
  clearBuildCache: boolean;
  clearLeftNetworks: boolean;
  // When the next clean-up starts, in the host's nightly window; null when none is coming (off, or the
  // host only watches).
  nextCleanupAt: number | null;
  // The host's own time zone, so that time shows as the host's clock does.
  timeZone: string;
  lastCleanup: JobView | null;
}

export interface HostControlChange {
  restartDefault?: RestartChoice;
  updateDefault?: UpdateChoice;
  imageCleanup?: ImageCleanup;
  clearBuildCache?: boolean;
  clearLeftNetworks?: boolean;
}

/** Whether passkeys work here, and whether the sign-in page offers one. */
export interface PasskeyStatusView {
  // False while the dashboard is reached at an IP address: browsers keep passkeys to names.
  usable: boolean;
  // Someone has a passkey for this address.
  offered: boolean;
}

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  // Kept by a password manager that syncs it between devices, rather than on one device only.
  synced: boolean;
  // Made for the address the dashboard had before: browsers won't offer it here.
  otherAddress: string | null;
}

/** One thing that changed on a host between two of its runner's reports. */
export interface HostChangeView {
  id: number;
  at: number;
  kind: HostChangeKind;
  // Null for the host's own changes: a reboot, Docker or its kernel.
  containerName: string | null;
  details: HostChangeDetails;
}

// One container's story, newest first. Each entry carries the view its own list shows: an incident, a job, what its
// host's reports saw change, a step on one of its tasks, or an alert about either.
export const TIMELINE_ENTRY = {
  incident: "incident",
  job: "job",
  change: "change",
  task: "task",
  notification: "notification",
} as const;
/** What a container used and how it ran out: a memory limit with room, and its OOM kills. */
export interface ResourceAdviceView {
  // Null until a day of its memory readings is in.
  memory: { percentileBytes: number; suggestedBytes: number; buckets: number } | null;
  // Its memory limit as last read: null for none, absent when no reading came lately.
  limitBytes?: number | null;
  // Times it ran out of memory within the window.
  oomKills: number;
}

export interface TimelineTaskView {
  id: string;
  number: number;
  title: string;
}
export type ContainerTimelineEntry =
  | { kind: typeof TIMELINE_ENTRY.incident; at: number; incident: IncidentSummaryView }
  | { kind: typeof TIMELINE_ENTRY.job; at: number; job: JobView }
  | { kind: typeof TIMELINE_ENTRY.change; at: number; change: HostChangeView }
  | { kind: typeof TIMELINE_ENTRY.task; at: number; task: TimelineTaskView; activity: TaskActivityView }
  | { kind: typeof TIMELINE_ENTRY.notification; at: number; notification: NotificationEventView };

/** The images no container on a host uses, to remove one by one, the ticked ones, or all at once. */
export interface HostImagesView {
  // Null until the host's runner reports them: runners from before this don't.
  images: UnusedImage[] | null;
  lastRemoval: JobView | null;
}

/** The host's Docker networks, and the latest change made to them. */
export interface HostNetworksView {
  // Null until the host's runner reports them: runners from before this don't.
  networks: NetworkReport[] | null;
  lastJob: JobView | null;
}

/** The host's Docker volumes, and the latest change made to them. */
export interface HostVolumesView {
  // Null until the host's runner reports them: runners from before this don't.
  volumes: VolumeReport[] | null;
  lastJob: JobView | null;
}

/** One tick for several containers at once: one container's, a stack's, or every one's. */
export interface ContainerControlChange {
  names: string[];
  restart?: RestartChoice;
  update?: UpdateChoice;
}

/** New images for several containers on one host, in this order. */
export interface ContainerUpdatesRequest {
  names: string[];
}

/** A host's run of updates: what is done, what is updating now, and what waits after one went wrong. */
export interface UpdateRunView {
  id: string;
  hostId: string;
  // In the order they are applied.
  names: string[];
  status: UpdateRunStatus;
  current: string | null;
  done: string[];
  // The one that did not come back healthy; the ones after it wait.
  failed: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StackRestartView {
  hostId: string;
  stack: string;
  // In the order they restart: the ones the others depend on first.
  names: string[];
  status: UpdateRunStatus;
  current: string | null;
  done: string[];
  // The one whose restart failed or could not be asked for, and why; the ones after it are left as they were.
  failed: string | null;
  outcome: string | null;
  refusal: ApiErrorCode | null;
}

/**
 * What a person hands to the Ollama agent on Attention: container updates by their tasks, packages by their host,
 * escalated incidents. The agent applies them whatever held them for a person; the host's .env still decides.
 */
export interface AgentDispatchRequest {
  updates: string[];
  packages: { hostId: string; names: string[] }[];
  incidents: string[];
}

/** How many of each the agent took. */
export interface AgentDispatchView {
  updates: number;
  packages: number;
  incidents: number;
}

/** A newer image waits behind its tag, and its label lets someone update it. */
export const hasUpdate = (container: ContainerView) =>
  container.update.status === UPDATE_STATUS.available && container.update.policy !== UPDATE_POLICY.off;

export interface UpdateVersions {
  from: string;
  to: string;
}

/**
 * The version a container runs and the one its update brings, when both images name theirs and they differ.
 * ponytail: a version label a base image left behind (ollama/ollama's 24.04 is Ubuntu's) reads as the app's;
 * equal on both sides, as it usually is, it says nothing and is left out.
 */
/**
 * A container given to Ollama, its failures or its new images: repaired once a restart does not hold, or each new
 * image applied; either way, an update that does not come back healthy is undone at once.
 */
export const givenToOllama = (container: ContainerView) =>
  container.byItself.restart === RESTART_CHOICE.repair || container.byItself.update === UPDATE_CHOICE.always;

export function updateVersions(container: ContainerView): UpdateVersions | null {
  const from = container.version;
  const to = container.update.remote?.version ?? null;
  return from === null || to === null || from === to ? null : { from, to };
}

/**
 * The work Autoheal takes on its own: an image update for one container, and a full disk, which it frees of
 * the images no container uses (never one kept for rolling back). Only the disk detector names a disk.
 */
export const autohealCanTake = (labels: readonly string[], resourceKind: string | null | undefined) =>
  (labels.includes(TASK_LABEL.update) && resourceKind === TASK_RESOURCE.container) ||
  resourceKind === TASK_RESOURCE.disk;

export interface ZigbeeDeviceView {
  id: string;
  name: string;
  area: string | null;
  manufacturer: string | null;
  model: string | null;
  role: ZigbeeRole;
  // Null when none of its entities reports a state.
  available: boolean | null;
  batteryPercent: number | null;
  linkQuality: number | null;
  lastSeen: number | null;
  problems: ZigbeeProblem[];
}

/** A smoke, gas, CO or heat alarm, and what its own sensors say about it. */
export interface SafetyDeviceView {
  id: string;
  name: string;
  area: string | null;
  model: string | null;
  available: boolean | null;
  alarm: boolean;
  online: boolean | null;
  batteryLow: boolean | null;
  fault: boolean | null;
  problems: SafetyProblem[];
}

export interface WatchedProblemView {
  entity: string;
  problem: WatchedProblem;
}

/** A device of a system Home Assistant already watches, e.g. a UniFi switch or an uptime check. */
export interface WatchedDeviceView {
  id: string;
  name: string;
  integration: string;
  area: string | null;
  available: boolean | null;
  problems: WatchedProblemView[];
  updatesAvailable: number;
}

/** An update waiting for software on Home Assistant's own box, as its update entity names it. */
export interface HomeAssistantUpdateView {
  title: string;
  installed: string | null;
  latest: string | null;
  // Where the update says what changed; only http and https links.
  releaseUrl: string | null;
}

/**
 * Home Assistant's own box, as its System Monitor and its Supervisor report it. Each figure is null when the sensor
 * for it is off, or missing: System Monitor ships some off, its network ones among them.
 */
export interface HomeAssistantSystemView {
  // System Monitor reports here at all: without it, only versions and updates are known.
  monitored: boolean;
  cpuPercent: number | null;
  temperatureCelsius: number | null;
  // Over 1, 5 and 15 minutes.
  loadAverage: [number, number, number] | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  // How much is used of how much, when System Monitor's "use" sensors are on.
  memory: { usedBytes: number; totalBytes: number } | null;
  disk: { usedBytes: number; totalBytes: number } | null;
  // The box's own network cards together; the first one's name.
  network: { name: string; receiveBytesPerSecond: number; transmitBytesPerSecond: number } | null;
  // Its network sensors are there, but off in System Monitor, as it ships them.
  networkOff: boolean;
  bootedAt: number | null;
  // When System Monitor last said anything.
  reportedAt: number | null;
  operatingSystem: string | null;
  supervisor: string | null;
  updates: HomeAssistantUpdateView[];
}

/** Nothing known of the box: Home Assistant is not set up, or reports none of it. */
export const UNKNOWN_HOME_ASSISTANT_SYSTEM: HomeAssistantSystemView = {
  monitored: false,
  cpuPercent: null,
  temperatureCelsius: null,
  loadAverage: null,
  memoryPercent: null,
  diskPercent: null,
  memory: null,
  disk: null,
  network: null,
  networkOff: false,
  bootedAt: null,
  reportedAt: null,
  operatingSystem: null,
  supervisor: null,
  updates: [],
};

export interface HomeAssistantView {
  status: {
    configured: boolean;
    connected: boolean;
    version: string | null;
    error: string | null;
    connectedSince: number | null;
  };
  system: HomeAssistantSystemView;
  zigbee: ZigbeeDeviceView[];
  safety: SafetyDeviceView[];
  watched: WatchedDeviceView[];
  entities: number;
  unavailableEntities: number;
}

export interface HomeAssistantSummaryView {
  connected: boolean;
  version: string | null;
  // Its own box, for the card beside the hosts on Fleet.
  system: HomeAssistantSystemView;
  entities: number;
  unavailableEntities: number;
  zigbee: { total: number; unavailable: number; lowBattery: number; weakLink: number };
  safety: { total: number; problems: number };
  watched: { total: number; problems: number };
}

export interface OverviewView {
  hosts: { total: number; online: number; silent: number; neverSeen: number };
  containers: { total: number; running: number; stopped: number; problems: number; updates: number };
  tasks: { open: number; byPriority: Record<TaskPriority, number>; mine: number };
  // Null when Home Assistant is not configured.
  homeAssistant: HomeAssistantSummaryView | null;
}

/** The runner on the dashboard's own machine, as the join volume names it; no host when there is none. */
export interface LocalHostView {
  hostId: string | null;
  revoked: boolean;
}

/** A stored SSH key: which one it is and where it is used, never its private half. */
export interface SshKeyView {
  id: string;
  name: string;
  publicLine: string;
  fingerprint: string;
  madeByAutoheal: boolean;
  createdBy: string;
  createdAt: number;
  // The labels of the hosts that use it.
  hosts: string[];
}

/** A key Autoheal made: its private half, given this once to download, and never again. */
export interface MadeSshKeyView {
  key: SshKeyView;
  privateKey: string;
}

/** What the host's user found when the host was added: Docker's socket, and whether it may use it. */
export interface SshDockerReadiness {
  socket: boolean;
  usable: boolean;
}

/** A host reached and its key accepted, waiting for a person to compare and trust its host key. */
export interface PendingSshHostView {
  pendingId: string;
  label: string;
  hostKeyFingerprint: string;
  expiresAt: number;
  // Without it the host is added all the same, its system watched alone.
  docker: SshDockerReadiness;
}

/** An SSH host as its page shows it to an admin: where and as whom, with which key, and its settings. */
export interface SshHostDetailsView {
  address: string;
  port: number;
  user: string;
  keyId: string;
  keyName: string;
  hostKeyFingerprint: string;
  // The key the host offers now, when it is not the trusted one; null otherwise.
  offeredHostKeyFingerprint: string | null;
  settings: SshHostSettings;
  // How a saved root password is used; null while none is saved. The password itself is never sent back.
  rootMethod: RootMethod | null;
}

export interface EnrolledHostView {
  host: HostView;
  // Shown once: it holds the runner's token, of which only a hash is stored.
  joinCode: string;
  // Null unless the host is a NAS that cannot download the image: what makes the file to copy to it first.
  imageCopyCommand: string | null;
  // What to paste on the new host: its compose file, its .env with the join code, and the start.
  installCommand: string;
}

export interface IncidentSummaryView {
  id: string;
  hostId: string;
  hostLabel: string;
  containerName: string;
  image: string;
  trigger: Trigger;
  status: string;
  decidedBy: string | null;
  action: AllowedAction | null;
  target: string | null;
  verdict: string | null;
  detectedAt: number;
  updatedAt: number;
}

export interface TraceEventView {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface IncidentDetailView extends IncidentSummaryView {
  diagnosis: string | null;
  outcome: string | null;
  promptHash: string | null;
  modelName: string | null;
  modelDigest: string | null;
  // What the model thought before it answered, when it is one that thinks: shown apart from the trace.
  reasoning: string | null;
  report: {
    stateSummary: string;
    healthOutputs: string[];
    knownContainers: string[];
    protectedContainers: string[];
    logs: string;
    // Its compose project, and the others in it as Docker showed them; none from runners from before them.
    composeProject: string | null;
    neighbours: { name: string; status: string; logs: string | null }[];
  } | null;
  trace: TraceEventView[];
  approvals: ApprovalView[];
  // The same container's incidents on this host before this one, from the month before, newest first.
  earlier: IncidentSummaryView[];
  // What the prompt carried besides the report, as the model read it.
  evidence: string[];
  // The failed container's usage in the half hour before it was decided, at most 60 readings.
  usage: ContainerUsageView[];
}

export interface ApprovalView {
  id: string;
  choice: ApprovalChoice;
  target: string | null;
  note: string | null;
  decidedBy: string;
  decidedAt: number;
}

export interface RunbookVersionView {
  id: string;
  version: number;
  body: string;
  contentHash: string;
  createdBy: string;
  createdAt: number;
  publishedAt: number | null;
}

export interface RunbookView {
  id: string;
  scope: RunbookScope;
  pattern: string | null;
  title: string;
  archived: boolean;
  createdAt: number;
  // The version decisions use: the most recently published one.
  publishedVersion: number | null;
  versions: RunbookVersionView[];
}

export interface PromptSnapshotView {
  hash: string;
  systemPrompt: string;
  createdAt: number;
}

export interface RunbookSuggestionView {
  // Its host, container, trigger and fix, hashed: the same case keeps its key.
  key: string;
  hostId: string;
  hostLabel: string;
  containerName: string;
  trigger: Trigger;
  // The fix a person approved each time, and the container it restarted.
  action: string;
  target: string;
  // The escalations behind it, newest first.
  incidents: { id: string; detectedAt: number }[];
  title: string;
  // Its draft once made, and the latest replay of that draft: how many of its decisions came out as the fix.
  runbookId: string | null;
  replay: { id: string; status: ReplayStatus; matched: number; incidents: number } | null;
}

export interface ReplayResultView {
  incidentId: string;
  containerName: string;
  originalAction: string | null;
  originalTarget: string | null;
  replayAction: string | null;
  replayTarget: string | null;
  replayDiagnosis: string | null;
  changed: boolean;
  error: string | null;
}

export interface ReplayRunView {
  id: string;
  status: ReplayStatus;
  createdBy: string;
  createdAt: number;
  finishedAt: number | null;
  modelName: string;
  modelDigest: string | null;
  draftVersionIds: string[];
  incidentCount: number;
  changedCount: number;
  results: ReplayResultView[];
}

export interface AuditEventView {
  id: string;
  occurredAt: number;
  actorKind: ActorKind;
  actorLabel: string;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
}

/** The effective configuration, for reading; secrets are reduced to where they come from. */
// The kinds of record the retention sweep removes once old enough, and the audit log, which it keeps whole.
export const DATA_KIND = {
  runnerResults: "runnerResults",
  updateRuns: "updateRuns",
  jobs: "jobs",
  replayRuns: "replayRuns",
  tasks: "tasks",
  incidents: "incidents",
  applicationBackupArtifacts: "applicationBackupArtifacts",
  applicationBackupRuns: "applicationBackupRuns",
  auditEvents: "auditEvents",
} as const;
export type DataKind = (typeof DATA_KIND)[keyof typeof DATA_KIND];

export interface DataKindView {
  kind: DataKind;
  rows: number;
  // How long a finished one is kept; null for one kept whole.
  keptMilliseconds: number | null;
}

export interface DataView {
  // The database file's size, in bytes.
  bytes: number;
  kinds: DataKindView[];
  // The latest sweep since the control plane started, and how many records it removed; null before its first.
  lastSweep: { at: number; removed: number } | null;
}

export interface SettingsView {
  // Admin-only repair notice: known setting keys, never stored values or parser diagnostics.
  invalidSettings?: SettingKey[];
  version: string;
  publicBaseUrl: string;
  trustedProxies: TrustedProxiesView;
  offboxBackupsConfigured: boolean;
  // Whether Autoheal made its certificate, or the .env names the operator's own.
  certificate: SecretSource;
  // Whether Autoheal made the backup passphrase, or the .env sets it.
  backupPassphrase: SecretSource;
  // Where "Add a host" points new runners, unless changed there.
  runnerAddress: string;
}

/**
 * The proxies whose word on a request's client is taken, and how the request asking reached the dashboard:
 * from which address, for whom a proxy says it forwards it, and the client Autoheal takes it to be.
 */
export interface TrustedProxiesView {
  // The .env (then fixed here), the dashboard, or none.
  source: IntegrationSource | null;
  addresses: string[];
  peer: string;
  forwardedFor: string | null;
  seenAs: string;
}

/** A shell just opened: what to follow and type into. */
export interface TerminalView {
  id: string;
  // A shell on the host: whom it runs as there.
  user?: string;
}

export interface TrustedProxiesRequest {
  addresses: string[];
}

/** Last observed request result for the current notification configuration; never device receipt. */
export interface NotificationDeliveryView {
  status: "unknown" | "healthy" | "degraded";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  failureCode: "refused" | "timeout" | "unreachable" | null;
}

/** A notification channel or Home Assistant: where it is, never its token. */
export interface IntegrationView {
  delivery?: NotificationDeliveryView;
  kind: IntegrationKind;
  // The .env (then fixed here), the dashboard, or not set up.
  source: IntegrationSource | null;
  // A webhook's address up to its host only: the rest is its key.
  url: string | null;
  // ntfy's topic; null for the others.
  topic: string | null;
  // A webhook's message shape; null for the others.
  format: WebhookFormat | null;
  tokenSet: boolean;
  plainHttp: boolean;
}

/** What "Send a test" found: null when the channel took the message. */
export interface IntegrationTestView {
  delivery?: NotificationDeliveryView;
  problem: string | null;
}

export interface BackupView {
  fileName: string;
  createdAt: number;
  createdBy: string;
  origin: BackupOrigin;
  schemaVersion: number;
  appVersion: string;
  sha256: string;
  sizeBytes: number;
  integrityCheck: string;
  offboxCopied: boolean;
}

/** What a restore would bring back, shown before anything changes. */
export interface RestorePreviewView {
  restoreId: string;
  // The command line restores without the dashboard, so it never shows here.
  source: Exclude<RestoreSource, typeof RESTORE_SOURCE.commandLine>;
  fileName: string | null;
  schemaVersion: number;
  dataAsOf: number | null;
  counts: { users: number; hosts: number; incidents: number; runbooks: number };
  usersReactivated: string[];
  usersAdded: string[];
  hostsRestored: string[];
  expiresAt: number;
}

export interface RestoreResultView {
  safetyBackup: string;
  cancelledIncidents: number;
}

// --- tasks -----------------------------------------------------------------------------------------

export type AssigneeView = { kind: "user"; id: string; name: string } | { kind: "agent"; id: AgentKey; name: string };
export type AssigneeChoice = { kind: "user"; id: string } | { kind: "agent"; id: AgentKey };

export interface TaskResourceView {
  kind: TaskResourceKind;
  // A container's name, a device's or entity's id, a disk's path.
  id: string;
  label: string;
}

export interface TaskSummaryView {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;
  assignee: AssigneeView | null;
  labels: string[];
  hostId: string | null;
  hostLabel: string | null;
  resource: TaskResourceView | null;
  parentId: string | null;
  // How many times its detector saw the problem start.
  occurrences: number;
  // Autoheal is working on it right now.
  checkedOut: boolean;
  // On an image update: Ollama's latest word, apply or hold; null until asked, and on other tasks.
  advice: UpdateAssessment | null;
  // Put off by a person until then: it waits among what was noticed. Null when it is not, or no longer.
  snoozedUntil: number | null;
  // The incident that opened it, or the newest one that joined it.
  incidentId: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  closedAt: number | null;
}

export interface TaskCommentView {
  id: string;
  author: string;
  // Comments from Autoheal itself, not a person.
  fromAgent: boolean;
  body: string;
  createdAt: number;
}

export interface TaskActivityView {
  id: number;
  kind: TaskActivityKind;
  actor: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface JobView {
  id: string;
  hostId: string;
  hostLabel: string;
  containerName: string;
  action: JobAction;
  status: JobStatus;
  requestedBy: string;
  taskId: string | null;
  createdAt: number;
  completedAt: number | null;
  outcome: string | null;
  // Logs, for a logs job; masked by the runner.
  output: string | null;
  // The packages an upgrade upgrades; empty for every other job.
  packages: string[];
  // The safety copy this restore made, which Undo goes back to; null for every other job and for older results.
  recoveryBackupId: string | null;
  // An update or a recreate on its way: what it is doing now, the new image's layers as they come.
  progress: UpdateProgress | null;
}

export interface TaskDetailView extends TaskSummaryView {
  description: string;
  createdBy: string;
  comments: TaskCommentView[];
  activity: TaskActivityView[];
  subtasks: TaskSummaryView[];
  // Tasks that must be done before this one, and the ones this one holds up.
  blockedBy: TaskSummaryView[];
  blocking: TaskSummaryView[];
  jobs: JobView[];
  // The container it is about, as its runner last reported it.
  container: ContainerView | null;
}

export interface TaskCreateRequest {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignee?: AssigneeChoice | null;
  labels?: string[];
  parentId?: string | null;
}

export interface TaskChangeRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: AssigneeChoice | null;
  labels?: string[];
  parentId?: string | null;
  // A day from now, or awake again at once.
  snoozed?: boolean;
}

export interface AssignableView {
  users: { id: string; name: string }[];
  agents: { id: AgentKey; name: string }[];
}

// --- Ollama ----------------------------------------------------------------------------------------

export interface OllamaStatusView {
  reachable: boolean;
  checkedAt: number | null;
  error: string | null;
  version: string | null;
  model: string;
  // Null until the first check.
  modelPresent: boolean | null;
  // What the model says of itself; null until Ollama has said.
  facts: OllamaModelFacts | null;
  models: { name: string; sizeBytes: number; parameterSize: string | null; quantization: string | null }[];
  loaded: { name: string; sizeBytes: number; videoMemoryBytes: number; expiresAt: number | null }[];
}

/** A server beside the default: what it runs, whether it answers, and the hosts it watches. */
export interface OllamaServerView {
  id: string;
  name: string;
  url: string;
  model: string;
  contextTokens: number;
  plainHttp: boolean;
  status: OllamaStatusView;
  hostIds: string[];
}

export interface OllamaServersView {
  extras: OllamaServerView[];
  // The server that reads Home Assistant's files; null is the default.
  reviewServerId: string | null;
  // What a person calls the default server; null until they do.
  defaultName: string | null;
  // The server that reads the network; null is the default.
  routerServerId: string | null;
}

/** A model on an Ollama server, and whether that server holds it in memory now. */
export interface OllamaServerModel {
  name: string;
  sizeBytes: number;
  parameterSize: string | null;
  quantization: string | null;
  loaded: boolean;
}

/** What a model says of itself: whether it can answer chats, whether it thinks first, and how much it reads. */
export interface OllamaModelFacts {
  answers: boolean;
  thinks: boolean;
  // Null when the model does not say.
  contextLength: number | null;
}

/** The Ollama Autoheal asks: the .env's, unless an admin chose another in Settings. */
export interface OllamaSettingsView {
  source: IntegrationSource;
  url: string;
  model: string;
  contextTokens: number;
  // Reached over plain http: the redacted logs sent to it can be read on the way.
  plainHttp: boolean;
  fromEnvironment: { url: string; model: string; contextTokens: number };
}

// --- the Homepage widget ---------------------------------------------------------------------------

export interface WidgetKeyView {
  id: string;
  name: string;
  // What it reads: Homepage's counts, or the metrics.
  scope: AnyKeyScope;
  hint: string;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreatedWidgetKeyView {
  key: WidgetKeyView;
  // Shown once; only its hash is stored.
  secret: string;
}

// Counts only: a leaked widget key tells nothing about what runs where.
export interface WidgetView {
  hostsOnline: number;
  hostsTotal: number;
  containersRunning: number;
  containersTotal: number;
  containerProblems: number;
  updatesAvailable: number;
  openTasks: number;
  urgentTasks: number;
  needsYou: number;
}

// One card on the board: an incident, or a task. A task its own incident already shows is left out.
export type BoardCardView =
  | { kind: typeof BOARD_CARD.incident; incident: IncidentSummaryView }
  | { kind: typeof BOARD_CARD.task; task: TaskSummaryView };

/** Every open problem in the column of who has it now, and what was settled in the last day. */
export interface BoardView {
  needsYou: BoardCardView[];
  autoheal: BoardCardView[];
  noticed: BoardCardView[];
  done: BoardCardView[];
}

/** One package an upgrade would change, sorted by the rules. */
export interface AssessedPackageView {
  name: string;
  installed: string;
  candidate: string;
  security: boolean;
  kind: PackageKind;
  held: boolean;
  // What it is, in a line; null from a runner from before it.
  summary: string | null;
  // Where the new version comes from: the distribution's suite (noble-security), another repository's
  // label, or dnf's repository id.
  source: string | null;
}

/** A package nothing needs any more, which the package manager would remove. */
export interface RemovablePackageView {
  name: string;
  installed: string;
}

/** How long a host's release gets security fixes, by endoflife.date; days as "2028-06-30". */
export interface LifecycleView {
  // "Debian 12", "Proxmox VE 8".
  release: string;
  status: LifecycleStatus;
  // Null when no date was announced yet.
  securityUntil: string | null;
  extendedUntil: string | null;
}

export interface HostUpdateSettingsView {
  securityInWindow: boolean;
  // "03:00", in each host's own time zone.
  windowStart: string;
  windowEnd: string;
}

/** Everything about a host's own packages, for its page and its tasks. */
export interface HostPackagesView {
  hostId: string;
  // What the host's files say; null until its runner reports them.
  facts: PackageFacts | null;
  // The host, or dnf since it last booted, says a reboot is needed, with or without naming packages.
  rebootRequired: boolean;
  // Null when endoflife.date does not know the host's release.
  lifecycle: LifecycleView | null;
  // The last check; null before the first.
  checkedAt: number | null;
  refreshed: boolean | null;
  refreshProblem: string | null;
  needsRepair: boolean;
  packages: AssessedPackageView[];
  keptBack: AssessedPackageView[];
  // Old kernels, and what only they needed.
  removable: RemovablePackageView[];
  automatic: string[];
  unattended: string[];
  forPerson: string[];
  // A package job on its way or running; the recent ones, newest first.
  running: JobView | null;
  recent: JobView[];
  window: HostUpdateSettingsView;
}
