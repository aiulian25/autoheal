import { expect, it } from "vitest";
import { FakeDockerEngine } from "../../test/fakes/fake-docker-engine.js";
import { guardStateFixture } from "../../test/support/guard-state.js";
import { RESTART_WINDOW_SECONDS } from "../shared/constants.js";
import { DockerClient } from "./docker-client.js";
import { GuardState } from "./guard-state.js";
import { RemedyGuard } from "./remedy-guard.js";

it("retains safety state through the real Docker volume transport and a new runner client", async () => {
  const engine = await FakeDockerEngine.start();
  try {
    const f = guardStateFixture();
    const docker = new DockerClient(engine.socketPath);
    const state = await GuardState.open(docker, f.timing);
    f.advance(RESTART_WINDOW_SECONDS + 2);
    const guard = new RemedyGuard(new Set(), undefined, null, state);
    expect(guard.takeRestart("synthetic-app")).toBe(true);
    expect(guard.takeRestart("synthetic-app")).toBe(true);
    guard.noteKill("deliberately-stopped");
    expect(guard.claim("already-handled")).toBe(true);
    await guard.persisted();

    f.restart();
    const restartedClient = new DockerClient(engine.socketPath);
    const restartedState = await GuardState.open(restartedClient, f.timing);
    const restored = new RemedyGuard(new Set(), undefined, null, restartedState);
    expect(restored.takeRestart("synthetic-app")).toBe(false);
    expect(restored.claim("deliberately-stopped")).toBe(false);
    expect(restored.claim("already-handled")).toBe(false);
    expect(restored.restartsUsed()).toEqual({ "synthetic-app": 2 });
    expect(await restartedClient.volumes("autoheal.guard.state")).toHaveLength(1);
  } finally {
    await engine.close();
  }
});
