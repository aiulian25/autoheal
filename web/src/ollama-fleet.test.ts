import { describe, expect, it } from "vitest";
import type { OllamaServersView, OllamaStatusView } from "../../src/shared/api.js";
import { answeringFor, fleetOf, serversFor } from "./ollama-fleet.js";

const status = (reachable: boolean) => ({ reachable }) as OllamaStatusView;
const servers = (reachable = true): OllamaServersView => ({
  extras: [
    {
      id: "s1",
      name: "Orion2480",
      url: "http://delta",
      model: "big",
      contextTokens: 1,
      plainHttp: true,
      status: status(reachable),
      hostIds: ["h2", "revoked"],
    },
  ],
  reviewServerId: null,
  routerServerId: null,
  defaultName: null,
});
const PRIMARY = { model: "small", reachable: true };
const HOSTS = [{ id: "h1" }, { id: "h2" }, { id: "h3" }];

describe("the servers on the landing page", () => {
  it("is just the default with no others", () => {
    expect(
      fleetOf(PRIMARY, { extras: [], reviewServerId: null, routerServerId: null, defaultName: null }, HOSTS),
    ).toEqual({
      lines: [{ id: null, name: null, model: "small", hosts: 3, reachable: true }],
      answering: 1,
      state: "all",
    });
    expect(fleetOf(PRIMARY, undefined, HOSTS).lines).toHaveLength(1);
  });

  it("counts each server's hosts, leaving out one no longer enrolled", () => {
    const { lines, state } = fleetOf(PRIMARY, servers(), HOSTS);
    expect(lines.map(({ name, hosts }) => [name, hosts])).toEqual([
      [null, 2],
      ["Orion2480", 1],
    ]);
    expect(state).toBe("all");
  });

  it("says when some or none answer", () => {
    expect(fleetOf(PRIMARY, servers(false), HOSTS)).toMatchObject({ answering: 1, state: "some" });
    expect(fleetOf({ ...PRIMARY, reachable: false }, servers(true), HOSTS).state).toBe("some");
    expect(fleetOf({ ...PRIMARY, reachable: false }, servers(false), HOSTS)).toMatchObject({
      answering: 0,
      state: "none",
    });
  });
});

describe("a default with a name", () => {
  const named = { ...servers(false), defaultName: "Mini" };

  it("is called that on its line, and wherever work falls back to it", () => {
    expect(fleetOf(PRIMARY, named, HOSTS).lines[0]?.name).toBe("Mini");
    expect(answeringFor(named, "h1")).toBe("Mini");
    expect(answeringFor(named, "h2")).toBe("Mini");
  });
});

describe("who answers for a host", () => {
  it("is its own server, or the default while that is down", () => {
    expect(answeringFor(servers(), "h2")).toBe("Orion2480");
    expect(answeringFor(servers(), "h1")).toBeNull();
    expect(answeringFor(servers(false), "h2")).toBeNull();
    expect(answeringFor(servers(), null)).toBeNull();
  });

  it("counts each server once, however many hosts go there", () => {
    expect(serversFor(servers(), ["h2", "h2"])).toEqual(["Orion2480"]);
    expect(serversFor(servers(), ["h2", "h1", "h3"])).toEqual(["Orion2480", null]);
  });
});
