import { describe, expect, it } from "vitest";
import { detailsOf, joinableNetworks } from "./container-details.js";
import type { ContainerDetails } from "./incident-report.js";

const inspected = (overrides: Record<string, unknown> = {}) =>
  ({
    Name: "/app",
    Image: "sha256:abc",
    Created: "2026-10-26T09:14:00Z",
    State: {
      Running: true,
      StartedAt: "2026-10-31T00:40:00Z",
      OOMKilled: true,
      Health: {
        Status: "healthy",
        FailingStreak: 0,
        Log: [
          { End: "one", ExitCode: 1, Output: "old" },
          { End: "two", ExitCode: 0, Output: "ok" },
        ],
      },
    },
    Config: {
      Env: ["API_TOKEN=do-not-send-me"],
      Labels: {},
      Entrypoint: ["node"],
      Cmd: ["server.js"],
      WorkingDir: "/app",
      User: "1000:1000",
      Hostname: "app",
      Healthcheck: { Test: ["CMD", "true"], Interval: 30_000_000_000, Timeout: 5_000_000_000 },
    },
    HostConfig: {
      Privileged: false,
      CapAdd: ["NET_ADMIN"],
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined"],
      NanoCpus: 1_500_000_000,
      Memory: 1024,
      PidsLimit: 64,
    },
    AppArmorProfile: "docker-default",
    NetworkSettings: { Networks: { newt: { IPAddress: "172.20.0.7", Gateway: "172.20.0.1", Aliases: ["app"] } } },
    Mounts: [
      { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: false },
      { Type: "volume", Name: "data", Source: "/var/lib/docker/volumes/data", Destination: "/data", RW: true },
    ],
    ...overrides,
  }) as unknown as ContainerDetails;

describe("what a container's panel reads", () => {
  it("says what Docker says, newest health check first, and never its environment", () => {
    const details = detailsOf(inspected(), { Titles: ["PID", "CMD"], Processes: [["1", "node"]] }, [
      { Created: 5, CreatedBy: "COPY . /app", Size: 74 },
    ]);
    expect(JSON.stringify(details)).not.toContain("do-not-send-me");
    expect(details).toMatchObject({
      imageId: "sha256:abc",
      startedAt: "2026-10-31T00:40:00Z",
      command: ["node", "server.js"],
      networks: [{ name: "newt", address: "172.20.0.7", gateway: "172.20.0.1", aliases: ["app"] }],
      security: {
        privileged: false,
        capabilitiesAdded: ["NET_ADMIN"],
        capabilitiesDropped: ["ALL"],
        readOnlyRoot: true,
        noNewPrivileges: true,
        appArmor: "docker-default",
        seccomp: "unconfined",
        dockerSocket: true,
      },
      resources: { cpuCores: 1.5, memoryBytes: 1024, processes: 64, oomKilled: true },
      processes: { titles: ["PID", "CMD"], rows: [["1", "node"]] },
      layers: [{ sizeBytes: 74, createdAt: 5, step: "COPY . /app" }],
    });
    expect(details.health).toMatchObject({ everySeconds: 30, timeoutSeconds: 5, failingStreak: 0 });
    expect(details.health?.checks.map((check) => check.output)).toEqual(["ok", "old"]);
    expect(details.mounts[1]).toEqual({ kind: "volume", source: "data", target: "/data", readOnly: false });
  });

  it("has no health, limits or processes where Docker has none", () => {
    const details = detailsOf(inspected({ State: { Running: false }, HostConfig: {} }), null, []);
    expect(details).toMatchObject({
      health: null,
      processes: null,
      layers: [],
      resources: { cpuCores: null, memoryBytes: null, processes: null, oomKilled: false },
    });
  });
});

describe("the ports a container has", () => {
  it("lists each it has in the container, lowest first, with where the host publishes it as it runs", () => {
    const { ports } = detailsOf(
      inspected({
        Config: { Labels: {}, ExposedPorts: { "3000/tcp": {}, "9229/tcp": {}, "53/udp": {}, "port/tcp": {} } },
        NetworkSettings: {
          Networks: {},
          Ports: {
            "3000/tcp": null,
            "80/tcp": [
              { HostIp: "0.0.0.0", HostPort: "8080" },
              { HostIp: "::", HostPort: "8080" },
            ],
            "53/udp": [{ HostIp: "127.0.0.1", HostPort: "5353" }],
            "70000/tcp": null,
            "25/smtp": null,
          },
        },
      }),
      null,
      [],
    );
    expect(ports).toEqual([
      { port: 53, protocol: "udp", published: [{ address: "127.0.0.1", port: 5353 }] },
      { port: 80, protocol: "tcp", published: [{ address: "", port: 8080 }] },
      { port: 3000, protocol: "tcp", published: [] },
      { port: 9229, protocol: "tcp", published: [] },
    ]);
  });

  it("says where it is set to be published while it is stopped, and lists none it has not", () => {
    const stopped = inspected({
      Config: { Labels: {} },
      HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "8080" }] } },
      NetworkSettings: { Networks: {}, Ports: {} },
    });
    expect(detailsOf(stopped, null, []).ports).toEqual([
      { port: 80, protocol: "tcp", published: [{ address: "", port: 8080 }] },
    ]);
    expect(detailsOf(inspected({ Config: { Labels: {} } }), null, []).ports).toEqual([]);
  });
});

describe("what Autoheal installed", () => {
  it("says where, only for what carries its label", () => {
    const ours = inspected({
      Config: {
        Image: "a",
        Labels: { "com.autoheal.installed": "true", "com.docker.compose.project.working_dir": "/home/me/docker/app" },
      },
    });
    expect(detailsOf(ours, null, []).installedIn).toBe("/home/me/docker/app");
    const theirs = inspected({
      Config: { Image: "a", Labels: { "com.docker.compose.project.working_dir": "/home/me/docker/app" } },
    });
    expect(detailsOf(theirs, null, []).installedIn).toBeUndefined();
  });
});

describe("what a container can join with a click", () => {
  const networks = [
    { Name: "bridge" },
    { Name: "host" },
    { Name: "none" },
    { Name: "npm" },
    { Name: "newt", Labels: { "com.docker.compose.network": "newt" } },
    { Name: "wiki_default", Labels: { "com.docker.compose.network": "default" } },
    { Name: "app_default", Labels: { "com.docker.compose.network": "default" } },
  ];
  const on = (names: string[], mode = "bridge") =>
    inspected({
      HostConfig: { NetworkMode: mode },
      NetworkSettings: { Networks: Object.fromEntries(names.map((name) => [name, {}])) },
    });

  it("offers the host's networks, not Docker's own nor another app's private one, and keeps its own to leave", () => {
    expect(joinableNetworks(on(["app_default"]), networks)).toEqual(["app_default", "newt", "npm"]);
  });

  it("offers nothing in a mode that has no networks to join", () => {
    for (const mode of ["host", "none", "container:other"]) {
      expect(joinableNetworks(on([], mode), networks)).toEqual([]);
    }
  });
});
