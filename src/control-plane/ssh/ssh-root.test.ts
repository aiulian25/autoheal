import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSshServer } from "../../../test/fakes/fake-ssh-server.js";
import { ROOT_METHOD, SSH_STATE } from "../../shared/constants.js";
import { findRootMethod } from "./ssh-root.js";
import { SshSession } from "./ssh-session.js";

const USER = "alex";
const USER_PASSWORD = "the user's own, with a ' and a $";
const ROOT_PASSWORD = "root's own password";
const SETTLE_MILLISECONDS = 5_000;

describe("root commands with a saved password", () => {
  let server: FakeSshServer;
  let session: SshSession;

  beforeEach(async () => {
    const key = FakeSshServer.newHostKey();
    server = await FakeSshServer.start(USER, [key]);
    session = new SshSession(() => ({
      address: "127.0.0.1",
      port: server.port,
      user: USER,
      privateKey: key,
      passphrase: null,
      pinnedHostKey: server.hostKeyBlob(),
    }));
    session.start();
    const started = Date.now();
    while (session.state().state !== SSH_STATE.connected) {
      if (Date.now() - started > SETTLE_MILLISECONDS) throw new Error(session.state().state);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  afterEach(async () => {
    session.close();
    await server.stop();
  });

  const methodFor = (password: string) =>
    findRootMethod((method, command) => session.asRoot(method, password, command));

  it("finds sudo for the user's own password, su for root's, and neither for a wrong one", async () => {
    server.sudoPassword = USER_PASSWORD;
    server.rootPassword = ROOT_PASSWORD;
    expect(await methodFor(USER_PASSWORD)).toBe(ROOT_METHOD.sudo);
    expect(await methodFor(ROOT_PASSWORD)).toBe(ROOT_METHOD.su);
    expect(await methodFor("not it")).toBeNull();
    // A user who may not use sudo: root's password still works, through su.
    server.sudoPassword = null;
    expect(await methodFor(ROOT_PASSWORD)).toBe(ROOT_METHOD.su);
  });

  it("runs a command as root by either way, the command whole and the password never on a command line", async () => {
    server.sudoPassword = USER_PASSWORD;
    server.rootPassword = ROOT_PASSWORD;
    server.exec = (command) => ({ stdout: `ran: ${command}\n` });
    const command = "apt-get -s upgrade 'name with; quotes'";
    const bySudo = await session.asRoot(ROOT_METHOD.sudo, USER_PASSWORD, command);
    const bySu = await session.asRoot(ROOT_METHOD.su, ROOT_PASSWORD, command);
    expect(bySudo).toMatchObject({ exitCode: 0, stdout: `ran: ${command}\n` });
    expect(bySu).toMatchObject({ exitCode: 0 });
    expect(bySu.stdout).toContain(`ran: ${command}`);
    expect(server.rootCommands).toEqual([command, command]);
    expect(server.commands.join("\n")).not.toContain(USER_PASSWORD);
    expect(server.commands.join("\n")).not.toContain(ROOT_PASSWORD);

    const refused = await session.asRoot(ROOT_METHOD.sudo, "wrong", command);
    expect(refused.exitCode).toBe(1);
    expect(server.rootCommands).toHaveLength(2);
  });
});
