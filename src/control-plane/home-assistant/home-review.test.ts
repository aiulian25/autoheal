import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ScanBudget,
  commentedOutBlocks,
  deadReferences,
  entityReferences,
  findLeftovers,
  readConfigFile,
  readYamlFiles,
  topLevelBlocks,
  yamlProblems,
} from "./home-config-scan.js";
import { HOME_SCAN_INCOMPLETE } from "../../shared/home-review.js";
import { HomeReview, type HomeFacts, type HomeLogRecord } from "./home-review.js";

const AUTOMATIONS = `- id: a
  alias: Hall light
  triggers:
  - entity_id: binary_sensor.hall_motion
    trigger: state
  actions:
  - target:
      entity_id:
      - light.hall
      - light.gone_lamp
    action: light.turn_on
- id: b
  alias: Kitchen fan
  triggers:
  - entity_id: sensor.kitchen_humidity, sensor.kitchen_temp
    trigger: state
  actions:
  - action: fan.turn_on
    target:
      entity_id: "{{ states('sensor.x') }}"
`;
const CONFIG = `homeassistant:
  name: Home
# light:
#   - platform: template
#     lights:
#       old:
# a sentence about something
template: !include templates.yaml
`;
const FACTS: HomeFacts = {
  areas: new Map([
    ["hall", "Hallway"],
    ["kitchen", "Kitchen"],
  ]),
  devices: [{ id: "d1", area_id: "hall" }],
  entities: [
    { entity_id: "binary_sensor.hall_motion", device_id: "d1", disabled_by: null },
    { entity_id: "light.hall", device_id: "d1", disabled_by: null },
    { entity_id: "light.gone_lamps", device_id: null, disabled_by: null, area_id: "kitchen" },
    { entity_id: "sensor.kitchen_humidity", device_id: null, disabled_by: null, area_id: "kitchen" },
    { entity_id: "sensor.kitchen_temp", device_id: null, disabled_by: null, area_id: "kitchen" },
    { entity_id: "switch.hidden", device_id: "d1", disabled_by: "user" },
    { entity_id: "sensor.hall_battery", device_id: "d1", disabled_by: null, entity_category: "diagnostic" },
  ],
  states: new Map([["light.hall", { state: "on", attributes: { friendly_name: "Hall", device_class: "light" } }]]),
};
const LOG: HomeLogRecord = {
  exception: "TypeError: the real reason",
  name: "homeassistant.components.automation",
  level: "ERROR",
  message: ["Error in 'Kitchen fan' with password=hunter2"],
  source: ["components/automation.py", 12],
  count: 3,
  timestamp: 1_000,
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "home-review-"));
  writeFileSync(join(root, "configuration.yaml"), CONFIG);
  writeFileSync(join(root, "automations.yaml"), AUTOMATIONS);
  writeFileSync(join(root, "secrets.yaml"), "db_password: never-to-be-seen\n");
  writeFileSync(join(root, "configuration.yaml.bak-traps-1"), "old");
  mkdirSync(join(root, "dashboard-backups"));
  writeFileSync(join(root, "dashboard-backups", "one.json"), "12345");
  mkdirSync(join(root, ".storage"));
  writeFileSync(join(root, ".storage", "core.entity_registry.bak-claude"), "1234567");
  writeFileSync(join(root, ".storage", "auth"), "never-to-be-seen");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const reviewWith = (
  overrides: { ask?: (system: string, user: string) => Promise<string>; log?: HomeLogRecord[] } = {},
) =>
  new HomeReview({
    root,
    connected: () => true,
    facts: () => FACTS,
    systemLog: async () => overrides.log ?? [],
    ask: overrides.ask ?? (async () => '{"suggestions":[]}'),
    contextTokens: () => 16_384,
    clock: () => 5_000,
  });

describe("reading the configuration", () => {
  it("never opens what holds passwords and sign-ins, whoever asks", async () => {
    await expect(readConfigFile(root, "secrets.yaml")).rejects.toThrow();
    await expect(readConfigFile(root, ".storage/auth")).rejects.toThrow();
    const { files, skipped } = await readYamlFiles(root);
    expect(skipped).toEqual([]);
    expect(files.map(({ path }) => path).toSorted()).toEqual(["automations.yaml", "configuration.yaml"]);
    expect(JSON.stringify(files)).not.toContain("never-to-be-seen");
  });

  describe("whatever a name says, by what the file really is", () => {
    const MARKER = "never-to-be-seen";
    const refused = (path: string) => expect(readConfigFile(root, path)).rejects.toThrow();

    it("refuses a harmless name that links to a secret, or out of the folder", async () => {
      const outside = mkdtempSync(join(tmpdir(), "home-review-outside-"));
      writeFileSync(join(outside, "private.yaml"), `password: ${MARKER}\n`);
      symlinkSync(join(root, "secrets.yaml"), join(root, "sneaky.yaml"));
      symlinkSync("secrets.yaml", join(root, "relative.yaml"));
      symlinkSync(join(outside, "private.yaml"), join(root, "outside.yaml"));
      await refused("sneaky.yaml");
      await refused("relative.yaml");
      await refused("outside.yaml");
      rmSync(outside, { recursive: true, force: true });
    });

    it("refuses a path through a linked folder, even to an ordinary file", async () => {
      const outside = mkdtempSync(join(tmpdir(), "home-review-outside-"));
      writeFileSync(join(outside, "ordinary.yaml"), `password: ${MARKER}\n`);
      symlinkSync(outside, join(root, "packages"));
      symlinkSync(join(root, ".storage"), join(root, "scripts"));
      await refused("packages/ordinary.yaml");
      await refused("scripts/auth");
      rmSync(outside, { recursive: true, force: true });
    });

    it("refuses leaving the folder by name, however it is spelled", async () => {
      await refused("../secrets.yaml");
      await refused("packages/../../secrets.yaml");
      await refused(join(root, "automations.yaml"));
      await refused("");
    });

    it("refuses a second name for the same file, and the same name in other letter case", async () => {
      linkSync(join(root, "secrets.yaml"), join(root, "hard.yaml"));
      await refused("hard.yaml");
      await refused("SECRETS.YAML");
      await refused(".STORAGE/auth");
    });

    it("refuses what is not a plain file, without waiting on it", async () => {
      mkdirSync(join(root, "folder.yaml"));
      await refused("folder.yaml");
      execFileSync("mkfifo", [join(root, "pipe.yaml")]);
      await refused("pipe.yaml");
    });

    it("still reads an ordinary file, in a folder, and from a root that is itself a link", async () => {
      mkdirSync(join(root, "packages"));
      writeFileSync(join(root, "packages", "lights.yaml"), "light: []\n");
      expect(await readConfigFile(root, "automations.yaml")).toBe(AUTOMATIONS);
      expect(await readConfigFile(root, "packages/lights.yaml")).toBe("light: []\n");
      const linkedRoot = `${root}-link`;
      symlinkSync(root, linkedRoot);
      expect(await readConfigFile(linkedRoot, "packages/lights.yaml")).toBe("light: []\n");
      rmSync(linkedRoot);
    });
  });

  it("passes over what it refused, and says which and why, with nothing of its contents", async () => {
    symlinkSync(join(root, "secrets.yaml"), join(root, "sneaky.yaml"));
    linkSync(join(root, "secrets.yaml"), join(root, "hard.yaml"));
    mkdirSync(join(root, "packages"));
    symlinkSync(join(root, "secrets.yaml"), join(root, "packages", "nested.yaml"));
    mkdirSync(join(root, "folder.yaml"));
    const { files, skipped } = await readYamlFiles(root);

    expect(JSON.stringify(files)).not.toContain("never-to-be-seen");
    expect(JSON.stringify(skipped)).not.toContain("never-to-be-seen");
    expect(skipped.toSorted((one, other) => one.path.localeCompare(other.path))).toEqual([
      { path: "folder.yaml", why: "not_plain" },
      { path: "hard.yaml", why: "second_name" },
      { path: "packages/nested.yaml", why: "link" },
      { path: "sneaky.yaml", why: "link" },
    ]);
  });

  it("lists backups and dumps by name, with their size, a folder as a whole", async () => {
    utimesSync(join(root, "configuration.yaml.bak-traps-1"), 100, 100);
    const found = await findLeftovers(root);
    expect(found.map(({ path, bytes }) => [path, bytes])).toEqual([
      [".storage/core.entity_registry.bak-claude", 7],
      ["dashboard-backups", 5],
      ["configuration.yaml.bak-traps-1", 3],
    ]);
    expect(found[1]?.folder).toBe(true);
    expect(found[2]?.modifiedAt).toBe(100_000);
  });

  it("finds runs of commented-out code, and leaves a sentence alone", () => {
    expect(commentedOutBlocks("c.yaml", CONFIG)).toEqual([
      { file: "c.yaml", fromLine: 3, toLine: 6, preview: "light:" },
    ]);
    expect(commentedOutBlocks("c.yaml", "# one note\n# another note\n# and a third\n")).toEqual([]);
    expect(commentedOutBlocks("c.yaml", "# a: 1\n# b: 2\nc: 3\n")).toEqual([]);
  });

  it("reads each form of entity_id, passing over templates and services", () => {
    expect(entityReferences(AUTOMATIONS).map(({ entity }) => entity)).toEqual([
      "binary_sensor.hall_motion",
      "light.hall",
      "light.gone_lamp",
      "sensor.kitchen_humidity",
      "sensor.kitchen_temp",
    ]);
    expect(entityReferences(AUTOMATIONS).find(({ entity }) => entity === "light.gone_lamp")?.line).toBe(10);
  });

  it("names what a home does not have, with what it likely meant", () => {
    const known = new Set(FACTS.entities.map(({ entity_id }) => entity_id));
    expect(deadReferences([{ path: "automations.yaml", text: AUTOMATIONS }], known)).toEqual([
      { file: "automations.yaml", line: 10, entity: "light.gone_lamp", nearest: "light.gone_lamps" },
    ]);
  });

  it("sees a number used as a state, and quotes that do not match", () => {
    expect(yamlProblems("to: '3.5'\n")).toHaveLength(1);
    expect(yamlProblems("  - state: below 18\n")).toHaveLength(1);
    expect(yamlProblems("to: 'on'\nstate: below_horizon\nabove: 3\n")).toEqual([]);
    expect(yamlProblems("description: 'it opens and shuts\"\n")).toHaveLength(1);
  });

  it("splits a file into its automations", () => {
    expect(topLevelBlocks(AUTOMATIONS)).toHaveLength(2);
  });
});

describe("what one look at the configuration may cost", () => {
  const SIXTY_FOUR_MEBIBYTES = 64 * 1024 * 1024;

  it("reads no file too big to be a person's, and says so, reading the rest", async () => {
    await writeFile(join(root, "huge.yaml"), "");
    await truncate(join(root, "huge.yaml"), SIXTY_FOUR_MEBIBYTES);
    const { files, skipped } = await readYamlFiles(root);
    expect(files.map(({ path }) => path)).not.toContain("huge.yaml");
    expect(files.map(({ path }) => path)).toContain("automations.yaml");
    expect(skipped).toContainEqual({ path: "huge.yaml", why: "too_big" });
  });

  it("is not led round in circles by links inside a leftover folder", async () => {
    const folder = join(root, "old.bak");
    await mkdir(folder);
    await writeFile(join(folder, "a"), "12345");
    await symlink(".", join(folder, "one"));
    await symlink(".", join(folder, "two"));
    await symlink("..", join(folder, "three"));
    const found = await findLeftovers(root);
    const leftover = found.find(({ path }) => path === "old.bak");
    expect(leftover?.folder).toBe(true);
    // Its own file and its links' own short sizes: nothing reached through them.
    expect(leftover?.bytes).toBeLessThan(100);
  }, 5_000);

  describe("with its own budget", () => {
    const LIMITS = { entries: 50, fileBytes: 1_000, totalBytes: 2_500, readers: 3 };
    const budgetOf = (limits: Partial<typeof LIMITS> = {}, signal = new AbortController().signal) =>
      new ScanBudget(signal, { ...LIMITS, ...limits });
    const yamlFiles = async (count: number, bytes = 10) => {
      await mkdir(join(root, "packages"), { recursive: true });
      for (let index = 0; index < count; index += 1) {
        await writeFile(join(root, "packages", `file-${index}.yaml`), "x".repeat(bytes));
      }
    };

    it("stops looking at its limit of entries, and says the look was partial", async () => {
      await yamlFiles(200);
      const budget = budgetOf({ entries: 30 });
      const { files } = await readYamlFiles(root, budget);
      expect(files.length).toBeLessThanOrEqual(30);
      expect(budget.incomplete).toBe(HOME_SCAN_INCOMPLETE.entries);
    });

    it("keeps no more than its limit of bytes, saying which were left, and reads what still fits", async () => {
      await yamlFiles(10, 800);
      const budget = budgetOf({ entries: 500 });
      const { files, skipped } = await readYamlFiles(root, budget);
      const kept = files.reduce((total, { text }) => total + text.length, 0);
      expect(kept).toBeLessThanOrEqual(LIMITS.totalBytes);
      expect(skipped.map(({ why }) => why)).toContain("over_budget");
      expect(budget.incomplete).toBe(HOME_SCAN_INCOMPLETE.bytes);
    });

    it("reads a file of exactly its limit, not one byte more", async () => {
      await writeFile(join(root, "fits.yaml"), "x".repeat(LIMITS.fileBytes));
      await writeFile(join(root, "over.yaml"), "x".repeat(LIMITS.fileBytes + 1));
      const { files, skipped } = await readYamlFiles(root, budgetOf({ entries: 500, totalBytes: 100_000 }));
      expect(files.map(({ path }) => path)).toContain("fits.yaml");
      expect(skipped).toContainEqual({ path: "over.yaml", why: "too_big" });
    });

    it("reads a few at a time", async () => {
      await yamlFiles(30);
      let running = 0;
      let most = 0;
      const reading = async (where: string, path: string) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        return { where, path } as unknown as string;
      };
      await readYamlFiles(root, budgetOf({ entries: 500, totalBytes: 100_000 }), reading);
      expect(most).toBe(LIMITS.readers);
    });

    it("starts nothing once told to stop, and says why", async () => {
      await yamlFiles(5);
      const stop = new AbortController();
      stop.abort();
      const budget = budgetOf({ entries: 500 }, stop.signal);
      const { files } = await readYamlFiles(root, budget);
      expect(files).toEqual([]);
      expect(await findLeftovers(root, budget)).toEqual([]);
      expect(budget.incomplete).toBe(HOME_SCAN_INCOMPLETE.time);
    });

    it("stops mid-way when told to, the reads under way finishing", async () => {
      await yamlFiles(30);
      const stop = new AbortController();
      let started = 0;
      const reading = async () => {
        started += 1;
        if (started === 3) stop.abort();
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "x";
      };
      const budget = budgetOf({ entries: 500, totalBytes: 100_000 }, stop.signal);
      const { files } = await readYamlFiles(root, budget, reading);
      expect(started).toBeLessThanOrEqual(LIMITS.readers + 2);
      expect(files.length).toBeLessThan(30);
      expect(budget.incomplete).toBe(HOME_SCAN_INCOMPLETE.time);
    });

    it("counts what a leftover folder holds towards the same budget", async () => {
      const folder = join(root, "many.bak");
      await mkdir(folder);
      for (let index = 0; index < 100; index += 1) await writeFile(join(folder, `n-${index}`), "x");
      const budget = budgetOf({ entries: 40 });
      const found = await findLeftovers(root, budget);
      expect(found.find(({ path }) => path === "many.bak")?.bytes ?? 0).toBeLessThanOrEqual(40);
      expect(budget.incomplete).toBe(HOME_SCAN_INCOMPLETE.entries);
    });
  });

  describe("one scan at a time", () => {
    const stage = () => {
      const asked: { budget: ScanBudget; finish: () => void }[] = [];
      const scanFolder = vi.fn(
        (_root: string, budget: ScanBudget) =>
          new Promise<{ files: []; skipped: []; leftovers: [] }>((resolve) => {
            asked.push({ budget, finish: () => resolve({ files: [], skipped: [], leftovers: [] }) });
          }),
      );
      return { asked, scanFolder };
    };
    const scanningWith = (scanFolder: ReturnType<typeof stage>["scanFolder"], milliseconds = 20, grace = 20) =>
      new HomeReview({
        root,
        connected: () => true,
        facts: () => FACTS,
        systemLog: async () => [],
        ask: async () => '{"suggestions":[]}',
        contextTokens: () => 16_384,
        clock: () => 5_000,
        scanFolder,
        scanMilliseconds: milliseconds,
        scanGraceMilliseconds: grace,
      });
    const settle = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    it("tells the scan to stop at its deadline, and labels what it found as partial", async () => {
      const { asked, scanFolder } = stage();
      const review = scanningWith(scanFolder, 10, 500);
      const viewing = review.view();
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      await vi.waitFor(() => expect(asked[0]!.budget.incomplete).toBe(HOME_SCAN_INCOMPLETE.time));
      asked[0]!.finish();
      const view = await viewing;
      expect(view.scanIncomplete).toBe(HOME_SCAN_INCOMPLETE.time);
      expect(view.scannedAt).not.toBeNull();
    });

    it("starts no second scan until a stuck one has really ended", async () => {
      const { asked, scanFolder } = stage();
      const review = scanningWith(scanFolder);
      const first = await review.rescan();
      expect(first.scannedAt).toBeNull();
      await review.rescan();
      await settle(60);
      await review.rescan();
      expect(scanFolder).toHaveBeenCalledTimes(1);

      asked[0]!.finish();
      await settle(5);
      await review.rescan();
      expect(scanFolder).toHaveBeenCalledTimes(2);
      asked[1]!.finish();
    });

    it("keeps nothing from a scan that ends after a restore, and tells it to stop", async () => {
      const { asked, scanFolder } = stage();
      const review = scanningWith(scanFolder, 10_000, 10_000);
      const scanned = (review as unknown as { currentScan: (fresh: boolean) => Promise<unknown> }).currentScan(true);
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      review.reset();
      expect(asked[0]!.budget.incomplete).toBe(HOME_SCAN_INCOMPLETE.time);
      asked[0]!.finish();
      expect(await scanned).toBeNull();
      expect((review as unknown as { scan: unknown }).scan).toBeNull();
    });
  });
});

describe("the review", () => {
  it("says the folder is not there", async () => {
    rmSync(join(root, "configuration.yaml"));
    const view = await reviewWith().view();
    expect(view.mounted).toBe(false);
    expect(view.leftovers).toEqual([]);
  });

  it("gathers the log, wrong references, rooms and clean-ups, with no secret in the log", async () => {
    const view = await reviewWith({ log: [LOG] }).view();
    expect(view.mounted).toBe(true);
    expect(view.log?.[0]).toMatchObject({ level: "ERROR", count: 3, lastAt: 1_000_000 });
    expect(view.log?.[0]?.message).not.toContain("hunter2");
    expect(view.deadReferences.map(({ entity }) => entity)).toEqual(["light.gone_lamp"]);
    expect(view.rooms).toMatchObject([
      { name: "Hallway", entities: 2, automations: 1 },
      { name: "Kitchen", entities: 3, automations: 1 },
    ]);
    expect(view.comments).toHaveLength(1);
    expect(view.leftovers).toHaveLength(3);
  });

  it("asks about a room with only what is in it, and marks what the answer makes up", async () => {
    const ask = vi.fn(async () =>
      JSON.stringify({
        suggestions: [
          {
            kind: "new",
            title: "Night light",
            why: "dark hall",
            yaml: "actions:\n  - entity_id: light.hall\n  - entity_id: light.made_up\n",
          },
        ],
      }),
    );
    const review = reviewWith({ ask });
    expect(review.suggestForRoom("hall")).toBe(true);
    await vi.waitFor(async () => expect((await review.view()).rooms[0]?.run.status).toBe("done"));
    const [, user] = ask.mock.calls[0] as unknown as [string, string];
    expect(user).toContain("light.hall | Hall | light | on");
    expect(user).toContain("Hall light");
    expect(user).not.toContain("sensor.kitchen_humidity");
    expect(user).not.toContain("switch.hidden");
    expect(user).not.toContain("hall_battery");
    expect(user).not.toContain("never-to-be-seen");
    const answer = (await review.view()).rooms[0]?.run.suggestions[0];
    expect(answer?.unknownEntities).toEqual(["light.made_up"]);
  });

  it("sends a model nothing from a file reached through a link, and shows that it was not read", async () => {
    writeFileSync(join(root, "secrets.yaml"), "# Kitchen fan never-to-be-seen\n");
    symlinkSync(join(root, "secrets.yaml"), join(root, "kitchen.yaml"));
    const ask = vi.fn(async () => '{"suggestions":[]}');
    const review = reviewWith({ ask, log: [LOG] });
    const { log, skippedFiles } = await review.view();
    expect(skippedFiles).toEqual([{ path: "kitchen.yaml", why: "link" }]);

    await review.suggestFix(log![0]!.id);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    expect(JSON.stringify(ask.mock.calls)).not.toContain("never-to-be-seen");
  });

  it("asks about an error with what mentions it, redacted, and says when the model fails", async () => {
    const ask = vi.fn(async () => {
      throw new Error("Ollama is away");
    });
    const review = reviewWith({ ask, log: [LOG] });
    const { log } = await review.view();
    expect(await review.suggestFix(log![0]!.id)).toBe(true);
    await vi.waitFor(async () => expect((await review.view()).log?.[0]?.run.status).toBe("failed"));
    expect((await review.view()).log?.[0]?.run.error).toContain("Ollama is away");
    const [, user] = ask.mock.calls[0] as unknown as [string, string];
    expect(user).toContain("Kitchen fan");
    expect(user).toContain("TypeError: the real reason");
    expect(user).not.toContain("hunter2");
    expect(await review.suggestFix("nothing")).toBe(false);
    expect(review.suggestForRoom("nowhere")).toBe(false);
  });
});
