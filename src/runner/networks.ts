import { COMPOSE_PROJECT_LABEL, REPORT_LIMITS } from "../shared/constants.js";
import type { NetworkReport } from "../shared/networks.js";
import type { ContainerSummary, DockerClient, DockerNetwork } from "./docker-client.js";

type NetworkLister = Pick<DockerClient, "containerSummaries" | "networks">;

const RUNNING = "running";
const nameOf = (container: ContainerSummary) => container.Names[0]?.replace(/^\//, "") ?? container.Id;
const membersOf = (network: DockerNetwork, containers: readonly ContainerSummary[]) =>
  containers.flatMap((container) => {
    const endpoint = container.NetworkSettings?.Networks?.[network.Name];
    if (endpoint === undefined) return [];
    return [{ name: nameOf(container), running: container.State === RUNNING, address: endpoint.IPAddress ?? "" }];
  });

// The IPv4 range where it has one: a network may list an IPv6 one beside it.
const addressesOf = (network: DockerNetwork) => {
  const ranges = network.IPAM?.Config ?? [];
  return ranges.find((range) => range.Subnet?.includes(".")) ?? ranges[0];
};

/** Every network on the host, with who is on it, stopped containers too: they would not start again without it. */
export async function networksReport(docker: NetworkLister, selfContainerName: string): Promise<NetworkReport[]> {
  const [networks, containers] = await Promise.all([docker.networks(), docker.containerSummaries()]);
  const projects = new Set(containers.map((container) => container.Labels?.[COMPOSE_PROJECT_LABEL]));
  return networks.slice(0, REPORT_LIMITS.networks).map((network) => {
    const members = membersOf(network, containers);
    const project = network.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
    const addresses = addressesOf(network);
    return {
      name: network.Name,
      driver: network.Driver ?? "",
      subnet: addresses?.Subnet ?? null,
      gateway: addresses?.Gateway ?? null,
      internal: network.Internal === true,
      project,
      projectHere: project !== null && projects.has(project),
      own: members.some((member) => member.name === selfContainerName),
      members,
    };
  });
}
