import { metricRollupsMigration } from "./0028-metric-rollups.js";
import { applicationBackupsMigration } from "./0029-application-backups.js";
import { rolloutsMigration } from "./0030-rollouts.js";
import { sealedSecretsMigration } from "./0031-sealed-secrets.js";
import { recoveryHoldMigration } from "./0032-recovery-hold.js";
import { applicationBackupFailureMigration } from "./0033-application-backup-failure.js";
import { restartSafetyMigration } from "./0034-restart-safety.js";
import { widgetKeyScopeMigration } from "./0035-widget-key-scope.js";
import { sshHostsMigration } from "./0036-ssh-hosts.js";
import { sshRootAndDockerMigration } from "./0037-ssh-root-and-docker.js";
import { hostTerminalMigration } from "./0038-host-terminal.js";
import { hostDeployMigration } from "./0039-host-deploy.js";
import { networksMigration } from "./0040-networks.js";
import { volumesMigration } from "./0041-volumes.js";
import { stacksMigration } from "./0042-stacks.js";
import { ollamaServersMigration } from "./0043-ollama-servers.js";
import { networkMigration } from "./0044-network.js";
import { speedTestSourceMigration } from "./0045-speed-test-source.js";
import { containerBackupsMigration } from "./0046-container-backups.js";
import { jarvisMigration } from "./0047-jarvis.js";
import { jarvisConfirmedMigration } from "./0048-jarvis-confirmed.js";
import { stackRestartsMigration } from "./0049-stack-restarts.js";
import { jobRecoveryBackupMigration } from "./0050-job-recovery-backup.js";
import { installPayloadMigration } from "./0051-install-payload.js";
import { applicationBootDrillsMigration } from "./0052-application-boot-drills.js";
import { stackDriftMigration } from "./0053-stack-drift.js";
import { serviceProbesMigration } from "./0054-service-probes.js";
import { rebootPlansMigration } from "./0055-reboot-plans.js";
import { viewPreferencesMigration } from "./0056-view-preferences.js";
import { probeCertificatesMigration } from "./0057-probe-certificates.js";
import { installRetryMigration } from "./0058-install-retry.js";
import { revokedHostNamesMigration } from "./0059-revoked-host-names.js";
import { rebootPlanRetentionMigration } from "./0060-reboot-plan-retention.js";
import { registryCredentialsMigration } from "./0061-registry-credentials.js";
import { imageTrustMigration } from "./0062-image-trust.js";
import { probeVantagesMigration } from "./0063-probe-vantages.js";
import { availabilityGroupsMigration } from "./0064-availability-groups.js";
import { tagChangesMigration } from "./0065-tag-changes.js";
import { editSettingsMigration } from "./0066-edit-settings.js";
import { clockSkewMigration } from "./0067-clock-skew.js";
import { containersStaleMigration } from "./0068-containers-stale.js";
import { reportTrimmedMigration } from "./0069-report-trimmed.js";
import { joinCodesMigration } from "./0070-join-codes.js";
import { clockOffsetMigration } from "./0071-clock-offset.js";
import { searchMigration } from "./0027-search.js";
import { notificationDeliveriesMigration } from "./0026-notification-deliveries.js";
import { topologyMigration } from "./0025-topology.js";
import { resourcePermissionsMigration } from "./0024-resource-permissions.js";
import { maintenanceMigration } from "./0023-maintenance.js";
import { runnerResultsMigration } from "./0022-runner-results.js";
import type Database from "better-sqlite3";
import { DATABASE_MESSAGES } from "../../../shared/constants.js";
import { identityMigration } from "./0001-identity.js";
import { fleetMigration } from "./0002-fleet.js";
import { runbooksMigration } from "./0003-runbooks.js";
import { replayMigration } from "./0004-replay.js";
import { secondFactorFailuresMigration } from "./0005-second-factor-failures.js";
import { inventoryMigration } from "./0006-inventory.js";
import { tasksMigration } from "./0007-tasks.js";
import { settingsMigration } from "./0008-settings.js";
import { hostPackagesMigration } from "./0009-host-packages.js";
import { hostControlMigration } from "./0010-host-control.js";
import { unusedImagesMigration } from "./0011-unused-images.js";
import { passkeysMigration } from "./0012-passkeys.js";
import { hostDefaultsMigration } from "./0013-host-defaults.js";
import { updateRunsMigration } from "./0014-update-runs.js";
import { containerChoicesMigration } from "./0015-container-choices.js";
import { taskSnoozeMigration } from "./0016-task-snooze.js";
import { containerAccessMigration } from "./0017-container-access.js";
import { incidentEvidenceMigration } from "./0018-incident-evidence.js";
import { incidentUsageMigration } from "./0019-incident-usage.js";
import { hostChangesMigration } from "./0020-host-changes.js";
import { jobUndoMigration } from "./0021-job-undo.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  identityMigration,
  fleetMigration,
  runbooksMigration,
  replayMigration,
  secondFactorFailuresMigration,
  inventoryMigration,
  tasksMigration,
  settingsMigration,
  hostPackagesMigration,
  hostControlMigration,
  unusedImagesMigration,
  passkeysMigration,
  hostDefaultsMigration,
  updateRunsMigration,
  containerChoicesMigration,
  taskSnoozeMigration,
  containerAccessMigration,
  incidentEvidenceMigration,
  incidentUsageMigration,
  hostChangesMigration,
  jobUndoMigration,
  runnerResultsMigration,
  maintenanceMigration,
  resourcePermissionsMigration,
  topologyMigration,
  notificationDeliveriesMigration,
  searchMigration,
  metricRollupsMigration,
  applicationBackupsMigration,
  rolloutsMigration,
  sealedSecretsMigration,
  recoveryHoldMigration,
  applicationBackupFailureMigration,
  restartSafetyMigration,
  widgetKeyScopeMigration,
  sshHostsMigration,
  sshRootAndDockerMigration,
  hostTerminalMigration,
  hostDeployMigration,
  networksMigration,
  volumesMigration,
  stacksMigration,
  ollamaServersMigration,
  networkMigration,
  speedTestSourceMigration,
  containerBackupsMigration,
  jarvisMigration,
  jarvisConfirmedMigration,
  stackRestartsMigration,
  jobRecoveryBackupMigration,
  installPayloadMigration,
  applicationBootDrillsMigration,
  stackDriftMigration,
  serviceProbesMigration,
  rebootPlansMigration,
  viewPreferencesMigration,
  probeCertificatesMigration,
  installRetryMigration,
  revokedHostNamesMigration,
  rebootPlanRetentionMigration,
  registryCredentialsMigration,
  imageTrustMigration,
  probeVantagesMigration,
  availabilityGroupsMigration,
  tagChangesMigration,
  editSettingsMigration,
  clockSkewMigration,
  containersStaleMigration,
  reportTrimmedMigration,
  joinCodesMigration,
  clockOffsetMigration,
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export const schemaVersionOf = (sqlite: Database.Database) => sqlite.pragma("user_version", { simple: true }) as number;

/** Apply every migration newer than the file's `user_version`, each in its own transaction. */
export function migrate(sqlite: Database.Database): number {
  const current = schemaVersionOf(sqlite);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(DATABASE_MESSAGES.tooNew(current, LATEST_SCHEMA_VERSION));
  }
  for (const migration of MIGRATIONS.filter(({ version }) => version > current)) {
    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${migration.version}`);
    })();
  }
  return schemaVersionOf(sqlite);
}
