import { describe, expect, it } from "vitest";
import {
  isolatedOperatorContainer,
  operatorAccessTarget,
  unchangedOperatorBoundaries,
} from "./operator-authorization.js";
import type { ContainerDetails } from "./incident-report.js";
import type { ContainerSettings } from "../shared/protocol.js";

const isolated = (): ContainerDetails => ({
  Id: "app-id",
  Name: "/app",
  State: { Running: true, Status: "running" },
  Config: { Image: "app:1", Labels: { "com.docker.compose.project": "stack" } },
  HostConfig: { NetworkMode: "bridge" },
  Mounts: [],
});
const settings = (): ContainerSettings => ({
  environment: [],
  labels: [{ name: "com.docker.compose.project", value: "stack" }],
  mounts: [],
  ports: [],
  restart: { policy: "no", retries: 0 },
});

describe("delegated container isolation", () => {
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
    expect(isolatedOperatorContainer({ ...isolated(), HostConfig: { ...isolated().HostConfig, ...config } })).toBe(
      false,
    );
  });
  it("requires known inspect metadata and refuses host binds and unnamed/unknown mount types", () => {
    expect(isolatedOperatorContainer({ ...isolated(), HostConfig: undefined })).toBe(false);
    expect(isolatedOperatorContainer({ ...isolated(), Mounts: undefined })).toBe(false);
    expect(
      isolatedOperatorContainer({
        ...isolated(),
        Mounts: [{ Type: "bind", Source: "/srv/app", Destination: "/data" }],
      }),
    ).toBe(false);
    expect(isolatedOperatorContainer({ ...isolated(), Mounts: [{ Type: "volume", Destination: "/data" }] })).toBe(
      false,
    );
    expect(isolatedOperatorContainer(isolated())).toBe(true);
    expect(isolatedOperatorContainer({ ...isolated(), HostConfig: { SecurityOpt: ["no-new-privileges:true"] } })).toBe(
      true,
    );
  });
  it("permits a verified exclusive local named volume, rejects bind-backed/remote/shared/unknown volumes", async () => {
    const app = {
      ...isolated(),
      Mounts: [
        { Type: "volume", Name: "app-data", Source: "/var/lib/docker/volumes/app-data/_data", Destination: "/data" },
      ],
    };
    const other = { ...isolated(), Id: "other-id", Name: "/other", Mounts: [] as ContainerDetails["Mounts"] };
    let options: Record<string, string> = {};
    let driver = "local";
    const docker = {
      inspect: async (name: string) => (name === "app" ? app : other),
      inspectVolume: async () => ({ Name: "app-data", Driver: driver, Options: options }),
      containerSummaries: async () => [{ Id: "other-id", Names: ["/other"], State: "running", Status: "Up" }],
    };
    expect(await operatorAccessTarget("app", docker)).toEqual({ name: "app", composeProject: "stack" });
    options = { type: "none", o: "bind", device: "/" };
    expect(await operatorAccessTarget("app", docker)).toBeNull();
    options = {};
    driver = "remote-plugin";
    expect(await operatorAccessTarget("app", docker)).toBeNull();
    driver = "local";
    other.Mounts = [{ Type: "volume", Name: "app-data", Destination: "/data", RW: false }];
    expect(await operatorAccessTarget("app", docker)).toBeNull();
    other.Mounts = [
      { Type: "bind", Source: "/var/lib/docker/volumes/app-data/_data/subfolder", Destination: "/shared" },
    ];
    expect(await operatorAccessTarget("app", docker)).toBeNull();
    expect(await operatorAccessTarget("app", { inspect: docker.inspect })).toBeNull();
  });
  it("allows settings only while mounted data and Compose/AutoHeal control labels remain identical", () => {
    const before = isolated();
    expect(unchangedOperatorBoundaries(before, settings())).toBe(true);
    expect(
      unchangedOperatorBoundaries(before, {
        ...settings(),
        mounts: [{ kind: "volume", source: "other-data", target: "/data", readOnly: false }],
      }),
    ).toBe(false);
    expect(unchangedOperatorBoundaries(before, { ...settings(), labels: [] })).toBe(false);
    expect(
      unchangedOperatorBoundaries(before, {
        ...settings(),
        labels: [{ name: "com.docker.compose.project", value: "other" }],
      }),
    ).toBe(false);
    expect(
      unchangedOperatorBoundaries(before, {
        ...settings(),
        labels: [...settings().labels, { name: "autoheal.update", value: "always" }],
      }),
    ).toBe(false);
    expect(
      unchangedOperatorBoundaries(before, {
        ...settings(),
        labels: [...settings().labels, { name: "com.autoheal.installed", value: "true" }],
      }),
    ).toBe(false);
    expect(
      unchangedOperatorBoundaries(before, { ...settings(), environment: [{ name: "APP_MODE", value: "fixed" }] }),
    ).toBe(true);
  });
});
