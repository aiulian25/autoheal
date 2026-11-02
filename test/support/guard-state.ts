import type { DockerVolume } from "../../src/runner/docker-client.js";
import type { GuardTiming } from "../../src/runner/guard-state.js";

/** A persistent engine metadata store and independently adjustable process, boot and wall clocks. */
export function guardStateFixture() {
  const volumes = new Map<string, DockerVolume>();
  const time = { mono: 0, wall: Date.UTC(2026, 9, 26) / 1000, uptime: 10000, bootId: "boot-a" };
  const timing: GuardTiming = {
    clock: () => time.mono,
    wall: () => time.wall,
    uptime: () => time.uptime,
    bootId: () => time.bootId,
  };
  const store = {
    volumes: async (label?: string) =>
      [...volumes.values()].filter((volume) => label === undefined || volume.Labels?.[label] !== undefined),
    createVolume: async (Name: string, Labels: Record<string, string>) => {
      if (!volumes.has(Name)) volumes.set(Name, { Name, Labels });
    },
    removeVolume: async (name: string) => {
      volumes.delete(name);
    },
  };
  const advance = (seconds: number) => {
    time.mono += seconds;
    time.wall += seconds;
    time.uptime += seconds;
  };
  const restart = (seconds = 5) => {
    advance(seconds);
    time.mono = 0;
  };
  return { volumes, time, timing, store, advance, restart };
}
