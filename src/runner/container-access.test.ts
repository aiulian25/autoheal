import { expect, it } from "vitest";
import { followContainerAccess } from "./container-access.js";
import type { FileRequest, SettingsRequest } from "../shared/protocol.js";
it("drains admitted file/settings work after aborting its poll", async () => {
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const reported: string[] = [];
  let polled = false;
  const follow = followContainerAccess(
    {
      profile: async () => ({ error: null, profile: null }),
      installs: { answer: async () => ({ error: null, draft: null, checks: [] }) },
      controlPlane: {
        reportHostProfile: async () => undefined,
        reportVolumeLook: async () => undefined,
        reportStack: async () => undefined,
        reportBackup: async () => undefined,
        reportInstall: async () => undefined,
        takeContainerAccessWork: async (signal) => {
          if (!polled) {
            polled = true;
            return {
              terminals: [],
              files: [{ id: "file" } as FileRequest],
              settings: [{ id: "settings" } as SettingsRequest],
            };
          }
          await new Promise<void>((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(new Error("closed")), { once: true }),
          );
          throw new Error("closed");
        },
        reportFileAnswer: async () => {
          reported.push("file");
        },
        reportSettingsAnswer: async () => {
          reported.push("settings");
        },
      },
      terminals: { start: () => {} },
      files: {
        answer: async () => {
          entered();
          await gate;
          return { error: null, entries: null, content: null, truncated: false };
        },
      },
      settings: {
        answer: async () => {
          await gate;
          return { error: null, settings: null };
        },
      },
    },
    controller.signal,
  );
  await started;
  controller.abort();
  let done = false;
  const drain = follow.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await drain;
  expect(reported.sort()).toEqual(["file", "settings"]);
});

it("polls application work independently, flushes reports first, and drains an admitted task at shutdown", async () => {
  const controller = new AbortController();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const order: string[] = [];
  let accessPolls = 0,
    applicationPolls = 0;
  const follow = followContainerAccess(
    {
      profile: async () => ({ error: null, profile: null }),
      installs: { answer: async () => ({ error: null, draft: null, checks: [] }) },
      controlPlane: {
        reportHostProfile: async () => undefined,
        reportVolumeLook: async () => undefined,
        reportStack: async () => undefined,
        reportBackup: async () => undefined,
        reportInstall: async () => undefined,
        takeContainerAccessWork: async (signal) => {
          if (accessPolls++ === 0)
            return { terminals: [], files: [{ id: "ordinary", containerName: "other" } as FileRequest], settings: [] };
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { terminals: [], files: [], settings: [] };
        },
        takeApplicationBackupWork: async () => {
          applicationPolls++;
          order.push("poll");
          return [{ id: "backup" } as import("../shared/application-backups.js").ApplicationBackupTask];
        },
        reportFileAnswer: async () => {
          order.push("file-reported");
        },
        reportSettingsAnswer: async () => {},
      },
      terminals: { start: () => {} },
      files: { answer: async () => ({ error: null, entries: [], content: null, truncated: false }) },
      settings: { answer: async () => ({ error: null, settings: null }) },
      applicationBackups: {
        flush: async () => {
          order.push("flush");
        },
        run: async () => {
          order.push("application-started");
          entered();
          await gate;
          order.push("application-finished");
        },
      },
    },
    controller.signal,
  );
  await started;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order[0]).toBe("flush");
  expect(order).toContain("file-reported");
  expect(applicationPolls).toBe(1);
  controller.abort();
  let done = false;
  const draining = follow.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await draining;
  expect(order.at(-1)).toBe("application-finished");
});

it("refuses shells, files and settings only for containers with incomplete application recovery", async () => {
  const controller = new AbortController();
  const started: string[] = [],
    files: string[] = [],
    settings: string[] = [],
    refused: string[] = [];
  let polls = 0;
  const follow = followContainerAccess(
    {
      profile: async () => ({ error: null, profile: null }),
      installs: { answer: async () => ({ error: null, draft: null, checks: [] }) },
      controlPlane: {
        reportHostProfile: async () => undefined,
        reportVolumeLook: async () => undefined,
        reportStack: async () => undefined,
        reportBackup: async () => undefined,
        reportInstall: async () => undefined,
        takeContainerAccessWork: async (signal) => {
          if (polls++ === 0)
            return {
              terminals: ["blocked", "ordinary"].map((containerName) => ({
                id: containerName,
                containerName,
                columns: 80,
                rows: 24,
                requestedBy: "admin",
              })),
              files: ["blocked", "ordinary"].map(
                (containerName) => ({ id: containerName, containerName }) as FileRequest,
              ),
              settings: ["blocked", "ordinary"].map(
                (containerName) => ({ id: containerName, containerName }) as SettingsRequest,
              ),
            };
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { terminals: [], files: [], settings: [] };
        },
        terminalEnd: async (id, end) => {
          if (end.reason?.includes("recovery")) refused.push(`terminal:${id}`);
        },
        reportFileAnswer: async (id, answer) => {
          if (answer.error?.includes("recovery")) refused.push(`file:${id}`);
        },
        reportSettingsAnswer: async (id, answer) => {
          if (answer.error?.includes("recovery")) refused.push(`settings:${id}`);
        },
      },
      recoveryBlocked: (name) => name === "blocked",
      terminals: {
        start: (terminal) => {
          started.push(terminal.containerName ?? "");
        },
      },
      files: {
        answer: async (request) => {
          files.push(request.containerName);
          return { error: null, entries: [], content: null, truncated: false };
        },
      },
      settings: {
        answer: async (request) => {
          settings.push(request.containerName);
          return { error: null, settings: null };
        },
      },
    },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await follow;
  expect(started).toEqual(["ordinary"]);
  expect(files).toEqual(["ordinary"]);
  expect(settings).toEqual(["ordinary"]);
  expect(refused.sort()).toEqual(["file:blocked", "settings:blocked", "terminal:blocked"]);
});
