import { describe, expect, it } from "vitest";
import {
  JARVIS_LIMITS,
  jarvisQuestion,
  jarvisSay,
  jarvisVersionQuestion,
  jarvisSetup,
  matchSpoken,
  spokenName,
  type JarvisStatus,
} from "../../shared/jarvis.js";
import type { ContainerView, HostView } from "../../shared/api.js";
import {
  isBuildContainer,
  planJarvis,
  type JarvisCandidate,
  type JarvisPlanned,
  type JarvisQuestion,
} from "./jarvis-filter.js";
import { fleetSummary } from "./jarvis-summary.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const candidate = (detectorKey: string, overrides: Partial<JarvisCandidate> = {}): JarvisCandidate => ({
  taskId: detectorKey,
  detectorKey,
  priority: "medium",
  hostId: "h1",
  hostLabel: "OrionBx3",
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
      { target: "orion", names: ["Orion2480"] },
      { target: "bx", names: ["OrionBx3"] },
      { target: "rowan", names: ["Rowan", "Tower", "the laptop"] },
      { target: "cedar1", names: ["cedar1"] },
      { target: "cedar2", names: ["cedar2"] },
    ];
    expect(matchSpoken("orion twenty four eighty", targets)).toEqual(["orion"]);
    expect(matchSpoken("Orion 2480", targets)).toEqual(["orion"]);
    expect(matchSpoken("orion b x three", targets)).toEqual(["bx"]);
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
      null,
    );
    expect(say).toContain("with 1 of 2 containers running");
  });

  it("gives each machine its own sentence, under all its names and with no wildcard", () => {
    const setup = jarvisSetup(
      "https://a",
      "w",
      [
        { label: "Rowan", aliases: ["rowen", "the-laptop"] },
        { label: "Orion2480", aliases: [] },
      ],
      "sir",
    );
    expect(setup).toContain("id: rowan");
    expect(setup).toContain("- (how is|how's) (rowan|rowen|the laptop) [doing]");
    expect(setup).toContain("- (how is|how's) (orion2480|orion twenty four eighty) [doing]");
    expect(setup).not.toContain("(how is|how's) {machine}");
    // Any house fills in its own: none of the house it was first written for.
    expect(setup).toContain('rooms: "assist_satellite.YOUR_SATELLITE"');
    expect(setup).not.toMatch(/speak_here|alias: Jarvis|jarvis_key/);
    expect(setup).toContain('"Autoheal is not answering, sir."');
    expect(jarvisSetup("https://a", "w", [], null)).toContain('"Autoheal is not answering."');
    expect(jarvisSetup("https://a", "w", [], "ma'am")).toContain(`"Autoheal is not answering, ma'am."`);
  });

  it("says names as they are read", () => {
    expect(spokenName("Orion2480")).toBe("Orion twenty four eighty");
    expect(spokenName("OrionBx3")).toBe("Orion B x three");
    expect(spokenName("home-media-manager")).toBe("home media manager");
    expect(spokenName("OLLAMA-WEBUI")).toBe("ollama webui");
    const sonarr = { kind: "container_updates" as const, host: "Rowan", names: ["sonarr"] };
    expect(jarvisSay(sonarr, "sir")).toBe("An update is waiting for sonarr on Rowan, sir.");
    // A connection with no form of address says the same, plainly.
    expect(jarvisSay(sonarr, null)).toBe("An update is waiting for sonarr on Rowan.");
    expect(jarvisSay({ ...sonarr, names: ["a", "b", "c", "d"] }, null)).toBe(
      "4 containers on Rowan have updates waiting.",
    );
  });
});

describe("what Jarvis asks", () => {
  const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
  const update = (name: string, overrides: Partial<NonNullable<JarvisCandidate["ask"]>> = {}, hostId = "h1") =>
    candidate(`update:${hostId}:${name}`, {
      taskId: `${hostId}-${name}`,
      hostId,
      resource: name,
      priority: "low",
      ask: { brings: digest("a"), askable: true, ready: true, ...overrides },
    });
  const onRow = (planned: JarvisPlanned, status: JarvisStatus, overrides: Partial<JarvisQuestion> = {}) => ({
    id: "q1",
    groupKey: planned.groupKey,
    members: planned.members!,
    status,
    sentAt: NOW - HOUR,
    due: false,
    ...overrides,
  });
  const four = ["whoami", "gitea", "umami", "adminer"].map((name) => update(name));

  it("asks about an update a yes would take, and tells the rest as it always has", () => {
    const planned = planJarvis([update("whoami"), update("gitea", { askable: false })], [], NOW);
    expect(planned.map(({ tier, names }) => [tier, names])).toEqual([
      ["say", ["gitea"]],
      ["ask", ["whoami"]],
    ]);
  });

  it("names three at most, holds the rest while it is open, and asks about them once it is answered", () => {
    const [first] = planJarvis(four, [], NOW);
    expect(first).toMatchObject({ tier: "ask", names: ["adminer", "gitea", "umami"] });
    expect(planJarvis(four, [], NOW, [onRow(first!, "asked")])).toEqual([]);
    const [next] = planJarvis(four, [], NOW, [onRow(first!, "declined")]);
    expect(next).toMatchObject({ tier: "ask", names: ["whoami"] });
  });

  it("asks again about an update only once its newer image changed", () => {
    const [first] = planJarvis([update("whoami")], [], NOW);
    const answered = [onRow(first!, "declined")];
    expect(planJarvis([update("whoami")], [], NOW, answered)).toEqual([]);
    const [again] = planJarvis([update("whoami", { brings: digest("b") })], [], NOW, answered);
    expect(again).toMatchObject({ tier: "ask", names: ["whoami"], members: [`h1-whoami@${digest("b")}`] });
    expect(again!.fingerprint).not.toBe(first!.fingerprint);
  });

  it("puts one question at a time, and none it could not carry out at once", () => {
    const [elsewhere] = planJarvis([update("forgejo", {}, "h2")], [], NOW);
    const justSent = onRow(elsewhere!, "sent", { sentAt: NOW - JARVIS_LIMITS.hearMilliseconds + 1 });
    expect(planJarvis([update("whoami")], [], NOW, [justSent])).toEqual([]);
    const unheard = { ...justSent, sentAt: NOW - JARVIS_LIMITS.hearMilliseconds };
    expect(planJarvis([update("whoami")], [], NOW, [unheard])).toHaveLength(1);
    // Not now, and not told either: it is asked once its host and Home Assistant are there.
    expect(planJarvis([update("whoami", { ready: false })], [], NOW)).toEqual([]);
  });

  it("asks a due question again before a new one, once each of its updates could be carried out", () => {
    const [first] = planJarvis([update("whoami")], [], NOW);
    const due = [onRow(first!, "asked", { due: true })];
    const [again] = planJarvis([update("whoami"), update("forgejo", {}, "h2")], [], NOW, due);
    expect(again).toMatchObject({ again: "q1", names: ["whoami"] });
    const [instead] = planJarvis([update("whoami", { ready: false }), update("forgejo", {}, "h2")], [], NOW, due);
    expect(instead).toMatchObject({ names: ["forgejo"] });
    expect(instead!.again).toBeUndefined();
  });

  it("asks about a newer version on its own, never tells one, and holds it for no update question", () => {
    const version = candidate("newer-version:h1:gitea:3.5", {
      taskId: "h1-gitea-3.5",
      resource: "gitea",
      priority: "low",
      ask: { brings: "3.5", askable: true, ready: true },
    });
    expect(planJarvis([version], [], NOW)).toEqual([
      expect.objectContaining({
        kind: "newer_version",
        tier: "ask",
        names: ["gitea"],
        groupKey: "ask:newer_version:h1:gitea",
      }),
    ]);
    expect(planJarvis([{ ...version, ask: { brings: "3.5", askable: false, ready: true } }], [], NOW)).toEqual([]);
    const [updates] = planJarvis([update("whoami")], [], NOW);
    const [asked] = planJarvis([update("whoami"), version], [], NOW, [onRow(updates!, "asked")]);
    expect(asked).toMatchObject({ kind: "newer_version", names: ["gitea"] });
  });

  it("shares the day's allowance with what is told", () => {
    const full = Array.from({ length: JARVIS_LIMITS.perDay }, (_, index) => ({
      groupKey: `g${index}`,
      fingerprint: `f${index}`,
      tier: "ask" as const,
      at: NOW - HOUR,
      counted: true,
    }));
    expect(planJarvis([update("whoami"), candidate("reboot:h1")], full, NOW)).toEqual([]);
    expect(planJarvis([update("whoami"), candidate("host-silent:h1")], full, NOW).map(({ kind }) => kind)).toEqual([
      "host_silent",
    ]);
  });

  it("asks in words that let the owner answer, and says when it asks for the last time", () => {
    expect(jarvisQuestion({ host: "Rowan", names: ["sonarr"] }, false, "sir")).toEqual({
      say: "An update is waiting for sonarr on Rowan, sir. Shall I update it?",
      text: "Rowan: an update is waiting: sonarr. Update it?",
    });
    const last = jarvisQuestion({ host: "OrionBx3", names: ["gitea", "whoami"] }, true, "sir");
    expect(last.say).toBe(
      "Two updates are waiting on Orion B x three, sir: gitea and whoami. Shall I update them? I will not ask again.",
    );
    expect(last.text).toBe("OrionBx3: 2 updates are waiting: gitea, whoami. Update them? I will not ask again.");
    expect(jarvisQuestion({ host: "OrionBx3", names: ["gitea", "whoami"] }, false, null).say).toBe(
      "Two updates are waiting on Orion B x three: gitea and whoami. Shall I update them?",
    );
    expect(jarvisVersionQuestion({ host: "Rowan", name: "gitea", from: "3.4", to: "3.5" }, false, "sir").say).toBe(
      "Version 3.5 of gitea is out, and Rowan runs 3.4, sir. Shall I move it to 3.5?",
    );
    expect(
      jarvisVersionQuestion({ host: "Rowan", name: "gitea", from: "1.21-rootless", to: "1.22-rootless" }, true, "sir"),
    ).toEqual({
      say: "A newer version of gitea is out on Rowan, sir. Shall I move to it? I will not ask again.",
      text: "Rowan: gitea can move from 1.21-rootless to 1.22-rootless. Move it? I will not ask again.",
    });
  });
});
