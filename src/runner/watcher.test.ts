import { describe, expect, it } from "vitest";
import { containerIdOf, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { guardStateFixture } from "../../test/support/guard-state.js";
import { containerSnapshot } from "../../test/support/inventory.js";
import {
  ACTION_ESCALATE,
  CATCH_UP_WINDOW_MILLISECONDS,
  COMPOSE_PROJECT_LABEL,
  DECIDED_BY,
  EVENT_KILL,
  MILLISECONDS_PER_MINUTE,
  OLD_CONTAINER_SUFFIX,
  OUTCOMES,
  RECOVERY_HOLD,
  SELF_UPDATE,
  TRIGGER_DIE,
  VERDICT_ESCALATED,
  VERDICT_SKIPPED,
} from "../shared/constants.js";
import type { Decision } from "../shared/decision.js";
import type { ContainerSnapshot, IncidentSubmission, Outcome } from "../shared/protocol.js";
import type { ContainerSummary } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";
import { GuardState } from "./guard-state.js";
import { RemedyGuard } from "./remedy-guard.js";
import { Watcher, type WatcherDependencies } from "./watcher.js";

const NOW = Date.UTC(2026, 9, 24, 9);
const WINDOW_MINUTES = CATCH_UP_WINDOW_MILLISECONDS / MILLISECONDS_PER_MINUTE;
const PROTECTED = new Set(["npm"]);

const crashed = (name: string, minutesAgo: number, exitCode = 1): ContainerSnapshot =>
  containerSnapshot({
    name,
    state: "exited",
    health: "none",
    exitCode,
    finishedAt: NOW - minutesAgo * MILLISECONDS_PER_MINUTE,
  });

// The second look finds each container as `docker` has it (by default still down, exit 1); the decider notes what
// it is asked about. `unwatched`: the containers its host's page leaves unwatched.
// `summaries`: the containers `docker ps` lists, for a report's compose neighbours.
function setup(
  docker: Record<string, ContainerDetails> = {},
  unwatched: readonly string[] = [],
  summaries: ContainerSummary[] = [],
  decide?: WatcherDependencies["decider"]["decide"],
  guard = new RemedyGuard(PROTECTED),
) {
  const asked: IncidentSubmission[] = [];
  const actions: string[] = [];
  const outcomes: Outcome[] = [];
  const watcher = new Watcher({
    docker: {
      inspect: async (name) => docker[name] ?? exitedContainer(name),
      containerNames: async () => new Set(Object.keys(docker)),
      composeProjectNames: async () => new Set(),
      containerSummaries: async () => summaries,
      logs: async () => "",
      allEnvironmentEntries: async () => [],
    },
    guard,
    decider: {
      decide: async (submission) => {
        asked.push(submission);
        if (decide) return decide(submission);
        const decision: Decision = { action: ACTION_ESCALATE, target: submission.report.containerName, diagnosis: "" };
        return { incidentId: null, decision, decidedBy: DECIDED_BY.model };
      },
      recordOutcome: async (_submission, _decided, outcome) => void outcomes.push(outcome),
    },
    executor: {
      carryOut: async (decision) => {
        actions.push(decision.target);
        return { outcome: "Escalated.", verdict: VERDICT_ESCALATED, executed: false };
      },
      watches: (name) => !unwatched.includes(name),
    },
    notify: async () => undefined,
    settings: { protectedContainers: PROTECTED },
    settleMilliseconds: 0,
  });
  const handled = async () => {
    await watcher.settled();
    return asked.map(({ report }) => [report.containerName, report.trigger]);
  };
  return { watcher, handled, asked, actions, outcomes };
}

describe("a failed container's report", () => {
  it("carries how Docker shows the rest of its compose project", async () => {
    const labels = { [COMPOSE_PROJECT_LABEL]: "paperless" };
    const paperless = exitedContainer("paperless", { Config: { Image: "paperless:2", Labels: labels } });
    const database = {
      Id: "db",
      Names: ["/paperless-db"],
      State: "exited",
      Status: "Exited (0) 1 minute ago",
      Labels: labels,
    };
    const { watcher, handled, asked } = setup({ paperless }, [], [database]);
    watcher.catchUp([crashed("paperless", 5)], NOW, null);
    await handled();
    expect(asked[0]?.report.neighbours).toEqual([
      { name: "paperless-db", status: "Exited (0) 1 minute ago", logs: "" },
    ]);
  });
});

describe("catching up once the event stream connects", () => {
  it("handles a container that crashed while nobody listened", async () => {
    const { watcher, handled } = setup();
    expect(watcher.catchUp([crashed("paperless", 5)], NOW, null)).toBe(1);
    expect(await handled()).toEqual([["paperless", "die"]]);
  });

  it("leaves a container someone stopped", async () => {
    const { watcher, handled } = setup();
    expect(watcher.catchUp([crashed("paperless", 5, 143)], NOW, null)).toBe(0);
    expect(await handled()).toEqual([]);
  });

  it("leaves a crash older than the catch-up window", async () => {
    const { watcher, handled } = setup();
    expect(watcher.catchUp([crashed("paperless", WINDOW_MINUTES + 1)], NOW, null)).toBe(0);
    expect(await handled()).toEqual([]);
  });

  it("handles a running container that is unhealthy as unhealthy", async () => {
    const unhealthy = { Status: "running", Running: true, Health: { Status: "unhealthy" } };
    const { watcher, handled } = setup({ paperless: exitedContainer("paperless", { State: unhealthy }) });
    expect(watcher.catchUp([containerSnapshot({ health: "unhealthy" })], NOW, null)).toBe(1);
    expect(await handled()).toEqual([["paperless", "unhealthy"]]);
  });

  it("leaves a protected container", async () => {
    const { watcher, handled } = setup();
    expect(watcher.catchUp([crashed("npm", 5)], NOW, null)).toBe(0);
    expect(await handled()).toEqual([]);
  });

  it("after the stream dropped, handles only what broke since: the events told it about the rest", async () => {
    const { watcher, handled } = setup();
    expect(
      watcher.catchUp([crashed("paperless", 12), crashed("tika", 8)], NOW, NOW - 10 * MILLISECONDS_PER_MINUTE),
    ).toBe(1);
    expect(await handled()).toEqual([["tika", "die"]]);
  });

  it("leaves the old container an update keeps aside", async () => {
    const { watcher, handled } = setup();
    expect(watcher.catchUp([crashed(`paperless${OLD_CONTAINER_SUFFIX}`, 5)], NOW, null)).toBe(0);
    expect(await handled()).toEqual([]);
  });

  it("leaves a container its host's page leaves unwatched, and still handles the others", async () => {
    const { watcher, handled } = setup({}, ["attic"]);
    expect(watcher.catchUp([crashed("attic", 5), crashed("paperless", 5)], NOW, null)).toBe(2);
    expect(await handled()).toEqual([["paperless", "die"]]);
  });

  it("never takes on one of Autoheal's own helpers, as an update's that stays, failed, to say how it went", async () => {
    const { watcher, handled } = setup();
    const labels = { name: SELF_UPDATE.helperName, [SELF_UPDATE.label]: "1", exitCode: "1" };
    await watcher.handleEvent({ Type: "container", Action: TRIGGER_DIE, Actor: { Attributes: labels } });
    expect(await handled()).toEqual([]);
  });

  it("handles a crash once when its die event comes as well", async () => {
    const { watcher, handled } = setup();
    expect(watcher.catchUp([crashed("paperless", 0)], NOW, null)).toBe(1);
    watcher.handleEvent({ Type: "container", Action: "die", Actor: { Attributes: { name: "paperless" } } });
    expect(await handled()).toEqual([["paperless", "die"]]);
  });
});

describe("a stop someone made", () => {
  const event = (Action: string, name: string) => ({ Type: "container", Action, Actor: { Attributes: { name } } });

  it("saves the stops of a burst together, as a stack taken down gives, not one save for each", async () => {
    const fixture = guardStateFixture();
    const state = await GuardState.open(fixture.store, fixture.timing);
    let saves = 0;
    const createVolume = fixture.store.createVolume;
    // As an engine takes a moment over each save.
    fixture.store.createVolume = async (name, labels) => {
      saves += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await createVolume(name, labels);
    };
    const guard = new RemedyGuard(PROTECTED, undefined, null, state);
    const { watcher } = setup({}, [], [], undefined, guard);

    for (const name of Array.from({ length: 10 }, (_, index) => `service-${index}`)) {
      await watcher.handleEvent(event(EVENT_KILL, name));
    }
    await guard.persisted();
    expect(saves).toBeLessThanOrEqual(2);
    // Each stop is kept, and each was deliberate: none of them is a failure to heal.
    expect(guard.claim("service-9")).toBe(false);
  });

  it("goes on to the next event once the guard can no longer save: its hold says so, not a lost stream", async () => {
    const fixture = guardStateFixture();
    const state = await GuardState.open(fixture.store, fixture.timing);
    fixture.store.createVolume = async () => {
      throw new Error("no space");
    };
    const guard = new RemedyGuard(PROTECTED, undefined, null, state);
    const { watcher } = setup({}, [], [], undefined, guard);

    // The first stop's save fails; neither it nor the next stop takes Docker's event stream down with it.
    await expect(watcher.handleEvent(event(EVENT_KILL, "paperless"))).resolves.toBeUndefined();
    await guard.persisted().catch(() => undefined);
    expect(guard.recoveryHold()).toMatchObject({ reason: RECOVERY_HOLD.saveFailed });
    await expect(watcher.handleEvent(event(EVENT_KILL, "redis"))).resolves.toBeUndefined();
    await expect(watcher.handleEvent(event(TRIGGER_DIE, "redis"))).resolves.toBeUndefined();
    // Claims stay refused while nothing can be saved: nothing is restarted meanwhile.
    expect(guard.claim("redis")).toBe(false);
  });
});

describe("watcher shutdown", () => {
  it("wakes pending settle timers and admits no new failures", async () => {
    const { watcher, asked } = setup();
    watcher.catchUp([crashed("app", 1)], NOW, null);
    watcher.stop();
    await watcher.settled();
    expect(asked).toEqual([]);
    expect(watcher.catchUp([crashed("another", 1)], NOW, null)).toBe(0);
  });
  it("does not execute a model decision that arrives after shutdown begins", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { watcher, actions } = setup({}, [], [], async () => {
      entered();
      await gate;
      return {
        incidentId: "incident",
        decidedBy: DECIDED_BY.model,
        decision: { action: "restart", target: "app", diagnosis: "synthetic" },
      };
    });
    watcher.catchUp([crashed("app", 1)], NOW, null);
    await started;
    watcher.stop();
    release();
    await watcher.settled();
    expect(actions).toEqual([]);
  });
});

describe("a restart the model decided while it took its time", () => {
  const ORIGINAL = containerIdOf("app");
  // The model holds its answer until told: meanwhile the container may come back, or be replaced.
  function heldModel() {
    let release!: () => void;
    let entered!: () => void;
    const asking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decide = async () => {
      entered();
      await answer;
      return {
        incidentId: "incident",
        decidedBy: DECIDED_BY.model,
        decision: { action: "restart", target: "app", diagnosis: "synthetic" } as Decision,
      };
    };
    return { decide, asking, release };
  }

  it.each([
    ["came back by itself", { State: { Status: "running", Running: true, ExitCode: 0, OOMKilled: false, Error: "" } }],
    ["was replaced by another", { Id: containerIdOf("app-replacement") }],
  ])("is not carried out once the container %s, and says so", async (_meanwhile, change) => {
    const docker: Record<string, ContainerDetails> = { app: exitedContainer("app", { Id: ORIGINAL }) };
    const model = heldModel();
    const { watcher, actions, outcomes } = setup(docker, [], [], model.decide);
    watcher.catchUp([crashed("app", 1)], NOW, null);
    await model.asking;

    docker.app = exitedContainer("app", { Id: ORIGINAL, ...change });
    model.release();
    await watcher.settled();

    expect(actions).toEqual([]);
    expect(outcomes).toEqual([{ outcome: OUTCOMES.decidedTooLate("app"), verdict: VERDICT_SKIPPED, executed: false }]);
  });

  it("is carried out when the same container is still down", async () => {
    const docker: Record<string, ContainerDetails> = { app: exitedContainer("app", { Id: ORIGINAL }) };
    const model = heldModel();
    const { watcher, actions } = setup(docker, [], [], model.decide);
    watcher.catchUp([crashed("app", 1)], NOW, null);
    await model.asking;

    model.release();
    await watcher.settled();

    expect(actions).toEqual(["app"]);
  });
});
