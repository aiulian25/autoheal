import { describe, expect, it, vi } from "vitest";
import type { DockerVolume } from "./docker-client.js";
import { VolumeSizes, volumesReport } from "./volumes.js";

describe("the host's volumes, as reported", () => {
  it("says who uses each, stopped containers too, what made it, and who must not lose it", async () => {
    const report = await volumesReport(
      {
        allVolumes: async (): Promise<DockerVolume[]> => [
          { Name: "abc", Driver: "local", CreatedAt: "2026-10-04", Labels: { "com.docker.volume.anonymous": "" } },
          { Name: "data", Labels: { "com.docker.compose.project": "app" } },
          { Name: "gone_data", Labels: { "com.docker.compose.project": "gone" } },
          { Name: "autoheal-guard-370", Labels: { "autoheal.guard.state": "1" } },
          { Name: "autoheal-results-1" },
          { Name: "other-tool-cache", Labels: { "com.example.internal.resource": "true" } },
          { Name: "strange", Labels: { "org.other.internal.resource": "true" } },
        ],
        containerSummaries: async () => [
          {
            Id: "1",
            Names: ["/app"],
            State: "running",
            Status: "",
            Labels: { "com.docker.compose.project": "app" },
            Mounts: [
              { Type: "volume", Name: "data", Destination: "/data" },
              { Type: "bind", Name: "abc", Destination: "/not-a-volume-mount" },
            ],
          },
          {
            Id: "2",
            Names: ["/old"],
            State: "exited",
            Status: "",
            Mounts: [{ Type: "volume", Name: "data", Destination: "/old" }],
          },
        ],
      },
      new Map([
        ["abc", 0],
        ["data", 500],
      ]),
    );
    const of = (name: string) => report.find((each) => each.name === name);

    expect(of("abc")).toEqual({
      name: "abc",
      driver: "local",
      sizeBytes: 0,
      createdAt: "2026-10-04",
      nameless: true,
      project: null,
      projectHere: false,
      own: false,
      ownedBy: null,
      members: [],
    });
    expect(of("data")).toMatchObject({
      sizeBytes: 500,
      project: "app",
      projectHere: true,
      members: [
        { name: "app", running: true, destination: "/data" },
        { name: "old", running: false, destination: "/old" },
      ],
    });
    expect(of("gone_data")).toMatchObject({ projectHere: false, sizeBytes: null });
    expect(of("autoheal-guard-370")?.own).toBe(true);
    expect(of("autoheal-results-1")?.own).toBe(true);
    expect(of("other-tool-cache")?.ownedBy).toBe("com.example");
    expect(of("strange")?.ownedBy).toBe("org.other");
  });
});

describe("what volumes hold", () => {
  it("never holds up a report: gives the last count, and counts again only when it has aged", async () => {
    let now = 0;
    const volumeSizes = vi.fn(async () => new Map([["a", 5]]));
    const sizes = new VolumeSizes({ volumeSizes }, () => now);

    expect(sizes.current().size).toBe(0);
    await vi.waitFor(() => expect(sizes.current().get("a")).toBe(5));
    now += 60_000;
    sizes.current();
    expect(volumeSizes).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    sizes.current();
    expect(volumeSizes).toHaveBeenCalledTimes(2);
  });

  it("says when it could not count, and keeps the last it knew", async () => {
    const problems: string[] = [];
    const sizes = new VolumeSizes(
      { volumeSizes: async () => Promise.reject(new Error("too slow")) },
      () => 0,
      (problem) => problems.push(problem),
    );
    sizes.current();
    await vi.waitFor(() => expect(problems).toEqual(["too slow"]));
    expect(sizes.current().size).toBe(0);
  });
});
