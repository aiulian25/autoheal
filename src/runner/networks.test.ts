import { describe, expect, it } from "vitest";
import type { ContainerSummary, DockerNetwork } from "./docker-client.js";
import { networksReport } from "./networks.js";

const container = (
  name: string,
  state: string,
  networks: Record<string, string>,
  project?: string,
): ContainerSummary => ({
  Id: name,
  Names: [`/${name}`],
  State: state,
  Status: state,
  ...(project === undefined ? {} : { Labels: { "com.docker.compose.project": project } }),
  NetworkSettings: {
    Networks: Object.fromEntries(Object.entries(networks).map(([key, address]) => [key, { IPAddress: address }])),
  },
});
const NETWORKS: DockerNetwork[] = [
  {
    Name: "npm",
    Driver: "bridge",
    IPAM: { Config: [{ Subnet: "fd00::/64" }, { Subnet: "192.168.16.0/20", Gateway: "192.168.16.1" }] },
  },
  { Name: "wyrmrss_default", Driver: "bridge", Labels: { "com.docker.compose.project": "wyrmrss" } },
  { Name: "linkwarden_default", Driver: "bridge", Labels: { "com.docker.compose.project": "linkwarden" } },
  { Name: "autoheal_default", Driver: "bridge", Internal: true },
];
const CONTAINERS = [
  container("radicale", "running", { npm: "192.168.16.7" }),
  container("old", "exited", { npm: "" }),
  container("linkwarden", "running", { npm: "192.168.16.9" }, "linkwarden"),
  container("autoheal", "running", { autoheal_default: "172.30.0.2" }),
];

describe("the host's networks, as reported", () => {
  it("says who is on each, stopped containers too, and what made it", async () => {
    const report = await networksReport(
      { networks: async () => NETWORKS, containerSummaries: async () => CONTAINERS },
      "autoheal",
    );

    expect(report.find(({ name }) => name === "npm")).toEqual({
      name: "npm",
      driver: "bridge",
      subnet: "192.168.16.0/20",
      gateway: "192.168.16.1",
      internal: false,
      project: null,
      projectHere: false,
      own: false,
      members: [
        { name: "radicale", running: true, address: "192.168.16.7" },
        { name: "old", running: false, address: "" },
        { name: "linkwarden", running: true, address: "192.168.16.9" },
      ],
    });
    expect(report.find(({ name }) => name === "wyrmrss_default")).toMatchObject({
      project: "wyrmrss",
      projectHere: false,
    });
    expect(report.find(({ name }) => name === "linkwarden_default")).toMatchObject({ projectHere: true, members: [] });
    expect(report.find(({ name }) => name === "autoheal_default")).toMatchObject({ own: true, internal: true });
  });
});
