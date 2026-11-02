import { describe, expect, it } from "vitest";
import { JARVIS_LIMITS, jarvisSay, jarvisSetup, matchSpoken, spokenName } from "../../shared/jarvis.js";
import type { ContainerView, HostView } from "../../shared/api.js";
import { isBuildContainer, planJarvis, type JarvisCandidate } from "./jarvis-filter.js";
import { fleetSummary } from "./jarvis-summary.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const candidate = (detectorKey: string, overrides: Partial<JarvisCandidate> = {}): JarvisCandidate => ({
  taskId: detectorKey,
  detectorKey,
  priority: "medium",
  hostId: "h1",
  hostLabel: "DeltaAv1",
  resource: null,
  createdAt: NOW - HOUR,
  ...overrides,
});

describe("what Jarvis is told", () => {
  it("leaves out what comes and goes, and what Jarvis knows already", () => {
    const quiet = ["anomaly|a|cpu|b", "temperature:h1", "watched:x", "ha-updates", "zigbee-link:z", "safety:s"];
    expect(
      planJarvis(
        quiet.map((key) => candidate(key)),
        [],
        NOW,
      ),
    ).toEqual([]);
  });

  it("waits, so what fixes itself is never told", () => {
    const fresh = candidate("container:h1:sonarr", { createdAt: NOW - JARVIS_LIMITS.settleMilliseconds + 1 });
    expect(planJarvis([fresh], [], NOW)).toEqual([]);
    const settled = { ...fresh, createdAt: NOW - JARVIS_LIMITS.settleMilliseconds };
    expect(planJarvis([settled], [], NOW)).toHaveLength(1);
  });

  it("makes one sentence of a host's updates", () => {
    const planned = planJarvis(
      [
        candidate("update:h1:sonarr", { resource: "sonarr" }),
        candidate("update:h1:radarr", { resource: "radarr" }),
        candidate("update:h2:forgejo", { hostId: "h2", resource: "forgejo" }),
      ],
      [],
      NOW,
    );
    expect(planned).toHaveLength(2);
    expect(planned.find(({ hostId }) => hostId === "h1")?.names).toEqual(["radarr", "sonarr"]);
  });

  it("does not say the same thing twice, nor soon after", () => {
    const [first] = planJarvis([candidate("reboot:h1")], [], NOW);
    const said = {
      groupKey: first!.groupKey,
      fingerprint: first!.fingerprint,
      tier: first!.tier,
      at: NOW - HOUR,
      counted: true,
    };
    expect(planJarvis([candidate("reboot:h1")], [said], NOW)).toEqual([]);
    const later = { ...said, at: NOW - 2 * JARVIS_LIMITS.repeatMilliseconds };
    expect(planJarvis([candidate("reboot:h1")], [later], NOW)).toEqual([]);
    expect(planJarvis([candidate("reboot:h1", { taskId: "new episode" })], [said], NOW)).toEqual([]);
    expect(planJarvis([candidate("reboot:h1", { taskId: "new episode" })], [later], NOW)).toHaveLength(1);
  });

  it("says at most a few a day, the most important first, and the urgent always", () => {
    const keys = ["reboot:a", "reboot:b", "reboot:c", "reboot:d"];
    const many = keys.map((key) => candidate(key, { priority: "low" }));
    const high = candidate("disk:h1:/data", { priority: "high", resource: "/data" });
    const silent = candidate("host-silent:h1");
    const planned = planJarvis([...many, high, silent], [], NOW);
    expect(planned.filter(({ tier }) => tier === "say")).toHaveLength(JARVIS_LIMITS.perDay);
    expect(planned.map(({ kind }) => kind).slice(0, 2)).toEqual(["host_silent", "disk"]);

    const full = Array.from({ length: JARVIS_LIMITS.perDay }, (_, index) => ({
      groupKey: `g${index}`,
      fingerprint: `f${index}`,
      tier: "say" as const,
      at: NOW - HOUR,
      counted: true,
    }));
    expect(planJarvis([...many, silent], full, NOW).map(({ kind }) => kind)).toEqual(["host_silent"]);
  });

  it("leaves out anything there to build things, by name or image", () => {
    expect(isBuildContainer("buildx_buildkit_app-builder0", "moby/buildkit:buildx-stable-1")).toBe(true);
    expect(isBuildContainer("CI-BUILDER", null)).toBe(true);
    expect(isBuildContainer("helper", "moby/buildkit:latest")).toBe(true);
    expect(isBuildContainer("sonarr", "linuxserver/sonarr:4")).toBe(false);
  });

  it("does not count against the day what never reached anyone", () => {
    const lost = Array.from({ length: JARVIS_LIMITS.perDay }, (_, index) => ({
      groupKey: `g${index}`,
      fingerprint: "",
      tier: "say" as const,
      at: NOW - HOUR,
      counted: false,
    }));
    expect(planJarvis([candidate("reboot:h1")], lost, NOW)).toHaveLength(1);
  });

  it("works out which machine was meant from what was heard", () => {
    const targets = [
      { target: "delta", names: ["Delta3640"] },
      { target: "av", names: ["DeltaAv1"] },
      { target: "rowan", names: ["Rowan", "Tower", "the laptop"] },
      { target: "cedar1", names: ["cedar1"] },
      { target: "cedar2", names: ["cedar2"] },
    ];
    expect(matchSpoken("delta thirty six forty", targets)).toEqual(["delta"]);
    expect(matchSpoken("Delta 3640", targets)).toEqual(["delta"]);
    expect(matchSpoken("delta a v one", targets)).toEqual(["av"]);
    expect(matchSpoken("The Laptop", targets)).toEqual(["rowan"]);
    expect(matchSpoken("tower", targets)).toEqual(["rowan"]);
    expect(matchSpoken("rowen", targets)).toEqual(["rowan"]);
    expect(matchSpoken("cedar three", targets)).toEqual([]);
    expect(matchSpoken("toaster", targets)).toEqual([]);
    expect(matchSpoken("", targets)).toEqual([]);
    // A machine's own name beats another's alias.
    expect(
      matchSpoken("x", [
        { target: "a", names: ["b", "x"] },
        { target: "b", names: ["x"] },
      ]),
    ).toEqual(["b"]);
  });

  it("counts containers as the host's card does: one left unwatched is stopped on purpose", () => {
    const host = { id: "h1", label: "Rowan", state: "online" } as HostView;
    const container = (name: string, state: string, restart: string) =>
      ({
        name,
        state,
        hostId: "h1",
        hostLabel: "Rowan",
        image: "app:1",
        problem: null,
        update: {},
        byItself: { restart },
      }) as unknown as ContainerView;
    const { say } = fleetSummary(
      [host],
      [
        container("up", "running", "alone"),
        container("down", "exited", "alone"),
        container("parked", "exited", "ignore"),
      ],
      [],
    );
    expect(say).toContain("with 1 of 2 containers running");
  });

  it("gives each machine its own sentence, under all its names and with no wildcard", () => {
    const setup = jarvisSetup("https://a", "w", [
      { label: "Rowan", aliases: ["rowen", "the-laptop"] },
      { label: "Delta3640", aliases: [] },
    ]);
    expect(setup).toContain("id: rowan");
    expect(setup).toContain("- (how is|how's) (rowan|rowen|the laptop) [doing]");
    expect(setup).toContain("- (how is|how's) (delta3640|delta thirty six forty) [doing]");
    expect(setup).not.toContain("(how is|how's) {machine}");
  });

  it("says names as they are read", () => {
    expect(spokenName("Delta3640")).toBe("Delta thirty six forty");
    expect(spokenName("DeltaAv1")).toBe("Delta A v one");
    expect(spokenName("home-media-manager")).toBe("home media manager");
    expect(spokenName("OLLAMA-WEBUI")).toBe("ollama webui");
    expect(jarvisSay({ kind: "container_updates", host: "Rowan", names: ["sonarr"] })).toBe(
      "An update is waiting for sonarr on Rowan, sir.",
    );
    expect(jarvisSay({ kind: "container_updates", host: "Rowan", names: ["a", "b", "c", "d"] })).toContain(
      "4 containers",
    );
  });
});
