import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedSshHost, until, type EmbeddedSshHost } from "../../test/support/embedded-ssh-host.js";
import { API_ROUTES } from "../shared/api.js";
import { COMMAND_MESSAGES, EXIT_SUCCESS, SSH_SESSIONS_PATH, SSH_STATE } from "../shared/constants.js";
import { buildHealthServer } from "../control-plane/server.js";
import { runSelfTest } from "./self-test.js";

const output = () => ({ log: vi.fn(), error: vi.fn() });
const printed = (lines: ReturnType<typeof output>) => lines.log.mock.calls.map(([line]) => String(line));

describe("the self-test command", () => {
  let setup: EmbeddedSshHost | null = null;
  // The control plane's loopback listener, on a port of its own.
  const newHealth = () =>
    buildHealthServer(
      () => true,
      () => setup!.controlPlane.services.inventoryService.sshSessions(),
    );
  let health = newHealth();
  const listen = async () => {
    await health.listen({ host: "127.0.0.1", port: 0 });
    return `http://127.0.0.1:${(health.server.address() as AddressInfo).port}${SSH_SESSIONS_PATH}`;
  };

  afterEach(async () => {
    await health.close();
    health = newHealth();
    await setup?.stop();
    setup = null;
  });

  it("in the control plane's container, says how each SSH host's session stands, and passes when one is down", async () => {
    setup = await startEmbeddedSshHost();
    const { admin, controlPlane, server } = setup;
    // A runner host has no session to report.
    await admin.post(API_ROUTES.hosts, { label: "synology" });
    controlPlane.services.embeddedRunners.begin();
    const session = () => controlPlane.services.inventoryService.sshSessions()[0]!.session;
    await until(session, (current) => current?.state === SSH_STATE.connected);
    const address = await listen();

    const connected = output();
    expect(await runSelfTest([], connected, address)).toBe(EXIT_SUCCESS);
    expect(printed(connected).slice(1)).toEqual([
      COMMAND_MESSAGES.selfTestSshSession("mini", SSH_STATE.connected, null),
    ]);

    await server.stop();
    const down = await until(session, (current) => current !== null && current.state !== SSH_STATE.connected);
    const lost = output();
    expect(await runSelfTest([], lost, address)).toBe(EXIT_SUCCESS);
    expect(printed(lost).slice(1)).toEqual([COMMAND_MESSAGES.selfTestSshSession("mini", down!.state, down!.reason)]);
    expect(lost.error).not.toHaveBeenCalled();
  });

  it("elsewhere, as in a runner's container, says no SSH hosts were checked", async () => {
    // Nothing listens there any more.
    const address = await listen();
    await health.close();
    const lines = output();
    expect(await runSelfTest([], lines, address)).toBe(EXIT_SUCCESS);
    expect(printed(lines)[0]).toMatch(/^Self-test passed/);
    expect(printed(lines).slice(1)).toEqual([COMMAND_MESSAGES.selfTestNoControlPlane]);
  });
});
