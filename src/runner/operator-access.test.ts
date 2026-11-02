import { describe, expect, it } from "vitest";
import { FileOperations } from "./file-operations.js";
import { SettingsReader } from "./container-settings.js";
import { TerminalSessions } from "./terminal-sessions.js";
import type { ContainerDetails } from "./incident-report.js";
import type { FileRequest, SettingsRequest, TerminalStart, TerminalEnd } from "../shared/protocol.js";

const settings = {
  containerAccess: true,
  dryRun: false,
  selfContainerName: "runner",
  protectedContainers: new Set<string>(),
  hostTerminal: false,
};
const isolated = (): ContainerDetails => ({
  Id: "app-id",
  Name: "/app",
  Image: "image-id",
  Config: { Image: "app:1", Env: ["APP_MODE=safe"] },
  HostConfig: { NetworkMode: "bridge" },
  Mounts: [],
  State: { Status: "running", Running: true },
});
const file = (): FileRequest => ({
  id: "file-id",
  operatorUserId: "operator",
  containerName: "app",
  operation: "list",
  path: "/",
  to: null,
  content: null,
  requestedBy: "viewer",
});

describe("delegated terminal/file/settings requests", () => {
  it("does not list files or reveal settings without fresh permission, and keeps admin behavior", async () => {
    const calls: string[] = [];
    const docker = {
      inspect: async () => isolated(),
      inspectImage: async () => null,
      processes: async () => null,
      imageHistory: async () => [],
      networks: async () => [],
      connect: async () => undefined,
      disconnect: async () => undefined,
      runCommand: async () => {
        calls.push("list");
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
      },
      pathStat: async () => null,
      readEntry: async () => null,
      putArchive: async () => {
        calls.push("put");
      },
    };
    const denied = new FileOperations({ docker, settings, authorizeOperator: async () => false });
    expect((await denied.answer(file())).error).toContain("delegated action");
    expect(calls).toEqual([]);
    const noAuthorizer = new SettingsReader({ docker, settings });
    const request: SettingsRequest = {
      id: "settings-id",
      containerName: "app",
      requestedBy: "viewer",
      operatorUserId: "operator",
    };
    expect((await noAuthorizer.answer(request)).settings).toBeNull();
    const permitted = new SettingsReader({
      docker,
      settings,
      authorizeOperator: async (id, target) => id === "settings-id" && target.name === "app",
    });
    expect((await permitted.answer(request)).settings?.environment).toEqual([{ name: "APP_MODE", value: "safe" }]);
    const adminFile = { ...file(), operatorUserId: undefined };
    expect((await denied.answer(adminFile)).error).toBeNull();
    expect(calls).toEqual(["list"]);
  });
  it("refuses delegated shells on host-access workloads and on unavailable authorizers before exec", async () => {
    const ends: TerminalEnd[] = [];
    let opens = 0;
    let details: ContainerDetails = { ...isolated(), HostConfig: { Privileged: true } };
    const terminal: TerminalStart = {
      id: "terminal-id",
      containerName: "app",
      requestedBy: "viewer",
      columns: 80,
      rows: 24,
      operatorUserId: "operator",
    };
    const sessions = new TerminalSessions({
      hostShell: null,
      docker: {
        inspect: async () => details,
        openShell: async () => {
          opens++;
          throw new Error("must not execute");
        },
      },
      controlPlane: {
        terminalInput: async () => ({ data: [], size: null, closed: true }),
        terminalOutput: async () => {},
        terminalEnd: async (_id, end) => {
          ends.push(end);
        },
      },
      settings,
      authorizeOperator: async () => {
        throw new Error("offline");
      },
    });
    sessions.start(terminal);
    await sessions.settled();
    expect(ends[0]?.reason).toContain("isolated workload");
    details = isolated();
    sessions.start({ ...terminal, id: "second" });
    await sessions.settled();
    expect(ends[1]?.reason).toContain("delegated action");
    expect(opens).toBe(0);
  });
});
