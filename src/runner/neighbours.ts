import {
  COMPOSE_PROJECT_LABEL,
  CONTAINER_STATE_RUNNING,
  HEALTH_IN_STATUS_PATTERN,
  HEALTH_UNHEALTHY,
  NEIGHBOUR_LOG_TAIL_LINES,
  REPORT_LIMITS,
} from "../shared/constants.js";
import { stripSlash, type ContainerSummary, type DockerClient } from "./docker-client.js";
import { composeProjectOf, containerNameOf, type ContainerDetails } from "./incident-report.js";

/** Another container of the failed one's compose project, as Docker shows it now. */
export interface NeighbourFacts {
  name: string;
  status: string;
  logs: string | null;
}

const nameOf = (summary: ContainerSummary) => stripSlash(summary.Names[0] ?? summary.Id);
// Down, or failing its health check: its own last lines may say why the failed container failed.
const inTrouble = (summary: ContainerSummary) =>
  summary.State !== CONTAINER_STATE_RUNNING || HEALTH_IN_STATUS_PATTERN.exec(summary.Status)?.[1] === HEALTH_UNHEALTHY;

async function logsOf(docker: Pick<DockerClient, "inspect" | "logs">, name: string): Promise<string | null> {
  const details = await docker.inspect(name);
  if (details === null) {
    return null;
  }
  return docker.logs(name, details.Config.Tty ?? false, NEIGHBOUR_LOG_TAIL_LINES);
}

/** The other containers of its compose project, the first few in trouble with their last lines. */
export async function neighboursOf(
  docker: Pick<DockerClient, "containerSummaries" | "inspect" | "logs">,
  failed: ContainerDetails,
): Promise<NeighbourFacts[]> {
  const project = composeProjectOf(failed);
  if (project === null) {
    return [];
  }
  const failedName = containerNameOf(failed);
  const neighbours = (await docker.containerSummaries())
    .filter((summary) => summary.Labels?.[COMPOSE_PROJECT_LABEL] === project && nameOf(summary) !== failedName)
    .sort((first, second) => nameOf(first).localeCompare(nameOf(second)))
    .slice(0, REPORT_LIMITS.neighbours);
  const withLogs = new Set(neighbours.filter(inTrouble).slice(0, REPORT_LIMITS.neighbourLogs).map(nameOf));
  return Promise.all(
    neighbours.map(async (summary) => {
      const name = nameOf(summary);
      const logs = withLogs.has(name) ? await logsOf(docker, name).catch(() => null) : null;
      return { name, status: summary.Status, logs };
    }),
  );
}
