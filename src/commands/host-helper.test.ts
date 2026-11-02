import { describe, expect, it, vi } from "vitest";
import { DbusError, type DbusValue, type MethodCall } from "../host-helper/dbus-connection.js";
import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE, HOST_PACKAGE_LIMIT, SYSTEMD } from "../shared/constants.js";
import { runHostHelper, type Bus } from "./host-helper.js";

const JOB = "0b8c3c5e-6a52-4f7e-9d3c-2f6d7a1b9e10";

// A bus that answers each systemd method with what the test says, and remembers what was asked.
function fakeBus(answers: Partial<Record<string, () => DbusValue[]>>) {
  const calls: MethodCall[] = [];
  const bus: Bus & { closed: boolean } = {
    closed: false,
    call: vi.fn(async (call: MethodCall) => {
      calls.push(call);
      const answer = answers[call.member];
      if (answer === undefined) {
        throw new Error(`unexpected call ${call.member}`);
      }
      return answer();
    }),
    close: () => {
      bus.closed = true;
    },
  };
  return { bus, calls };
}

const unitExists = () => {
  throw new DbusError(SYSTEMD.unitExists, "Unit autoheal-packages.service was already loaded");
};

async function helper(commandArguments: string[], bus: Bus) {
  const output = { log: vi.fn(), error: vi.fn() };
  const opened = vi.fn(async () => bus);
  const exitCode = await runHostHelper(commandArguments, output, opened);
  const printed = output.log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
  return { exitCode, printed, opened, output };
}

describe("the host helper", () => {
  it.each([
    ["an unknown package manager", ["yum", "check", JOB]],
    ["no package manager", ["check", JOB]],
    ["an unknown verb", ["apt", "install", JOB, "openssl"]],
    ["a job that is not a UUID", ["apt", "check", "../../etc/passwd"]],
    ["an upgrade naming nothing", ["apt", "upgrade", JOB]],
    ["a check naming packages", ["apt", "check", JOB, "openssl"]],
    ["a removal naming packages", ["dnf", "autoremove", JOB, "kernel"]],
    ["a repair on dnf, which has none", ["dnf", "repair", JOB]],
    ["a name that is shell", ["apt", "upgrade", JOB, "openssl;reboot"]],
    ["a name that is an apt option", ["apt", "upgrade", JOB, "-oAPT::Get::AllowUnauthenticated=1"]],
    ["a name that is a dnf option", ["dnf", "upgrade", JOB, "--nogpgcheck"]],
    ["too many names", ["apt", "upgrade", JOB, ...Array.from({ length: HOST_PACKAGE_LIMIT + 1 }, (_, i) => `pkg${i}`)]],
  ])("refuses %s without touching the bus", async (_case, commandArguments) => {
    const { bus } = fakeBus({});
    const { exitCode, opened, output } = await helper(commandArguments, bus);

    expect(exitCode).toBe(EXIT_USAGE);
    expect(opened).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("asks systemd for the one package unit, failing rather than queueing behind another", async () => {
    const { bus, calls } = fakeBus({ [SYSTEMD.startTransientUnit]: () => ["/org/freedesktop/systemd1/job/1"] });
    const { exitCode, printed } = await helper(["apt", "upgrade", JOB, "openssl", "curl"], bus);

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(printed).toEqual([{ outcome: "started" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      destination: SYSTEMD.name,
      interface: SYSTEMD.manager,
      member: SYSTEMD.startTransientUnit,
      body: ["autoheal-packages.service", "fail", expect.any(Array), []],
    });
    expect(bus.closed).toBe(true);
  });

  it("says busy when a package run is already going on", async () => {
    const { bus } = fakeBus({ [SYSTEMD.startTransientUnit]: unitExists });
    const { exitCode, printed } = await helper(["dnf", "check", JOB], bus);

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(printed).toEqual([{ outcome: "busy" }]);
  });

  it("reboots through the same unit, so never in the middle of a package run", async () => {
    const started = fakeBus({ [SYSTEMD.startTransientUnit]: () => ["/org/freedesktop/systemd1/job/9"] });
    const busy = fakeBus({ [SYSTEMD.startTransientUnit]: unitExists });

    expect((await helper(["apt", "reboot", JOB], started.bus)).printed).toEqual([{ outcome: "started" }]);
    expect(started.calls[0]?.body?.[0]).toBe("autoheal-packages.service");
    expect((await helper(["dnf", "reboot", JOB], busy.bus)).printed).toEqual([{ outcome: "busy" }]);
  });

  it("reports why it failed, and still closes the bus", async () => {
    const { bus } = fakeBus({
      [SYSTEMD.startTransientUnit]: () => {
        throw new DbusError("org.freedesktop.DBus.Error.AccessDenied", "Access denied");
      },
    });
    const { exitCode, printed } = await helper(["apt", "check", JOB], bus);

    expect(exitCode).toBe(EXIT_FAILURE);
    expect(printed).toEqual([{ outcome: "failed", reason: "Access denied" }]);
    expect(bus.closed).toBe(true);
  });

  it("reports a bus it cannot reach", async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    const exitCode = await runHostHelper(["apt", "check", JOB], output, async () => {
      throw new Error("connect ENOENT /run/dbus/system_bus_socket");
    });

    expect(exitCode).toBe(EXIT_FAILURE);
    expect(JSON.parse(String(output.log.mock.calls[0]![0]))).toEqual({
      outcome: "failed",
      reason: "connect ENOENT /run/dbus/system_bus_socket",
    });
  });
});
