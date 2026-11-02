import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import { readBackupPassphrase } from "../control-plane/backups/backup-passphrase.js";
import { BACKUP_PASSPHRASE_MESSAGES, EXIT_FAILURE, EXIT_SUCCESS } from "../shared/constants.js";

/**
 * Prints the backup passphrase, on the host only: `docker compose run --rm control-plane
 * backup-passphrase`. Whoever can run that holds the data volume already.
 */
export async function runBackupPassphrase(
  _commandArguments: string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const passphrase = readBackupPassphrase(loadControlPlaneConfig(process.env));
  if (passphrase === null) {
    output.error(BACKUP_PASSPHRASE_MESSAGES.missing);
    return EXIT_FAILURE;
  }
  output.log(passphrase.passphrase);
  return EXIT_SUCCESS;
}
