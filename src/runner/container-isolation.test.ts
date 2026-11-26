import { describe, expect, it } from "vitest";
import { isolatedContainer } from "./container-isolation.js";
import type { ContainerDetails } from "./incident-report.js";

const isolated = (): ContainerDetails => ({
  Id: "app-id",
  Name: "/app",
  State: { Running: true, Status: "running" },
  Config: { Image: "app:1", Labels: { "com.docker.compose.project": "stack" } },
  HostConfig: { NetworkMode: "bridge" },
  Mounts: [],
});
describe("a container that keeps to itself, as a rollout needs", () => {
  it.each([
    { Privileged: true },
    { CapAdd: ["SYS_ADMIN"] },
    { Devices: [{ PathOnHost: "/dev/sda" }] },
    { DeviceRequests: [{ Driver: "nvidia" }] },
    { DeviceCgroupRules: ["c *:* rwm"] },
    { NetworkMode: "host" },
    { NetworkMode: "container:other" },
    { PidMode: "host" },
    { IpcMode: "container:other" },
    { UTSMode: "host" },
    { UsernsMode: "host" },
    { CgroupnsMode: "host" },
    { Binds: ["/var/run/docker.sock:/socket:ro"] },
    { VolumesFrom: ["other"] },
    { SecurityOpt: ["seccomp=unconfined"] },
    { Mounts: [{ Type: "bind", Source: "/" }] },
  ])("refuses broader host capabilities %j", (config) => {
    expect(isolatedContainer({ ...isolated(), HostConfig: { ...isolated().HostConfig, ...config } })).toBe(false);
  });
  it("requires known inspect metadata and refuses host binds and unnamed/unknown mount types", () => {
    expect(isolatedContainer({ ...isolated(), HostConfig: undefined })).toBe(false);
    expect(isolatedContainer({ ...isolated(), Mounts: undefined })).toBe(false);
    expect(
      isolatedContainer({
        ...isolated(),
        Mounts: [{ Type: "bind", Source: "/srv/app", Destination: "/data" }],
      }),
    ).toBe(false);
    expect(isolatedContainer({ ...isolated(), Mounts: [{ Type: "volume", Destination: "/data" }] })).toBe(false);
    expect(isolatedContainer(isolated())).toBe(true);
    expect(isolatedContainer({ ...isolated(), HostConfig: { SecurityOpt: ["no-new-privileges:true"] } })).toBe(true);
  });
});
