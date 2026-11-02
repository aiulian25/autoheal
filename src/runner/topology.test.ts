import { describe, expect, it } from "vitest";
import { COMPOSE_DEPENDS_ON_LABEL, COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "../shared/constants.js";
import { createHash } from "node:crypto";
import {
  DECLARED_DEPENDENCIES_LABEL,
  SHARED_VIA,
  TOPOLOGY_LIMITS,
  topologySnapshotSchema,
} from "../shared/topology.js";
import { exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { topologyOf } from "./topology.js";

const entry = (name: string, more: Parameters<typeof exitedContainer>[1] = {}) => ({
  name,
  details: exitedContainer(name, { Id: `${name}-id`, ...more }),
});
describe("bounded Docker relationship reporting", () => {
  it("distinguishes namespace, Compose association, shared writable data and operator-declared links", () => {
    const graph = topologyOf(
      [
        entry("db", {
          Config: { Image: "fixture:latest", Labels: { [COMPOSE_PROJECT_LABEL]: "app" } },
          Mounts: [{ Type: "volume", Name: "db-data", Source: "/secret/volume/data", Destination: "/data", RW: true }],
        }),
        entry("web", {
          Config: {
            Image: "fixture:latest",
            Labels: { [COMPOSE_PROJECT_LABEL]: "app", [DECLARED_DEPENDENCIES_LABEL]: "db" },
            Env: ["PASSWORD=synthetic-private"],
          },
          HostConfig: { Image: "fixture:latest", NetworkMode: "container:db-id" },
        }),
        entry("writer", {
          Mounts: [{ Type: "bind", Source: "/secret/volume/data/subdir", Destination: "/work", RW: true }],
        }),
        entry("readonly", {
          Mounts: [{ Type: "bind", Source: "/secret/volume/data", Destination: "/work", RW: false }],
        }),
        entry("sibling", {
          Mounts: [{ Type: "bind", Source: "/secret/volume/data2", Destination: "/work", RW: true }],
        }),
      ],
      123,
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "web", to: "db", kind: "network_namespace", source: "docker" },
        { from: "db", to: "web", kind: "compose_association", source: "docker" },
        // Through the broader folder, named by a fingerprint of its path: the path itself stays on the host.
        {
          from: "db",
          to: "writer",
          kind: "shared_writable_data",
          source: "docker",
          via: `${SHARED_VIA.folder}${createHash("sha256").update("/secret/volume/data").digest("hex").slice(0, 8)}`,
        },
        { from: "web", to: "db", kind: "declared_dependency", source: "operator_label" },
      ]),
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "shared_writable_data" &&
          [edge.from, edge.to].some((name) => name === "readonly" || name === "sibling"),
      ),
    ).toBe(false);
    expect(JSON.stringify(graph)).not.toContain("/secret");
    expect(JSON.stringify(graph)).not.toContain("synthetic-private");
    expect(topologySnapshotSchema.safeParse(graph).success).toBe(true);
  });
  it("names a volume two containers share by the volume's own name", () => {
    const volume = { Type: "volume", Name: "media", Source: "/var/lib/docker/volumes/media/_data", RW: true };
    const graph = topologyOf(
      [
        entry("handbrake", { Mounts: [{ ...volume, Destination: "/output" }] }),
        entry("mkvtoolnix", { Mounts: [{ ...volume, Destination: "/storage" }] }),
      ],
      123,
    );
    expect(graph.edges).toEqual([
      { from: "handbrake", to: "mkvtoolnix", kind: "shared_writable_data", source: "docker", via: "volume:media" },
    ]);
  });
  it("never calls a common bridge network a dependency and flags unresolved declarations", () => {
    const graph = topologyOf(
      [
        entry("one", {
          HostConfig: { Image: "fixture:latest", NetworkMode: "bridge" },
          Config: { Image: "fixture:latest", Labels: { [DECLARED_DEPENDENCIES_LABEL]: "missing" } },
        }),
        entry("two", { HostConfig: { Image: "fixture:latest", NetworkMode: "bridge" } }),
      ],
      123,
    );
    expect(graph.edges).toEqual([]);
    expect(graph.notes).toContain("unresolved_reference");
  });
  it("reads Compose's depends_on as dependencies on the containers of its own project's services", () => {
    const compose = (name: string, project: string, service: string, dependsOn?: string) =>
      entry(name, {
        Config: {
          Image: "fixture:latest",
          Labels: {
            [COMPOSE_PROJECT_LABEL]: project,
            [COMPOSE_SERVICE_LABEL]: service,
            ...(dependsOn === undefined ? {} : { [COMPOSE_DEPENDS_ON_LABEL]: dependsOn }),
          },
        },
      });
    const graph = topologyOf(
      [
        // As Compose writes it: service, condition, restart; one service it names is not there.
        compose(
          "musicbox",
          "musicbox",
          "musicbox",
          "musicbox-pg:service_healthy:false,musicbox-redis:service_started:false,gone:service_started:false",
        ),
        compose("musicbox-pg", "musicbox", "musicbox-pg"),
        compose("musicbox-redis-1", "musicbox", "musicbox-redis"),
        compose("musicbox-redis-2", "musicbox", "musicbox-redis"),
        // The same service name in another project is no dependency.
        compose("other-pg", "other", "musicbox-pg"),
      ],
      123,
    );
    expect(graph.edges.filter((edge) => edge.kind === "declared_dependency")).toEqual([
      { from: "musicbox", to: "musicbox-pg", kind: "declared_dependency", source: "docker" },
      { from: "musicbox", to: "musicbox-redis-1", kind: "declared_dependency", source: "docker" },
      { from: "musicbox", to: "musicbox-redis-2", kind: "declared_dependency", source: "docker" },
    ]);
    expect(graph.notes).toContain("unresolved_reference");
    expect(topologySnapshotSchema.safeParse(graph).success).toBe(true);
  });
  it("bounds serialized bytes while retaining valid endpoints and explicit partial-report metadata", () => {
    const graph = topologyOf(
      Array.from({ length: 1000 }, (_, index) =>
        entry(`${index}-${"x".repeat(240)}`, {
          Id: String(index).padStart(64, "a"),
          Config: { Image: "fixture:latest", Labels: { [COMPOSE_PROJECT_LABEL]: "all" } },
        }),
      ),
      123,
    );
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(TOPOLOGY_LIMITS.bytes);
    expect(graph.truncated).toBe(true);
    expect(graph.notes).toContain("byte_limit");
    const names = new Set(graph.nodes.map(({ name }) => name));
    expect(graph.edges.every((edge) => names.has(edge.from) && names.has(edge.to))).toBe(true);
    expect(topologySnapshotSchema.safeParse(graph).success).toBe(true);
  });
});
