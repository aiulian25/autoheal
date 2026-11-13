import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ShutdownJournal } from "./shutdown-journal.js";
import type { DockerVolume } from "./docker-client.js";
const barrier = () => {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
};
const store = () => {
  const volumes = new Map<string, DockerVolume>();
  return {
    volumes: async () => [...volumes.values()],
    createVolume: async (Name: string, Labels: Record<string, string>) => {
      volumes.set(Name, { Name, Labels });
    },
    removeVolume: async (name: string) => {
      volumes.delete(name);
    },
  };
};
describe("shutdown write-ahead records", () => {
  it.each(["pull", "stop", "create", "start", "runCommand"])(
    "retains %s before mutation and blocks unsafe replay after reconstruction",
    async (phase) => {
      const storage = store();
      const journal = new ShutdownJournal(storage);
      const gate = barrier();
      const entered = barrier();
      const docker = journal.docker({
        [phase]: async (_id: string, _payload: object) => {
          entered.release();
          await gate.promise;
        },
      });
      const work = journal.run("job:synthetic:update", "app", () =>
        docker[phase]!("immutable-original-id", { Env: ["SYNTHETIC_SECRET"], command: "PRIVATE_COMMAND" }),
      );
      await entered.promise;
      const recovered = new ShutdownJournal(storage);
      const pending = await recovered.pending();
      expect(pending).toMatchObject([
        { operation: "job:synthetic:update", target: "app", phase, reference: "immutable-original-id" },
      ]);
      expect(JSON.stringify(pending)).not.toContain("SYNTHETIC_SECRET");
      expect(JSON.stringify(pending)).not.toContain("PRIVATE_COMMAND");
      await expect(recovered.assertClean()).rejects.toThrow("needs clearing before this runner can start");
      gate.release();
      await work;
      await recovered.assertClean();
      expect(await storage.volumes()).toEqual([]);
    },
  );
  it("never mutates if a phase cannot be persisted", async () => {
    const storage = store();
    let calls = 0;
    const journal = new ShutdownJournal({
      ...storage,
      createVolume: async (name, labels) => {
        if (JSON.parse(labels["autoheal.shutdown.record"]!).phase !== "admitted") throw new Error("disk unavailable");
        await storage.createVolume(name, labels);
      },
    });
    const docker = journal.docker({
      stop: async () => {
        calls++;
      },
    });
    await expect(journal.run("job:stop", "app", () => docker.stop())).rejects.toThrow("disk unavailable");
    expect(calls).toBe(0);
  });
  it("keeps an interrupted record if the operation throws and rejects malformed state", async () => {
    const storage = store();
    const journal = new ShutdownJournal(storage);
    await expect(
      journal.run("job:restore", "app", async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow();
    await expect(new ShutdownJournal(storage).assertClean()).rejects.toThrow(
      "needs clearing before this runner can start",
    );
    await storage.createVolume("bad", { "autoheal.shutdown.journal": "1", "autoheal.shutdown.record": "{}" });
    await expect(journal.pending()).rejects.toThrow();
  });
  it("hands running systemd jobs to restart reconciliation while retaining launch failures", async () => {
    const storage = store();
    const journal = new ShutdownJournal(storage);
    const started = barrier();
    const finish = barrier();
    const running = journal.run("host:host-job-1", "host", async () => {
      await journal.delegate("host-job-1");
      started.release();
      await finish.promise;
    });
    await started.promise;
    const recovered = new ShutdownJournal(storage);
    await recovered.assertClean();
    await recovered.hostLaunchesSettled();
    await expect(recovered.reconcileHostRuns([])).rejects.toThrow("status files are unavailable");
    const result = finish.promise.then(() => ({ succeeded: true, outcome: "done", output: null }));
    await recovered.reconcileHostRuns([{ jobId: "host-job-1", result }]);
    finish.release();
    await running;
  });
  it("retains a finished tombstone on cleanup failure without hiding the operation result", async () => {
    const storage = store();
    const journal = new ShutdownJournal({
      ...storage,
      removeVolume: async () => {
        throw new Error("cleanup unavailable");
      },
    });
    expect(await journal.run("job:start", "app", async () => 42)).toBe(42);
    expect(await journal.pending()).toEqual([]);
    await new ShutdownJournal(storage).assertClean();
    expect((await storage.volumes()).length).toBeGreaterThan(0);
  });

  it("clears a reboot's record and removes its helper at the next start, booted again or not", async () => {
    const storage = store();
    const removed: string[] = [];
    const engine = { ...storage, remove: async (name: string) => void removed.push(name) };
    const journal = new ShutdownJournal(engine);
    const entered = barrier();
    const docker = journal.docker({
      start: async (_name: string) => {
        entered.release();
        // The reboot ends the runner here, before it can note the hand-over to systemd.
        await new Promise(() => undefined);
      },
    });
    void journal.run("host:job-1", "", () => docker.start!("autoheal-helper-job-1"), { reboot: true });
    await entered.promise;

    const next = new ShutdownJournal(engine);
    await next.settleReboots();
    await next.assertClean();
    expect(removed).toEqual(["autoheal-helper-job-1"]);
    expect(await storage.volumes()).toEqual([]);
  });

  it("lets a runner start past a reboot handed to systemd, whose run is never followed again", async () => {
    const storage = store();
    const journal = new ShutdownJournal(storage);
    const handedOver = barrier();
    void journal.run(
      "host:job-3",
      "",
      async () => {
        await journal.delegate("job-3");
        handedOver.release();
        await new Promise(() => undefined);
      },
      { reboot: true },
    );
    await handedOver.promise;

    const next = new ShutdownJournal(storage);
    await next.settleReboots();
    await next.assertClean();
    await next.reconcileHostRuns([]);
    expect(await storage.volumes()).toEqual([]);
  });

  it("clears a reboot's record that a runner up to 1.5.3 left on a host reached over SSH, with no boot", async () => {
    const storage = store();
    const id = randomUUID();
    const record = { version: 1, id, operation: "host:job-4", target: "", at: 1, bootId: null };
    const labels = (step: number, phase: string, reference: string | null) => ({
      "autoheal.shutdown.journal": "1",
      "autoheal.shutdown.record": JSON.stringify({ ...record, step, phase, reference }),
    });
    await storage.createVolume(`autoheal-shutdown-${id}-0`, labels(0, "admitted", null));
    await storage.createVolume(`autoheal-shutdown-${id}-1`, labels(1, "delegated", "job-4"));

    const journal = new ShutdownJournal(storage);
    await journal.settleReboots();
    await journal.assertClean();
    await journal.reconcileHostRuns([]);
    expect(await storage.volumes()).toEqual([]);
  });

  it("leaves any other interrupted host job for a person", async () => {
    const storage = store();
    const journal = new ShutdownJournal(storage);
    const entered = barrier();
    const docker = journal.docker({
      start: async (_name: string) => {
        entered.release();
        await new Promise(() => undefined);
      },
    });
    void journal.run("host:job-2", "", () => docker.start!("autoheal-helper-job-2"));
    await entered.promise;
    const next = new ShutdownJournal(storage);
    await next.settleReboots();
    await expect(next.assertClean()).rejects.toThrow("needs clearing before this runner can start");
  });

  describe("an action interrupted before it changed anything", () => {
    const interrupted = (storage: ReturnType<typeof store>, operation: string) => {
      void new ShutdownJournal(storage).run(operation, "app", () => new Promise(() => undefined));
    };
    const settled = async (storage: ReturnType<typeof store>) => {
      await new Promise((resolve) => setImmediate(resolve));
      const next = new ShutdownJournal(storage);
      await next.settleUntouched();
      return next;
    };

    it.each(["start", "stop", "restart", "pause", "unpause", "update"])("clears a %s by itself", async (action) => {
      const storage = store();
      interrupted(storage, `job:job-1:${action}`);
      await (await settled(storage)).assertClean();
      expect(await storage.volumes()).toEqual([]);
    });

    it.each(["job:job-1:edit", "job:job-1:deploy", "job:job-1:stack_up", "host:job-1", "healing:restart", "file:r"])(
      "leaves %s for a person, as it may change a host where no note sees it",
      async (operation) => {
        const storage = store();
        interrupted(storage, operation);
        await expect((await settled(storage)).assertClean()).rejects.toThrow(
          "needs clearing before this runner can start",
        );
      },
    );

    it("leaves one that had already asked Docker for a change", async () => {
      const storage = store();
      const journal = new ShutdownJournal(storage);
      const docker = journal.docker({ pull: (_image: string) => new Promise(() => undefined) });
      void journal.run("job:job-1:update", "app", () => docker.pull!("redis"));
      await expect((await settled(storage)).assertClean()).rejects.toThrow(
        "needs clearing before this runner can start",
      );
    });
  });
});
