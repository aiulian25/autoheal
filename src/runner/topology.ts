import {
  COMPOSE_DEPENDS_ON_LABEL,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  NETWORK_MODE_CONTAINER_PREFIX,
  REPORT_LIMITS,
} from "../shared/constants.js";
import { createHash } from "node:crypto";
import { DECLARED_DEPENDENCIES_LABEL, SHARED_VIA, TOPOLOGY_LIMITS, type TopologySnapshot } from "../shared/topology.js";
import type { ContainerDetails } from "./incident-report.js";
import { rollbackDataSources } from "./rollback-data.js";

// What a pair of overlapping mounts share: the volume, or the broader of two host folders, its path fingerprinted.
function sharedVia(a: { type: string; source: string }, b: { type: string; source: string }): string {
  if (a.type === "volume") return `${SHARED_VIA.volume}${a.source}`;
  const broader = a.source.length <= b.source.length ? a.source : b.source;
  const fingerprint = createHash("sha256").update(broader).digest("hex").slice(0, SHARED_VIA.fingerprintCharacters);
  return `${SHARED_VIA.folder}${fingerprint}`;
}

/**
 * Observed links only. Docker mount source paths are used locally and never appear in the report: a shared host
 * folder is named by a fingerprint of its path.
 */
export function topologyOf(
  input: readonly { name: string; details: ContainerDetails }[],
  capturedAt: number,
): TopologySnapshot {
  const notes = new Set<TopologySnapshot["notes"][number]>();
  const entries = [...new Map(input.map((entry) => [entry.name, entry])).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, REPORT_LIMITS.containers);
  if (input.length > entries.length) notes.add("container_limit");
  const names = new Set(entries.map(({ name }) => name));
  const ids = new Map(entries.flatMap(({ name, details }) => (details.Id ? [[details.Id, name]] : [])));
  const nodes = entries.map(({ name, details }) => ({
    name,
    containerId: (details.Id ?? name).slice(0, 128),
    composeProject: details.Config.Labels?.[COMPOSE_PROJECT_LABEL]?.slice(0, REPORT_LIMITS.nameCharacters) ?? null,
  }));
  const edges = new Map<string, TopologySnapshot["edges"][number]>();
  const add = (
    from: string,
    to: string,
    kind: TopologySnapshot["edges"][number]["kind"],
    source: "docker" | "operator_label" = "docker",
    via?: string,
  ) => {
    if (from === to) return;
    const edge = { from, to, kind, source, ...(via === undefined ? {} : { via }) };
    const key = JSON.stringify(edge);
    if (edges.has(key)) return;
    if (edges.size >= TOPOLOGY_LIMITS.edges) {
      notes.add("edge_limit");
      return;
    }
    edges.set(key, edge);
  };
  const projects = new Map<string, string[]>();
  for (const node of nodes)
    if (node.composeProject)
      projects.set(node.composeProject, [...(projects.get(node.composeProject) ?? []), node.name]);
  // Association uses a star per project, not an invented startup/dependency order or an unbounded clique.
  for (const members of projects.values())
    for (const name of members.slice(1)) add(members[0]!, name, "compose_association");
  // Compose's depends_on names services of the container's own project; each of their containers is a dependency.
  const containersOfService = new Map<string, string[]>();
  for (const { name, details } of entries) {
    const service = details.Config.Labels?.[COMPOSE_SERVICE_LABEL];
    if (service === undefined) continue;
    const key = JSON.stringify([details.Config.Labels?.[COMPOSE_PROJECT_LABEL], service]);
    containersOfService.set(key, [...(containersOfService.get(key) ?? []), name]);
  }
  for (const { name, details } of entries) {
    const mode = details.HostConfig?.NetworkMode ?? "";
    if (mode.startsWith(NETWORK_MODE_CONTAINER_PREFIX)) {
      const reference = mode.slice(NETWORK_MODE_CONTAINER_PREFIX.length).replace(/^\//, "");
      const matches = [...ids].filter(([id]) => reference.length >= 12 && id.startsWith(reference));
      const provider = names.has(reference)
        ? reference
        : (ids.get(reference) ?? (matches.length === 1 ? matches[0]![1] : undefined));
      if (provider) add(name, provider, "network_namespace");
      else notes.add("unresolved_reference");
    }
    const declared = (details.Config.Labels?.[DECLARED_DEPENDENCIES_LABEL] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (declared.length > TOPOLOGY_LIMITS.declaredPerContainer) notes.add("edge_limit");
    for (const target of declared.slice(0, TOPOLOGY_LIMITS.declaredPerContainer))
      if (names.has(target)) add(name, target, "declared_dependency", "operator_label");
      else notes.add("unresolved_reference");
    const waitsFor = (details.Config.Labels?.[COMPOSE_DEPENDS_ON_LABEL] ?? "")
      .split(",")
      .map((value) => value.split(":")[0]!.trim())
      .filter(Boolean);
    if (waitsFor.length > TOPOLOGY_LIMITS.declaredPerContainer) notes.add("edge_limit");
    for (const service of waitsFor.slice(0, TOPOLOGY_LIMITS.declaredPerContainer)) {
      const providers =
        containersOfService.get(JSON.stringify([details.Config.Labels?.[COMPOSE_PROJECT_LABEL], service])) ?? [];
      if (providers.length === 0) notes.add("unresolved_reference");
      for (const provider of providers) add(name, provider, "declared_dependency");
    }
  }
  const sources = entries.map(({ details }) => {
    const values = rollbackDataSources(details);
    if (values.length > TOPOLOGY_LIMITS.mountSources) notes.add("mount_limit");
    return values.slice(0, TOPOLOGY_LIMITS.mountSources);
  });
  let comparisons = 0;
  outer: for (let left = 0; left < entries.length; left++)
    for (let right = left + 1; right < entries.length; right++) {
      let shared: string | null = null;
      for (const a of sources[left]!)
        for (const b of sources[right]!) {
          if (++comparisons > TOPOLOGY_LIMITS.comparisons) {
            notes.add("comparison_limit");
            break outer;
          }
          if (
            a.type === b.type &&
            (a.source === b.source ||
              (a.type === "path" &&
                (a.source === "/" ||
                  b.source === "/" ||
                  a.source.startsWith(`${b.source}/`) ||
                  b.source.startsWith(`${a.source}/`))))
          )
            shared ??= sharedVia(a, b);
        }
      if (shared !== null) add(entries[left]!.name, entries[right]!.name, "shared_writable_data", "docker", shared);
      if (edges.size >= TOPOLOGY_LIMITS.edges) break outer;
    }
  const snapshot: TopologySnapshot = {
    capturedAt,
    nodes,
    edges: [...edges.values()],
    truncated: [...notes].some((note) => note !== "unresolved_reference"),
    notes: [...notes],
  };
  // Shrink geometrically so the byte cap is enforced without quadratic serialization work.
  let bytes = Buffer.byteLength(JSON.stringify(snapshot));
  while (bytes > TOPOLOGY_LIMITS.bytes) {
    notes.add("byte_limit");
    snapshot.truncated = true;
    snapshot.notes = [...notes];
    const keep = Math.max(1, Math.floor(snapshot.nodes.length * Math.min(0.75, (TOPOLOGY_LIMITS.bytes / bytes) * 0.8)));
    if (keep < snapshot.nodes.length) {
      snapshot.nodes = snapshot.nodes.slice(0, keep);
      const visible = new Set(snapshot.nodes.map((node) => node.name));
      snapshot.edges = snapshot.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));
    } else snapshot.edges = snapshot.edges.slice(0, Math.floor(snapshot.edges.length * 0.75));
    bytes = Buffer.byteLength(JSON.stringify(snapshot));
  }
  return snapshot;
}
