import { describe, expect, it } from "vitest";
import { SettingsReader } from "./container-settings.js";
import type { ContainerDetails } from "./incident-report.js";

function reader(names: string[], { mode = "bridge", settings = {} } = {}) {
  const current = new Set(names);
  const calls: string[] = [];
  const container = () =>
    ({
      Name: "/app",
      Image: "sha256:abc",
      State: { Running: false },
      Config: { Image: "a/b", Labels: {} },
      HostConfig: { NetworkMode: mode },
      NetworkSettings: { Networks: Object.fromEntries([...current].map((name) => [name, {}])) },
    }) as unknown as ContainerDetails;
  const subject = new SettingsReader({
    docker: {
      inspect: async () => container(),
      inspectImage: async () => null,
      processes: async () => null,
      imageHistory: async () => [],
      networks: async () => [
        { Name: "npm" },
        { Name: "newt" },
        { Name: "secret_default", Labels: { "com.docker.compose.network": "default" } },
      ],
      connect: async (network: string) => {
        calls.push(`connect ${network}`);
        current.add(network);
      },
      disconnect: async (network: string) => {
        calls.push(`disconnect ${network}`);
        current.delete(network);
      },
    } as never,
    settings: {
      containerAccess: true,
      dryRun: false,
      protectedContainers: new Set<string>(),
      selfContainerName: "autoheal",
      ...settings,
    },
  });
  const change = (name: string, joined: boolean) =>
    subject.answer({ id: "1", containerName: "app", requestedBy: "admin", network: { name, joined } });
  return { change, calls };
}

describe("a click on a network", () => {
  it("joins, and answers with what it is on now", async () => {
    const { change, calls } = reader(["app_default"]);
    const answer = await change("npm", true);
    expect(calls).toEqual(["connect npm"]);
    expect(answer.details?.networks.map((network) => network.name).sort()).toEqual(["app_default", "npm"]);
    expect(answer.settings).toBeNull();
  });

  it("leaves one it is on, and does nothing when it already is as asked", async () => {
    const { change, calls } = reader(["npm", "newt"]);
    await change("newt", false);
    await change("npm", true);
    await change("nope", false);
    expect(calls).toEqual(["disconnect newt"]);
  });

  it("will not leave it with no network", async () => {
    const { change, calls } = reader(["npm"]);
    expect((await change("npm", false)).error).toMatch(/only network/);
    expect(calls).toEqual([]);
  });

  it("refuses a network it was not offered, such as another app's private one", async () => {
    const { change, calls } = reader(["npm"]);
    expect((await change("secret_default", true)).error).toMatch(/not a network this container can join/);
    expect((await change("bridge", true)).error).toMatch(/not a network/);
    expect(calls).toEqual([]);
  });

  it("refuses in a mode with no networks to join", async () => {
    const { change, calls } = reader([], { mode: "host" });
    expect((await change("npm", true)).error).toMatch(/network mode host/);
    expect(calls).toEqual([]);
  });

  it("changes nothing where its host says no", async () => {
    for (const settings of [{ dryRun: true }, { containerAccess: false }, { protectedContainers: new Set(["app"]) }]) {
      const { change, calls } = reader(["npm"], { settings });
      expect((await change("newt", true)).error).toBeTruthy();
      expect(calls).toEqual([]);
    }
  });
});
