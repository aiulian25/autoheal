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
      await expect(recovered.assertClean()).rejects.toThrow("operator recovery");
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
    await expect(new ShutdownJournal(storage).assertClean()).rejects.toThrow("operator recovery");
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

  it("clears a reboot's record and removes its helper once the host has booted again, and not before", async () => {
    const storage = store();
    const removed: string[] = [];
    const engine = { ...storage, remove: async (name: string) => void removed.push(name) };
    const journal = new ShutdownJournal(engine, () => "boot-a");
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

    // Started again in the same boot: the reboot did not happen, so a person decides.
    const sameBoot = new ShutdownJournal(engine, () => "boot-a");
    await sameBoot.settleReboots();
    await expect(sameBoot.assertClean()).rejects.toThrow("operator recovery");
    // Where the boot cannot be read, nothing counts as rebooted.
    const unknownBoot = new ShutdownJournal(engine);
    await unknownBoot.settleReboots();
    await expect(unknownBoot.assertClean()).rejects.toThrow("operator recovery");
    expect(removed).toEqual([]);

    const nextBoot = new ShutdownJournal(engine, () => "boot-b");
    await nextBoot.settleReboots();
    await nextBoot.assertClean();
    expect(removed).toEqual(["autoheal-helper-job-1"]);
    expect(await storage.volumes()).toEqual([]);
  });

  it("leaves any other interrupted host job for a person, even after the host booted again", async () => {
    const storage = store();
    const journal = new ShutdownJournal(storage, () => "boot-a");
    const entered = barrier();
    const docker = journal.docker({
      start: async (_name: string) => {
        entered.release();
        await new Promise(() => undefined);
      },
    });
    void journal.run("host:job-2", "", () => docker.start!("autoheal-helper-job-2"));
    await entered.promise;
    const nextBoot = new ShutdownJournal(storage, () => "boot-b");
    await nextBoot.settleReboots();
    await expect(nextBoot.assertClean()).rejects.toThrow("operator recovery");
  });
});
