import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import { AuditLog } from "../control-plane/audit/audit-log.js";
import { resetAdmin } from "../control-plane/auth/bootstrap.js";
import { DatabaseHandle, databasePathIn } from "../control-plane/database/connection.js";
import { ADMIN_USERNAME, EXIT_SUCCESS } from "../shared/constants.js";

export async function runResetAdmin(
  [username = ADMIN_USERNAME]: string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const handle = new DatabaseHandle(databasePathIn(loadControlPlaneConfig(process.env).dataDirectory));
  try {
    await resetAdmin(handle, new AuditLog(handle), username, (message) => output.log(message));
  } finally {
    handle.close();
  }
  return EXIT_SUCCESS;
}
