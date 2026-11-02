import Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "../control-plane/auth/password-hashing.js";
import type { SshSessionReport } from "../shared/api.js";
import {
  COMMAND_MESSAGES,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  HEALTHCHECK_TIMEOUT_MILLISECONDS,
  IN_MEMORY_DATABASE,
  SELF_TEST_SAMPLE,
  SSH_SESSIONS_URL,
} from "../shared/constants.js";

type Output = Pick<Console, "log" | "error">;

/** The control plane's SSH sessions, read from its loopback listener; null where none runs in this container. */
async function sshSessions(address: string): Promise<SshSessionReport[] | null> {
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MILLISECONDS) });
    return response.ok ? ((await response.json()) as SshSessionReport[]) : null;
  } catch {
    return null;
  }
}

// A host that is down is the host's news, not the image's: it is reported, and the test still passes.
function reportSshSessions(sessions: SshSessionReport[] | null, output: Output) {
  if (sessions === null) {
    output.log(COMMAND_MESSAGES.selfTestNoControlPlane);
    return;
  }
  if (sessions.length === 0) {
    output.log(COMMAND_MESSAGES.selfTestNoSshSessions);
    return;
  }
  sessions.forEach(({ label, session }) =>
    output.log(
      COMMAND_MESSAGES.selfTestSshSession(
        label,
        session?.state ?? COMMAND_MESSAGES.selfTestSshSessionNotOpen,
        session?.reason ?? null,
      ),
    ),
  );
}

/**
 * Proves both native modules load and work in this image, with the real Argon2id settings; in the control plane's
 * container, also says how each SSH host's session stands.
 */
export async function runSelfTest(
  _commandArguments: string[],
  output: Output = console,
  sessionsAddress = SSH_SESSIONS_URL,
): Promise<number> {
  const database = new Database(IN_MEMORY_DATABASE);
  const { version } = database.prepare("select sqlite_version() as version").get() as { version: string };
  database.close();
  if (!(await verifyPassword(await hashPassword(SELF_TEST_SAMPLE), SELF_TEST_SAMPLE))) {
    output.error(COMMAND_MESSAGES.selfTestFailed);
    return EXIT_FAILURE;
  }
  output.log(COMMAND_MESSAGES.selfTestPassed(version));
  reportSshSessions(await sshSessions(sessionsAddress), output);
  return EXIT_SUCCESS;
}
