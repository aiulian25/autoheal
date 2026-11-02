import { describe, expect, it } from "vitest";
import { STACK_DRIFT_FIELD, STACK_DRIFT_KIND, stackDriftSchema } from "../shared/stacks.js";
import type { ContainerDetails } from "./incident-report.js";
import { driftOf, reconcilableServices, type DeclaredService, type RunningMember } from "./stack-drift.js";

const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);
const SECRET = "the-real-database-password";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const declared = (over: DeclaredService = {}): DeclaredService => ({
  image: "wiki:2",
  environment: { DB_PASS: SECRET, MODE: "live" },
  labels: { team: "home" },
  ports: [{ target: 80, published: "8080", protocol: "tcp", host_ip: "" }],
  volumes: [
    { type: "bind", source: "/srv/wiki/data", target: "/data" },
    { type: "volume", source: "cache", target: "/cache" },
  ],
  restart: "unless-stopped",
  ...over,
});
const member = (over: Partial<ContainerDetails> = {}, overLabels: object = {}): RunningMember => ({
  details: {
    Id: "wiki-id",
    Name: "/wiki-1",
    Image: "sha256:one",
    Config: {
      Image: "wiki:2",
      Env: [`DB_PASS=${SECRET}`, "MODE=live", "PATH=/usr/bin", "FROM_IMAGE=1"],
      Labels: {
        team: "home",
        version: "from-image",
        "com.docker.compose.service": "wiki",
        "com.docker.compose.config-hash": HASH,
        "com.docker.compose.container-number": "1",
        ...overLabels,
      },
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "8080" }] },
    },
    Mounts: [
      { Type: "bind", Source: "/srv/wiki/data", Destination: "/data", RW: true },
      { Type: "volume", Name: "wiki_cache", Destination: "/cache", RW: true },
      { Type: "volume", Name: "f".repeat(64), Destination: "/from-image", RW: true },
      { Type: "bind", Source: "/srv/secret", Destination: "/run/secrets/key", RW: false },
    ],
    State: { Running: true, Status: "running" },
    ...over,
  } as ContainerDetails,
  image: { environment: ["PATH=/usr/bin", "FROM_IMAGE=1"], labels: { version: "from-image" } },
});
const stackWith = (service: DeclaredService, members: RunningMember[], hash = HASH) => ({
  project: "wiki",
  files: ["compose.yaml"],
  declared: { wiki: service },
  hashes: new Map([["wiki", hash]]),
  members,
});
const only = (stack: ReturnType<typeof stackWith>) => driftOf(stack, KEY)?.services[0];

describe("how a stack differs from its files", () => {
  it("says nothing of a stack that matches, whatever Docker and its image add", () => {
    expect(driftOf(stackWith(declared(), [member()]), KEY)).toBeNull();
  });

  it("calls it a change to the files when Compose's hash moved, and names what moved", () => {
    const service = declared({ environment: { DB_PASS: SECRET, MODE: "test" } });
    expect(only(stackWith(service, [member()], OTHER_HASH))).toEqual({
      service: "wiki",
      container: "wiki-1",
      kind: STACK_DRIFT_KIND.source,
      fields: [{ field: STACK_DRIFT_FIELD.environment, names: ["MODE"] }],
    });
  });

  it("says so too when the hash moved and it cannot name what, as with a changed command", () => {
    expect(only(stackWith(declared(), [member()], OTHER_HASH))).toMatchObject({
      kind: STACK_DRIFT_KIND.source,
      fields: [],
    });
  });

  it.each([
    [
      "a setting added by hand",
      member({ Config: { ...member().details.Config, Env: [...member().details.Config.Env!, "EXTRA=1"] } }),
      { field: STACK_DRIFT_FIELD.environment, names: ["EXTRA"] },
    ],
    [
      "a label added by another tool",
      member({}, { managed: "elsewhere" }),
      { field: STACK_DRIFT_FIELD.labels, names: ["managed"] },
    ],
    [
      "a restart policy changed in place",
      member({ HostConfig: { ...member().details.HostConfig, RestartPolicy: { Name: "no", MaximumRetryCount: 0 } } }),
      { field: STACK_DRIFT_FIELD.restart, names: [] },
    ],
    [
      "a port changed",
      member({
        HostConfig: { ...member().details.HostConfig, PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "9090" }] } },
      }),
      { field: STACK_DRIFT_FIELD.ports, names: ["80"] },
    ],
    [
      "a folder swapped",
      member({
        Mounts: member().details.Mounts!.map((each) =>
          each.Destination === "/data" ? { ...each, Source: "/elsewhere" } : each,
        ),
      }),
      { field: STACK_DRIFT_FIELD.mounts, names: ["/data"] },
    ],
    [
      "another image",
      member({ Config: { ...member().details.Config, Image: "wiki:3" } }),
      { field: STACK_DRIFT_FIELD.image, names: [] },
    ],
  ])("sees %s on the container, the files unchanged", (_name, running, field) => {
    expect(only(stackWith(declared(), [running]))).toMatchObject({ kind: STACK_DRIFT_KIND.runtime, fields: [field] });
  });

  it("reports names and never a value, in anything that leaves the host", () => {
    const changed = declared({ environment: { DB_PASS: "the-new-password", MODE: "live" } });
    const drift = driftOf(stackWith(changed, [member()], OTHER_HASH), KEY)!;
    const said = JSON.stringify(drift);
    expect(stackDriftSchema.safeParse(drift).success).toBe(true);
    expect(said).toContain("DB_PASS");
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain("the-new-password");
    expect(said).not.toContain(HASH);
  });

  it("gives another revision when only a value changes, under a key of its own", () => {
    const stack = (password: string) =>
      stackWith(declared({ environment: { DB_PASS: password, MODE: "test" } }), [member()]);
    const revision = driftOf(stack("one"), KEY)!.revision;
    expect(driftOf(stack("one"), KEY)!.revision).toBe(revision);
    expect(driftOf(stack("two"), KEY)!.revision).not.toBe(revision);
    expect(driftOf(stack("one"), OTHER_KEY)!.revision).not.toBe(revision);
  });

  it("does not count what is only noise from Docker or Compose", () => {
    const noisy = member({
      HostConfig: {
        ...member().details.HostConfig,
        PortBindings: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
      },
    });
    const service = declared({ image: "docker.io/library/wiki:2:latest".replace(":2:latest", ":2") });
    expect(driftOf(stackWith(service, [noisy]), KEY)).toBeNull();
    const fromId = member({ Config: { ...member().details.Config, Image: "sha256:one" } });
    expect(driftOf(stackWith(declared(), [fromId]), KEY)).toBeNull();
    const anyPort = declared({ ports: [{ target: 80, protocol: "tcp" }] });
    expect(driftOf(stackWith(anyPort, [member()]), KEY)).toBeNull();
    const shellValue = declared({ environment: { DB_PASS: null, MODE: "live" } });
    expect(driftOf(stackWith(shellValue, [member()]), KEY)).toBeNull();
    const dollars = declared({ environment: { DB_PASS: "a$$b", MODE: "live" } });
    const withDollar = member({
      Config: {
        ...member().details.Config,
        Env: ["DB_PASS=a$b", "MODE=live", "PATH=/usr/bin", "FROM_IMAGE=1"],
      },
    });
    expect(driftOf(stackWith(dollars, [withDollar]), KEY)).toBeNull();
  });

  it("compares only what the files declare once its image is gone, rather than call the image's settings added", () => {
    const orphan = { ...member(), image: null };
    expect(driftOf(stackWith(declared(), [orphan]), KEY)).toBeNull();
    const changed = declared({ environment: { DB_PASS: SECRET, MODE: "test" } });
    expect(only(stackWith(changed, [orphan]))?.fields).toEqual([
      { field: STACK_DRIFT_FIELD.environment, names: ["MODE"] },
    ]);
  });

  it("finds a service with no container, a container of none, and one with no record, leaving a one-off out", () => {
    const stack = {
      project: "wiki",
      files: ["compose.yaml"],
      declared: { wiki: declared(), worker: {}, off: { deploy: { replicas: 0 } }, also: { scale: 0 } },
      hashes: new Map([["wiki", HASH]]),
      members: [
        member(),
        member({ Name: "/old-1" }, { "com.docker.compose.service": "old" }),
        member({ Name: "/run-1" }, { "com.docker.compose.service": "task", "com.docker.compose.oneoff": "True" }),
      ],
    };
    const drift = driftOf(stack, KEY)!;
    expect(drift.services.map(({ service, kind }) => [service, kind])).toEqual([
      ["old", STACK_DRIFT_KIND.extra],
      ["worker", STACK_DRIFT_KIND.missing],
    ]);
    expect(reconcilableServices(drift)).toEqual(["worker"]);
    const noRecord = member();
    delete noRecord.details.Config.Labels!["com.docker.compose.config-hash"];
    const unknown = only(stackWith(declared(), [noRecord]));
    expect(unknown?.kind).toBe(STACK_DRIFT_KIND.unknown);
  });

  it("says so when its files cannot be read, claiming nothing of its services", () => {
    const drift = driftOf({ ...stackWith(declared(), [member()]), declared: null }, KEY)!;
    expect(drift).toMatchObject({ unreadable: true, services: [] });
    expect(reconcilableServices(drift)).toEqual([]);
  });
});
