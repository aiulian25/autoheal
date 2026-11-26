import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import { AuditLog } from "../control-plane/audit/audit-log.js";
import { refusalOf, resetOwner } from "../control-plane/auth/bootstrap.js";
import { ownerOfFile } from "../control-plane/auth/single-owner.js";
import { DatabaseHandle, databasePathIn } from "../control-plane/database/connection.js";
import { EXIT_FAILURE, EXIT_SUCCESS, SINGLE_OWNER_MESSAGES } from "../shared/constants.js";

/** Resets the one person this Autoheal is for; a username only confirms them, or chooses them where it cannot tell. */
export async function runResetAdmin(
  [username]: string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const databasePath = databasePathIn(loadControlPlaneConfig(process.env).dataDirectory);
  // Nothing named and nothing to go by: the file is left as it was, for the version it came from.
  if (username === undefined && ownerOfFile(databasePath).kind === "unclear") {
    output.error(SINGLE_OWNER_MESSAGES.chooseOne);
    return EXIT_FAILURE;
  }
  const handle = new DatabaseHandle(databasePath);
  try {
    const outcome = await resetOwner(handle, new AuditLog(handle), username, (message) => output.log(message));
    if (outcome.kind === "reset") return EXIT_SUCCESS;
    output.error(refusalOf(outcome));
    return EXIT_FAILURE;
  } finally {
    handle.close();
  }
}
