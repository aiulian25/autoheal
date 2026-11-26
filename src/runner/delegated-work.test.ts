import { describe, expect, it } from "vitest";
import { DELEGATED_WORK_REFUSAL } from "../shared/constants.js";
import type { FileRequest, SettingsRequest, TerminalEnd, TerminalStart } from "../shared/protocol.js";
import { SettingsReader } from "./container-settings.js";
import { FileOperations } from "./file-operations.js";
import type { ContainerDetails } from "./incident-report.js";
import { TerminalSessions } from "./terminal-sessions.js";

const settings = {
  containerAccess: true,
  dryRun: false,
  selfContainerName: "runner",
  protectedContainers: new Set<string>(),
  hostTerminal: false,
};
const running = (): ContainerDetails => ({
  Id: "app-id",
  Name: "/app",
  Image: "image-id",
  Config: { Image: "app:1", Env: ["APP_MODE=safe"] },
  HostConfig: { NetworkMode: "bridge" },
  Mounts: [],
  State: { Status: "running", Running: true },
});
// Docker as far as each of them reaches it: every call is noted, and none should come.
const watchedDocker = (calls: string[]) => {
  const noted =
    <T>(name: string, answer: T) =>
    async () => {
      calls.push(name);
      return answer;
    };
  return {
    inspect: noted("inspect", running()),
    inspectImage: noted("inspectImage", null),
    processes: noted("processes", null),
    imageHistory: noted("imageHistory", []),
    networks: noted("networks", []),
    connect: noted("connect", undefined),
    disconnect: noted("disconnect", undefined),
    runCommand: noted("runCommand", { stdout: "", stderr: "", exitCode: 0, truncated: false }),
    pathStat: noted("pathStat", null),
    readEntry: noted("readEntry", null),
    putArchive: noted("putArchive", undefined),
    openShell: async () => {
      calls.push("openShell");
      throw new Error("must not open");
    },
  };
};

// Only a dashboard from before Autoheal was one person's asks on someone's behalf.
describe("files, settings and shells asked for on someone's behalf", () => {
  it("are refused before Docker is touched, while the owner's own go ahead", async () => {
    const calls: string[] = [];
    const docker = watchedDocker(calls);
    const file: FileRequest = {
      id: "file-id",
      containerName: "app",
      operation: "list",
      path: "/",
      to: null,
      content: null,
      requestedBy: "cedar",
    };
    const files = new FileOperations({ docker, settings });
    expect(await files.answer({ ...file, operatorUserId: "cedar" })).toMatchObject({ error: DELEGATED_WORK_REFUSAL });
    const read: SettingsRequest = { id: "settings-id", containerName: "app", requestedBy: "cedar" };
    const reader = new SettingsReader({ docker, settings });
    expect(await reader.answer({ ...read, operatorUserId: "cedar" })).toEqual({
      error: DELEGATED_WORK_REFUSAL,
      settings: null,
    });
    expect(calls).toEqual([]);

    expect((await files.answer(file)).error).toBeNull();
    expect((await reader.answer(read)).settings?.environment).toEqual([{ name: "APP_MODE", value: "safe" }]);
  });

  it("ends a shell before it opens", async () => {
    const calls: string[] = [];
    const ends: TerminalEnd[] = [];
    const sessions = new TerminalSessions({
      hostShell: null,
      docker: watchedDocker(calls),
      controlPlane: {
        terminalInput: async () => ({ data: [], size: null, closed: true }),
        terminalOutput: async () => {},
        terminalEnd: async (_id, end) => {
          ends.push(end);
        },
      },
      settings,
    });
    const terminal: TerminalStart = {
      id: "terminal-id",
      containerName: "app",
      requestedBy: "cedar",
      columns: 80,
      rows: 24,
      operatorUserId: "cedar",
    };
    sessions.start(terminal);
    await sessions.settled();
    expect(ends).toEqual([{ exitCode: null, reason: DELEGATED_WORK_REFUSAL }]);
    expect(calls).toEqual([]);
  });
});
