import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { HOST_TERMINAL_HELPER } from "../shared/constants.js";
import { DockerClient } from "./docker-client.js";
import { hostShellThroughDocker } from "./host-shell.js";

describe("a shell on the runner's own host, through a helper", () => {
  let engine: FakeDockerEngine;

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    const runner = exitedContainer("autoheal");
    engine.add({ ...runner, Image: "sha256:autoheal", State: { ...runner.State, Status: "running", Running: true } });
  });

  afterEach(() => engine.close());

  it("runs nsenter as root in a privileged helper of the runner's image in the host's processes, then removes it", async () => {
    const open = hostShellThroughDocker(new DockerClient(engine.socketPath), "autoheal", null);
    const shell = await open(100, 40);
    const [created] = engine.creations;
    expect(created!.name.startsWith(HOST_TERMINAL_HELPER.containerPrefix)).toBe(true);
    expect(created!.specification).toMatchObject({
      Image: "sha256:autoheal",
      User: "0",
      HostConfig: { Privileged: true, PidMode: "host", NetworkMode: "none", AutoRemove: true },
    });
    const [exec] = [...engine.execs.values()];
    expect(exec).toMatchObject({ container: created!.name, command: HOST_TERMINAL_HELPER.shell(null), tty: true });
    expect(engine.removals).toEqual([]);

    const ended = new Promise((resolve) => shell.socket.once("end", resolve));
    shell.socket.resume();
    shell.socket.write("exit\r");
    await ended;
    expect(await shell.exitCode()).toBe(0);
    await expect.poll(() => engine.removals.some((removal) => removal.startsWith(created!.name))).toBe(true);
  });

  it("logs in as the user the host's .env names, in their home", async () => {
    const open = hostShellThroughDocker(new DockerClient(engine.socketPath), "autoheal", "alex");
    const shell = await open(100, 40);
    const [exec] = [...engine.execs.values()];
    expect(exec!.command.slice(-3)).toEqual(["su", "-l", "alex"]);
    const ended = new Promise((resolve) => shell.socket.once("end", resolve));
    shell.socket.resume();
    shell.socket.write("exit\r");
    await ended;
  });

  it("leaves no helper behind when its shell cannot be opened", async () => {
    const open = hostShellThroughDocker(new DockerClient(engine.socketPath), "not-there", null);
    await expect(open(100, 40)).rejects.toThrow(/cannot find its own container/);
    expect(engine.creations).toEqual([]);
  });
});
