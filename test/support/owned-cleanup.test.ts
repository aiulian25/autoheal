import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A drill started with a stand-in for docker, which asks no engine anything: what it removes is what it says exists.
interface Drill {
  script: string;
  // Fixed names a person's own, or another run's, may hold: a failed run must leave them be.
  others: string[];
  // Where the drill first makes something, and a step after it has made some of what it needs, where it gets there.
  first: string;
  later: string | null;
}
const DRILLS: Drill[] = [
  {
    script: "test/boot-drill-fixture/run.sh",
    others: ["container autoheal-boot-fixture", "volume autoheal-boot-fixture-store"],
    first: "run",
    later: "load",
  },
  {
    script: "test/runner-update-drill/run.sh",
    others: [
      "container autoheal-runner-drill",
      "volume autoheal-runner-drill-store",
      "image autoheal:runner-drill-old",
      "image autoheal:runner-drill-new",
    ],
    first: "build",
    later: "save",
  },
  {
    script: "test/assistant-drill/run.sh",
    others: [
      "container autoheal-assistant-drill",
      "volume autoheal-assistant-drill-store",
      "image autoheal:assistant-drill",
      "image autoheal:assistant-drill-app-one",
    ],
    first: "build",
    later: "save",
  },
  {
    script: "test/smoke/run-smoke.sh",
    others: ["network autoheal-smoke", "volume autoheal-smoke-data", "volume autoheal-smoke-join"],
    // It looks at the image before making anything, and a stand-in gets no further.
    first: "inspect",
    later: null,
  },
];
// Another run of the same drill, going on meanwhile, under a name of its own.
const ANOTHER_RUN = "container autoheal-boot-fixture-1700000000-1-1";

describe("a drill that fails part-way", () => {
  let root: string;
  let world: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-drill-cleanup-"));
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "home", ".cache"), { recursive: true });
    mkdirSync(join(root, "tmp"));
    copyFileSync("test/support/fake-docker.sh", join(root, "bin", "docker"));
    chmodSync(join(root, "bin", "docker"), 0o755);
    world = join(root, "world");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ran = (drill: Drill, failing: string, engine: Record<string, string> = {}) => {
    writeFileSync(world, [...drill.others, ANOTHER_RUN].map((line) => `${line}\n`).join(""));
    const { status, stderr } = spawnSync("bash", [drill.script], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
        FAKE_DOCKER_WORLD: world,
        FAKE_DOCKER_CALLS: join(root, "calls"),
        FAKE_DOCKER_FAIL: failing,
        ...engine,
      },
    });
    return { status, stderr, left: readFileSync(world, "utf8").trim().split("\n") };
  };

  it("removes what it made on the engine it was started against, not on another", () => {
    const outer = "unix:///run/fake-outer/docker.sock";
    ran(DRILLS[0]!, "load", { DOCKER_HOST: outer });
    const removals = readFileSync(join(root, "calls"), "utf8")
      .split("\n")
      .filter((call) => / rm -f /.test(call));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatch(new RegExp(`^${outer} rm -f autoheal-boot-fixture-\\d+-\\d+-\\d+$`));
  });

  it("says what it made and could not remove", () => {
    const { stderr, left } = ran(DRILLS[0]!, "load rm");
    const engine = left.find(
      (line) => line !== ANOTHER_RUN && /^container autoheal-boot-fixture-\d+-\d+-\d+$/.test(line),
    );
    expect(engine).toBeDefined();
    expect(stderr).toContain(`LEFT BEHIND: ${engine}`);
  });

  describe.each(DRILLS)("$script", (drill) => {
    it("removes none of what it did not make, failing where it first makes something", () => {
      const { status, left } = ran(drill, drill.first);
      expect(status).not.toBe(0);
      expect(left.toSorted()).toEqual([...drill.others, ANOTHER_RUN].toSorted());
    });

    it.skipIf(drill.later === null)("removes all it made, and only that, failing after it made some", () => {
      const { status, stderr, left } = ran(drill, drill.later!);
      expect(status).not.toBe(0);
      expect(left.toSorted()).toEqual([...drill.others, ANOTHER_RUN].toSorted());
      expect(stderr).not.toContain("LEFT BEHIND");
      expect(readdirSync(join(root, "home", ".cache"))).toEqual([]);
      expect(readdirSync(join(root, "tmp"))).toEqual([]);
    });
  });
});
