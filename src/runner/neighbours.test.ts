import { describe, expect, it } from "vitest";
import { exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { COMPOSE_PROJECT_LABEL, NEIGHBOUR_LOG_TAIL_LINES } from "../shared/constants.js";
import type { ContainerSummary } from "./docker-client.js";
import { neighboursOf } from "./neighbours.js";

const summary = (name: string, project: string, state: string, status: string): ContainerSummary => ({
  Id: name,
  Names: [`/${name}`],
  State: state,
  Status: status,
  Labels: { [COMPOSE_PROJECT_LABEL]: project },
});

const app = exitedContainer("paperless", {
  Config: { Image: "paperless:2", Labels: { [COMPOSE_PROJECT_LABEL]: "paperless" } },
});

function docker(summaries: ContainerSummary[], unreadable: readonly string[] = []) {
  const tails: number[] = [];
  return {
    tails,
    client: {
      containerSummaries: async () => summaries,
      inspect: async (name: string) => exitedContainer(name),
      logs: async (name: string, _usesTty: boolean, tailLines?: number) => {
        tails.push(tailLines ?? 0);
        if (unreadable.includes(name)) {
          throw new Error("gone");
        }
        return `${name} said goodbye`;
      },
    },
  };
}

describe("a failed container's neighbours", () => {
  it("lists the others of its compose project as Docker shows them, with the last lines of those in trouble", async () => {
    const { client, tails } = docker([
      summary("paperless", "paperless", "exited", "Exited (1) 1 minute ago"),
      summary("paperless-redis", "paperless", "running", "Up 3 hours"),
      summary("paperless-db", "paperless", "exited", "Exited (0) 12 minutes ago"),
      summary("paperless-tika", "paperless", "running", "Up 3 hours (unhealthy)"),
      summary("immich-db", "immich", "exited", "Exited (0) 2 hours ago"),
    ]);
    expect(await neighboursOf(client, app)).toEqual([
      { name: "paperless-db", status: "Exited (0) 12 minutes ago", logs: "paperless-db said goodbye" },
      { name: "paperless-redis", status: "Up 3 hours", logs: null },
      { name: "paperless-tika", status: "Up 3 hours (unhealthy)", logs: "paperless-tika said goodbye" },
    ]);
    expect(tails).toEqual([NEIGHBOUR_LOG_TAIL_LINES, NEIGHBOUR_LOG_TAIL_LINES]);
  });

  it("has none outside a compose project, and leaves out the logs it cannot read", async () => {
    const { client } = docker([summary("paperless-db", "paperless", "exited", "Exited (0) now")], ["paperless-db"]);
    expect(await neighboursOf(client, exitedContainer("paperless"))).toEqual([]);
    expect(await neighboursOf(client, app)).toEqual([{ name: "paperless-db", status: "Exited (0) now", logs: null }]);
  });
});
