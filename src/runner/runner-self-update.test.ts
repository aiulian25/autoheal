import { beforeEach, describe, expect, it } from "vitest";
import { SELF_UPDATE } from "../shared/constants.js";
import type { ContainerDetails } from "./incident-report.js";
import { handOverToRelease, type RunnerUpdateDocker, updateTarget } from "./runner-self-update.js";

const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;
const RELEASE = "ghcr.io/example/autoheal:1.2.0";

const runner = (change: Partial<ContainerDetails> = {}): ContainerDetails =>
  ({
    Id: "runner-id",
    Image: OLD,
    Config: { Image: "ghcr.io/example/autoheal:1.0.0" },
    State: { Status: "running", Running: true },
    Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }],
    ...change,
  }) as unknown as ContainerDetails;

/** An engine holding this runner, and whatever image a pull of the release brings. */
function engine() {
  const state = {
    containers: new Map<string, ContainerDetails>([["runner-id", runner()]]),
    pulled: NEW as string | null,
    failPull: false,
    calls: [] as string[],
    created: [] as { name: string; specification: Record<string, unknown> }[],
  };
  const docker: RunnerUpdateDocker = {
    pull: async (reference) => {
      state.calls.push(`pull ${reference}`);
      if (state.failPull) throw new Error("manifest unknown");
    },
    inspect: async (reference) => state.containers.get(reference) ?? null,
    inspectImage: async () => (state.pulled === null ? null : ({ Id: state.pulled } as never)),
    createVolume: async (name) => {
      state.calls.push(`volume ${name}`);
    },
    create: async (name, specification) => {
      state.calls.push(`create ${name}`);
      state.created.push({ name, specification });
      return "helper-id";
    },
    start: async (reference) => {
      state.calls.push(`start ${reference}`);
    },
    remove: async (reference) => {
      state.calls.push(`remove ${reference}`);
    },
  };
  return { state, docker };
}

describe("a sidecar runner moving to its control plane's release", () => {
  let world: ReturnType<typeof engine>;
  const own = { reference: "runner-id", socketPath: "/var/run/docker.sock", socketGroup: 998 };
  beforeEach(() => {
    world = engine();
  });

  it("pulls the release and hands its own container to the helper, from the new image", async () => {
    const result = await handOverToRelease(world.docker, own, RELEASE);

    expect(result.handedOver).toBe(true);
    expect(result.outcome).toContain(RELEASE);
    expect(world.state.calls).toEqual([
      `pull ${RELEASE}`,
      `remove ${SELF_UPDATE.helperName}`,
      `volume ${SELF_UPDATE.runnerVolume}`,
      `create ${SELF_UPDATE.helperName}`,
      `start ${SELF_UPDATE.helperName}`,
    ]);
    const helper = world.state.created[0]!.specification as {
      Image: string;
      Cmd: string[];
      HostConfig: Record<string, unknown>;
    };
    expect(helper.Image).toBe(NEW);
    // Never read unhealthy, nor acted on for it: the image's own check is a runner's.
    expect(world.state.created[0]!.specification).toMatchObject({ Healthcheck: { Test: ["NONE"] } });
    expect(helper.Cmd).toEqual(["self-update", "runner-id", NEW, RELEASE, SELF_UPDATE.runnerMode]);
    expect(helper.HostConfig).toMatchObject({
      Binds: ["/var/run/docker.sock:/var/run/docker.sock", `${SELF_UPDATE.runnerVolume}:/data`],
      GroupAdd: ["998"],
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      NetworkMode: "none",
    });
  });

  it("refuses an unsigned release where the admin asks for a signed one, and starts no helper", async () => {
    const DIGEST = `sha256:${"3".repeat(64)}`;
    world.docker.inspectImage = async () => ({ Id: NEW, RepoDigests: [`ghcr.io/example/autoheal@${DIGEST}`] }) as never;
    let status: "unsigned" | "verified" = "unsigned";
    const provenance = {
      policy: () => ({
        revision: 1,
        publishers: [{ name: "example", publicKey: "irrelevant here" }],
        required: [{ registry: "ghcr.io", repository: "example/autoheal", publishers: [] }],
      }),
      read: async () => ({
        status,
        digest: DIGEST,
        publisher: status === "verified" ? "example" : null,
        checkedAt: 0,
        problem: null,
      }),
    };

    const refused = await handOverToRelease(world.docker, own, RELEASE, provenance as never);
    expect(refused.handedOver).toBe(false);
    expect(refused.outcome).toContain("needs a signed image");
    expect(world.state.created).toEqual([]);

    status = "verified";
    expect((await handOverToRelease(world.docker, own, RELEASE, provenance as never)).handedOver).toBe(true);
  });

  it("changes nothing when it already runs that release", async () => {
    world.state.pulled = OLD;

    const result = await handOverToRelease(world.docker, own, RELEASE);

    expect(result).toEqual({ handedOver: false, outcome: expect.stringContaining("already runs"), upToDate: true });
    expect(world.state.calls).toEqual([`pull ${RELEASE}`]);
  });

  it("changes nothing when the release cannot be pulled, and says why", async () => {
    world.state.failPull = true;

    const result = await handOverToRelease(world.docker, own, RELEASE);

    expect(result.handedOver).toBe(false);
    expect(result.outcome).toContain("manifest unknown");
    expect(world.state.calls).toEqual([`pull ${RELEASE}`]);
  });

  it("never interrupts a helper still at work", async () => {
    world.state.containers.set(
      SELF_UPDATE.helperName,
      runner({ State: { Status: "running", Running: true } as never }),
    );

    const result = await handOverToRelease(world.docker, own, RELEASE);

    expect(result).toEqual({ handedOver: false, outcome: expect.stringContaining("already under way") });
    expect(world.state.calls.some((call) => call.startsWith("create") || call.startsWith("remove"))).toBe(false);
  });

  it("clears a helper that finished before, and goes on", async () => {
    world.state.containers.set(
      SELF_UPDATE.helperName,
      runner({ State: { Status: "exited", Running: false } as never }),
    );

    expect((await handOverToRelease(world.docker, own, RELEASE)).handedOver).toBe(true);
  });

  it("will not start without the socket mounted, since nothing could replace it from here", async () => {
    world.state.containers.set("runner-id", runner({ Mounts: [] }));

    const result = await handOverToRelease(world.docker, own, RELEASE);

    expect(result).toEqual({ handedOver: false, outcome: expect.stringContaining("no Docker socket") });
    expect(world.state.calls).toEqual([]);
  });

  it("keeps a runner started from a channel tag on that tag, pulling it again", async () => {
    world.state.containers.set("runner-id", runner({ Config: { Image: "ghcr.io/example/autoheal:latest" } }));

    const result = await handOverToRelease(world.docker, own, RELEASE);

    expect(result.handedOver).toBe(true);
    expect(world.state.calls[0]).toBe("pull ghcr.io/example/autoheal:latest");
    expect((world.state.created[0]!.specification as { Cmd: string[] }).Cmd[3]).toBe("ghcr.io/example/autoheal:latest");
  });

  it("will not start when it cannot find its own container", async () => {
    world.state.containers.clear();

    expect((await handOverToRelease(world.docker, own, RELEASE)).handedOver).toBe(false);
    expect(world.state.calls).toEqual([]);
  });
});

describe("which image a runner updates to, keeping the person's choice of tag", () => {
  it.each([
    ["registry.example/autoheal:latest", "registry.example/autoheal:latest"],
    ["registry.example/autoheal:1", "registry.example/autoheal:1"],
    ["registry.example/autoheal:1.1", "registry.example/autoheal:1.1"],
    ["registry.example/autoheal:1.1.0", "registry.example/autoheal:1.2.0"],
    ["registry.example/autoheal:1.2.0", "registry.example/autoheal:1.2.0"],
    ["registry.example/autoheal:1.3.0", "registry.example/autoheal:1.3.0"],
    [`registry.example/autoheal@${OLD}`, "registry.example/autoheal:1.2.0"],
  ])("%s → %s", (own, expected) => {
    expect(updateTarget(own, RELEASE)).toBe(expected);
  });
});
