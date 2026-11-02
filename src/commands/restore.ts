import { join } from "node:path";
import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import { AuditLog } from "../control-plane/audit/audit-log.js";
import { readBackupPassphrase } from "../control-plane/backups/backup-passphrase.js";
import { restoreOffline } from "../control-plane/backups/restore-service.js";
import { DatabaseHandle, databasePathIn } from "../control-plane/database/connection.js";
import {
  BACKUP_PASSPHRASE_MESSAGES,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  RESTORE_MESSAGES,
  TEMPORARY_DIRECTORY,
} from "../shared/constants.js";

/** Restore with the control plane stopped, e.g. `docker compose run --rm control-plane restore …`. */
export async function runRestore(
  [backupPath]: string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  if (backupPath === undefined) {
    output.error(RESTORE_MESSAGES.usage);
    return EXIT_USAGE;
  }
  const config = loadControlPlaneConfig(process.env);
  const passphrase = readBackupPassphrase(config);
  if (passphrase === null) {
    output.error(BACKUP_PASSPHRASE_MESSAGES.missing);
    return EXIT_FAILURE;
  }
  const databasePath = databasePathIn(config.dataDirectory);
  const result = await restoreOffline(
    () => new DatabaseHandle(databasePath),
    (handle) => new AuditLog(handle),
    {
      databasePath,
      temporaryDirectory: join(config.dataDirectory, TEMPORARY_DIRECTORY),
      passphrase: passphrase.passphrase,
    },
    backupPath,
    Date.now(),
  );
  output.log(RESTORE_MESSAGES.done(backupPath, result.schemaVersion));
  return EXIT_SUCCESS;
}
