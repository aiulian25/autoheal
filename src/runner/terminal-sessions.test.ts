import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import type { TerminalEnd, TerminalInput, TerminalStart } from "../shared/protocol.js";
import { DockerClient } from "./docker-client.js";
import { TerminalSessions, type HostShellOpener } from "./terminal-sessions.js";
import { CONTAINER_ACCESS_REFUSALS, HOST_TERMINAL_REFUSALS } from "../shared/constants.js";

const terminal = (containerName: string): TerminalStart => ({
  id: `t-${containerName}`,
  containerName,
  columns: 120,
  rows: 30,
  requestedBy: "admin",
});
const typing = (data: string[], size: TerminalInput["size"] = null): TerminalInput => ({ data, size, closed: false });
const CLOSED: TerminalInput = { data: [], size: null, closed: true };
const NOTHING: TerminalInput = { data: [], size: null, closed: false };
// How long the control plane's wait for keystrokes lasts here, when none come.
const WAIT_MILLISECONDS = 10;

describe("shells in containers", () => {
  let engine: FakeDockerEngine;
  let printed: string[];
  let ended: [string, TerminalEnd][];

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    const paperless = exitedContainer("paperless");
    engine.add({ ...paperless, State: { ...paperless.State, Status: "running", Running: true } });
    engine.add(exitedContainer("tika"));
    const npm = exitedContainer("npm");
    engine.add({ ...npm, State: { ...npm.State, Status: "running", Running: true } });
    printed = [];
    ended = [];
  });

  afterEach(() => engine.close());

  // A control plane that hands out what was typed, then, with nothing more, answers none once its wait ran out.
  const sessionsWith = (
    inputs: TerminalInput[],
    containerAccess = true,
    host: { hostTerminal?: boolean; dryRun?: boolean; hostShell?: HostShellOpener | null; withDocker?: boolean } = {},
  ) =>
    new TerminalSessions({
      docker: host.withDocker === false ? null : new DockerClient(engine.socketPath),
      hostShell: host.hostShell ?? null,
      controlPlane: {
        terminalInput: async () =>
          inputs.shift() ?? new Promise((resolve) => setTimeout(() => resolve(NOTHING), WAIT_MILLISECONDS)),
        terminalOutput: async (_id, data) => void printed.push(Buffer.from(data, "base64").toString()),
        terminalEnd: async (id, end) => void ended.push([id, end]),
      },
      settings: {
        containerAccess,
        dryRun: host.dryRun ?? false,
        protectedContainers: new Set(["npm"]),
        selfContainerName: "autoheal",
        hostTerminal: host.hostTerminal ?? true,
      },
    });

  it("opens a shell where its host allows it, types what comes, sends what it prints, and says how it ended", async () => {
    const sessions = sessionsWith([typing(["ls\r"], { columns: 100, rows: 40 }), typing(["exit\r"])]);
    sessions.start(terminal("paperless"));
    await sessions.settled();

    expect(printed.join("")).toBe("ls\rexit\rbye\r\n");
    expect(ended).toEqual([["t-paperless", { exitCode: 0, reason: null }]]);
    expect([...engine.execs.values()]).toEqual([
      {
        container: "paperless",
        command: ["/bin/sh", "-c", "if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi"],
        tty: true,
        environment: ["TERM=xterm-256color"],
        sizes: ["h=40&w=100"],
        exitCode: 0,
      },
    ]);
  });

  it("types a terminal's answer for the cursor on its own, so busybox does not drop the keys typed behind it", async () => {
    const sessions = sessionsWith([typing(["ec", "\u001b[1;5Rho autoheal\r"]), typing(["exit\r"])]);
    sessions.start(terminal("paperless"));
    await sessions.settled();
    expect(printed.join("")).toBe("echo autoheal\rexit\rbye\r\n");
  });

  it("opens none where its host's .env does not allow it, in a protected container, or in one not running", async () => {
    sessionsWith([], false).start(terminal("paperless"));
    const sessions = sessionsWith([]);
    sessions.start(terminal("npm"));
    sessions.start(terminal("tika"));
    sessions.start(terminal("autoheal"));
    await sessions.settled();

    expect(Object.fromEntries(ended.map(([id, end]) => [id, end.reason]))).toEqual({
      "t-paperless": "Refused: this host's CONTAINER_ACCESS is not on.",
      "t-npm": "Refused: npm is protected on this host.",
      "t-tika": "tika is not running.",
      "t-autoheal": "Refused: the runner does not reach inside its own container.",
    });
    expect(engine.execs.size).toBe(0);
  });

  it("ends the shell when the control plane closes it, as a person would: Ctrl-C, then Ctrl-D", async () => {
    const sessions = sessionsWith([typing(["sleep 1000\r"]), CLOSED]);
    sessions.start(terminal("paperless"));
    await sessions.settled();
    expect(printed.join("")).toBe("sleep 1000\r\u0003\u0004bye\r\n");
    expect(ended).toEqual([["t-paperless", { exitCode: 0, reason: null }]]);
  });

  describe("on the host itself", () => {
    const onHost: TerminalStart = { id: "t-host", containerName: null, columns: 120, rows: 30, requestedBy: "admin" };

    it("opens the shell the runner has for its host, at the size asked, and says how it ended", async () => {
      const asked: [number, number][] = [];
      // A container's shell stands in for the host's: what opens it is the runner's, not the sessions'.
      const docker = new DockerClient(engine.socketPath);
      const hostShell: HostShellOpener = (columns, rows) => {
        asked.push([columns, rows]);
        return docker.openShell("paperless", columns, rows);
      };
      const sessions = sessionsWith([typing(["exit\r"])], false, { hostShell });
      sessions.start(onHost);
      await sessions.settled();
      expect(asked).toEqual([[120, 30]]);
      expect(ended).toEqual([["t-host", { exitCode: 0, reason: null }]]);
    });

    it("opens none where its .env turns it off, in dry-run, or where the runner has no way to", async () => {
      const opened: string[] = [];
      const hostShell: HostShellOpener = async () => {
        opened.push("host");
        throw new Error("never opened");
      };
      for (const host of [{ hostTerminal: false, hostShell }, { dryRun: true, hostShell }, { hostShell: null }]) {
        const sessions = sessionsWith([], true, host);
        sessions.start(onHost);
        await sessions.settled();
      }
      expect(opened).toEqual([]);
      expect(ended.map(([, end]) => end.reason)).toEqual([
        HOST_TERMINAL_REFUSALS.off,
        HOST_TERMINAL_REFUSALS.dryRun,
        HOST_TERMINAL_REFUSALS.unavailable,
      ]);
    });

    it("refuses a container's shell on a host without Docker, saying so", async () => {
      const sessions = sessionsWith([], true, { withDocker: false });
      sessions.start(terminal("paperless"));
      await sessions.settled();
      expect(ended).toEqual([["t-paperless", { exitCode: null, reason: CONTAINER_ACCESS_REFUSALS.noDocker }]]);
    });
  });
});
