import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPOSE_PROJECT_LABEL, COMPOSE_WORKING_DIR_LABEL, OWN_COMPOSE_TEXT } from "../shared/constants.js";
import { COMPOSE_FILE, ENV_FILE } from "../shared/install.js";
import type { OwnRetry, OwnRun } from "../shared/own-compose.js";
import type { ContainerSummary } from "./docker-client.js";
import { OwnCompose } from "./own-compose.js";

const COMPOSE = "services:\n  wiki:\n    image: wiki:2\n";
const ENV = "DB_PASS=first\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const RETRY: OwnRetry = { composeSha256: sha256(COMPOSE), envSha256: sha256(ENV) };
const report = { enter: () => undefined, pulled: () => undefined };

describe("a second try at an install of a person's own files", () => {
  let root: string;
  let folder: string;
  let containers: ContainerSummary[];
  let ups: number;
  let protectedContainers: Set<string>;
  let held: Set<string>;
  let now = 0;

  // The files and their checks really run; Compose itself and Docker do not.
  const hostScript = async (script: string) => {
    if (script.includes("config --no-path-resolution")) {
      const mark = /echo "(AUTOHEAL-[0-9a-f-]+)"/.exec(script)![1]!;
      const config = Buffer.from(JSON.stringify({ services: { wiki: { image: "wiki:2" } } })).toString("base64");
      return { exitCode: 0, output: `${mark}\n${config}\n${mark}\n\n${mark}\n0\n` };
    }
    if (/\bup -d\b/.test(script)) {
      ups += 1;
      return { exitCode: 0, output: "" };
    }
    if (script.includes("writable=") || script.includes("taken=")) {
      const taken = existsSync(join(folder, COMPOSE_FILE)) ? "taken=1\n" : "";
      return { exitCode: 0, output: `${taken}writable=1\n` };
    }
    const ran = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    return { exitCode: ran.status ?? 1, output: `${ran.stdout}${ran.stderr}` };
  };
  const member = (name: string, project: string, workingDirectory: string): ContainerSummary => ({
    Id: name,
    Names: [`/${name}`],
    State: "running",
    Status: "Up",
    Image: "wiki:2",
    Labels: { [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_WORKING_DIR_LABEL]: workingDirectory },
  });
  const own = () =>
    new OwnCompose({
      docker: {
        containerSummaries: async () => containers,
        inspect: async () => ({ State: { Running: true, Status: "running" }, RestartCount: 0 }) as never,
        inspectImage: async () => ({ Id: "wiki:2" }) as never,
        pull: async () => undefined,
        networks: async () => [],
        allVolumes: async () => [],
      } as never,
      files: {} as never,
      hostRoot: "/",
      hostScript,
      imageExists: async () => true,
      settings: {
        hostDeploy: true,
        containerAccess: true,
        dryRun: false,
        selfContainerName: "autoheal",
        protectedContainers,
      },
      maintenanceHeld: (name) => held.has(name),
      wait: async () => undefined,
      clock: () => (now += 60_000),
    });
  const run = (retry: OwnRetry | null, change: Partial<OwnRun> = {}): OwnRun => ({
    own: true,
    folder,
    compose: `${COMPOSE}# edited\n`,
    env: ENV,
    retry,
    ...change,
  });
  const leftBehind = () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, COMPOSE_FILE), COMPOSE);
    writeFileSync(join(folder, ENV_FILE), ENV);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-own-compose-"));
    folder = join(root, "wiki");
    containers = [];
    ups = 0;
    protectedContainers = new Set();
    held = new Set();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("goes ahead over what that install left, replacing its files", async () => {
    leftBehind();
    containers = [member("wiki-1", "wiki", folder)];
    const result = await own().install(run(RETRY), report);
    expect(result.succeeded, result.outcome).toBe(true);
    expect(readFileSync(join(folder, COMPOSE_FILE), "utf8")).toContain("# edited");
    expect(ups).toBe(1);
  });

  it("goes ahead when that install stopped before writing anything", async () => {
    expect((await own().install(run(RETRY), report)).succeeded).toBe(true);
    expect(readFileSync(join(folder, ENV_FILE), "utf8")).toBe(ENV);
  });

  it("still refuses an existing folder when it is no retry", async () => {
    leftBehind();
    const result = await own().install(run(null), report);
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain(OWN_COMPOSE_TEXT.folderTaken(folder));
    expect(readFileSync(join(folder, COMPOSE_FILE), "utf8")).toBe(COMPOSE);
    expect(ups).toBe(0);
  });

  it.each([
    ["its Compose file", COMPOSE_FILE],
    ["its settings", ENV_FILE],
  ])("leaves %s alone when someone changed it since", async (_name, changed) => {
    leftBehind();
    writeFileSync(join(folder, changed), "changed by hand\n");
    const result = await own().install(run(RETRY), report);
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain(OWN_COMPOSE_TEXT.folderChanged(folder));
    expect(readFileSync(join(folder, changed), "utf8")).toBe("changed by hand\n");
    expect(ups).toBe(0);
  });

  it("leaves them alone when they change after the look, at the moment of writing", async () => {
    leftBehind();
    const compose = own();
    const racing = compose as unknown as { hostIssues: () => Promise<unknown[]> };
    racing.hostIssues = async () => {
      writeFileSync(join(folder, ENV_FILE), "changed by hand\n");
      return [];
    };
    const result = await compose.install(run(RETRY), report);
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain(OWN_COMPOSE_TEXT.folderChanged(folder));
    expect(readFileSync(join(folder, ENV_FILE), "utf8")).toBe("changed by hand\n");
    expect(ups).toBe(0);
  });

  it("still will not write over a file that appears after the look, when it is no retry", async () => {
    const compose = own();
    (compose as unknown as { hostIssues: () => Promise<unknown[]> }).hostIssues = async () => {
      leftBehind();
      return [];
    };
    const result = await compose.install(run(null), report);
    expect(result.succeeded).toBe(false);
    expect(readFileSync(join(folder, COMPOSE_FILE), "utf8")).toBe(COMPOSE);
    expect(ups).toBe(0);
  });

  it.each([
    ["kept hands-off", () => protectedContainers.add("wiki-1"), OWN_COMPOSE_TEXT.memberProtected("wiki-1")],
    ["under maintenance", () => held.add("wiki-1"), OWN_COMPOSE_TEXT.memberHeld("wiki-1")],
  ])("will not replace a member %s", async (_name, arrange, said) => {
    leftBehind();
    containers = [member("wiki-1", "wiki", folder)];
    arrange();
    const result = await own().install(run(RETRY), report);
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain(said);
    expect(readFileSync(join(folder, COMPOSE_FILE), "utf8")).toBe(COMPOSE);
    expect(ups).toBe(0);
  });

  it("will not replace Autoheal itself", async () => {
    leftBehind();
    containers = [member("autoheal", "wiki", folder)];
    const result = await own().install(run(RETRY), report);
    expect(result.outcome).toContain(OWN_COMPOSE_TEXT.memberIsSelf("autoheal"));
    expect(ups).toBe(0);
  });

  it("does not take a same-named app in another folder for its own", async () => {
    leftBehind();
    containers = [member("wiki-1", "wiki", "/somewhere/else/wiki")];
    const result = await own().install(run(RETRY), report);
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain(OWN_COMPOSE_TEXT.nameTaken("wiki"));
    expect(ups).toBe(0);
  });

  it("says the same when only checking, changing nothing", async () => {
    const files = {
      filesystem: async () => [],
      system: async () => null,
    };
    leftBehind();
    writeFileSync(join(folder, ENV_FILE), "changed by hand\n");
    protectedContainers.add("wiki-1");
    containers = [member("wiki-1", "wiki", folder)];
    const compose = own();
    (compose as unknown as { dependencies: { files: unknown } }).dependencies.files = files;
    const check = await compose.check(run(RETRY));
    const messages = check.issues.map(({ message }) => message);
    expect(messages).toContain(OWN_COMPOSE_TEXT.folderChanged(folder));
    expect(messages).toContain(OWN_COMPOSE_TEXT.memberProtected("wiki-1"));
    expect(readFileSync(join(folder, ENV_FILE), "utf8")).toBe("changed by hand\n");
  });
});
