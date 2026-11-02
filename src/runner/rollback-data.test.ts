import { describe, expect, it } from "vitest";
import { sharesRollbackData } from "./rollback-data.js";
import type { ContainerDetails } from "./incident-report.js";
const container = (mount: NonNullable<ContainerDetails["Mounts"]>[number]): ContainerDetails => ({
  Name: "/test",
  Config: { Image: "test:1" },
  State: { Running: true },
  Mounts: [mount],
});
describe("rollback writer coverage", () => {
  it("matches named volumes and physical bind aliases", () => {
    const volume = container({ Type: "volume", Name: "data", Source: "/volumes/data", Destination: "/data" });
    expect(sharesRollbackData(volume, container({ Type: "volume", Name: "data", Destination: "/other" }))).toBe(true);
    expect(
      sharesRollbackData(volume, container({ Type: "bind", Source: "/volumes/data/sub", Destination: "/other" })),
    ).toBe(true);
  });
  it.each(["/srv/data", "/srv/data/sub", "/srv", "/"])("matches overlapping bind tree %s", (source) => {
    expect(
      sharesRollbackData(
        container({ Type: "bind", Source: "/srv/data", Destination: "/data" }),
        container({ Type: "bind", Source: source, Destination: "/other" }),
      ),
    ).toBe(true);
  });
  it("excludes sibling paths and read-only writers", () => {
    const data = container({ Type: "bind", Source: "/srv/data", Destination: "/data" });
    expect(sharesRollbackData(data, container({ Type: "bind", Source: "/srv/database", Destination: "/other" }))).toBe(
      false,
    );
    expect(
      sharesRollbackData(data, container({ Type: "bind", Source: "/srv/data", Destination: "/other", RW: false })),
    ).toBe(false);
  });
});
