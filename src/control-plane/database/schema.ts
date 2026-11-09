import { JARVIS_STATUSES, type JarvisStatus } from "../../shared/jarvis.js";
import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import {
  ACTION_RESTART,
  ACTION_RESTART_DEPENDENCY,
  ACTOR_KINDS,
  ALLOWED_ACTIONS,
  APPROVAL_CHOICES,
  DECIDERS,
  HOST_CHANGE_KINDS,
  HOST_KIND,
  HOST_KINDS,
  ROOT_METHODS,
  HOST_STATUS_ACTIVE,
  HOST_STATUSES,
  IMAGE_CLEANUP,
  IMAGE_CLEANUPS,
  INCIDENT_STATUSES,
  JOB_ACTIONS,
  JOB_STATUSES,
  REPLAY_STATUSES,
  RESTART_CHOICE,
  RESTART_CHOICES,
  ROLES,
  RUNBOOK_SCOPES,
  AGENTS,
  TASK_PRIORITIES,
  TASK_RESOURCES,
  TASK_SOURCES,
  TASK_STATUSES,
  TRIGGERS,
  UPDATE_CHOICE,
  UPDATE_CHOICES,
  UPDATE_RUN_STATUSES,
  USER_STATUS_ACTIVE,
  USER_STATUSES,
  WIDGET_KEY_SCOPE,
  JARVIS_KEY_SCOPE,
  WIDGET_KEY_SCOPES,
  WORK_ITEM_STATUSES,
  type DecidedBy,
  type IncidentStatus,
  type JobAction,
  type JobStatus,
  type TaskPriority,
  type TaskResourceKind,
  type TaskSource,
  type TaskStatus,
  type UpdateRunStatus,
  type WorkItemStatus,
} from "../../shared/constants.js";

// Mirrors the SQL in ./migrations; migrations.test.ts fails if the two drift apart.

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ROLES }).notNull(),
  status: text("status", { enum: USER_STATUSES }).notNull().default(USER_STATUS_ACTIVE),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  totpSecret: text("totp_secret"),
  totpPendingSecret: text("totp_pending_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  totpLastStep: integer("totp_last_step"),
  createdAt: integer("created_at").notNull(),
  passwordChangedAt: integer("password_changed_at"),
  lastLoginAt: integer("last_login_at"),
});

export const userViewPreferences = sqliteTable("user_view_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  preferencesJson: text("preferences_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const recoveryCodes = sqliteTable("recovery_codes", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: integer("used_at"),
});

// A passkey: only its public key, for the address (relying party) it was made for.
export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  relyingPartyId: text("relying_party_id").notNull(),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull(),
  transportsJson: text("transports_json").notNull().default("[]"),
  synced: integer("synced", { mode: "boolean" }).notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  csrfToken: text("csrf_token").notNull(),
  secondFactorDone: integer("second_factor_done", { mode: "boolean" }).notNull().default(false),
  secondFactorFailures: integer("second_factor_failures").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
});

export const loginAttempts = sqliteTable("login_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  ip: text("ip").notNull(),
  succeeded: integer("succeeded", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  occurredAt: integer("occurred_at").notNull(),
  actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
  actorId: text("actor_id"),
  actorLabel: text("actor_label").notNull(),
  action: text("action").notNull(),
  targetKind: text("target_kind"),
  targetId: text("target_id"),
  detailsJson: text("details_json").notNull().default("{}"),
  ip: text("ip"),
  requestId: text("request_id"),
});

export const ollamaServers = sqliteTable("ollama_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  url: text("url").notNull(),
  model: text("model").notNull(),
  contextTokens: integer("context_tokens").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const registryCredentials = sqliteTable("registry_credentials", {
  id: text("id").primaryKey(),
  registry: text("registry").notNull(),
  repository: text("repository"),
  username: text("username").notNull(),
  sealedPassword: text("sealed_password").notNull(),
  hostIdsJson: text("host_ids_json"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const trustedPublishers = sqliteTable("trusted_publishers", {
  name: text("name").primaryKey(),
  publicKey: text("public_key").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const imageTrustRules = sqliteTable("image_trust_rules", {
  id: text("id").primaryKey(),
  registry: text("registry").notNull(),
  repository: text("repository"),
  publishersJson: text("publishers_json"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const availabilityGroups = sqliteTable("availability_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  minimumAvailable: integer("minimum_available").notNull(),
  evidenceFreshSeconds: integer("evidence_fresh_seconds").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const availabilityGroupMembers = sqliteTable(
  "availability_group_members",
  {
    groupId: text("group_id").notNull(),
    hostId: text("host_id").notNull(),
    containerName: text("container_name").notNull(),
    failureDomain: text("failure_domain"),
    probeId: text("probe_id"),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.hostId, table.containerName] })],
);

export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  label: text("label").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenHint: text("token_hint").notNull(),
  // Its join code while it waits to be traded for its runner's token: its hash, and when it stops working.
  joinCodeHash: text("join_code_hash"),
  joinCodeExpiresAt: integer("join_code_expires_at"),
  status: text("status", { enum: HOST_STATUSES }).notNull().default(HOST_STATUS_ACTIVE),
  enrolledBy: text("enrolled_by").references(() => users.id, { onDelete: "set null" }),
  enrolledAt: integer("enrolled_at").notNull(),
  // The Ollama server this host's work goes to; null is the default.
  ollamaServerId: text("ollama_server_id").references(() => ollamaServers.id, { onDelete: "set null" }),
  revokedAt: integer("revoked_at"),
  lastHeartbeatAt: integer("last_heartbeat_at"),
  runnerVersion: text("runner_version"),
  dryRun: integer("dry_run", { mode: "boolean" }),
  eventStreamConnected: integer("event_stream_connected", { mode: "boolean" }).notNull().default(false),
  protectedContainersJson: text("protected_containers_json").notNull().default("[]"),
  maintenanceGeneration: integer("maintenance_generation"),
  // How far its clock is from the control plane's, in seconds, while that pauses its runner; null otherwise.
  clockSkewSeconds: integer("clock_skew_seconds"),
  // How far its clock is from the control plane's, in seconds, as its last full report found it; null when unknown.
  clockOffsetSeconds: integer("clock_offset_seconds"),
  // When its kept containers were reported, while its runner says Docker could not list them since; null otherwise.
  containersStaleSince: integer("containers_stale_since"),
  // What its latest report left out to fit, as a JSON list; null when it left out nothing.
  reportTrimmedJson: text("report_trimmed_json"),
  resourcePermissions: integer("resource_permissions", { mode: "boolean" }).notNull().default(false),
  topologyJson: text("topology_json"),
  operationPreviews: integer("operation_previews", { mode: "boolean" }).notNull().default(false),
  // Whether its runner can make service checks from its own host.
  serviceProbes: integer("service_probes", { mode: "boolean" }).notNull().default(false),
  rollouts: integer("rollouts", { mode: "boolean" }).notNull().default(false),
  tagChanges: integer("tag_changes", { mode: "boolean" }).notNull().default(false),
  applicationBackups: integer("application_backups", { mode: "boolean" }).notNull().default(false),
  restartBudgetJson: text("restart_budget_json").notNull().default("{}"),
  // Why its runner restarts nothing on its own, as its latest report said; null while it may.
  recoveryHoldJson: text("recovery_hold_json"),
  // When each container's used-up restarts free again and its wait ends, as its latest report said; null from a
  // runner before it.
  restartWaitJson: text("restart_wait_json"),
  // When an admin reset each container's restarts: sent to its runner with every answer, for an hour.
  restartResetsJson: text("restart_resets_json").notNull().default("{}"),
  // The runner's latest report: the host's health, every container on it, and the images none uses (null
  // until its runner reports them).
  healthJson: text("health_json"),
  containersJson: text("containers_json").notNull().default("[]"),
  unusedImagesJson: text("unused_images_json"),
  networksJson: text("networks_json"),
  volumesJson: text("volumes_json"),
  // Its .env's CONTAINER_ACCESS, as its runner last said; null until it says.
  containerAccess: integer("container_access", { mode: "boolean" }),
  // Its .env's HOST_TERMINAL, as its runner last said; null from a runner that cannot open a shell on its host.
  hostTerminal: integer("host_terminal", { mode: "boolean" }),
  // Its .env's HOST_DEPLOY, as its runner last said; null from a runner that cannot install.
  hostDeploy: integer("host_deploy", { mode: "boolean" }),
  // Added without a name: it takes the one its runner reports first.
  namedByRunner: integer("named_by_runner", { mode: "boolean" }).notNull().default(false),
  // What its page lets Autoheal do there on its own: what a container does until someone sets it, and
  // when the images no container uses are removed.
  restartDefault: text("restart_default", { enum: RESTART_CHOICES }).notNull().default(RESTART_CHOICE.ask),
  updateDefault: text("update_default", { enum: UPDATE_CHOICES }).notNull().default(UPDATE_CHOICE.ask),
  imageCleanup: text("image_cleanup", { enum: IMAGE_CLEANUPS }).notNull().default(IMAGE_CLEANUP.off),
  clearBuildCache: integer("clear_build_cache", { mode: "boolean" }).notNull().default(false),
  clearLeftNetworks: integer("clear_left_networks", { mode: "boolean" }).notNull().default(false),
  kind: text("kind", { enum: HOST_KINDS }).notNull().default(HOST_KIND.runner),
  // An SSH host: where and as whom to reach it, with which stored key, and the host key a person trusted.
  sshAddress: text("ssh_address"),
  sshPort: integer("ssh_port"),
  sshUser: text("ssh_user"),
  sshKeyId: text("ssh_key_id").references(() => sshKeys.id),
  sshHostKey: text("ssh_host_key"),
  sshHostKeyFingerprint: text("ssh_host_key_fingerprint"),
  // Sealed: its embedded runner reports with it, so the control plane keeps it.
  sshRunnerToken: text("ssh_runner_token"),
  // What a runner reads from its .env, set on the host's page instead.
  sshSettingsJson: text("ssh_settings_json"),
  // False once its report says Docker is not there: an SSH host watched for its system alone.
  docker: integer("docker", { mode: "boolean" }).notNull().default(true),
  // Sealed; Autoheal runs root commands with it by itself, through sudo or su as it was found to work.
  sshRootPassword: text("ssh_root_password"),
  sshRootMethod: text("ssh_root_method", { enum: ROOT_METHODS }),
});

// SSH keys: the user's own, or one Autoheal made; the private half and its passphrase sealed, never shown back.
export const sshKeys = sqliteTable("ssh_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  publicLine: text("public_line").notNull(),
  fingerprint: text("fingerprint").notNull(),
  privateKey: text("private_key").notNull(),
  passphrase: text("passphrase"),
  madeByAutoheal: integer("made_by_autoheal", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
});

// What changed on a host between two of its reports, kept two weeks.
export const hostChanges = sqliteTable("host_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  at: integer("at").notNull(),
  kind: text("kind", { enum: HOST_CHANGE_KINDS }).notNull(),
  containerName: text("container_name"),
  detailsJson: text("details_json").notNull().default("{}"),
});

// A container's own ticks, once someone changed them on its host's page.
export const containerControls = sqliteTable(
  "container_controls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    containerName: text("container_name").notNull(),
    restartChoice: text("restart_choice", { enum: RESTART_CHOICES }).notNull().default(RESTART_CHOICE.ask),
    updateChoice: text("update_choice", { enum: UPDATE_CHOICES }).notNull().default(UPDATE_CHOICE.ask),
    changedAt: integer("changed_at").notNull(),
  },
  (table) => [unique().on(table.hostId, table.containerName)],
);

// The newer version a person ignores for one container: one tag, or IGNORE_EVERY_VERSION for every new one.
export const ignoredVersions = sqliteTable(
  "ignored_versions",
  {
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    containerName: text("container_name").notNull(),
    version: text("version").notNull(),
    ignoredBy: text("ignored_by").notNull(),
    ignoredAt: integer("ignored_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.hostId, table.containerName] })],
);

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id),
  containerName: text("container_name").notNull(),
  image: text("image").notNull(),
  triggerEvent: text("trigger_event", { enum: TRIGGERS }).notNull(),
  detectedAt: integer("detected_at").notNull(),
  status: text("status", { enum: INCIDENT_STATUSES as [IncidentStatus, ...IncidentStatus[]] }).notNull(),
  decidedBy: text("decided_by", { enum: DECIDERS as [DecidedBy, ...DecidedBy[]] }),
  action: text("action", { enum: ALLOWED_ACTIONS }),
  target: text("target"),
  diagnosis: text("diagnosis"),
  verdict: text("verdict"),
  outcome: text("outcome"),
  promptHash: text("prompt_hash"),
  modelName: text("model_name"),
  modelDigest: text("model_digest"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const incidentReports = sqliteTable("incident_reports", {
  incidentId: text("incident_id")
    .primaryKey()
    .references(() => incidents.id, { onDelete: "cascade" }),
  reportJson: text("report_json").notNull(),
  // The sections the prompt carried besides the report; null for incidents from before them.
  evidenceJson: text("evidence_json"),
  // The failed container's last half hour of usage, at most 60 readings; null before it or without any.
  usageJson: text("usage_json"),
});

export const incidentEvents = sqliteTable("incident_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  incidentId: text("incident_id")
    .notNull()
    .references(() => incidents.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id")
    .notNull()
    .references(() => incidents.id),
  decidedBy: text("decided_by")
    .notNull()
    .references(() => users.id),
  choice: text("choice", { enum: APPROVAL_CHOICES }).notNull(),
  target: text("target"),
  note: text("note"),
  decidedAt: integer("decided_at").notNull(),
});

export const workItems = sqliteTable("work_items", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id),
  incidentId: text("incident_id")
    .notNull()
    .references(() => incidents.id),
  approvalId: text("approval_id")
    .notNull()
    .references(() => approvals.id),
  action: text("action", { enum: [ACTION_RESTART, ACTION_RESTART_DEPENDENCY] }).notNull(),
  target: text("target").notNull(),
  status: text("status", {
    enum: WORK_ITEM_STATUSES as [WorkItemStatus, ...WorkItemStatus[]],
  }).notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  deliveredAt: integer("delivered_at"),
  completedAt: integer("completed_at"),
  resultJson: text("result_json"),
});

export const runbooks = sqliteTable("runbooks", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: RUNBOOK_SCOPES }).notNull(),
  pattern: text("pattern"),
  title: text("title").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
});

export const runbookVersions = sqliteTable(
  "runbook_versions",
  {
    id: text("id").primaryKey(),
    runbookId: text("runbook_id")
      .notNull()
      .references(() => runbooks.id),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    publishedAt: integer("published_at"),
  },
  (table) => [unique().on(table.runbookId, table.version)],
);

export const promptSnapshots = sqliteTable("prompt_snapshots", {
  hash: text("hash").primaryKey(),
  systemPrompt: text("system_prompt").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const replayRuns = sqliteTable("replay_runs", {
  id: text("id").primaryKey(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
  status: text("status", { enum: REPLAY_STATUSES }).notNull(),
  modelName: text("model_name").notNull(),
  modelDigest: text("model_digest"),
  draftVersionIdsJson: text("draft_version_ids_json").notNull().default("[]"),
  incidentCount: integer("incident_count").notNull(),
});

export const replayResults = sqliteTable("replay_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  replayRunId: text("replay_run_id")
    .notNull()
    .references(() => replayRuns.id, { onDelete: "cascade" }),
  incidentId: text("incident_id")
    .notNull()
    .references(() => incidents.id),
  originalAction: text("original_action"),
  originalTarget: text("original_target"),
  replayAction: text("replay_action"),
  replayTarget: text("replay_target"),
  replayDiagnosis: text("replay_diagnosis"),
  changed: integer("changed", { mode: "boolean" }).notNull(),
  error: text("error"),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  number: integer("number").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", { enum: TASK_STATUSES as [TaskStatus, ...TaskStatus[]] }).notNull(),
  priority: text("priority", { enum: TASK_PRIORITIES as [TaskPriority, ...TaskPriority[]] }).notNull(),
  source: text("source", { enum: TASK_SOURCES as [TaskSource, ...TaskSource[]] }).notNull(),
  // The detector's name for the problem; one open task per key (a partial unique index).
  detectorKey: text("detector_key"),
  assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
  assigneeAgent: text("assignee_agent", { enum: AGENTS }),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  parentId: text("parent_id"),
  hostId: text("host_id").references(() => hosts.id),
  resourceKind: text("resource_kind", { enum: TASK_RESOURCES as [TaskResourceKind, ...TaskResourceKind[]] }),
  resourceId: text("resource_id"),
  resourceLabel: text("resource_label"),
  labelsJson: text("labels_json").notNull().default("[]"),
  incidentId: text("incident_id").references(() => incidents.id),
  occurrences: integer("occurrences").notNull().default(1),
  checkedOutBy: text("checked_out_by"),
  checkedOutAt: integer("checked_out_at"),
  closedByDetector: integer("closed_by_detector", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  closedAt: integer("closed_at"),
  snoozedUntil: integer("snoozed_until"),
});

export const taskComments = sqliteTable("task_comments", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
  authorAgent: text("author_agent", { enum: AGENTS }),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const taskActivity = sqliteTable("task_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  actorLabel: text("actor_label").notNull(),
  dataJson: text("data_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const taskBlockers = sqliteTable(
  "task_blockers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    blockedById: text("blocked_by_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (table) => [unique().on(table.taskId, table.blockedById)],
);

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
  containerName: text("container_name").notNull(),
  action: text("action", { enum: JOB_ACTIONS as [JobAction, ...JobAction[]] }).notNull(),
  operatorUserId: text("operator_user_id"),
  expectedResourcesFingerprint: text("expected_resources_fingerprint"),
  rolloutJson: text("rollout_json"),
  requestedByUserId: text("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  requestedByAgent: text("requested_by_agent", { enum: AGENTS }),
  status: text("status", { enum: JOB_STATUSES as [JobStatus, ...JobStatus[]] }).notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  deliveredAt: integer("delivered_at"),
  completedAt: integer("completed_at"),
  outcome: text("outcome"),
  output: text("output"),
  recoveryBackupId: text("recovery_backup_id"),
  installPayload: text("install_payload"),
  installRetry: text("install_retry"),
  editSettings: text("edit_settings"),
  // The packages a host upgrade names, and the images a removal names; null for every other job.
  packagesJson: text("packages_json"),
  imagesJson: text("images_json"),
  networkJson: text("network_json"),
  volumeJson: text("volume_json"),
  stackJson: text("stack_json"),
  // A backup or restore: its target, where it goes, and its sealed key. Nothing here opens without the passphrase.
  backupJson: text("backup_json"),
  // The host's boot when a reboot was handed to its runner.
  deliveredBootId: text("delivered_boot_id"),
  // An update its runner puts back at once when the new container does not come back healthy.
  undoIfUnhealthy: integer("undo_if_unhealthy", { mode: "boolean" }).notNull().default(false),
  // The tag a change-tag job moves its container to.
  targetTag: text("target_tag"),
});

// Several containers' new images on one host, one at a time: see the update-runs migration.
export const updateRuns = sqliteTable("update_runs", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id),
  namesJson: text("names_json").notNull(),
  status: text("status", { enum: UPDATE_RUN_STATUSES as [UpdateRunStatus, ...UpdateRunStatus[]] }).notNull(),
  doneCount: integer("done_count").notNull().default(0),
  currentJobId: text("current_job_id").references(() => jobs.id),
  requestedByUserId: text("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expectedResourcesJson: text("expected_resources_json"),
});

// How a stack differs from its files, by name alone: see control-plane/inventory/stack-drift-service.
export const stackDrift = sqliteTable(
  "stack_drift",
  {
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    project: text("project").notNull(),
    driftJson: text("drift_json").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastObservedAt: integer("last_observed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.hostId, table.project] })],
);

// A stack's containers restarted one at a time: see control-plane/jobs/stack-restarts-service.
export const stackRestarts = sqliteTable("stack_restarts", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id),
  stack: text("stack").notNull(),
  namesJson: text("names_json").notNull(),
  status: text("status", { enum: UPDATE_RUN_STATUSES as [UpdateRunStatus, ...UpdateRunStatus[]] }).notNull(),
  current: text("current"),
  doneJson: text("done_json").notNull(),
  failed: text("failed"),
  outcome: text("outcome"),
  refusal: text("refusal"),
  currentJobId: text("current_job_id").references(() => jobs.id, { onDelete: "set null" }),
  actorJson: text("actor_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// What Jarvis was told, or is about to be: see control-plane/jarvis.
export const jarvisItems = sqliteTable("jarvis_items", {
  id: text("id").primaryKey(),
  groupKey: text("group_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  taskIdsJson: text("task_ids_json").notNull(),
  messageJson: text("message_json").notNull(),
  status: text("status", { enum: JARVIS_STATUSES as [JarvisStatus, ...JarvisStatus[]] }).notNull(),
  createdAt: integer("created_at").notNull(),
  sentAt: integer("sent_at"),
  attempts: integer("attempts").notNull().default(0),
});

export const widgetKeys = sqliteTable("widget_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyHint: text("key_hint").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  scope: text("scope", { enum: [...WIDGET_KEY_SCOPES, JARVIS_KEY_SCOPE] })
    .notNull()
    .default(WIDGET_KEY_SCOPE.widget),
});

// What the dashboard sets rather than the environment, one JSON value per key (see SETTING_KEYS).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Each host's latest package check, as its runner found it.
export const hostPackageChecks = sqliteTable("host_package_checks", {
  hostId: text("host_id")
    .primaryKey()
    .references(() => hosts.id, { onDelete: "cascade" }),
  jobId: text("job_id"),
  checkedAt: integer("checked_at").notNull(),
  checkJson: text("check_json").notNull(),
});

// What Ollama said a package is, asked once per name.
export const packageKinds = sqliteTable("package_kinds", {
  name: text("name").primaryKey(),
  keepsData: integer("keeps_data", { mode: "boolean" }).notNull(),
  decidedAt: integer("decided_at").notNull(),
});

export const runnerResults = sqliteTable("runner_results", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  payloadHash: text("payload_hash").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const maintenanceRevision = sqliteTable("maintenance_revision", {
  id: integer("id").primaryKey(),
  generation: integer("generation").notNull(),
});
export const maintenanceWindows = sqliteTable("maintenance_windows", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  containerName: text("container_name"),
  owner: text("owner").notNull(),
  reason: text("reason").notNull(),
  startsAt: integer("starts_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const resourcePermissions = sqliteTable("resource_permissions", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  grantsJson: text("grants_json").notNull().default("[]"),
});

export { notificationEvents, notificationDeliveries, notificationRouting } from "../notifications/delivery-schema.js";

export { metricSeries, metricRollups, metricAnomalies } from "../inventory/metric-rollups-schema.js";
export {
  applicationBackupPlans,
  applicationBackupRuns,
  applicationBackupArtifacts,
} from "./application-backup-schema.js";
export { rollouts } from "../jobs/rollout-schema.js";
export * from "../network/network-schema.js";
export * from "../probes/probe-schema.js";
export { rebootPlans } from "../power/reboot-plans-schema.js";
