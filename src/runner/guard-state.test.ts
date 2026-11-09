import { Executor } from "./executor.js";
import { ShutdownJournal } from "./shutdown-journal.js";
import { instantTime } from "../../test/support/instant-time.js";
import { describe, expect, it } from "vitest";
import { guardStateFixture } from "../../test/support/guard-state.js";
import {
  DELIBERATE_STOP_WINDOW_SECONDS,
  HANDLE_COOLDOWN_SECONDS,
  MILLISECONDS_PER_SECOND,
  RESTART_WINDOW_SECONDS,
} from "../shared/constants.js";
import { GuardState } from "./guard-state.js";
import { RemedyGuard } from "./remedy-guard.js";

async function initialized() {
  const fixture = guardStateFixture();
  const state = await GuardState.open(fixture.store, fixture.timing);
  fixture.advance(RESTART_WINDOW_SECONDS + 2);
  const guard = new RemedyGuard(new Set(), undefined, null, state);
  const reload = async () =>
    new RemedyGuard(new Set(), undefined, null, await GuardState.open(fixture.store, fixture.timing));
  return { ...fixture, guard, state, reload };
}

function executorFor(guard: RemedyGuard, restart: () => Promise<void>) {
  const time = instantTime();
  return new Executor(
    {
      restart,
      inspect: async (name) => ({
        Id: name,
        Name: `/${name}`,
        Config: { Image: "synthetic:1" },
        State: { Running: true },
      }),
    },
    guard,
    { dryRun: false, protectedContainers: new Set() },
    undefined,
    time.wait,
    time.clock,
  );
}

describe("persistent runner safety state", () => {
  it("preserves deliberate stops and handled cooldowns across process reconstruction", async () => {
    const f = await initialized();
    f.guard.noteKill("stopped");
    expect(f.guard.claim("handled")).toBe(true);
    await f.guard.persisted();
    f.restart();
    const restored = await f.reload();
    expect(restored.claim("stopped")).toBe(false);
    expect(restored.claim("handled")).toBe(false);
    f.advance(DELIBERATE_STOP_WINDOW_SECONDS);
    expect(restored.claim("stopped")).toBe(true);
    expect(restored.claim("handled")).toBe(false);
    f.advance(HANDLE_COOLDOWN_SECONDS);
    expect(restored.claim("handled")).toBe(true);
    await restored.persisted();
  });
  it("expires old credits before catch-up and bounds retained snapshots", async () => {
    const f = await initialized();
    f.guard.takeRestart("app");
    f.guard.takeRestart("app");
    await f.guard.persisted();
    f.restart(RESTART_WINDOW_SECONDS + 2);
    const restored = await f.reload();
    expect(restored.restartsUsed()).toEqual({});
    expect(restored.takeRestart("app")).toBe(true);
    await restored.persisted();
    expect(f.volumes.size).toBe(1);
  });
  it.each([-86400, 86400])("uses boot uptime across a wall-clock change of %s seconds", async (jump) => {
    const f = await initialized();
    f.guard.takeRestart("app");
    f.guard.takeRestart("app");
    f.guard.noteKill("stopped");
    await f.guard.persisted();
    f.restart();
    f.time.wall += jump;
    const restored = await f.reload();
    expect(restored.takeRestart("app")).toBe(false);
    expect(restored.claim("stopped")).toBe(false);
    f.advance(RESTART_WINDOW_SECONDS + 2);
    expect(restored.takeRestart("app")).toBe(true);
    await restored.persisted();
  });
  it("preserves credits conservatively across a new boot with a clock rollback", async () => {
    const f = await initialized();
    f.guard.takeRestart("app");
    f.guard.takeRestart("app");
    await f.guard.persisted();
    f.time.bootId = "boot-b";
    f.time.uptime = 1;
    f.time.mono = 0;
    f.time.wall -= 86400;
    const restored = await f.reload();
    expect(restored.takeRestart("app")).toBe(false);
    f.advance(RESTART_WINDOW_SECONDS);
    expect(restored.takeRestart("app")).toBe(true);
    await restored.persisted();
  });
  it("applies a persisted one-hour hold to first use and erased state, including previously unseen containers", async () => {
    const f = guardStateFixture();
    let state = await GuardState.open(f.store, f.timing);
    let guard = new RemedyGuard(new Set(), undefined, null, state);
    expect(guard.takeRestart("app")).toBe(false);
    expect(guard.claim("app")).toBe(false);
    expect(guard.restartsUsed()).toEqual({});
    await guard.persisted();
    f.restart(20);
    state = await GuardState.open(f.store, f.timing);
    guard = new RemedyGuard(new Set(), undefined, null, state);
    f.advance(RESTART_WINDOW_SECONDS + 2);
    expect(guard.takeRestart("app")).toBe(true);
    await guard.persisted();
    f.volumes.clear();
    f.restart();
    state = await GuardState.open(f.store, f.timing);
    guard = new RemedyGuard(new Set(), undefined, null, state);
    expect(guard.takeRestart("app")).toBe(false);
    expect(guard.takeRestart("unknown-app")).toBe(false);
  });
  it.each(["not JSON", '{"version":99}', '{"version":1,"private":"SyntheticDoNotLog"}'])(
    "refuses malformed state without printing its contents",
    async (record) => {
      const f = guardStateFixture();
      await f.store.createVolume("autoheal-guard-1", { "autoheal.guard.state": "1", "autoheal.guard.record": record });
      await expect(GuardState.open(f.store, f.timing)).rejects.toThrow("safety state is unreadable or invalid");
      expect(f.volumes.size).toBe(1);
    },
  );
  it("fails closed on read/write failure and never silently resets the state", async () => {
    const f = await initialized();
    await expect(
      GuardState.open(
        {
          ...f.store,
          volumes: async () => {
            throw new Error("unavailable");
          },
        },
        f.timing,
      ),
    ).rejects.toThrow("safety state");
    const state = await GuardState.open(f.store, f.timing);
    f.store.createVolume = async () => {
      throw new Error("no space");
    };
    const guard = new RemedyGuard(new Set(), undefined, null, state);
    expect(guard.takeRestart("app")).toBe(true);
    await expect(guard.persisted()).rejects.toThrow("could not be persisted");
    expect(guard.takeRestart("app")).toBe(false);
    expect(guard.claim("other")).toBe(false);
    expect(guard.restartsUsed()).toEqual({ app: 1 });
    expect(f.volumes.size).toBe(1);
  });
  it("says Docker could not be read, not that its state is damaged, when Docker is not up yet", async () => {
    const f = await initialized();
    const notUp = Object.assign(new Error("connect ENOENT /var/run/docker.sock"), { code: "ENOENT" });
    const opening = GuardState.open(
      {
        ...f.store,
        volumes: async () => {
          throw notUp;
        },
      },
      f.timing,
    );
    await expect(opening).rejects.toThrow(/from Docker \(connect ENOENT \/var\/run\/docker\.sock\)/);
    await expect(opening).rejects.not.toThrow("unreadable or invalid");
    // Once it is up, the state it kept is there as it was.
    await expect(GuardState.open(f.store, f.timing)).resolves.toBeInstanceOf(GuardState);
  });

  it("refuses duplicate names and impossible future timestamps", async () => {
    const f = await initialized();
    f.guard.takeRestart("app");
    await f.guard.persisted();
    const volume = [...f.volumes.values()][0]!;
    const original = JSON.parse(volume.Labels!["autoheal.guard.record"]!);
    for (const modified of [
      { ...original, entries: [...original.entries, ...original.entries] },
      { ...original, uncertainAt: original.savedAt + 1 },
    ]) {
      volume.Labels!["autoheal.guard.record"] = JSON.stringify(modified);
      await expect(f.reload()).rejects.toThrow("safety state");
    }
  });
  it("keeps acting when an old snapshot is in use for a moment, and removes it at the next save", async () => {
    const f = await initialized();
    f.guard.takeRestart("app");
    await f.guard.persisted();
    const remove = f.store.removeVolume;
    f.store.removeVolume = async () => {
      throw new Error("volume is in use");
    };
    f.guard.takeRestart("app");
    await f.guard.persisted();
    expect(f.volumes.size).toBe(2);
    expect(f.guard.stateBlocked()).toBe(false);

    f.store.removeVolume = remove;
    f.guard.noteKill("other");
    await f.guard.persisted();
    expect(f.volumes.size).toBe(1);
    expect((await f.reload()).restartsUsed()).toEqual({ app: 2 });
  });
  it("stops recovery once old snapshots keep piling up", async () => {
    const f = await initialized();
    const remove = f.store.removeVolume;
    f.store.removeVolume = async () => {
      throw new Error("volume is in use");
    };
    for (let save = 0; save < 40 && !f.guard.stateBlocked(); save += 1) {
      f.guard.noteKill(`app-${save}`);
      await f.guard.persisted().catch(() => undefined);
    }
    expect(f.guard.stateBlocked()).toBe(true);
    expect(f.volumes.size).toBeLessThanOrEqual(32);
    // Whatever held them gone, a restart reads every snapshot left and clears the old ones.
    f.store.removeVolume = remove;
    f.restart();
    expect((await f.reload()).stateBlocked()).toBe(false);
    expect(f.volumes.size).toBe(1);
  });
  it("does not discard the previous snapshot or permit recovery on an unverified write", async () => {
    const f = await initialized();
    f.store.createVolume = async () => {};
    expect(f.guard.takeRestart("app")).toBe(true);
    await expect(f.guard.persisted()).rejects.toThrow("could not be persisted");
    expect(f.guard.takeRestart("app")).toBe(false);
    expect(f.volumes.size).toBe(1);
  });
  it("does not expire credits when uptime unexpectedly moves backwards on the same boot", async () => {
    const f = await initialized();
    f.guard.takeRestart("app");
    f.guard.takeRestart("app");
    await f.guard.persisted();
    f.time.mono = 0;
    f.time.uptime = 1;
    f.time.wall += 86400;
    const restored = await f.reload();
    expect(restored.takeRestart("app")).toBe(false);
  });
  it("publishes the restart charge before the executor may call Docker", async () => {
    const f = await initialized();
    const write = f.store.createVolume;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.store.createVolume = async (name, labels) => {
      entered();
      await gate;
      await write(name, labels);
    };
    let calls = 0;
    const execution = executorFor(f.guard, async () => {
      const record = JSON.parse([...f.volumes.values()][0]!.Labels!["autoheal.guard.record"]!);
      expect(record.entries.find((entry: { name: string }) => entry.name === "app").restarts).toHaveLength(1);
      calls++;
    }).carryOut({ action: "restart", target: "app", diagnosis: "synthetic" }, "app");
    await started;
    expect(calls).toBe(0);
    release();
    expect((await execution).executed).toBe(true);
    expect(calls).toBe(1);
  });
  it("leaves an execution recovery record and never restarts if the guard charge cannot be saved", async () => {
    const f = await initialized();
    const write = f.store.createVolume;
    f.store.createVolume = async (name, labels) => {
      if (labels["autoheal.guard.state"]) throw new Error("state unavailable");
      await write(name, labels);
    };
    let calls = 0;
    const executor = executorFor(f.guard, async () => {
      calls++;
    });
    const journal = new ShutdownJournal(f.store);
    await expect(
      journal.run("healing:restart", "app", async () => {
        const result = await executor.carryOut({ action: "restart", target: "app", diagnosis: "synthetic" }, "app");
        await f.guard.persisted();
        return result;
      }),
    ).rejects.toThrow("could not be persisted");
    expect(calls).toBe(0);
    expect(await journal.pending()).toMatchObject([{ operation: "healing:restart", target: "app", phase: "admitted" }]);
  });
  it("fails closed at the live-entry bound instead of dropping active safety records", async () => {
    const f = await initialized();
    for (let index = 0; index <= 4096; index++) f.guard.noteKill(`synthetic-${index}`);
    await expect(f.guard.persisted()).rejects.toThrow("could not be persisted");
    expect(f.guard.takeRestart("app")).toBe(false);
    expect(f.guard.recoveryHold()).toEqual({ reason: "state_full", until: null });
    expect(f.volumes.size).toBe(1);
  });
  it("says why automatic recovery is held, and when a hold with no saved state ends by itself", async () => {
    const f = guardStateFixture();
    const startedAt = f.time.wall;
    const guard = new RemedyGuard(new Set(), undefined, null, await GuardState.open(f.store, f.timing));
    const endsAt = (startedAt + RESTART_WINDOW_SECONDS) * MILLISECONDS_PER_SECOND;
    expect(guard.recoveryHold()).toEqual({ reason: "no_saved_state", until: endsAt });
    f.advance(RESTART_WINDOW_SECONDS / 2);
    expect(guard.recoveryHold()).toEqual({ reason: "no_saved_state", until: endsAt });
    f.advance(RESTART_WINDOW_SECONDS / 2);
    expect(guard.recoveryHold()).toBeNull();
    expect(new RemedyGuard(new Set()).recoveryHold()).toBeNull();

    f.store.createVolume = async () => {
      throw new Error("no space");
    };
    guard.noteKill("app");
    await expect(guard.persisted()).rejects.toThrow("could not be persisted");
    expect(guard.recoveryHold()).toEqual({ reason: "save_failed", until: null });
  });
  it("ignores nameless event targets without poisoning the persisted state", async () => {
    const f = await initialized();
    f.guard.noteKill("");
    expect(f.guard.claim("")).toBe(false);
    await f.guard.persisted();
    expect(f.guard.claim("valid-app")).toBe(true);
    await f.guard.persisted();
    expect(f.guard.stateBlocked()).toBe(false);
  });
});
