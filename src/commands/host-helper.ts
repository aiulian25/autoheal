import { z } from "zod";
import { DbusConnection, DbusError, type MethodCall } from "../host-helper/dbus-connection.js";
import type { HelperReport } from "../host-helper/helper-report.js";
import { packageUnit, verbFits } from "../host-helper/package-units.js";
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  HOST_HELPER_MESSAGES,
  HOST_HELPER_OUTCOME,
  HOST_PACKAGE_LIMIT,
  HOST_PACKAGE_MANAGERS,
  HOST_PACKAGE_UNIT,
  HOST_PACKAGE_VERB,
  HOST_PACKAGE_VERBS,
  PACKAGE_NAME_CHARACTERS,
  PACKAGE_NAME_PATTERN,
  SYSTEMD,
  type HostPackageManager,
  type HostPackageVerb,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";

export type Bus = Pick<DbusConnection, "call" | "close">;

const MANAGER_VERB_AND_JOB = 3;
const packageName = z.string().max(PACKAGE_NAME_CHARACTERS).regex(PACKAGE_NAME_PATTERN);
// Packages name what an upgrade upgrades, and nothing else takes any; each manager has its own verbs.
const helperArguments = z
  .tuple([z.enum(HOST_PACKAGE_MANAGERS), z.enum(HOST_PACKAGE_VERBS), z.uuid()], packageName)
  .refine((parsed) => parsed.length - MANAGER_VERB_AND_JOB <= HOST_PACKAGE_LIMIT)
  .refine((parsed) => (parsed[1] === HOST_PACKAGE_VERB.upgrade) === parsed.length > MANAGER_VERB_AND_JOB)
  .refine((parsed) => verbFits(parsed[0], parsed[1]));

const isUnitThere = (error: unknown) => error instanceof DbusError && error.errorName === SYSTEMD.unitExists;

async function withBus<Result>(openBus: () => Promise<Bus>, use: (bus: Bus) => Promise<Result>): Promise<Result> {
  const bus = await openBus();
  try {
    return await use(bus);
  } finally {
    bus.close();
  }
}

// The one unit name for every run: systemd refuses a second while one goes on, a reboot included.
async function startUnit(
  bus: Bus,
  manager: HostPackageManager,
  verb: HostPackageVerb,
  jobId: string,
  packages: readonly string[],
): Promise<HelperReport> {
  const properties = packageUnit(manager, verb, jobId, packages).map(({ name, value }) => [name, value]);
  const call: MethodCall = {
    destination: SYSTEMD.name,
    path: SYSTEMD.path,
    interface: SYSTEMD.manager,
    member: SYSTEMD.startTransientUnit,
    signature: SYSTEMD.startTransientUnitSignature,
    body: [HOST_PACKAGE_UNIT, SYSTEMD.jobMode, properties, []],
  };
  try {
    await bus.call(call);
    return { outcome: HOST_HELPER_OUTCOME.started };
  } catch (error) {
    if (isUnitThere(error)) {
      return { outcome: HOST_HELPER_OUTCOME.busy };
    }
    throw error;
  }
}

/**
 * The runner's hands on its host. The runner starts it as root in a container that has nothing but the
 * host's D-Bus socket; it asks the host's systemd for one fixed package job, and prints how that went.
 */
export async function runHostHelper(
  commandArguments: string[],
  output: Pick<Console, "log" | "error"> = console,
  openBus: () => Promise<Bus> = () => DbusConnection.open(),
): Promise<number> {
  const parsed = helperArguments.safeParse(commandArguments);
  if (!parsed.success) {
    output.error(HOST_HELPER_MESSAGES.usage);
    return EXIT_USAGE;
  }
  const [manager, verb, jobId, ...packages] = parsed.data;
  const report = await withBus(openBus, (bus) => startUnit(bus, manager, verb, jobId, packages)).catch(
    (error: unknown): HelperReport => ({ outcome: HOST_HELPER_OUTCOME.failed, reason: describeError(error) }),
  );
  output.log(JSON.stringify(report));
  return report.outcome === HOST_HELPER_OUTCOME.failed ? EXIT_FAILURE : EXIT_SUCCESS;
}
