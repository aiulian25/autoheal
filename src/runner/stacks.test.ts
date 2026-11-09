import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STACK_OUTCOMES } from "../shared/constants.js";
import type { StackAnswer } from "../shared/stacks.js";
import type { ContainerSummary } from "./docker-client.js";
import { settingsOf } from "./container-settings.js";
import { Stacks, imageExistsWith } from "./stacks.js";

const FOLDER = "/home/alex/docker/wiki";
const COMPOSE = `${FOLDER}/docker-compose.yml`;
const ENV = `${FOLDER}/.env`;
const FILE_TEXT = "services:\n  wiki:\n    image: wiki:2\n    env_file: .env\n";
const ENV_TEXT = "DB_PASS=secret\n";
const member = (name: string, service: string, hash: string, state = "running"): ContainerSummary => ({
  Id: name,
  Names: [`/${name}`],
  State: state,
  Status: state,
  Image: "wiki:2",
  Labels: {
    "com.docker.compose.project": "wiki",
    "com.docker.compose.project.working_dir": FOLDER,
    "com.docker.compose.project.config_files": COMPOSE,
    "com.docker.compose.service": service,
    "com.docker.compose.config-hash": hash,
  },
});
const nameOfMember = (container: ContainerSummary) => container.Names[0]!.replace(/^\//, "");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const encoded = (text: string) => Buffer.from(text).toString("base64");
const MARK = /echo "(AUTOHEAL-[0-9a-f-]+) 0 file"/;

// Answers a read as a host would, and a check with what Compose would say of the files.
function stacksWith(
  overrides: {
    hashes?: string;
    config?: object;
    checkFails?: string;
    files?: Record<string, string | null>;
    settings?: object;
    imageExists?: boolean | null;
    keptVersions?: string[];
    // Where each path really is on the host; null where it cannot be told. Others are as written.
    canonical?: Record<string, string | null>;
    // Files that, once every link is followed, lie outside the stack's folder.
    outside?: string[];
    // What is there once Compose has run, and how each of those looks when inspected; else as before it.
    membersAfterUp?: ContainerSummary[];
    membersBefore?: ContainerSummary[];
    inspected?: Record<string, object>;
    // What Compose says the stack should have; null when it cannot say.
    wantedServices?: object | null;
    // Runs as each script arrives, for what must happen while another is under way.
    duringScript?: (script: string) => Promise<void>;
    // What the deployment script itself answers: a refusal, or a timeout, which has no exit code.
    deployment?: { exitCode: number | null; output: string };
  } = {},
) {
  const scripts: string[] = [];
  const files: Record<string, string | null> = overrides.files ?? { [COMPOSE]: FILE_TEXT, [ENV]: ENV_TEXT };
  const hostScript = vi.fn(async (script: string) => {
    scripts.push(script);
    await overrides.duringScript?.(script);
    if (overrides.deployment !== undefined && / up -d/.test(script)) return overrides.deployment;
    const mark = MARK.exec(script)?.[1];
    if (mark !== undefined) {
      const paths = [...script.matchAll(/if \[ -f '([^']+)' \]/g)].map((match) => match[1]!);
      const output = paths.flatMap((path, index) => {
        const text = files[path] ?? null;
        const kept = overrides.keptVersions?.includes(path) ? [`${mark} ${index} previous`] : [];
        if (overrides.outside?.includes(path)) return [`${mark} ${index} file`, `${mark} ${index} outside`, ...kept];
        return [`${mark} ${index} file`, text === null ? `${mark} ${index} absent` : encoded(text), ...kept];
      });
      return { exitCode: 0, output: output.join("\n") };
    }
    const batch = /echo "(AUTOHEAL-[0-9a-f-]+) \d+ hashes"/.exec(script)?.[1];
    if (batch !== undefined) {
      const asked = [...script.matchAll(/ (\d+) hashes"/g)].map((match) => match[1]!);
      const services = overrides.wantedServices === null ? null : (overrides.wantedServices ?? { wiki: {} });
      const output = asked.flatMap((index) => [
        `${batch} ${index} hashes`,
        encoded(overrides.hashes ?? `wiki ${HASH_A}`),
        `${batch} ${index} config`,
        services === null ? "" : encoded(JSON.stringify({ services })),
      ]);
      return { exitCode: 0, output: output.join("\n") };
    }
    if (script.includes("config --format json") && !script.includes("config --hash")) {
      const marker = /echo "(AUTOHEAL-[0-9a-f-]+)"/.exec(script)?.[1] ?? "";
      if (overrides.wantedServices === null) return { exitCode: 1, output: marker };
      return {
        exitCode: 0,
        output: `${marker}\n${encoded(JSON.stringify({ services: overrides.wantedServices ?? { wiki: {} } }))}`,
      };
    }
    if (script.includes("config --hash")) {
      if (overrides.checkFails !== undefined) return { exitCode: 9, output: overrides.checkFails };
      const marker = /echo "(AUTOHEAL-[0-9a-f-]+)"/.exec(script)?.[1] ?? "";
      const config = overrides.config ?? { services: { wiki: { image: "wiki:2", env_file: [{ path: ".env" }] } } };
      return {
        exitCode: 0,
        output: `${overrides.hashes ?? `wiki ${HASH_A}`}\n${marker}\n${encoded(JSON.stringify(config))}`,
      };
    }
    const asked = [...script.matchAll(/echo "canonical (\d+) \$\(readlink -f -- '([^']+)'/g)];
    if (asked.length > 0) {
      const lines = asked.map(([, index, path]) => {
        const known = overrides.canonical?.[path!];
        return `canonical ${index} ${known === undefined ? path : (known ?? "")}`;
      });
      return { exitCode: 0, output: lines.join("\n") };
    }
    return { exitCode: 0, output: "done" };
  });
  const stacks = new Stacks({
    docker: {
      containerSummaries: async () => {
        const composeRan = scripts.some((script) => / up -d/.test(script));
        if (composeRan && overrides.membersAfterUp !== undefined) return overrides.membersAfterUp;
        return overrides.membersBefore ?? [member("Wiki", "wiki", HASH_A)];
      },
      networks: async () => [],
      inspectImage: async () => null,
      inspect: async (name: string) =>
        (overrides.inspected?.[name] ?? {
          Config: {},
          State: { Running: true, Status: "running" },
          RestartCount: 0,
        }) as never,
    },
    hostScript,
    imageExists: async () => overrides.imageExists ?? true,
    settings: {
      containerAccess: true,
      hostDeploy: true,
      dryRun: false,
      protectedContainers: new Set<string>(),
      selfContainerName: "autoheal",
      ...overrides.settings,
    },
    wait: async () => undefined,
    clock: (() => {
      let now = 0;
      return () => (now += 60_000);
    })(),
  });
  const ask = (request: object): Promise<StackAnswer> =>
    stacks.answer({ id: "r1", project: "wiki", ...request } as never);
  return { stacks, ask, scripts };
}
const hashOf = async (ask: ReturnType<typeof stacksWith>["ask"], path: string) =>
  (await ask({ kind: "read" })).files!.files.find((file) => file.path === path)!.hash;

describe("a stack's files", () => {
  it("reads its Compose file and .env from where Compose says it started", async () => {
    const { ask } = stacksWith();

    const { error, files } = await ask({ kind: "read" });

    expect(error).toBeNull();
    expect(files?.folder).toBe(FOLDER);
    expect(files?.files.map(({ path, kind, text }) => [path, kind, text])).toEqual([
      [COMPOSE, "compose", FILE_TEXT],
      [ENV, "env", ENV_TEXT],
    ]);
  });

  it("offers a .env that is not there yet, and says when the Compose file is gone", async () => {
    const noEnv = await stacksWith({ files: { [COMPOSE]: FILE_TEXT } }).ask({ kind: "read" });
    expect(noEnv.files?.files.find(({ path }) => path === ENV)).toMatchObject({ text: null, hash: null });

    const gone = await stacksWith({ files: {} }).ask({ kind: "read" });
    expect(gone.error).toContain("no longer on this host");
  });

  it("will not read anything on a host that keeps containers closed, or for a project not here", async () => {
    expect((await stacksWith({ settings: { containerAccess: false } }).ask({ kind: "read" })).error).toContain("off");
    const elsewhere = await stacksWith().stacks.answer({ id: "r", project: "other", kind: "read" });
    expect(elsewhere.error).toContain("was not started by Compose");
  });

  it("says what a change would recreate, by Compose's own hash against what runs", async () => {
    const unchanged = await stacksWith().ask({ kind: "check", files: [] });
    expect(unchanged.check).toMatchObject({ problem: null, recreate: [], unchanged: ["Wiki"] });

    const changed = await stacksWith({ hashes: `wiki ${HASH_B}\nnew ${HASH_A}` }).ask({ kind: "check", files: [] });
    expect(changed.check).toMatchObject({ recreate: ["Wiki"], unchanged: [], added: ["new"] });

    const gone = await stacksWith({ hashes: `other ${HASH_A}` }).ask({ kind: "check", files: [] });
    expect(gone.check?.removed).toEqual(["Wiki"]);
  });

  it("counts an edited .env as a change to what reads it, though Compose's hash does not", async () => {
    const { ask } = stacksWith();
    const hash = await hashOf(ask, ENV);
    const answer = await ask({ kind: "check", files: [{ path: ENV, text: "NEW=1\n", hash }] });
    expect(answer.check?.recreate).toEqual(["Wiki"]);
  });

  it("warns of an image that cannot be found, without stopping anything", async () => {
    const config = { services: { wiki: { image: "wiki:nope" } } };
    const answer = await stacksWith({ config, imageExists: false }).ask({ kind: "check", files: [] });
    expect(answer.check).toMatchObject({ problem: null });
    expect(answer.check?.warnings[0]).toContain("wiki:nope could not be found");
  });

  it("never writes what Compose cannot read, or over what changed since it was opened", async () => {
    const broken = stacksWith({ checkFails: "yaml: line 9: did not find expected" });
    const hash = await hashOf(broken.ask, COMPOSE);
    const notRead = await broken.ask({ kind: "save", files: [{ path: COMPOSE, text: "nonsense", hash }] });
    expect(notRead.error).toContain("yaml: line 9");
    expect(broken.scripts.some((script) => script.includes("mv "))).toBe(false);

    const stale = stacksWith();
    const old = await stale.ask({ kind: "save", files: [{ path: COMPOSE, text: FILE_TEXT, hash: "old" }] });
    expect(old.error).toContain("changed on the host");
    expect(stale.scripts.some((script) => script.includes("mv "))).toBe(false);
  });

  it("writes in place, keeping the last version, its owner and its mode", async () => {
    const { ask, scripts } = stacksWith();
    const hash = await hashOf(ask, COMPOSE);

    expect((await ask({ kind: "save", files: [{ path: COMPOSE, text: "services: {}\n", hash }] })).error).toBeNull();

    const write = scripts.find((script) => script.includes("mv "))!;
    expect(write).toContain(`cp -p "$old0" '${COMPOSE}.autoheal-previous'`);
    expect(write).toContain(`cp -p '${COMPOSE}' "$new0"`);
    expect(write).toContain(`mv -f "$new0" '${COMPOSE}'`);
  });

  it("forgets the kept version of a file this save did not write, so putting back restores this save alone", async () => {
    const { ask, scripts } = stacksWith({ keptVersions: [COMPOSE, ENV] });
    const hash = await hashOf(ask, COMPOSE);

    await ask({ kind: "save", files: [{ path: COMPOSE, text: "services: {}\n", hash }] });

    const write = scripts.find((script) => script.includes("mv "))!;
    expect(write).toContain(`rm -f -- '${ENV}.autoheal-previous'`);
    expect(write).not.toContain(`&& rm -f -- '${COMPOSE}.autoheal-previous'`);
    expect(write).toContain(`cp -p "$old0" '${COMPOSE}.autoheal-previous'`);
  });

  it("refuses to save a file that is not this stack's", async () => {
    const { ask } = stacksWith();
    const answer = await ask({ kind: "save", files: [{ path: "/etc/passwd", text: "x", hash: null }] });
    expect(answer.error).toContain("not one of this stack's files");
  });

  it.each([
    ["only watches", { dryRun: true }, "only watches"],
    ["keeps a container to itself", { protectedContainers: new Set(["Wiki"]) }, "read only here"],
    ["is the runner's own", { selfContainerName: "Wiki" }, "read only here"],
  ])("changes nothing on a host that %s, though it can still be read", async (_case, settings, refusal) => {
    const { ask, stacks, scripts } = stacksWith({ settings });
    const hash = await hashOf(ask, COMPOSE);
    scripts.length = 0;

    expect((await ask({ kind: "save", files: [{ path: COMPOSE, text: "x", hash }] })).error).toContain(refusal);
    expect((await stacks.run("stack_up", { project: "wiki", removeData: false })).outcome).toContain(refusal);
    expect((await ask({ kind: "restore" })).error).toContain(refusal);
    expect(scripts.some((script) => /mv |up -d|cp -p/.test(script))).toBe(false);
  });

  it("neither opens nor changes a stack's files on a host that keeps changes off, though it still shows its logs", async () => {
    const { ask, stacks, scripts } = stacksWith({ settings: { hostDeploy: false } });

    expect((await ask({ kind: "read" })).error).toBe(STACK_OUTCOMES.filesOff);
    expect((await ask({ kind: "check", files: [] })).error).toBe(STACK_OUTCOMES.filesOff);
    const changesOff = STACK_OUTCOMES.deployOff;
    expect((await ask({ kind: "save", files: [{ path: COMPOSE, text: "x", hash: null }] })).error).toBe(changesOff);
    expect((await stacks.run("stack_up", { project: "wiki", removeData: false })).outcome).toContain(changesOff);
    expect((await ask({ kind: "restore" })).error).toBe(changesOff);
    expect(scripts).toEqual([]);

    expect((await ask({ kind: "logs" })).error).toBeNull();
  });

  it("asks Compose nothing about a stack whose Compose file lies outside its folder", async () => {
    const { ask, scripts } = stacksWith({ outside: [COMPOSE] });

    const checked = await ask({ kind: "check", files: [] });

    expect(checked.check?.problem).toBe(STACK_OUTCOMES.outsideFolder(COMPOSE, FOLDER));
    expect(scripts.some((script) => script.includes("config"))).toBe(false);
  });
});

describe("a stack's files, opened only inside its folder", () => {
  const SECRET = "root:not-a-compose-file\n";
  let root: string;
  let folder: string;
  let elsewhere: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-stack-inside-"));
    folder = join(root, "wiki");
    elsewhere = join(root, "elsewhere", "secret.yml");
    mkdirSync(folder);
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(folder, "docker-compose.yml"), FILE_TEXT);
    writeFileSync(join(folder, ".env"), ENV_TEXT);
    writeFileSync(elsewhere, SECRET);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Labels as anything may write them, then the real read script run by a real shell over real files.
  const readWith = (workingFolder: string, composeFile: string) => {
    const labelled = member("Wiki", "wiki", HASH_A);
    labelled.Labels = {
      ...labelled.Labels,
      "com.docker.compose.project.working_dir": workingFolder,
      "com.docker.compose.project.config_files": composeFile,
    };
    const stacks = new Stacks({
      docker: {
        containerSummaries: async () => [labelled],
        networks: async () => [],
        inspectImage: async () => null,
        inspect: async () => null,
      },
      hostScript: async (script: string) => {
        const ran = spawnSync("sh", ["-c", script], { encoding: "utf8" });
        return { exitCode: ran.status, output: `${ran.stdout}${ran.stderr}` };
      },
      imageExists: async () => true,
      settings: {
        containerAccess: true,
        hostDeploy: true,
        dryRun: false,
        protectedContainers: new Set<string>(),
        selfContainerName: "autoheal",
      },
      wait: async () => undefined,
      clock: () => 0,
    });
    return stacks.answer({ id: "r1", project: "wiki", kind: "read" });
  };

  it("refuses a Compose file outside its folder, whatever its labels say, and shows none of it", async () => {
    expect(await readWith(folder, elsewhere)).toEqual({ error: STACK_OUTCOMES.outsideFolder(elsewhere, folder) });
  });

  it("refuses a Compose file inside its folder that is a link to one outside it", async () => {
    const linked = join(folder, "docker-compose.override.yml");
    symlinkSync(elsewhere, linked);
    expect(await readWith(folder, linked)).toEqual({ error: STACK_OUTCOMES.outsideFolder(linked, folder) });
  });

  it("leaves out its settings files that are links to files outside its folder, and shows none of them", async () => {
    rmSync(join(folder, ".env"));
    symlinkSync(elsewhere, join(folder, ".env"));
    symlinkSync(elsewhere, join(folder, "app.env"));
    const listing = "services:\n  wiki:\n    image: wiki:2\n    env_file:\n      - .env\n      - app.env\n";
    writeFileSync(join(folder, "docker-compose.yml"), listing);
    const answer = await readWith(folder, join(folder, "docker-compose.yml"));
    expect(answer.error).toBeNull();
    expect(answer.files?.files.map(({ path }) => path)).toEqual([join(folder, "docker-compose.yml")]);
    expect(JSON.stringify(answer)).not.toContain("not-a-compose-file");
  });

  it("opens a stack whose folder is reached through a link, as Compose may have been given it", async () => {
    const throughLink = join(root, "stacks");
    symlinkSync(folder, throughLink);
    const answer = await readWith(throughLink, join(throughLink, "docker-compose.yml"));
    expect(answer.error).toBeNull();
    expect(answer.files?.files.map(({ kind, text }) => [kind, text])).toEqual([
      ["compose", FILE_TEXT],
      ["env", ENV_TEXT],
    ]);
  });
});

describe("a stack as one thing", () => {
  describe("while a deployment of it is running", () => {
    // What happens on the host while the Compose script of `project` is still pending.
    const during = (meanwhile: (host: ReturnType<typeof stacksWith>) => Promise<unknown>) => {
      let done = false;
      const host: ReturnType<typeof stacksWith> = stacksWith({
        duringScript: async (script) => {
          if (done || !/ up -d| down| stop| start/.test(script)) return;
          done = true;
          await meanwhile(host);
        },
      });
      return host;
    };

    it("refuses a save of the same stack's files, and writes none of them", async () => {
      let saved: StackAnswer | undefined;
      const host = during(async (running) => {
        const hash = await hashOf(running.ask, COMPOSE);
        saved = await running.ask({ kind: "save", files: [{ path: COMPOSE, text: "services: {}\n", hash }] });
      });

      const phases: string[] = [];
      const ran = await host.stacks.run(
        "stack_up",
        { project: "wiki", removeData: false },
        { enter: (phase) => void phases.push(phase) },
      );

      expect(ran.succeeded).toBe(true);
      // One line under its row says each step, as an update's does.
      expect(phases).toEqual(["recreating", "checking"]);
      expect(saved!.error).toBe(STACK_OUTCOMES.beingChanged("wiki"));
      // Nothing of that save reached the files Compose was reading.
      expect(host.scripts.some((script) => /mv |cp -p/.test(script))).toBe(false);
    });

    it.each(["stack_up", "stack_rebuild", "stack_stop", "stack_start", "stack_remove"])(
      "refuses a save through %s too, and gives the stack up again once it ends",
      async (action) => {
        let saved: StackAnswer | undefined;
        const host = during(async (running) => {
          const hash = await hashOf(running.ask, COMPOSE);
          saved = await running.ask({ kind: "save", files: [{ path: COMPOSE, text: "services: {}\n", hash }] });
        });

        await host.stacks.run(action, { project: "wiki", removeData: false });

        expect(saved!.error).toBe(STACK_OUTCOMES.beingChanged("wiki"));
        // Once it is over the stack is its own again: the next save goes through.
        const hash = await hashOf(host.ask, COMPOSE);
        expect(
          (await host.ask({ kind: "save", files: [{ path: COMPOSE, text: "services: {}\n", hash }] })).error,
        ).toBeNull();
      },
    );

    it("refuses restoring the previous files, and a settings write that would edit them", async () => {
      let restored: StackAnswer | undefined;
      const host = during(async (running) => {
        restored = await running.ask({ kind: "restore" });
      });

      await host.stacks.run("stack_up", { project: "wiki", removeData: false });

      expect(restored!.error).toBe(STACK_OUTCOMES.beingChanged("wiki"));
    });

    it("refuses a second deployment of the same stack while the first is still going", async () => {
      let second: { succeeded: boolean; outcome: string } | undefined;
      const host = during(async (running) => {
        second = await running.stacks.run("stack_stop", { project: "wiki", removeData: false });
      });

      const first = await host.stacks.run("stack_up", { project: "wiki", removeData: false });

      expect(first.succeeded).toBe(true);
      expect(second).toMatchObject({ succeeded: false, outcome: STACK_OUTCOMES.beingChanged("wiki") });
    });

    it.each([
      ["failed", { exitCode: 1, output: "boom" }],
      ["timed out, so has no exit code of its own", { exitCode: null, output: "" }],
    ])("gives the stack up again when the deployment %s", async (_case, deployment) => {
      const host = stacksWith({ deployment });
      const hash = await hashOf(host.ask, COMPOSE);

      expect(await host.stacks.run("stack_up", { project: "wiki", removeData: false })).toMatchObject({
        succeeded: false,
      });

      // Not left held: the editor saves again rather than being locked out until the runner restarts.
      expect(
        (await host.ask({ kind: "save", files: [{ path: COMPOSE, text: "services: {}\n", hash }] })).error,
      ).toBeNull();
    });

    it("leaves another project on the same host free to deploy while this one is held", async () => {
      const otherLabels = { ...member("Other", "other", HASH_A).Labels, "com.docker.compose.project": "other" };
      const elsewhere: ContainerSummary = { ...member("Other", "other", HASH_A), Labels: otherLabels };
      let alongside: { succeeded: boolean; outcome: string } | undefined;
      let ownSave: StackAnswer | undefined;
      const host: ReturnType<typeof stacksWith> = stacksWith({
        membersBefore: [member("Wiki", "wiki", HASH_A), elsewhere],
        duringScript: async (script) => {
          if (alongside !== undefined || !/ up -d/.test(script)) return;
          alongside = { succeeded: false, outcome: "not asked yet" };
          alongside = await host.stacks.run("stack_stop", { project: "other", removeData: false });
          // This stack's own save is still refused meanwhile, so the two are not one lock.
          const hash = await hashOf(host.ask, COMPOSE);
          ownSave = await host.ask({ kind: "save", files: [{ path: COMPOSE, text: "services: {}\n", hash }] });
        },
      });

      expect(await host.stacks.run("stack_up", { project: "wiki", removeData: false })).toMatchObject({
        succeeded: true,
      });
      // Admitted and carried out, not turned away: the other project's lock is its own.
      expect(alongside).toMatchObject({ succeeded: true, outcome: STACK_OUTCOMES.stopped("other") });
      expect(ownSave!.error).toBe(STACK_OUTCOMES.beingChanged("wiki"));
    });
  });

  it("recreates with the host's own Compose, from the stack's own folder and files", async () => {
    const { stacks, scripts } = stacksWith();

    expect(await stacks.run("stack_up", { project: "wiki", removeData: false })).toMatchObject({ succeeded: true });

    const line = scripts.find((script) => script.includes("up -d"))!;
    expect(line).toContain(`--project-directory '${FOLDER}' -p 'wiki' -f '${COMPOSE}'`);
  });

  it.each([
    ["stack_stop", "-p 'wiki' stop"],
    ["stack_start", "-p 'wiki' start"],
    ["stack_remove", "-p 'wiki' down"],
    ["stack_rebuild", "up -d --build"],
  ])("does %s", async (action, expected) => {
    const { stacks, scripts } = stacksWith();
    await stacks.run(action, { project: "wiki", removeData: false });
    expect(scripts.some((script) => script.includes(expected))).toBe(true);
  });

  it("removes data only when asked, and only inside its own folder", async () => {
    const inside = `${FOLDER}/db`;
    const { stacks, scripts } = stacksWith();
    const summaries = async () => [
      {
        ...member("Wiki", "wiki", HASH_A),
        Mounts: [
          { Type: "bind", Source: inside, Destination: "/db" },
          { Type: "bind", Source: "/mnt/storage", Destination: "/nas" },
          { Type: "bind", Source: FOLDER, Destination: "/all" },
        ],
      },
    ];
    (
      stacks as unknown as { dependencies: { docker: { containerSummaries: unknown } } }
    ).dependencies.docker.containerSummaries = summaries;

    await stacks.run("stack_remove", { project: "wiki", removeData: false });
    expect(scripts.some((script) => script.includes("rm -rf"))).toBe(false);

    await stacks.run("stack_remove", { project: "wiki", removeData: true });
    const script = scripts.find((each) => each.includes("rm -rf"))!;
    expect(script).toContain("down -v");
    expect(script).toContain(`rm -rf '${inside}'`);
    expect(script).not.toContain("/mnt/storage");
    expect(script).not.toContain(`rm -rf '${FOLDER}'`);
  });
});

describe("every lifecycle command on one stack", () => {
  const BASE = `${FOLDER}/deploy/base.yaml`;
  const OVERRIDE = `${FOLDER}/deploy/gpu.override.yaml`;
  const ENVIRONMENT = `${FOLDER}/deploy/prod.env`;
  // The real scripts in a real shell, its folder moved under a test's own; Compose is a stand-in saying how it was called.
  function onHost() {
    const root = mkdtempSync(join(tmpdir(), "autoheal-stack-commands-"));
    const folder = join(root, "wiki");
    mkdirSync(join(folder, "deploy"), { recursive: true });
    const moved = (path: string) => path.replace(FOLDER, folder);
    [BASE, OVERRIDE, ENVIRONMENT].forEach((path) => writeFileSync(moved(path), "x: 1\n"));
    // What Compose alone would find by itself in that folder, and must not be what these commands act on.
    writeFileSync(join(folder, "docker-compose.yml"), "services: {}\n");
    mkdirSync(join(root, "bin"));
    const calls = join(root, "calls");
    writeFileSync(
      join(root, "bin", "docker"),
      `#!/bin/sh\n[ "$2" = version ] && exit 0\necho "$(pwd) $*" >> '${calls}'\n`,
    );
    chmodSync(join(root, "bin", "docker"), 0o755);
    const summaries = [
      {
        ...member("Wiki", "wiki", HASH_A),
        Labels: {
          ...member("Wiki", "wiki", HASH_A).Labels,
          "com.docker.compose.project.config_files": `${BASE},${OVERRIDE}`,
          "com.docker.compose.project.environment_file": ENVIRONMENT,
        },
      },
    ];
    const stacks = new Stacks({
      docker: {
        containerSummaries: async () => summaries,
        networks: async () => [],
        inspectImage: async () => null,
        inspect: async () => ({ Config: {}, State: { Running: true, Status: "running" }, RestartCount: 0 }) as never,
      },
      hostScript: async (script: string) => {
        const ran = spawnSync("sh", ["-c", script.replaceAll(FOLDER, folder)], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
        });
        return { exitCode: ran.status, output: `${ran.stdout}${ran.stderr}`.replaceAll(folder, FOLDER) };
      },
      imageExists: async () => true,
      settings: {
        containerAccess: true,
        hostDeploy: true,
        dryRun: false,
        protectedContainers: new Set<string>(),
        selfContainerName: "autoheal",
      },
      wait: async () => undefined,
      clock: (() => {
        let now = 0;
        return () => (now += 60_000);
      })(),
    });
    return {
      folder,
      moved,
      run: (action: string, removeData = false) => stacks.run(action, { project: "wiki", removeData }),
      calls: () =>
        existsSync(calls)
          ? readFileSync(calls, "utf8")
              .trim()
              .split("\n")
              .map((line) => line.replaceAll(folder, FOLDER))
          : [],
    };
  }
  const EVERYTHING = `--project-directory ${FOLDER} -p wiki -f ${BASE} -f ${OVERRIDE} --env-file ${ENVIRONMENT}`;

  it.each([
    ["stack_stop", "stop"],
    ["stack_start", "start"],
    ["stack_remove", "down --remove-orphans"],
  ])("%s uses the files and settings up does, from the stack's folder", async (action, command) => {
    const host = onHost();
    expect(await host.run(action)).toMatchObject({ succeeded: true });
    expect(host.calls()).toEqual([`${FOLDER} compose ${EVERYTHING} ${command}`]);
  });

  it("keeps asking for a stack's volumes only when asked, and removes its data only after Compose worked", async () => {
    const host = onHost();
    await host.run("stack_remove", true);
    expect(host.calls()).toEqual([`${FOLDER} compose ${EVERYTHING} down -v --remove-orphans`]);
  });

  it("refuses when some of the files are gone, naming them, as they would describe another stack", async () => {
    const host = onHost();
    rmSync(host.moved(OVERRIDE));
    const result = await host.run("stack_stop");
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("put them back");
    expect(result.output).toContain(OVERRIDE);
    expect(host.calls()).toEqual([]);
  });

  it("refuses when its settings file is gone though its Compose files are there", async () => {
    const host = onHost();
    rmSync(host.moved(ENVIRONMENT));
    const result = await host.run("stack_remove", true);
    expect(result.succeeded).toBe(false);
    expect(result.output).toContain(ENVIRONMENT);
    expect(host.calls()).toEqual([]);
  });

  it("still reaches a stack whose Compose files are all gone, by its name, away from any other file", async () => {
    const host = onHost();
    rmSync(host.moved(BASE));
    rmSync(host.moved(OVERRIDE));
    rmSync(host.moved(ENVIRONMENT));
    expect(await host.run("stack_remove")).toMatchObject({ succeeded: true });
    expect(host.calls()).toEqual(["/ compose -p wiki down"]);
  });
});

describe("a stack compared with its files", () => {
  const HASHES = `wiki ${HASH_A}`;
  const up = (host: ReturnType<typeof stacksWith>, revision: string) =>
    host.stacks.run("stack_up", { project: "wiki", removeData: false, reconcile: { revision } });
  const changed = { services: { wiki: { image: "wiki:9" } } };
  const running = {
    Id: "Wiki",
    Name: "/Wiki",
    Config: {
      Image: "wiki:2",
      Labels: { "com.docker.compose.service": "wiki", "com.docker.compose.config-hash": HASH_A },
    },
    State: { Running: true, Status: "running" },
    RestartCount: 0,
  };
  const stale = (over: Parameters<typeof stacksWith>[0] = {}) =>
    stacksWith({ wantedServices: changed.services, hashes: HASHES, inspected: { Wiki: running }, ...over });

  it("reports what differs, by one script however many stacks", async () => {
    const elsewhere = {
      ...member("Blog", "wiki", HASH_A),
      Labels: {
        ...member("Blog", "wiki", HASH_A).Labels,
        "com.docker.compose.project": "blog",
        "com.docker.compose.project.working_dir": "/home/alex/docker/blog",
        "com.docker.compose.project.config_files": "/home/alex/docker/blog/docker-compose.yml",
      },
    };
    const host = stale({
      membersBefore: [member("Wiki", "wiki", HASH_A), elsewhere],
      inspected: { Wiki: running, Blog: { ...running, Id: "Blog", Name: "/Blog" } },
    });
    await host.stacks.refreshDrift();
    const report = host.stacks.currentDrift()!;
    expect(report.stacks.map(({ project }) => project).sort()).toEqual(["blog", "wiki"]);
    expect(report.stacks[0]!.services[0]).toMatchObject({ service: "wiki", kind: "runtime" });
    expect(host.scripts.filter((script) => script.includes("config --hash"))).toHaveLength(1);
  });

  it("stays quiet of a stack that matches its files", async () => {
    const host = stacksWith({
      wantedServices: { wiki: { image: "wiki:2" } },
      hashes: HASHES,
      inspected: { Wiki: running },
    });
    await host.stacks.refreshDrift();
    expect(host.stacks.currentDrift()!.stacks).toEqual([]);
  });

  it("does not look while a stack's files are being changed", async () => {
    let lookedDuringChange = false;
    const host = stale({
      duringScript: async (script) => {
        if (lookedDuringChange || !script.includes(".autoheal")) return;
        lookedDuringChange = true;
        await host.stacks.refreshDrift();
      },
    });
    await host.ask({ kind: "restore" });
    expect(lookedDuringChange).toBe(true);
    expect(host.stacks.currentDrift()).toBeNull();
  });

  it("names a stack whose files cannot be read, and never recreates it", async () => {
    const host = stale({ wantedServices: null });
    await host.stacks.refreshDrift();
    const { revision, unreadable } = host.stacks.currentDrift()!.stacks[0]!;
    expect(unreadable).toBe(true);
    expect(await up(host, revision)).toMatchObject({ succeeded: false });
    expect(host.scripts.some((script) => / up -d/.test(script))).toBe(false);
  });

  it("looks at nothing where a host keeps its containers closed, and takes back what it said", async () => {
    const host = stale({ settings: { containerAccess: false } });
    await host.stacks.refreshDrift();
    expect(host.stacks.currentDrift()!.stacks).toEqual([]);
    expect(host.scripts).toEqual([]);
  });

  it("reconciles what was reviewed, only the services that differ, recreating them", async () => {
    const host = stale();
    await host.stacks.refreshDrift();
    const { revision } = host.stacks.currentDrift()!.stacks[0]!;
    const result = await up(host, revision);
    expect(result).toMatchObject({ succeeded: true, outcome: STACK_OUTCOMES.reconciled("wiki", ["wiki"]) });
    expect(host.scripts.some((script) => script.includes("up -d --force-recreate --no-deps 'wiki'"))).toBe(true);
  });

  it("refuses a review gone stale, recreating nothing", async () => {
    const host = stale();
    const result = await up(host, "0".repeat(64));
    expect(result).toMatchObject({ succeeded: false, outcome: STACK_OUTCOMES.driftChanged("wiki") });
    expect(host.scripts.some((script) => / up -d/.test(script))).toBe(false);
  });

  it("refuses once nothing differs any more", async () => {
    const host = stacksWith({
      wantedServices: { wiki: { image: "wiki:2" } },
      hashes: HASHES,
      inspected: { Wiki: running },
    });
    expect(await up(host, "0".repeat(64))).toMatchObject({ succeeded: false });
    expect(host.scripts.some((script) => / up -d/.test(script))).toBe(false);
  });

  it.each([
    ["a protected member", { protectedContainers: new Set(["Wiki"]) }, "read only here"],
    ["a dry-run host", { dryRun: true }, "only watches"],
  ])("never recreates %s, though it can be read and reported", async (_name, settings, refusal) => {
    const host = stale({ settings });
    await host.stacks.refreshDrift();
    const { revision } = host.stacks.currentDrift()!.stacks[0]!;
    expect((await up(host, revision)).outcome).toContain(refusal);
    expect(host.scripts.some((script) => / up -d/.test(script))).toBe(false);
  });

  it("leaves a plain recreate as it was", async () => {
    const host = stale();
    await host.stacks.run("stack_up", { project: "wiki", removeData: false });
    expect(host.scripts.some((script) => script.includes("--force-recreate"))).toBe(false);
  });
});

describe("whether a stack really came back", () => {
  const up = (overrides: Parameters<typeof stacksWith>[0]) =>
    stacksWith(overrides).stacks.run("stack_up", { project: "wiki", removeData: false });
  const running = { Config: {}, State: { Running: true, Status: "running" }, RestartCount: 0 };
  const exited = (exitCode: number, restart = "no") => ({
    Config: {},
    HostConfig: { RestartPolicy: { Name: restart } },
    State: { Running: false, Status: "exited", ExitCode: exitCode },
    RestartCount: 0,
  });
  const init = member("Init", "init", HASH_A, "exited");
  const wiki = member("Wiki", "wiki", HASH_A);
  const replacement = { ...member("Wiki", "wiki", HASH_B, "exited"), Id: "new-wiki" };
  const bothServices = { wiki: {}, init: {} };

  it("succeeds when every service is healthy and a setup step finished with exit 0", async () => {
    const result = await up({
      wantedServices: bothServices,
      membersBefore: [wiki],
      membersAfterUp: [wiki, init],
      inspected: { Wiki: running, Init: exited(0) },
    });
    expect(result).toMatchObject({ succeeded: true });
  });

  it("waits out a setup step still running when first looked at, and counts its exit 0", async () => {
    const result = await up({
      wantedServices: bothServices,
      membersBefore: [wiki],
      membersAfterUp: [wiki, { ...init, State: "running" }],
      inspected: { Wiki: running, Init: exited(0, "on-failure") },
    });
    expect(result).toMatchObject({ succeeded: true });
  });

  it("fails a new container that exited 42, saying so", async () => {
    const result = await up({
      wantedServices: bothServices,
      membersBefore: [wiki],
      membersAfterUp: [wiki, init],
      inspected: { Wiki: running, Init: exited(42) },
    });
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("Init");
    expect(result.outcome).toContain("exit 42");
  });

  it("fails a setup step that failed again, though it had already exited before", async () => {
    const result = await up({
      wantedServices: bothServices,
      membersBefore: [wiki, init],
      membersAfterUp: [wiki, init],
      inspected: { Wiki: running, Init: exited(1) },
    });
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("exit 1");
  });

  it("fails when a service Compose wants has no container, and names it", async () => {
    const result = await up({
      wantedServices: bothServices,
      membersBefore: [wiki],
      membersAfterUp: [wiki],
      inspected: { Wiki: running },
    });
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("init");
  });

  it("fails when nothing at all is left of the stack", async () => {
    const result = await up({ wantedServices: { wiki: {} }, membersBefore: [wiki], membersAfterUp: [] });
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("wiki");
  });

  it("does not claim success when Compose cannot say what the stack should have", async () => {
    const result = await up({ wantedServices: null, membersAfterUp: [wiki], inspected: { Wiki: running } });
    expect(result.succeeded).toBe(false);
  });

  it("does not expect a service set to no copies", async () => {
    const result = await up({
      wantedServices: { wiki: {}, scaled: { deploy: { replicas: 0 } }, old: { scale: 0 } },
      membersAfterUp: [wiki],
      inspected: { Wiki: running },
    });
    expect(result).toMatchObject({ succeeded: true });
  });

  it("fails a service that was up before and whose new container just ended, even with exit 0", async () => {
    const result = await up({
      wantedServices: { wiki: {} },
      membersBefore: [wiki],
      membersAfterUp: [replacement],
      inspected: { [nameOfMember(replacement)]: exited(0) },
    });
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("exit 0");
  });

  it("fails what should keep restarting yet stopped with exit 0", async () => {
    const result = await up({
      wantedServices: bothServices,
      membersBefore: [wiki],
      membersAfterUp: [wiki, init],
      inspected: { Wiki: running, Init: exited(0, "always") },
    });
    expect(result.succeeded).toBe(false);
  });

  it("leaves out a crashed container of a service no longer in the file, and a one-off", async () => {
    const orphan = member("Old", "old", HASH_A, "exited");
    const oneOff = member("Wiki-run", "wiki", HASH_A, "exited");
    oneOff.Labels!["com.docker.compose.oneoff"] = "True";
    const result = await up({
      wantedServices: { wiki: {} },
      membersBefore: [wiki, orphan, oneOff],
      membersAfterUp: [wiki, orphan, oneOff],
      inspected: { Wiki: running, Old: exited(137), "Wiki-run": exited(2) },
    });
    expect(result).toMatchObject({ succeeded: true });
  });
});

describe("removing a stack with its data, when something else uses that data", () => {
  const INSIDE = `${FOLDER}/db`;
  const OWN = `${FOLDER}/own`;
  const bind = (Source: string) => ({ Type: "bind", Source, Destination: "/mount" });
  const wiki = () => ({ ...member("Wiki", "wiki", HASH_A), Mounts: [bind(INSIDE), bind(OWN)] });
  const other = (name: string, source: string, state = "running") => ({
    Id: name,
    Names: [`/${name}`],
    State: state,
    Status: state,
    Labels: {},
    Mounts: [bind(source)],
  });
  type Fleet = (ReturnType<typeof wiki> | ReturnType<typeof other>)[];
  const withFleet = (fleet: Fleet, canonical?: Record<string, string | null>) => {
    const made = stacksWith(canonical === undefined ? {} : { canonical });
    (
      made.stacks as unknown as { dependencies: { docker: { containerSummaries: unknown } } }
    ).dependencies.docker.containerSummaries = async () => fleet;
    return made;
  };
  const removed = (scripts: readonly string[]) =>
    scripts.flatMap((script) => [...script.matchAll(/rm -rf '([^']+)'/g)].map((match) => match[1]));
  const remove = (stacks: Stacks) => stacks.run("stack_remove", { project: "wiki", removeData: true });

  it.each([
    ["the same folder", INSIDE],
    ["a folder inside it", `${INSIDE}/media`],
    ["the folder above it", FOLDER],
    ["the host's root", "/"],
  ])("leaves it when another stack mounts %s, and removes what is its own alone", async (_what, source) => {
    const { stacks, scripts } = withFleet([wiki(), other("neighbour", source)]);
    const { succeeded, outcome } = await remove(stacks);

    expect(succeeded).toBe(true);
    expect(outcome).toContain(INSIDE);
    expect(removed(scripts)).not.toContain(INSIDE);
    if (source === FOLDER || source === "/") return;
    expect(removed(scripts)).toEqual([OWN]);
  });

  it("counts a stopped container, as it can be started again", async () => {
    const { stacks, scripts } = withFleet([wiki(), other("neighbour", INSIDE, "exited")]);
    await remove(stacks);
    expect(removed(scripts)).toEqual([OWN]);
  });

  it("is not fooled by a link: the other's path resolves to the same folder", async () => {
    const { stacks, scripts } = withFleet([wiki(), other("neighbour", "/srv/alias")], { "/srv/alias": INSIDE });
    await remove(stacks);
    expect(removed(scripts)).toEqual([OWN]);
  });

  it("leaves a folder of its own that is really elsewhere, behind a link", async () => {
    const { stacks, scripts } = withFleet([wiki()], { [INSIDE]: "/mnt/storage/everything" });
    await remove(stacks);
    expect(removed(scripts)).toEqual([OWN]);
    expect(scripts.join("\n")).not.toContain("rm -rf '/mnt/storage");
  });

  it("leaves what it cannot place", async () => {
    const { stacks, scripts } = withFleet([wiki()], { [INSIDE]: null });
    const { outcome } = await remove(stacks);
    expect(removed(scripts)).toEqual([OWN]);
    expect(outcome).toContain(INSIDE);
  });

  it("removes nothing when another container's path cannot be placed, as it could be any of these", async () => {
    const { stacks, scripts } = withFleet([wiki(), other("neighbour", "/srv/gone/deep")], { "/srv/gone/deep": null });
    const { outcome } = await remove(stacks);
    expect(removed(scripts)).toEqual([]);
    expect(outcome).toContain(INSIDE);
    expect(outcome).toContain(OWN);
  });

  it("removes nothing when the host cannot say where anything is", async () => {
    const { stacks, scripts } = withFleet([wiki()], { [FOLDER]: null });
    await remove(stacks);
    expect(removed(scripts)).toEqual([]);
  });

  it("leaves a folder that turns out to be a system folder", async () => {
    const { stacks, scripts } = withFleet([wiki()], { [INSIDE]: "/etc" });
    const { removal } = await stacks.answer({ id: "1", project: "wiki", kind: "removal" });
    expect(removal?.kept).toEqual([{ path: INSIDE, why: "host", usedBy: [] }]);
    await remove(stacks);
    expect(removed(scripts)).toEqual([OWN]);
  });

  it("does not take a folder two of its own members share for shared", async () => {
    const second = { ...member("Db", "db", HASH_A), Mounts: [bind(INSIDE)] };
    const { stacks, scripts } = withFleet([wiki(), second]);
    await remove(stacks);
    expect(removed(scripts).toSorted()).toEqual([INSIDE, OWN].toSorted());
  });

  it("removes everything as before when nothing else uses it", async () => {
    const { stacks, scripts } = withFleet([wiki(), other("unrelated", "/srv/unrelated")]);
    const { outcome } = await remove(stacks);
    expect(removed(scripts).toSorted()).toEqual([INSIDE, OWN].toSorted());
    expect(outcome).toBe(STACK_OUTCOMES.removedWithData("wiki"));
  });

  it("shows beforehand what it will leave and why, as it then does", async () => {
    const { stacks, scripts } = withFleet([wiki(), other("neighbour", INSIDE)]);
    const { removal } = await stacks.answer({ id: "1", project: "wiki", kind: "removal" });

    expect(removal?.data.map(({ path }) => path)).toEqual([OWN]);
    expect(removal?.kept).toEqual([{ path: INSIDE, why: "shared", usedBy: ["neighbour"] }]);
    await remove(stacks);
    expect(removed(scripts)).toEqual(removal?.data.map(({ path }) => path));
  });
});

describe("whether an image is there", () => {
  it("counts the host's copy, a registry's yes and no, and says when it could not tell", async () => {
    const local = imageExistsWith(
      async () => ({ Id: "x" }),
      async () => "sha256:x",
    );
    expect(await local("a")).toBe(true);
    const remote = (digest: () => Promise<string | null>) => imageExistsWith(async () => null, digest);
    expect(await remote(async () => "sha256:x")("a")).toBe(true);
    expect(await remote(async () => Promise.reject(new Error("HTTP 404")))("a")).toBe(false);
    expect(await remote(async () => Promise.reject(new Error("connection reset")))("a")).toBeNull();
  });
});

describe("saving several files as one", () => {
  const WIKI_DETAILS = {
    Id: "Wiki",
    Name: "/Wiki",
    Config: {
      Labels: { "com.docker.compose.project": "wiki", "com.docker.compose.service": "wiki" },
      Env: [],
      Image: "wiki:2",
    },
    HostConfig: {},
    Mounts: [],
    NetworkSettings: { Ports: {}, Networks: {} },
    State: { Running: true, Status: "running" },
    RestartCount: 0,
  } as never;
  const JOURNAL = ".autoheal-transaction";
  const NEW_COMPOSE = "services:\n  wiki:\n    image: wiki:3\n";
  const NEW_ENV = "DB_PASS=changed\n";
  // The real scripts, run by a real shell on real files, its folder moved under a test's own; only Compose is faked.
  function onDisk({
    agreeingCompose = false,
    membersAfterUp,
    details = WIKI_DETAILS,
  }: { agreeingCompose?: boolean; membersAfterUp?: ContainerSummary[]; details?: never } = {}) {
    let composeRan = false;
    const composeCommands: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "autoheal-stack-save-"));
    const folder = join(root, "wiki");
    const shims = join(root, "bin");
    mkdirSync(folder);
    mkdirSync(shims);
    const composeFile = join(folder, "docker-compose.yml");
    const envFile = join(folder, ".env");
    writeFileSync(composeFile, FILE_TEXT);
    writeFileSync(envFile, ENV_TEXT);
    chmodSync(envFile, 0o640);
    const plan = join(root, "plan");
    const tripped = join(root, "tripped");
    // A rename onto .env fails, or kills the script as a lost machine would; "always" fails every one after it too.
    writeFileSync(
      join(shims, "mv"),
      `#!/bin/sh
eval last=\\\${$#}
what=$(cat '${plan}' 2>/dev/null)
[ -f '${tripped}' ] && [ "$what" = always ] && { echo "mv: refused" >&2; exit 1; }
case "$last" in
  */.env)
    case "$what" in
      fail) echo "mv: refused" >&2; exit 1 ;;
      always) : > '${tripped}'; echo "mv: refused" >&2; exit 1 ;;
      kill) kill -9 $PPID; exit 1 ;;
    esac ;;
  */docker-compose.yml)
    [ "$what" = fail-compose ] && { echo "mv: refused" >&2; exit 1; } ;;
esac
exec /usr/bin/mv "$@"
`,
    );
    chmodSync(join(shims, "mv"), 0o755);
    let hold: Promise<void> = Promise.resolve();
    const checks = { started: 0 };
    const hostScript = vi.fn(async (script: string) => {
      if (script.includes("config --hash")) {
        checks.started += 1;
        await hold;
        const marker = /echo "(AUTOHEAL-[0-9a-f-]+)"/.exec(script)?.[1] ?? "";
        const config = { services: { wiki: { image: "wiki:2", env_file: [{ path: ".env" }] } } };
        return { exitCode: 0, output: `wiki ${HASH_A}\n${marker}\n${encoded(JSON.stringify(config))}` };
      }
      // Never this machine's own Compose or Docker.
      if (script.includes("docker compose version")) {
        if (/ up -d/.test(script)) composeRan = true;
        const [command] = /\bup (?:-d|--no-start)[^\n]*/.exec(script) ?? [];
        if (command !== undefined) composeCommands.push(command);
        const marker = /echo "(AUTOHEAL-[0-9a-f-]+)"/.exec(script)?.[1];
        // The service with whatever the settings wanted: Compose reads it as it was asked to.
        const config = { services: { wiki: { image: "wiki:2", environment: { ADDED: "1" } } } };
        return agreeingCompose && marker !== undefined
          ? { exitCode: 0, output: `${marker}\n${encoded(JSON.stringify(config))}` }
          : { exitCode: 0, output: "" };
      }
      const ran = spawnSync("sh", ["-c", script.replaceAll(FOLDER, folder)], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${shims}:${process.env.PATH}` },
      });
      return { exitCode: ran.status, output: `${ran.stdout}${ran.stderr}`.replaceAll(folder, FOLDER) };
    });
    const stacks = new Stacks({
      docker: {
        containerSummaries: async () =>
          composeRan && membersAfterUp !== undefined ? membersAfterUp : [member("Wiki", "wiki", HASH_A)],
        networks: async () => [],
        inspectImage: async () => null,
        inspect: async () => details,
      },
      hostScript,
      imageExists: async () => true,
      settings: {
        containerAccess: true,
        hostDeploy: true,
        dryRun: false,
        protectedContainers: new Set<string>(),
        selfContainerName: "autoheal",
      },
      wait: async () => undefined,
      clock: (() => {
        let now = 0;
        return () => (now += 60_000);
      })(),
    });
    const ask = (request: object): Promise<StackAnswer> =>
      stacks.answer({ id: "r1", project: "wiki", ...request } as never);
    const hashes = async () => {
      const { files } = await ask({ kind: "read" });
      return {
        compose: files!.files.find((file) => file.path === COMPOSE)!.hash,
        env: files!.files.find((file) => file.path === ENV)?.hash ?? null,
      };
    };
    const saveBoth = async (hash: { compose: string | null; env: string | null }) =>
      ask({
        kind: "save",
        files: [
          { path: COMPOSE, text: NEW_COMPOSE, hash: hash.compose },
          { path: ENV, text: NEW_ENV, hash: hash.env },
        ],
      });
    const contents = () => [readFileSync(composeFile, "utf8"), readFileSync(envFile, "utf8")];
    const leftovers = () =>
      readdirSync(folder).filter((name) => name.includes(".autoheal") && !name.endsWith(".autoheal-previous"));
    return {
      stacks,
      composeCommands,
      root,
      folder,
      composeFile,
      envFile,
      checks,
      ask,
      hashes,
      saveBoth,
      contents,
      leftovers,
      hostScript,
      failRenames: (what: string) => writeFileSync(plan, what),
      healRenames: () => writeFileSync(plan, ""),
      holdChecks: () => {
        let release!: () => void;
        hold = new Promise((resolve) => {
          release = resolve;
        });
        return release;
      },
    };
  }
  const OLD = [FILE_TEXT, ENV_TEXT];
  const NEW = [NEW_COMPOSE, NEW_ENV];

  it("writes both, keeps both last versions, leaves nothing else, and puts both back", async () => {
    const host = onDisk();
    chmodSync(host.composeFile, 0o604);
    expect((await host.saveBoth(await host.hashes())).error).toBeNull();
    expect(host.contents()).toEqual(NEW);
    expect(host.leftovers()).toEqual([]);
    expect(readFileSync(`${host.composeFile}.autoheal-previous`, "utf8")).toBe(FILE_TEXT);
    expect(readFileSync(`${host.envFile}.autoheal-previous`, "utf8")).toBe(ENV_TEXT);
    expect(statSync(host.composeFile).mode & 0o777).toBe(0o604);
    expect(statSync(host.envFile).mode & 0o777).toBe(0o640);

    expect((await host.ask({ kind: "restore" })).error).toBeNull();
    expect(host.contents()).toEqual(OLD);
    expect(host.leftovers()).toEqual([]);
    expect(statSync(host.envFile).mode & 0o777).toBe(0o640);
  });

  it("asks the host as few times as it safely can, as each trip starts a helper container on a slow host", async () => {
    const host = onDisk();
    const hash = await host.hashes();

    host.hostScript.mockClear();
    await host.ask({ kind: "read" });
    // Its Compose file and its .env in one trip.
    expect(host.hostScript).toHaveBeenCalledTimes(1);

    host.hostScript.mockClear();
    expect((await host.saveBoth(hash)).error).toBeNull();
    // An unfinished save, the files, Compose's word, the files again just before writing, and the write.
    expect(host.hostScript).toHaveBeenCalledTimes(5);
    expect(host.contents()).toEqual(NEW);
  });

  it("makes a new .env readable only by its owner", async () => {
    const host = onDisk();
    rmSync(host.envFile);
    expect((await host.saveBoth(await host.hashes())).error).toBeNull();
    expect(readFileSync(host.envFile, "utf8")).toBe(NEW_ENV);
    expect(statSync(host.envFile).mode & 0o777).toBe(0o600);
  });

  it("takes one of two saves of the same version, the other told to look again", async () => {
    const host = onDisk();
    const hash = await host.hashes();
    const release = host.holdChecks();
    const save = (text: string) => host.ask({ kind: "save", files: [{ path: COMPOSE, text, hash: hash.compose }] });
    const first = save("services:\n  first: {}\n");
    await vi.waitFor(() => expect(host.checks.started).toBeGreaterThan(0));
    const second = save("services:\n  second: {}\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const answers = await Promise.all([first, second]);
    expect(answers[0].error).toBeNull();
    expect(answers[1].error).toContain("being changed");
    expect(readFileSync(host.composeFile, "utf8")).toBe("services:\n  first: {}\n");
  });

  it("does not write over what changed on the host while Compose was reading the new version", async () => {
    const host = onDisk();
    const hash = await host.hashes();
    const release = host.holdChecks();
    const saving = host.saveBoth(hash);
    await vi.waitFor(() => expect(host.checks.started).toBeGreaterThan(0));
    writeFileSync(host.composeFile, "edited: by hand\n");
    release();
    expect((await saving).error).toContain("changed on the host");
    expect(host.contents()).toEqual(["edited: by hand\n", ENV_TEXT]);
  });

  it("leaves the whole old version, and the older kept one, when the second rename fails", async () => {
    const host = onDisk();
    writeFileSync(`${host.composeFile}.autoheal-previous`, "older compose\n");
    writeFileSync(`${host.envFile}.autoheal-previous`, "older env\n");
    const hash = await host.hashes();
    host.failRenames("fail");
    const answer = await host.saveBoth(hash);
    expect(answer.error).toContain("Could not write it");
    expect(host.contents()).toEqual(OLD);
    expect(host.leftovers()).toEqual([]);
    expect(readFileSync(`${host.composeFile}.autoheal-previous`, "utf8")).toBe("older compose\n");
    expect(readFileSync(`${host.envFile}.autoheal-previous`, "utf8")).toBe("older env\n");
  });

  it("removes a file it was creating when another of the set fails", async () => {
    const host = onDisk();
    const hash = await host.hashes();
    rmSync(host.envFile);
    const written = await host.ask({
      kind: "save",
      files: [
        { path: ENV, text: NEW_ENV, hash: null },
        { path: COMPOSE, text: NEW_COMPOSE, hash: hash.compose },
      ],
    });
    expect(written.error).toBeNull();
    expect((await host.ask({ kind: "restore" })).error).toBeNull();
    rmSync(host.envFile);
    rmSync(`${host.envFile}.autoheal-previous`, { force: true });
    host.failRenames("fail-compose");
    const latest = await host.hashes();
    const failed = await host.ask({
      kind: "save",
      files: [
        { path: ENV, text: NEW_ENV, hash: null },
        { path: COMPOSE, text: NEW_COMPOSE, hash: latest.compose },
      ],
    });
    expect(failed.error).toContain("Could not write it");
    expect(existsSync(host.envFile)).toBe(false);
    expect(host.leftovers()).toEqual([]);
  });

  it("puts everything back when a script dies between renames, at the next read", async () => {
    const host = onDisk();
    const hash = await host.hashes();
    host.failRenames("kill");
    expect((await host.saveBoth(hash)).error).not.toBeNull();
    expect(host.contents()).toEqual([NEW_COMPOSE, ENV_TEXT]);
    expect(host.leftovers()).toContain(JOURNAL);

    host.healRenames();
    const { files } = await host.ask({ kind: "read" });
    expect(files!.files.find((file) => file.path === COMPOSE)!.text).toBe(FILE_TEXT);
    expect(host.contents()).toEqual(OLD);
    expect(host.leftovers()).toEqual([]);
  });

  it("puts everything back first when the next thing after such a death is another save", async () => {
    const host = onDisk();
    const hash = await host.hashes();
    host.failRenames("kill");
    await host.saveBoth(hash);
    host.healRenames();
    expect((await host.saveBoth(hash)).error).toBeNull();
    expect(host.contents()).toEqual(NEW);
    expect(host.leftovers()).toEqual([]);
    expect(readFileSync(`${host.composeFile}.autoheal-previous`, "utf8")).toBe(FILE_TEXT);
  });

  it("says so and writes nothing more when it cannot put the old version back, until it can", async () => {
    const host = onDisk();
    const hash = await host.hashes();
    host.failRenames("always");
    const answer = await host.saveBoth(hash);
    expect(answer.error).toContain("could not be finished");
    expect(host.contents()).toEqual([NEW_COMPOSE, ENV_TEXT]);
    expect(host.leftovers()).toContain(JOURNAL);
    // The old copy stays while it is the only one there is.
    const keptCopies = host.leftovers().filter((name) => name.startsWith("docker-compose.yml.autoheal."));
    expect(keptCopies.map((name) => readFileSync(join(host.folder, name), "utf8"))).toContain(FILE_TEXT);

    const again = await host.ask({
      kind: "save",
      files: [{ path: COMPOSE, text: "services: {}\n", hash: hash.compose }],
    });
    expect(again.error).toContain("could not be finished");
    expect(host.contents()).toEqual([NEW_COMPOSE, ENV_TEXT]);
    expect(host.leftovers()).toContain(JOURNAL);

    host.healRenames();
    await host.ask({ kind: "read" });
    expect(host.contents()).toEqual(OLD);
    expect(host.leftovers()).toEqual([]);
  });

  it("will not act on a journal naming a file that is not this stack's", async () => {
    const host = onDisk();
    const outside = join(host.root, "outside");
    writeFileSync(outside, "someone's\n");
    writeFileSync(join(host.folder, JOURNAL), `N ${encoded(outside)} abcdef\n`);
    const hash = { compose: "x", env: "x" };
    const answer = await host.saveBoth(hash);
    expect(answer.error).toContain("could not be finished");
    expect(readFileSync(outside, "utf8")).toBe("someone's\n");
    expect(existsSync(join(host.folder, JOURNAL))).toBe(true);
  });

  it("puts back as one too: a failure leaves the version it started from", async () => {
    const host = onDisk();
    expect((await host.saveBoth(await host.hashes())).error).toBeNull();
    host.failRenames("fail");
    expect((await host.ask({ kind: "restore" })).error).toContain("Could not write it");
    expect(host.contents()).toEqual(NEW);
    expect(host.leftovers()).toEqual([]);
    expect(readFileSync(`${host.composeFile}.autoheal-previous`, "utf8")).toBe(FILE_TEXT);
  });

  it("keeps a save out while a person's settings go into the same files, and puts them back if Compose disagrees", async () => {
    const host = onDisk();
    const hash = await host.hashes();
    const release = host.holdChecks();
    const wanted = { ...settingsOf(WIKI_DETAILS, {}), environment: [{ name: "ADDED", value: "1" }] };
    const applying = host.stacks.applySettings("Wiki", wanted);
    await vi.waitFor(() => expect(host.checks.started).toBeGreaterThan(0));

    const save = await host.ask({ kind: "save", files: [{ path: COMPOSE, text: NEW_COMPOSE, hash: hash.compose }] });
    expect(save.error).toContain("being changed");
    release();
    const applied = await applying;

    expect(applied).toMatchObject({ written: false, reason: expect.stringContaining("Compose") });
    expect(host.contents()).toEqual(OLD);
    expect(host.leftovers()).toEqual([]);
  });

  describe("a person's settings going into a Compose app's file", () => {
    const withAdded = () => ({ ...settingsOf(WIKI_DETAILS, {}), environment: [{ name: "ADDED", value: "1" }] });
    const STOPPED = {
      ...(WIKI_DETAILS as object),
      State: { Running: false, Status: "exited", ExitCode: 0 },
    } as never;

    it("changes the file, recreates that container alone, and the last file can be put back", async () => {
      const host = onDisk({ agreeingCompose: true });
      const applied = await host.stacks.applySettings("Wiki", withAdded());

      expect(applied).toEqual({
        written: true,
        result: { succeeded: true, outcome: STACK_OUTCOMES.settingsWritten("Wiki", "docker-compose.yml") },
      });
      expect(readFileSync(host.composeFile, "utf8")).toContain("ADDED");
      expect(host.composeCommands).toEqual(["up -d --no-deps 'wiki' 2>&1"]);
      expect(readFileSync(`${host.composeFile}.autoheal-previous`, "utf8")).toBe(FILE_TEXT);

      // Putting back changes the file alone: a recreate is what puts it to use.
      expect((await host.ask({ kind: "restore" })).error).toBeNull();
      expect(readFileSync(host.composeFile, "utf8")).toBe(FILE_TEXT);
      expect(host.composeCommands).toHaveLength(1);
    });

    it("leaves a stopped container stopped", async () => {
      const host = onDisk({ agreeingCompose: true, details: STOPPED });
      const applied = await host.stacks.applySettings("Wiki", withAdded());
      expect(applied).toMatchObject({
        written: true,
        result: { succeeded: true, outcome: STACK_OUTCOMES.settingsWrittenStopped("Wiki", "docker-compose.yml") },
      });
      expect(host.composeCommands).toEqual(["up --no-start --no-deps 'wiki' 2>&1"]);
    });
  });

  it("puts settings back when the container they recreated is not there afterwards", async () => {
    const host = onDisk({ agreeingCompose: true, membersAfterUp: [] });
    const wanted = { ...settingsOf(WIKI_DETAILS, {}), environment: [{ name: "ADDED", value: "1" }] };
    const applied = await host.stacks.applySettings("Wiki", wanted);
    expect(applied).toMatchObject({ written: true, result: { succeeded: false } });
    expect(host.contents()).toEqual(OLD);
  });

  it("will not start Compose on what an interrupted save left, putting it right first", async () => {
    const host = onDisk({ agreeingCompose: true });
    const hash = await host.hashes();
    host.failRenames("kill");
    await host.saveBoth(hash);
    host.healRenames();
    const ran = await host.stacks.run("stack_up", { project: "wiki", removeData: false });
    expect(ran.succeeded).toBe(true);
    expect(host.contents()).toEqual(OLD);
    expect(host.leftovers()).toEqual([]);
  });
});

describe("a newer version handed to the agent, its tag changed in its files", () => {
  const TAGGED = "services:\n  wiki:\n    image: wiki:2.0 # pinned\n    env_file: .env\n";
  const imageIn = (text: string) => /image: (\S+)/.exec(text)?.[1] ?? "";

  // The real scripts on real files, under a test's own folder; only Compose and Docker are faked.
  function tagHost({ holdsOnNew = true, keeps = true, text = TAGGED } = {}) {
    const root = mkdtempSync(join(tmpdir(), "autoheal-retag-"));
    const folder = join(root, "wiki");
    mkdirSync(folder);
    const composeFile = join(folder, "docker-compose.yml");
    writeFileSync(composeFile, text);
    writeFileSync(join(folder, ".env"), ENV_TEXT);
    const commands: string[] = [];
    const onDiskImage = () => imageIn(readFileSync(composeFile, "utf8"));
    const resolved = (script: string) => {
      const edited = /printf %s '([^']+)' \| base64 -d > "\$work\/0"/.exec(script)?.[1];
      const read = edited === undefined ? readFileSync(composeFile, "utf8") : Buffer.from(edited, "base64").toString();
      return { services: { wiki: { image: imageIn(read), env_file: [{ path: ".env" }] } } };
    };
    const hostScript = vi.fn(async (script: string) => {
      const marker = /echo "(AUTOHEAL-[0-9a-f-]+)"/.exec(script)?.[1] ?? "";
      if (script.includes("config --hash")) {
        return { exitCode: 0, output: `wiki ${HASH_A}\n${marker}\n${encoded(JSON.stringify(resolved(script)))}` };
      }
      if (script.includes("config --format json")) {
        return { exitCode: 0, output: `${marker}\n${encoded(JSON.stringify(resolved(script)))}` };
      }
      if (script.includes("docker compose version")) {
        const command = / (stop|up -d --no-deps|up --no-start --no-deps) (.*) 2>&1/.exec(script);
        if (command !== null) commands.push(`${command[1]} ${command[2]}`);
        return { exitCode: 0, output: "" };
      }
      const ran = spawnSync("sh", ["-c", script.replaceAll(FOLDER, folder)], { encoding: "utf8" });
      return { exitCode: ran.status, output: `${ran.stdout}${ran.stderr}`.replaceAll(folder, FOLDER) };
    });
    // Running on what it was, or on the new version when that holds; else the new version exits at once.
    const details = () => {
      const failing = !holdsOnNew && onDiskImage() === "wiki:2.1";
      return {
        Id: "Wiki",
        Name: "/Wiki",
        Config: { Labels: member("Wiki", "wiki", HASH_A).Labels, Image: onDiskImage() },
        Mounts: [],
        State: failing
          ? { Running: false, Status: "exited", ExitCode: 1, FinishedAt: "2026-11-07T10:00:00Z" }
          : { Running: true, Status: "running" },
        RestartCount: 0,
      } as never;
    };
    const keeper = {
      take: vi.fn(async () => {
        // Copied while the old version is still what the files say.
        expect(onDiskImage()).toBe("wiki:2.0");
        return { containerId: "Wiki", mounts: [], complete: keeps, outcome: keeps ? "" : " The copy failed." };
      }),
      restore: vi.fn(async () => ({ at: 1, problem: null })),
      discard: vi.fn(async () => undefined),
    };
    const stacks = new Stacks({
      docker: {
        containerSummaries: async () => [member("Wiki", "wiki", HASH_A)],
        networks: async () => [],
        inspectImage: async () => null,
        inspect: async () => details(),
      },
      hostScript,
      imageExists: async () => true,
      settings: {
        containerAccess: true,
        hostDeploy: true,
        dryRun: false,
        protectedContainers: new Set<string>(),
        selfContainerName: "autoheal",
      },
      wait: async () => undefined,
      clock: (() => {
        let now = 0;
        return () => (now += 60_000);
      })(),
    });
    return { stacks, keeper, commands, composeText: () => readFileSync(composeFile, "utf8") };
  }

  it("changes only the tag, copies the data aside first, recreates it, and drops the copy once it holds", async () => {
    const host = tagHost();
    const phases: string[] = [];

    const ran = await host.stacks.changeTag("Wiki", "2.1", host.keeper, { enter: (phase) => void phases.push(phase) });

    expect(ran).toEqual({
      succeeded: true,
      outcome: STACK_OUTCOMES.tagChanged(["Wiki"], "2.1", STACK_OUTCOMES.tagLine("docker-compose.yml")),
      output: null,
    });
    expect(host.composeText()).toBe(TAGGED.replace("wiki:2.0", "wiki:2.1"));
    expect(host.commands).toEqual(["stop 'wiki'", "up -d --no-deps 'wiki'"]);
    expect(host.keeper.take).toHaveBeenCalledTimes(1);
    expect(host.keeper.discard).toHaveBeenCalledWith("Wiki");
    expect(phases).toEqual(["stopping", "keeping_data", "recreating", "checking"]);
  });

  it("puts the data, the file and the old container back when the new version does not come back well", async () => {
    const host = tagHost({ holdsOnNew: false });

    const ran = await host.stacks.changeTag("Wiki", "2.1", host.keeper);

    expect(ran.succeeded).toBe(false);
    expect(ran.outcome).toContain("were put back on 2.0");
    expect(host.composeText()).toBe(TAGGED);
    expect(host.keeper.restore).toHaveBeenCalledWith("Wiki", expect.objectContaining({ Id: "Wiki" }));
    expect(host.commands).toEqual(["stop 'wiki'", "up -d --no-deps 'wiki'", "stop 'wiki'", "up -d --no-deps 'wiki'"]);
  });

  it("changes nothing when its data could not be copied aside, and starts it again", async () => {
    const host = tagHost({ keeps: false });

    const ran = await host.stacks.changeTag("Wiki", "2.1", host.keeper);

    expect(ran).toMatchObject({ succeeded: false, outcome: STACK_OUTCOMES.tagNoCopy(" The copy failed.") });
    expect(host.composeText()).toBe(TAGGED);
    expect(host.commands).toEqual(["stop 'wiki'", "up -d --no-deps 'wiki'"]);
  });

  it("stops nothing and writes nothing for a container whose files hold no tag it can change", async () => {
    const built = "services:\n  wiki:\n    build: .\n";
    const host = tagHost({ text: built });

    const ran = await host.stacks.changeTag("Wiki", "2.1", host.keeper);

    expect(ran.succeeded).toBe(false);
    expect(ran.outcome).toContain("has no image line");
    expect(host.composeText()).toBe(built);
    expect(host.commands).toEqual([]);
    expect(host.keeper.take).not.toHaveBeenCalled();
  });
});
