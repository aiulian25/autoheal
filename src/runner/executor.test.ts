import { describe, expect, it } from "vitest";
import { instantTime } from "../../test/support/instant-time.js";
import {
  BACK_VERIFY,
  MILLISECONDS_PER_SECOND,
  RESTART_CHOICE,
  RESTART_VERIFY,
  VERDICT_SKIPPED,
} from "../shared/constants.js";
import type { HeartbeatResponse, HostControl } from "../shared/protocol.js";
import { Executor, restartChoiceOf } from "./executor.js";
import type { ContainerDetails, ContainerState } from "./incident-report.js";
import { RemedyGuard } from "./remedy-guard.js";

// The container each incident here is about.
const FAILED = "paperless";
const RUNNING: ContainerState = { Running: true };

interface Setup {
  dryRun?: boolean;
  failRestart?: boolean;
  asksFirst?: readonly string[];
  onlyTells?: readonly string[];
  // What each look at the restarted container finds; the last one again from then on.
  states?: readonly ContainerState[];
  // The container that failed, when a dependency was restarted for it: what each look finds, and its restart policy.
  failed?: { states: readonly ContainerState[]; restartPolicy: string };
  // Called before each look, with the container and how many looks at it came before.
  beforeLook?: (container: string, looks: number, guard: RemedyGuard) => void;
}

const setup = ({
  dryRun = false,
  failRestart = false,
  asksFirst = [],
  onlyTells = [],
  states = [RUNNING],
  failed,
  beforeLook = () => undefined,
}: Setup = {}) => {
  const restarted: string[] = [];
  const looks = new Map<string, number>();
  const docker = {
    restart: async (name: string) => {
      if (failRestart) {
        throw new Error("container is marked for removal");
      }
      restarted.push(name);
    },
    inspect: async (name: string): Promise<ContainerDetails> => {
      const count = looks.get(name) ?? 0;
      // Resource discovery before restart is not one of the post-restart verification samples.
      if (restarted.length > 0) {
        looks.set(name, count + 1);
        beforeLook(name, count, guard);
      }
      const seen = failed !== undefined && name === FAILED ? failed : { states, restartPolicy: undefined };
      const state = seen.states[Math.min(count, seen.states.length - 1)]!;
      return {
        Name: `/${name}`,
        State: state,
        Config: { Image: name },
        HostConfig: { RestartPolicy: { Name: seen.restartPolicy } },
      };
    },
  };
  const time = instantTime();
  const protectedContainers = new Set(["npm"]);
  const guard = new RemedyGuard(protectedContainers, () => time.clock() / MILLISECONDS_PER_SECOND);
  const executor = new Executor(
    docker,
    guard,
    { dryRun, protectedContainers },
    (name) => {
      if (onlyTells.includes(name)) {
        return RESTART_CHOICE.tell;
      }
      return asksFirst.includes(name) ? RESTART_CHOICE.ask : RESTART_CHOICE.restart;
    },
    time.wait,
    time.clock,
  );
  const allLooks = () => [...looks.values()].reduce((total, count) => total + count, 0);
  return { executor, restarted, guard, time, looks: allLooks };
};

const decision = (action: "restart" | "restart_dependency" | "escalate", target = FAILED) => ({
  action,
  target,
  diagnosis: "because",
});

const stoppedWith = (exitCode: number): ContainerState => ({ Running: false, ExitCode: exitCode });
const health = (status: string): ContainerState => ({ Running: true, Health: { Status: status } });
const BETWEEN_RESTARTS: ContainerState = { Running: false, Restarting: true };

describe("Executor", () => {
  it("does not restart through a container-group lease or a host-wide lease", async () => {
    const { executor, restarted, guard } = setup();
    const group = await guard.operations.acquire([`name:${FAILED}`, "name:provider"]);
    expect((await executor.carryOut(decision("restart"), FAILED)).executed).toBe(false);
    group.release();
    const host = await guard.operations.acquire(null);
    expect((await executor.carryOut(decision("restart"), FAILED)).executed).toBe(false);
    host.release();
    expect(restarted).toEqual([]);
  });

  it("never spends restart budget or starts a container blocked by recovery", async () => {
    const { executor, guard, restarted } = setup();
    guard.rollbackOf = async () => ({
      version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      owner: FAILED,
      phase: "prepared",
      at: null,
      members: [{ name: FAILED, id: "original", replacementId: "replacement", running: true, restore: true }],
    });
    expect(await executor.carryOut(decision("restart"), FAILED, true)).toMatchObject({
      executed: false,
      verdict: VERDICT_SKIPPED,
    });
    expect(restarted).toEqual([]);
    expect(guard.takeRestart(FAILED)).toBe(true);
    expect(guard.takeRestart(FAILED)).toBe(true);
  });

  it("holds both the target and failed container throughout dependency restart verification", async () => {
    const { executor, guard } = setup({
      beforeLook: () => {
        expect(guard.operations.tryAcquire(["name:tika"])).toBeNull();
        expect(guard.operations.tryAcquire([`name:${FAILED}`])).toBeNull();
      },
    });
    await executor.carryOut(decision("restart_dependency", "tika"), FAILED);
    const released = guard.operations.tryAcquire(["name:tika", `name:${FAILED}`]);
    expect(released).not.toBeNull();
    released!.release();
  });
  it("asks you first about a container its host's page does not let it restart, unless you chose the restart", async () => {
    const { executor, restarted } = setup({ asksFirst: [FAILED] });

    expect(await executor.carryOut(decision("restart"), FAILED)).toEqual({
      outcome: "Would restart paperless, but its host's page says to ask you first: nothing was changed.",
      verdict: "needs you",
      executed: false,
    });
    expect(restarted).toEqual([]);
    expect(await executor.carryOut(decision("restart"), FAILED, true)).toMatchObject({ verdict: "restarted" });
    expect(restarted).toEqual([FAILED]);
  });

  it("asks you first about a dependency restarted for a container that asks first, though the dependency need not", async () => {
    const { executor, restarted } = setup({ asksFirst: [FAILED] });

    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).toEqual({
      outcome:
        "Would restart tika for paperless, but its host's page says to ask you first about paperless: nothing was changed.",
      verdict: "needs you",
      executed: false,
    });
    expect(restarted).toEqual([]);
    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED, true)).toMatchObject({
      executed: true,
    });
    expect(restarted).toEqual(["tika"]);
  });

  it("still asks first about a dependency that itself asks first, for a container that may be restarted", async () => {
    const { executor, restarted } = setup({ asksFirst: ["tika"] });

    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).toMatchObject({
      outcome: "Would restart tika, but its host's page says to ask you first: nothing was changed.",
      executed: false,
    });
    expect(restarted).toEqual([]);
  });

  it("only tells about a container its host's page says only to tell about, whatever was decided", async () => {
    const { executor, restarted } = setup({ onlyTells: [FAILED] });

    for (const action of ["restart", "escalate"] as const) {
      expect(await executor.carryOut(decision(action), FAILED)).toEqual({
        outcome: "paperless failed, and its host's page says only to tell you: nothing was changed.",
        verdict: "left alone",
        executed: false,
      });
    }
    expect(restarted).toEqual([]);
  });

  it("takes the host's page from the control plane's last answer", () => {
    const answer = (control?: HeartbeatResponse["control"]): HeartbeatResponse => ({
      publicBaseUrl: "https://autoheal.lan",
      ollama: { url: "http://ollama:11434", model: "qwen3:4b-instruct", contextTokens: 16_384 },
      ...(control === undefined ? {} : { control }),
    });
    const control = { restartByDefault: false, restart: { paperless: true }, clearBuildCache: false };

    expect(restartChoiceOf(true, answer(control), "paperless")).toBe("restart");
    expect(restartChoiceOf(true, answer(control), "a-new-one")).toBe("ask");
    const answered = {
      ...control,
      restart: { paperless: false },
      whenFailing: { paperless: "tell", attic: "ignore" },
      whenFailingByDefault: "ask",
    } as const;
    expect(restartChoiceOf(true, answer(answered), "paperless")).toBe("tell");
    expect(restartChoiceOf(true, answer(answered), "attic")).toBe("ignore");
    expect(restartChoiceOf(true, answer(answered), "a-new-one")).toBe("ask");
    // An answer from a newer control plane that this runner does not know: ask first.
    const newer = { ...control, whenFailing: { paperless: "page-someone" } } as unknown as HostControl;
    expect(restartChoiceOf(true, answer(newer), "paperless")).toBe("ask");
    // Before the control plane first answered: ask first.
    expect(restartChoiceOf(true, null, "paperless")).toBe("ask");
    // A control plane from before the host's page, or none at all: as before.
    expect(restartChoiceOf(true, answer(), "paperless")).toBe("restart");
    expect(restartChoiceOf(false, null, "paperless")).toBe("restart");
  });

  it("restarts in live mode, and calls it restarted once it has run through the deliberate-stop window", async () => {
    const { executor, restarted, time } = setup();
    expect(await executor.carryOut(decision("restart"), FAILED)).toEqual({
      outcome: "Restarted paperless.",
      verdict: "restarted",
      executed: true,
    });
    expect(restarted).toEqual([FAILED]);
    expect(time.clock()).toBeGreaterThanOrEqual(RESTART_VERIFY.settleMilliseconds);
  });

  it("escalates a restart the container did not survive", async () => {
    const { executor, restarted } = setup({ states: [RUNNING, stoppedWith(1)] });
    expect(await executor.carryOut(decision("restart"), FAILED)).toEqual({
      outcome: "Restarted paperless, but it stopped again (exit 1); escalating.",
      verdict: "needs you",
      executed: true,
    });
    expect(restarted).toEqual([FAILED]);
  });

  it("escalates a restart that keeps restarting, or turns unhealthy before the window is over", async () => {
    const restarting = setup({ states: [{ Running: true, Restarting: true }] });
    expect((await restarting.executor.carryOut(decision("restart_dependency", "tika"), FAILED)).outcome).toBe(
      "Restarted tika, but it keeps restarting; escalating.",
    );

    // Healthy at once is not enough: it turns unhealthy half a minute in.
    const unhealthy = setup({ states: [...Array<ContainerState>(15).fill(health("healthy")), health("unhealthy")] });
    expect(await unhealthy.executor.carryOut(decision("restart"), FAILED)).toMatchObject({
      outcome: "Restarted paperless, but it reports unhealthy; escalating.",
      verdict: "needs you",
    });
  });

  it("escalates a restarted container whose health check never passes", async () => {
    const { executor, time } = setup({ states: [health("starting")] });
    expect((await executor.carryOut(decision("restart"), FAILED)).outcome).toBe(
      "Restarted paperless, but it was not healthy within 2 minutes; escalating.",
    );
    expect(time.clock()).toBeGreaterThanOrEqual(RESTART_VERIFY.timeoutMilliseconds);
  });

  it("calls it restarted when someone stopped or took over the container while it watched", async () => {
    const stopped = setup({
      states: [RUNNING, stoppedWith(143)],
      beforeLook: (container, looks, guard) => {
        if (looks === 1) {
          guard.noteKill(container);
        }
      },
    });
    expect(await stopped.executor.carryOut(decision("restart"), FAILED)).toMatchObject({ verdict: "restarted" });

    const updated = setup({
      states: [RUNNING, stoppedWith(0)],
      beforeLook: (container, looks, guard) => {
        if (looks === 1) {
          guard.hold(container);
        }
      },
    });
    expect(await updated.executor.carryOut(decision("restart"), FAILED)).toMatchObject({ verdict: "restarted" });
  });

  it("keeps what it did when it cannot look at the container again", async () => {
    const { executor } = setup({
      beforeLook: (_container, looks) => {
        if (looks === 1) {
          throw new Error("Docker is restarting");
        }
      },
    });
    expect(await executor.carryOut(decision("restart"), FAILED)).toEqual({
      outcome: "Restarted paperless.",
      verdict: "restarted",
      executed: true,
    });
  });

  it("after a dependency restart that held, waits for the container that failed to be up again", async () => {
    const { executor, restarted, time } = setup({
      failed: {
        // Down, then between Docker's restarts, then up but not healthy yet, then healthy for good.
        states: [stoppedWith(1), BETWEEN_RESTARTS, health("starting"), health("healthy")],
        restartPolicy: "unless-stopped",
      },
    });
    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).toEqual({
      outcome: "Restarted tika; paperless is up again.",
      verdict: "restarted",
      executed: true,
    });
    expect(restarted).toEqual(["tika"]);
    expect(time.clock()).toBeGreaterThanOrEqual(RESTART_VERIFY.settleMilliseconds + BACK_VERIFY.upMilliseconds);
  });

  it("starts the minute over when the container that failed falls over again", async () => {
    const { executor, time } = setup({
      failed: {
        states: [...Array<ContainerState>(10).fill(RUNNING), stoppedWith(1), RUNNING],
        restartPolicy: "unless-stopped",
      },
    });
    expect((await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).verdict).toBe("restarted");
    // Up from its 12th look on, and a whole minute from there.
    const lastStart = 12 * BACK_VERIFY.pollMilliseconds;
    expect(time.clock()).toBeGreaterThanOrEqual(
      RESTART_VERIFY.settleMilliseconds + lastStart + BACK_VERIFY.upMilliseconds,
    );
  });

  it("escalates at once when Docker will not start the container that failed again", async () => {
    const { executor, time } = setup({ failed: { states: [stoppedWith(1)], restartPolicy: "no" } });
    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).toEqual({
      outcome:
        "Restarted tika, but paperless is not back: Docker does not start it again by itself (its restart policy is no); escalating.",
      verdict: "needs you",
      executed: true,
    });
    expect(time.clock()).toBeLessThan(RESTART_VERIFY.settleMilliseconds + BACK_VERIFY.upMilliseconds);
  });

  it("escalates when the container that failed is not back up in time", async () => {
    const { executor, time } = setup({ failed: { states: [BETWEEN_RESTARTS], restartPolicy: "always" } });
    expect((await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).outcome).toBe(
      "Restarted tika, but paperless is not back: it was not back up within 3 minutes; escalating.",
    );
    expect(time.clock()).toBeGreaterThanOrEqual(RESTART_VERIFY.settleMilliseconds + BACK_VERIFY.timeoutMilliseconds);
  });

  it("claims nothing about the container that failed when it cannot look at it", async () => {
    const { executor } = setup({
      failed: { states: [RUNNING], restartPolicy: "unless-stopped" },
      beforeLook: (container) => {
        if (container === FAILED) {
          throw new Error("Docker is restarting");
        }
      },
    });
    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).toEqual({
      outcome: "Restarted tika.",
      verdict: "restarted",
      executed: true,
    });
  });

  it("leaves the container that failed to the person who stopped it meanwhile", async () => {
    const { executor } = setup({
      failed: { states: [stoppedWith(143)], restartPolicy: "no" },
      beforeLook: (container, looks, guard) => {
        if (container === FAILED && looks === 0) {
          guard.noteKill(container);
        }
      },
    });
    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).toEqual({
      outcome: "Restarted tika.",
      verdict: "restarted",
      executed: true,
    });
  });

  it("only reports in dry-run mode, and watches nothing", async () => {
    const { executor, restarted, looks } = setup({ dryRun: true });
    expect(await executor.carryOut(decision("restart_dependency", "tika"), FAILED)).toMatchObject({
      outcome: "DRY RUN: would restart tika.",
      verdict: "would restart",
    });
    expect(restarted).toEqual([]);
    expect(looks()).toBe(0);
  });

  it("changes nothing for an escalation", async () => {
    const { executor, restarted } = setup();
    expect(await executor.carryOut(decision("escalate"), FAILED)).toEqual({
      outcome: "Needs you, nothing was changed.",
      verdict: "needs you",
      executed: false,
    });
    expect(restarted).toEqual([]);
  });

  it("refuses a protected container whoever decided it", async () => {
    const { executor, restarted } = setup();
    expect((await executor.carryOut(decision("restart_dependency", "npm"), FAILED)).outcome).toBe(
      "Refused to restart npm: it is protected on this host.",
    );
    expect(restarted).toEqual([]);
  });

  it("never restarts the old container an update keeps aside, even when a person approved it", async () => {
    const { executor, restarted } = setup();
    const approved = await executor.carryOut(decision("restart_dependency", "paperless-autoheal-old"), FAILED, true);
    expect(approved.outcome).toBe(
      "Refused to restart paperless-autoheal-old: an update keeps it aside for rolling back, so only a person may start it.",
    );
    expect(restarted).toEqual([]);
  });

  it("stands aside while a person's action (an update) is changing the container", async () => {
    const { executor, restarted, guard } = setup();
    guard.hold(FAILED);
    expect(await executor.carryOut(decision("restart"), FAILED)).toEqual({
      outcome: "paperless was being changed by an action from the dashboard; healing stood aside and changed nothing.",
      verdict: "no longer needed",
      executed: false,
    });
    guard.release(FAILED);
    expect(restarted).toEqual([]);
  });

  it("escalates once the hourly budget is used", async () => {
    const { executor } = setup();
    await executor.carryOut(decision("restart"), FAILED);
    await executor.carryOut(decision("restart"), FAILED);
    expect(await executor.carryOut(decision("restart"), FAILED)).toMatchObject({
      verdict: "needs you",
      outcome: "Wanted to restart paperless, but it was already restarted 2 times this hour; escalating.",
    });
  });

  it("escalates when the restart itself fails", async () => {
    const { executor } = setup({ failRestart: true });
    expect(await executor.carryOut(decision("restart"), FAILED)).toMatchObject({
      verdict: "needs you",
      outcome: "Restart of paperless failed: container is marked for removal",
    });
  });
});
