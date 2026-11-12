import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPOSE_IMPORT, INSTALL_OUTCOMES, PROJECT_PAGE } from "../shared/constants.js";
import { INSTALL_RECIPES, OWNED_FOLDER, draftOf, type InstallSpec } from "../shared/install.js";
import { writeScript } from "./install-script.js";
import { Installs, type InstallsDependencies } from "./installs.js";

const spec: InstallSpec = {
  name: "App",
  slug: "app",
  image: "example/app:1",
  folder: "/home/me/docker/app",
  restartPolicy: "unless-stopped",
  owner: null,
  networks: ["npm"],
  port: { target: 3000, published: null },
  mounts: [{ source: "./data", target: "/data" }],
  environment: [],
  secrets: [],
  database: null,
};

interface Setup {
  containers?: Record<string, unknown>;
  summaries?: unknown[];
  scripts?: { exitCode: number | null; output: string }[];
  settings?: Partial<InstallsDependencies["settings"]>;
  available?: number;
  localImage?: unknown;
  facts?: () => Promise<unknown>;
  shell?: InstallsDependencies["hostScript"];
}

const execute = promisify(execFile);
// The host's own shell for real, with a stand-in for Compose, keeping what it prints on both streams as a host does.
const runWith = (compose: string) => (script: string) =>
  execute("sh", ["-c", script.replace(/^if docker compose[\s\S]*?fi$/m, () => compose)]).then(
    ({ stdout, stderr }) => ({ exitCode: 0, output: `${stdout}${stderr}` }),
    (error: { code: number; stdout: string; stderr: string }) => ({
      exitCode: error.code,
      output: `${error.stdout}${error.stderr}`,
    }),
  );
// With a Compose that does nothing: whatever a script would remove, it removes.
const runForReal = runWith("compose=true");

function installs({
  containers = {},
  summaries = [],
  scripts,
  settings = {},
  available = 1e12,
  localImage = null,
  facts,
  shell,
}: Setup = {}) {
  const ran: string[] = [];
  const pulled: string[] = [];
  const answers = [...(scripts ?? [])];
  const running = { State: { Running: true }, Config: {} };
  const dependencies = {
    docker: {
      inspect: async (name: string) => containers[name] ?? null,
      inspectImage: async () => localImage,
      containerSummaries: async () => summaries,
      pull: async (image: string, onLine: (line: object) => void) => {
        pulled.push(image);
        onLine({});
        containers[spec.name] = running;
      },
    },
    registry: { facts: facts ?? (async () => ({ ports: [3000], volumes: ["/data"], environment: [], user: "" })) },
    files: {
      filesystem: async () => ({ device: "1", totalBytes: 1, usedBytes: 0, availableBytes: available }),
      system: async () => ({ cpuCount: 1, kernel: "7", architecture: "x86_64" }),
    },
    hostRoot: "/host/root",
    hostScript: async (script: string, timeoutMilliseconds: number) => {
      ran.push(script);
      if (shell !== undefined) return shell(script, timeoutMilliseconds);
      return answers.shift() ?? { exitCode: 0, output: "compose=docker compose\nwritable=1\nplace=/home/me\n" };
    },
    settings: { hostDeploy: true, containerAccess: true, dryRun: false, ...settings },
    wait: async () => undefined,
    clock: (() => {
      let now = 0;
      return () => (now += 60_000);
    })(),
  } as unknown as InstallsDependencies;
  return { subject: new Installs(dependencies), ran, pulled };
}

const report = () => {
  const phases: string[] = [];
  return { phases, enter: (phase: string) => phases.push(phase), pulled: () => undefined };
};
const failing = async (setup: Setup) => {
  const answer = await installs(setup).subject.answer({ id: "1", kind: "check", spec });
  return answer.checks.filter((check) => !check.ok);
};
const OK_CHECK = { exitCode: 0, output: "compose=docker compose\nwritable=1\nplace=/home/me\n" };

describe("checking a new app", () => {
  it("finds nothing wrong on a host ready for it", async () => {
    expect(await failing({})).toEqual([]);
  });

  it.each([
    ["no Compose", { scripts: [{ exitCode: 3, output: "" }] }, "compose", /no Docker Compose/],
    [
      "a folder taken",
      { scripts: [{ exitCode: 0, output: `${OK_CHECK.output}taken=1\n` }] },
      "folder",
      /already has files in it/,
    ],
    [
      "a folder it cannot write",
      { scripts: [{ exitCode: 0, output: "compose=docker compose\nplace=/volume1\n" }] },
      "folder",
      /cannot write in \/volume1/,
    ],
    ["a name in use", { containers: { App: {} } }, "name", /already called App/],
    [
      "a missing network",
      { scripts: [{ exitCode: 0, output: "compose=docker compose\nwritable=1\nmissing=npm\n" }] },
      "network",
      /no network called npm/,
    ],
    ["a nearly full disk", { available: 1000 }, "disk", /Less than 1 GB/],
  ])("says so on %s", async (_what, setup, key, message) => {
    const [problem] = await failing(setup);
    expect(problem?.key).toBe(key);
    expect(problem?.detail).toMatch(message);
  });

  it("refuses a published port in use, and the host's own folders", async () => {
    const taken = await installs({ summaries: [{ Ports: [{ PublicPort: 8080 }] }] }).subject.answer({
      id: "1",
      kind: "check",
      spec: { ...spec, networks: [], port: { target: 3000, published: 8080 } },
    });
    expect(taken.checks.find((check) => check.key === "port")?.ok).toBe(false);
    const denied = await installs().subject.answer({
      id: "1",
      kind: "check",
      spec: { ...spec, mounts: [{ source: "/etc", target: "/x" }] },
    });
    expect(denied.checks.find((check) => check.key === "mounts")?.ok).toBe(false);
  });

  it.each([
    ["its .env's switch", { hostDeploy: false }, /HOST_DEPLOY/],
    ["dry-run", { dryRun: true }, /dry-run/],
    ["no access to containers", { containerAccess: false }, /keeps people out/],
  ])("does nothing under %s", async (_what, settings, message) => {
    const { subject, ran } = installs({ settings });
    const answer = await subject.answer({ id: "1", kind: "check", spec });
    expect(answer.error).toMatch(message);
    expect(ran).toEqual([]);
    expect((await subject.install(spec, report())).succeeded).toBe(false);
    expect((await subject.uninstall("App", false)).succeeded).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe("drafting a new app", () => {
  const app = {
    Name: "/wiki",
    State: { Running: true },
    Config: { Image: "a", Env: [], Labels: { "com.docker.compose.project.working_dir": "/volume1/docker/wiki" } },
    HostConfig: {},
  };

  it("reads an unknown image from its registry, for this machine's type, and fills the host's habits in", async () => {
    const asked: unknown[] = [];
    const { subject } = installs({
      containers: { x: app },
      summaries: [{ Id: "x" }],
      facts: async (...args: unknown[]) => {
        asked.push(args[1]);
        return { ports: [8080], volumes: [], environment: [], user: "" };
      },
    });
    const answer = await subject.answer({ id: "1", kind: "draft", image: "ghcr.io/dev/new:1", recipe: null });
    expect(asked).toEqual(["amd64"]);
    expect(answer.draft?.spec.folder).toBe("/volume1/docker/new");
    expect(answer.checks.length).toBeGreaterThan(0);
  });

  it("does not ask a registry about an image the host already has", async () => {
    const { subject } = installs({
      localImage: { Config: { ExposedPorts: { "9000/tcp": {} }, Volumes: { "/d": {} }, Env: ["A=1"], User: "app" } },
      facts: async () => {
        throw new Error("asked");
      },
    });
    const answer = await subject.answer({ id: "1", kind: "draft", image: "local/app:1", recipe: null });
    expect(answer.draft).toMatchObject({
      spec: { port: { target: 9000 }, mounts: [{ target: "/d" }] },
      identity: { kind: "image", user: "app" },
    });
  });

  it("says why an unknown image cannot be read, and shows a recipe all the same with its check failing", async () => {
    const facts = async () => {
      throw new Error("no version for arm64");
    };
    expect(await installs({ facts }).subject.answer({ id: "1", kind: "draft", image: "a/b:1", recipe: null })).toEqual({
      error: "no version for arm64",
      draft: null,
      checks: [],
    });
    const recipe = await installs({ facts }).subject.answer({ id: "1", kind: "draft", image: null, recipe: "mealie" });
    expect(recipe.draft?.spec.name).toBe("Mealie");
    expect(recipe.checks.find((check) => check.key === "image")).toMatchObject({
      ok: false,
      detail: "no version for arm64",
    });
  });
});

describe("a pasted project's page", () => {
  it("reads none of the settings files a Compose file names past how many it reads, and says so", async () => {
    const names = Array.from({ length: COMPOSE_IMPORT.envFilesRead + 1 }, (_, index) => `settings-${index}.env`);
    const asked: string[] = [];
    const read = (async (url: string) => {
      asked.push(url);
      return url.endsWith("/HEAD/compose.yaml")
        ? new Response("services:\n  app:\n    image: app:1\n")
        : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const config = { services: { app: { image: "app:1", env_file: names.map((path) => ({ path })) } } };
    const made = installs({ shell: async () => ({ exitCode: 0, output: JSON.stringify(config) }) });
    (
      made.subject as unknown as { dependencies: { fetchImplementation: typeof fetch } }
    ).dependencies.fetchImplementation = read;

    const answer = await made.subject.answer({
      id: "1",
      kind: "draft",
      image: null,
      recipe: null,
      project: "https://github.com/someone/many",
    });

    expect(answer.error).toBe(COMPOSE_IMPORT.tooManySettingsFiles(names.length));
    expect(asked.filter((url) => url.includes("/settings-"))).toEqual([]);
  });

  it.each([
    ["one its Compose file names", "settings.env", [{ path: "settings.env" }]],
    ["the example it keeps of its own", ".env.example", []],
  ])(
    "refuses a settings file longer than a preview reads, %s, rather than a start of it",
    async (_which, file, named) => {
      const long = "A=1\n".repeat(PROJECT_PAGE.readCharacters / 4 + 1);
      const read = (async (url: string) => {
        if (url.endsWith("/HEAD/compose.yaml")) return new Response("services:\n  app:\n    image: app:1\n");
        return url.endsWith(`/HEAD/${file}`) ? new Response(long) : new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      const config = { services: { app: { image: "app:1", env_file: named } } };
      const made = installs({ shell: async () => ({ exitCode: 0, output: JSON.stringify(config) }) });
      (
        made.subject as unknown as { dependencies: { fetchImplementation: typeof fetch } }
      ).dependencies.fetchImplementation = read;

      const answer = await made.subject.answer({
        id: "1",
        kind: "draft",
        image: null,
        recipe: null,
        project: "https://github.com/someone/long",
      });

      expect(answer.error).toBe(COMPOSE_IMPORT.settingsTooLarge);
    },
  );

  it("refuses a project whose Compose file is longer than a preview reads, drafting nothing", async () => {
    const long = `services:\n  app:\n    image: app:1\n# ${"x".repeat(PROJECT_PAGE.readCharacters)}\n`;
    const read = (async (url: string) =>
      url.endsWith("/HEAD/compose.yaml")
        ? new Response(long)
        : new Response("", { status: 404 })) as unknown as typeof fetch;
    const made = installs();
    (
      made.subject as unknown as { dependencies: { fetchImplementation: typeof fetch } }
    ).dependencies.fetchImplementation = read;

    const answer = await made.subject.answer({
      id: "1",
      kind: "draft",
      image: null,
      recipe: null,
      project: "https://github.com/someone/long",
    });

    expect(answer).toMatchObject({ error: COMPOSE_IMPORT.composeTooLarge, draft: null });
  });

  it("says the Compose file a person chose is gone, drafting nothing in its place", async () => {
    const chosen = "compose.postgres.yaml";
    const read = (async (url: string) =>
      url.includes("api.github.com")
        ? new Response(JSON.stringify({ tree: [{ path: "compose.yaml", type: "blob" }] }))
        : new Response("services:\n  app:\n    image: app:1\n")) as unknown as typeof fetch;
    const made = installs();
    (
      made.subject as unknown as { dependencies: { fetchImplementation: typeof fetch } }
    ).dependencies.fetchImplementation = read;

    const answer = await made.subject.answer({
      id: "1",
      kind: "draft",
      image: null,
      recipe: null,
      project: "https://github.com/someone/flavours",
      composeFile: chosen,
    });

    expect(answer).toMatchObject({ error: COMPOSE_IMPORT.variantGone(chosen), draft: null });
  });

  it("stops at settings files holding more together than a preview reads, and says so", async () => {
    const big = "A=1\n".repeat((COMPOSE_IMPORT.envCharacters * 0.6) / 4);
    const read = (async (url: string) => {
      if (url.endsWith("/HEAD/compose.yaml")) return new Response("services:\n  app:\n    image: app:1\n");
      return url.includes("/settings-") ? new Response(big) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const config = {
      services: { app: { image: "app:1", env_file: [{ path: "settings-1.env" }, { path: "settings-2.env" }] } },
    };
    const made = installs({ shell: async () => ({ exitCode: 0, output: JSON.stringify(config) }) });
    (
      made.subject as unknown as { dependencies: { fetchImplementation: typeof fetch } }
    ).dependencies.fetchImplementation = read;

    const answer = await made.subject.answer({
      id: "1",
      kind: "draft",
      image: null,
      recipe: null,
      project: "https://github.com/someone/heavy",
    });

    expect(answer.error).toBe(COMPOSE_IMPORT.settingsTooLarge);
  });

  it("drafts from what its README says, and says when it finds no image", async () => {
    const readme = "docker run -p 8383:8383 -v /x:/app/data 0xfurai/peekaping:latest";
    const read = (async () => new Response(readme)) as unknown as typeof fetch;
    const made = installs();
    (
      made.subject as unknown as { dependencies: { fetchImplementation: typeof fetch } }
    ).dependencies.fetchImplementation = read;
    const answer = await made.subject.answer({
      id: "1",
      kind: "draft",
      image: null,
      recipe: null,
      project: "https://github.com/0xfurai/peekaping",
    });
    expect(answer.draft?.spec).toMatchObject({ image: "0xfurai/peekaping:latest", port: { target: 8383 } });
    expect(answer.draft?.project?.address).toBe("https://github.com/0xfurai/peekaping");

    const nothing = installs({
      facts: async () => {
        throw new Error("no such image");
      },
    });
    (
      nothing.subject as unknown as { dependencies: { fetchImplementation: typeof fetch } }
    ).dependencies.fetchImplementation = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const missing = await nothing.subject.answer({
      id: "1",
      kind: "draft",
      image: null,
      recipe: null,
      project: "https://github.com/someone/nothing",
    });
    expect(missing.error).toMatch(/Could not find an image/);
  });
});

describe("installing", () => {
  it("checks, writes, pulls every image, starts, then waits to see it stay up", async () => {
    const { subject, ran, pulled } = installs();
    const progress = report();
    const mealie = INSTALL_RECIPES.find((recipe) => recipe.id === "mealie")!;
    const full = {
      ...draftOf(
        mealie.image,
        { ports: [], volumes: [], environment: [], user: "" },
        {
          containers: 0,
          user: null,
          timeZone: null,
          restartPolicy: null,
          composeFolder: null,
          mountsBesideCompose: 0,
          places: [],
          networks: [],
          proxies: [],
          databases: { common: null, ownToAnApp: 0, standingAlone: 0 },
        },
        mealie,
      ).spec,
      name: "App",
    };
    const result = await subject.install(full, progress);
    expect(result).toMatchObject({ succeeded: true, logsOf: null });
    expect(pulled).toEqual(["ghcr.io/mealie-recipes/mealie:latest", "postgres:17"]);
    expect(progress.phases).toEqual(["working", "pulling", "starting", "checking"]);
    expect(ran.at(-1)).toContain("$compose up -d");
  });

  it("does not fetch an image the host already has", async () => {
    const { subject, pulled, ran } = installs({ localImage: { Id: "here" } });
    await subject.install(spec, report());
    expect(pulled).toEqual([]);
    expect(ran.at(-1)).toContain("$compose up -d");
  });

  it("touches nothing when a check fails", async () => {
    const { subject, ran, pulled } = installs({ containers: { App: {} } });
    const result = await subject.install(spec, report());
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("already called App");
    expect(ran).toHaveLength(1);
    expect(pulled).toEqual([]);
  });

  it("says what failed at each step, and whose logs tell more", async () => {
    const noWrite = await installs({
      scripts: [OK_CHECK, { exitCode: 1, output: "mkdir: Permission denied" }],
    }).subject.install(spec, report());
    expect(noWrite).toMatchObject({ succeeded: false, logsOf: null });
    expect(noWrite.outcome).toContain("Permission denied");

    const noStart = await installs({
      scripts: [OK_CHECK, { exitCode: 0, output: "" }, { exitCode: 1, output: "port is already allocated" }],
    }).subject.install(spec, report());
    expect(noStart.succeeded).toBe(false);
    expect(noStart.outcome).toContain("port is already allocated");
  });
});

describe("taking an app back", () => {
  const ours = {
    Config: {
      Labels: { "com.autoheal.installed": "true", "com.docker.compose.project.working_dir": "/home/me/docker/app" },
    },
  };

  it("refuses what Autoheal did not install, whatever it is called", async () => {
    const { subject, ran } = installs({
      containers: { App: { Config: { Labels: { "com.docker.compose.project.working_dir": "/srv/x" } } } },
    });
    expect(await subject.uninstall("App", true)).toMatchObject({ succeeded: false });
    expect(ran).toEqual([]);
  });

  it("removes its data only when asked", async () => {
    const keep = installs({ containers: { App: ours } });
    expect((await keep.subject.uninstall("App", false)).outcome).toContain("data is still in /home/me/docker/app");
    expect(keep.ran[0]).not.toContain("rm -rf");
    const all = installs({ containers: { App: ours } });
    expect((await all.subject.uninstall("App", true)).succeeded).toBe(true);
    expect(all.ran[0]).toContain("rm -rf '/home/me/docker/app'");
  });

  describe("with the host's own shell", () => {
    let root: string;
    let folder: string;
    // What an install's containers carry: Autoheal's label, and where Compose found their folder.
    const installLabels = (workingFolder: string) => ({
      Config: { Labels: { "com.autoheal.installed": "true", "com.docker.compose.project.working_dir": workingFolder } },
    });
    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "autoheal-take-away-"));
      folder = join(root, "app");
      expect((await runForReal(writeScript({ ...spec, folder }))).exitCode).toBe(0);
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("leaves another app's folder alone when a container's labels point there, and still takes its own app", async () => {
      // Labels anything can set: a hand-written Compose file, an image, another tool on the host.
      const pointed = installLabels(folder);
      const { subject } = installs({ containers: { Other: pointed, App: pointed }, shell: runForReal });
      const refused = await subject.uninstall("Other", true);
      expect(existsSync(join(folder, "docker-compose.yml"))).toBe(true);
      expect(existsSync(join(folder, ".env"))).toBe(true);
      expect(existsSync(join(folder, "data"))).toBe(true);
      expect(refused).toEqual({ succeeded: false, outcome: INSTALL_OUTCOMES.notItsFolder("Other", folder) });
      expect(await subject.uninstall("App", true)).toEqual({
        succeeded: true,
        outcome: INSTALL_OUTCOMES.removedWithData("App"),
      });
      expect(existsSync(folder)).toBe(false);
    });

    it("keeps an older install's folder, and what is in it, when taking the app away with its data", async () => {
      rmSync(join(folder, OWNED_FOLDER.file));
      writeFileSync(join(folder, "notes.txt"), "kept\n");
      const { subject } = installs({ containers: { App: installLabels(folder) }, shell: runForReal });

      expect(await subject.uninstall("App", true)).toEqual({
        succeeded: true,
        outcome: INSTALL_OUTCOMES.removedFolderKept("App", folder),
      });

      expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("kept\n");
      expect(existsSync(join(folder, "data"))).toBe(true);
      expect(existsSync(join(folder, "docker-compose.yml"))).toBe(false);
    });

    it("keeps the app's folder, data included, when Compose cannot take it down, and says what Compose said", async () => {
      const said = "network app_default has active endpoints";
      const failingCompose = runWith(`failing() { echo "${said}" >&2; return 1; }; compose=failing`);
      const { subject } = installs({ containers: { App: installLabels(folder) }, shell: failingCompose });
      const taken = await subject.uninstall("App", true);
      expect(existsSync(join(folder, "docker-compose.yml"))).toBe(true);
      expect(existsSync(join(folder, ".env"))).toBe(true);
      expect(existsSync(join(folder, "data"))).toBe(true);
      expect(taken).toEqual({ succeeded: false, outcome: INSTALL_OUTCOMES.notTakenDown("App", said) });
    });
  });
});
