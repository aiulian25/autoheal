import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Each stage of the Dockerfile, by its name; the last one, which has none, is the image itself.
const stages = new Map(
  readFileSync("Dockerfile", "utf8")
    .split(/^(?=FROM )/m)
    .filter((stage) => stage.startsWith("FROM "))
    .map((stage) => [/ AS (\S+)/.exec(stage.split("\n")[0]!)?.[1] ?? "image", stage]),
);
const TOOL_STAGES = ["checkpoint-tool", "host-terminal-tool"];

describe("the tools the image copies in from the builder", () => {
  it("are upgraded where they are built: they ship as Debian has them now, not as the pinned builder had them", () => {
    for (const name of TOOL_STAGES) {
      expect(stages.get(name), name).toContain("apt-get -y --no-install-recommends upgrade");
    }
  });

  it("bring their Debian records into the image, where its scan reads the base image's own", () => {
    const image = stages.get("image")!;
    for (const name of TOOL_STAGES) {
      expect(stages.get(name), name).toContain("dpkg-query --status");
      expect(image, name).toContain(`COPY --from=${name} /tool-records/ /var/lib/dpkg/status.d/`);
    }
  });

  it("go into a runner's build id by those records, beside its code and the base images", () => {
    const build = stages.get("build")!;
    for (const name of TOOL_STAGES) {
      expect(build, name).toContain(`COPY --from=${name} /tool-records/ /build/tool-records/`);
    }
    expect(build).toMatch(/runner-identity\.js[^]*"tools@sha256:\$\(cat \/build\/tool-records\/\* \| sha256sum/);
  });
});
