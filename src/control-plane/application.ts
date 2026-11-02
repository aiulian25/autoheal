import { RUNNING_VERSION } from "../shared/build-version.js";
import { NOTIFICATION_DELIVERY_INTERVAL_MILLISECONDS } from "../shared/constants.js";
import { PROBE_TICK_MILLISECONDS } from "../shared/probes.js";
import { REBOOT_PLAN } from "../shared/reboot-plans.js";
import { RestoreJournal } from "./backups/restore-journal.js";
import { existsSync, statSync } from "node:fs";
import type { Server as TlsServer } from "node:tls";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import type { ControlPlaneConfig } from "../config/control-plane-config.js";
import {
  ADMIN_USERNAME,
  BACKUP_PASSPHRASE_MESSAGES,
  JOIN_DIRECTORY,
  PLAIN_HTTP_PROTOCOL,
  PLAIN_HTTP_MESSAGES,
  SECRET_SOURCES,
  TLS_DIRECTORY,
  TLS_EXTRA_NAMES,
  TLS_MESSAGES,
  TLS_RENEW_CHECK_MILLISECONDS,
  RUNNER_PORT,
  BACKUP_SCHEDULE_CHECK_MILLISECONDS,
  COMMAND_MESSAGES,
  DETECTOR_FIRST_RUN_MILLISECONDS,
  DETECTOR_INTERVAL_MILLISECONDS,
  HEALTH_LISTEN_ADDRESS,
  HEALTH_PORT,
  HEALTH_URL,
  LISTEN_ALL_ADDRESSES,
  LISTENER_NAMES,
  NETWORK_REPORT_CHECK_MILLISECONDS,
  NETWORK_WATCH_INTERVAL_MILLISECONDS,
  OLLAMA_STATUS_INTERVAL_MILLISECONDS,
  METRICS_SWEEP_INTERVAL_MILLISECONDS,
  RETENTION_SWEEP_INTERVAL_MILLISECONDS,
  ROLLOUT_TICK_INTERVAL_MILLISECONDS,
  TERMINAL_SWEEP_INTERVAL_MILLISECONDS,
  USER_INTERFACE_PORT,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import { untilShutdown } from "../shared/shutdown.js";
import { buildRunnerServer } from "./runner-api/runner-server.js";
import { AuditLog } from "./audit/audit-log.js";
import { backupIfDue } from "./backups/backup-scheduler.js";
import { ensureFirstAdmin } from "./auth/bootstrap.js";
import { ensureBackupPassphrase, type BackupPassphrase } from "./backups/backup-passphrase.js";
import { DatabaseHandle, databasePathIn } from "./database/connection.js";
import { builtWebAssets } from "./http/web-assets.js";
import { buildHealthServer, buildUserInterfaceServer, type StaticSettingsView } from "./server.js";
import { createControlPlaneServices, type ControlPlaneServices } from "./services.js";
import { ownCertificate, providedCertificate, type ServerCertificate } from "./tls/certificate.js";

function isDatabaseReachable(databaseHandle: DatabaseHandle) {
  try {
    if (databaseHandle.restore.busy) return true;
    databaseHandle.sqlite.prepare("select 1").get();
    return true;
  } catch {
    return false;
  }
}

// The image has an empty /join of its own, so that a fresh volume there is Autoheal's to write. Only a
// volume mounted there (a device of its own) means a runner on this machine shares it.
// ponytail: storage drivers that keep volumes and the root filesystem on one device (vfs) never
// join the local runner by itself; "Add a host" still works there.
const isMountPoint = (path: string) => existsSync(path) && statSync(path).dev !== statSync(dirname(path)).dev;

const madeBy = (generated: boolean) => (generated ? SECRET_SOURCES.autoheal : SECRET_SOURCES.operator);
const isPlainHttp = (url: string) => new URL(url).protocol === PLAIN_HTTP_PROTOCOL;

const settingsView = (config: ControlPlaneConfig, passphrase: BackupPassphrase): StaticSettingsView => ({
  version: RUNNING_VERSION,
  publicBaseUrl: config.publicBaseUrl,
  offboxBackupsConfigured: config.offboxBackupDirectory !== null,
  certificate: madeBy(config.tls === null),
  backupPassphrase: madeBy(passphrase.generated),
});

/** The operator's own certificate, or the one Autoheal made (made now, or signed again, when due). */
function serverCertificate(
  config: ControlPlaneConfig,
  now: number,
): { certificate: ServerCertificate; issued: boolean } {
  if (config.tls !== null) {
    return { certificate: providedCertificate(config.tls), issued: false };
  }
  const { material, issued } = ownCertificate(
    join(config.dataDirectory, TLS_DIRECTORY),
    [config.publicHostname, ...TLS_EXTRA_NAMES],
    now,
  );
  return { certificate: material, issued };
}

const tlsOptionsOf = (certificate: ServerCertificate) => ({
  cert: Buffer.from(certificate.certificate),
  key: Buffer.from(certificate.key),
});

/** A certificate Autoheal made is signed again before it ends; both listeners take it without a restart. */
function renewWhenDue(config: ControlPlaneConfig, servers: readonly FastifyInstance[], now: number) {
  const { certificate, issued } = serverCertificate(config, now);
  if (!issued) {
    return;
  }
  servers.forEach((server) => (server.server as unknown as TlsServer).setSecureContext(tlsOptionsOf(certificate)));
  log(TLS_MESSAGES.renewed);
}

/** Whatever the previous process left half-done has no process behind it any more. */
async function recoverFromRestart(services: ControlPlaneServices) {
  const cancelled = services.incidentsService.cancelInterrupted();
  const finished = services.replayService.finishInterrupted();
  await services.restoreService.clearPending();
  if (cancelled > 0 || finished > 0) {
    log(COMMAND_MESSAGES.recovered(cancelled, finished));
  }
}

export async function runControlPlane(): Promise<number> {
  // The one clock this process runs on: everything below reads the time from it.
  const clock = Date.now;
  const config = loadControlPlaneConfig(process.env);
  const passphrase = ensureBackupPassphrase(config);
  if (passphrase.madeNow) {
    log(BACKUP_PASSPHRASE_MESSAGES.made);
  }
  const { certificate, issued } = serverCertificate(config, clock());
  if (issued) {
    log(TLS_MESSAGES.created);
  }
  if (isPlainHttp(config.ollama.url)) {
    log(PLAIN_HTTP_MESSAGES.ollama);
  }
  new RestoreJournal(config.dataDirectory).assertClean();
  const databaseHandle = new DatabaseHandle(databasePathIn(config.dataDirectory));
  const auditLog = new AuditLog(databaseHandle);
  await ensureFirstAdmin(databaseHandle, auditLog, ADMIN_USERNAME, log, clock);
  const services = createControlPlaneServices(databaseHandle, auditLog, {
    ollama: config.ollama,
    backups: { ...config, backupPassphrase: passphrase.passphrase },
    generatedBackupPassphrase: passphrase.generated ? passphrase.passphrase : null,
    integrations: { gotify: config.gotify, ntfy: config.ntfy, homeAssistant: config.homeAssistant },
    trustedProxyAddresses: config.trustedProxyAddresses,
    publicBaseUrl: config.publicBaseUrl,
    runners: { pin: certificate.pin, image: config.autohealImage },
    environment: process.env,
    clock,
  });
  await recoverFromRestart(services);
  // With the Docker socket mounted, this machine is looked after from this container: no runner container joins.
  if (isMountPoint(JOIN_DIRECTORY) && !services.localHostRunner.inPlace()) {
    services.hostsService.ensureLocalRunner(JOIN_DIRECTORY);
  }
  services.homeAssistant.start();

  const tls = tlsOptionsOf(certificate);
  const userInterface = await buildUserInterfaceServer({
    publicHost: config.publicHost,
    publicOrigin: config.publicOrigin,
    tls,
    services,
    settings: settingsView(config, passphrase),
    webAssetsDirectory: builtWebAssets(),
  });
  const runnerServer = await buildRunnerServer(tls, services);
  const healthServer = buildHealthServer(
    () => isDatabaseReachable(databaseHandle),
    () => services.inventoryService.sshSessions(),
  );
  await userInterface.listen({ host: LISTEN_ALL_ADDRESSES, port: USER_INTERFACE_PORT });
  await runnerServer.listen({ host: LISTEN_ALL_ADDRESSES, port: RUNNER_PORT });
  await healthServer.listen({ host: HEALTH_LISTEN_ADDRESS, port: HEALTH_PORT });
  // Once the runner API listens: their first reports go to it.
  services.embeddedRunners.begin();
  services.localHostRunner.begin();
  log(COMMAND_MESSAGES.listening(LISTENER_NAMES.dashboard, `https://${LISTEN_ALL_ADDRESSES}:${USER_INTERFACE_PORT}`));
  log(COMMAND_MESSAGES.listening(LISTENER_NAMES.runners, `https://${LISTEN_ALL_ADDRESSES}:${RUNNER_PORT}`));
  log(COMMAND_MESSAGES.listening(LISTENER_NAMES.health, HEALTH_URL));

  const logFailure = (error: unknown) => log(describeError(error));
  const scheduled = (work: () => unknown) => {
    if (databaseHandle.restore.busy) return;
    void Promise.resolve()
      .then(() => databaseHandle.restore.run(work))
      .catch(logFailure);
  };

  // Detectors open and close tasks, escalations nothing is left to decide about settle; then Autoheal works its own.
  const detectAndWork = async () => {
    await services.detectorService.run();
    await services.incidentReconciler.run();
    // Ollama may take its time over a repair: the other work never waits for it.
    void services.repairWorker.run().catch(logFailure);
    await services.autohealWorker.run();
    // Ollama says why work handed to it failed, in its own time.
    void services.failureReporter.run().catch(logFailure);
    // Ollama may take its time over the updates people hold: the problem checks never wait for it.
    void services.autohealWorker.adviseUpdates().catch(logFailure);
    services.hostPackages.tick();
    services.hostControl.tick();
    services.embeddedRunners.tick();
    services.localHostRunner.tick();
    services.power.tick();
    void services.jarvis.tick().catch(logFailure);
  };
  let detectorTimer: NodeJS.Timeout | null = null;
  const detectorStart = setTimeout(() => {
    scheduled(detectAndWork);
    detectorTimer = setInterval(() => scheduled(detectAndWork), DETECTOR_INTERVAL_MILLISECONDS);
  }, DETECTOR_FIRST_RUN_MILLISECONDS);
  scheduled(() => services.ollamaPool.checkAll());
  const ollamaTimer = setInterval(
    () => scheduled(() => services.ollamaPool.checkAll()),
    OLLAMA_STATUS_INTERVAL_MILLISECONDS,
  );

  services.networkWatch.startLogReceiver();
  scheduled(() => services.networkWatch.tick());
  const networkTimer = setInterval(
    () => scheduled(() => services.networkWatch.tick()),
    NETWORK_WATCH_INTERVAL_MILLISECONDS,
  );
  const probeTimer = setInterval(() => scheduled(() => services.probes.tick()), PROBE_TICK_MILLISECONDS);
  const rebootPlanTimer = setInterval(() => scheduled(() => services.rebootPlans.tick()), REBOOT_PLAN.tickMilliseconds);
  const networkReportTimer = setInterval(
    () => scheduled(() => services.networkReview.weekly()),
    NETWORK_REPORT_CHECK_MILLISECONDS,
  );

  scheduled(() => backupIfDue(services.backupService, clock()));
  const backupTimer = setInterval(
    () => scheduled(() => backupIfDue(services.backupService, clock())),
    BACKUP_SCHEDULE_CHECK_MILLISECONDS,
  );
  const metricsTimer = setInterval(
    () => scheduled(() => services.metricsStore.sweep()),
    METRICS_SWEEP_INTERVAL_MILLISECONDS,
  );
  scheduled(() => services.rollouts.tick());
  const rolloutTimer = setInterval(() => scheduled(() => services.rollouts.tick()), ROLLOUT_TICK_INTERVAL_MILLISECONDS);
  scheduled(() => services.applicationBackups.schedule());
  const applicationBackupTimer = setInterval(
    () => scheduled(() => services.applicationBackups.schedule()),
    BACKUP_SCHEDULE_CHECK_MILLISECONDS,
  );
  scheduled(() => services.notificationDeliveries.tick());
  const notificationTimer = setInterval(
    () => scheduled(() => services.notificationDeliveries.tick()),
    NOTIFICATION_DELIVERY_INTERVAL_MILLISECONDS,
  );
  const terminalTimer = setInterval(
    () => scheduled(() => services.terminals.sweep()),
    TERMINAL_SWEEP_INTERVAL_MILLISECONDS,
  );
  scheduled(() => services.retentionSweep.sweep());
  const retentionTimer = setInterval(
    () => scheduled(() => services.retentionSweep.sweep()),
    RETENTION_SWEEP_INTERVAL_MILLISECONDS,
  );
  const renewTimer =
    config.tls === null
      ? setInterval(() => renewWhenDue(config, [userInterface, runnerServer], clock()), TLS_RENEW_CHECK_MILLISECONDS)
      : null;

  return untilShutdown(async () => {
    clearTimeout(detectorStart);
    clearInterval(detectorTimer ?? undefined);
    clearInterval(ollamaTimer);
    clearInterval(networkTimer);
    clearInterval(probeTimer);
    clearInterval(rebootPlanTimer);
    services.probes.stop();
    clearInterval(networkReportTimer);
    services.networkWatch.stopLogReceiver();
    clearInterval(backupTimer);
    clearInterval(terminalTimer);
    clearInterval(notificationTimer);
    clearInterval(rolloutTimer);
    clearInterval(applicationBackupTimer);
    clearInterval(metricsTimer);
    clearInterval(retentionTimer);
    clearInterval(renewTimer ?? undefined);
    // Their last reports still reach the runner API, which closes below.
    await services.embeddedRunners.stop();
    await services.localHostRunner.stop();
    // This also closes streams/interactive relays, cancels model work and blocks both APIs.
    // The same coordinator already owns every service method and admitted request.
    await databaseHandle.restore.shutdown();
    await userInterface.close();
    await runnerServer.close();
    await healthServer.close();
    databaseHandle.close();
  });
}
