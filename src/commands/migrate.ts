import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import { DatabaseHandle, databasePathIn } from "../control-plane/database/connection.js";
import { schemaVersionOf } from "../control-plane/database/migrations/index.js";
import { DATABASE_MESSAGES, EXIT_SUCCESS } from "../shared/constants.js";

export async function runMigrate(
  _commandArguments: string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const path = databasePathIn(loadControlPlaneConfig(process.env).dataDirectory);
  const handle = new DatabaseHandle(path);
  const version = schemaVersionOf(handle.sqlite);
  handle.close();
  output.log(DATABASE_MESSAGES.migrated(version, path));
  return EXIT_SUCCESS;
}
