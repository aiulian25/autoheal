import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTALLED_LINE, OWNED_FOLDER, composeOf, type InstallSpec } from "../shared/install.js";
import { INSTALL_EXIT, checkScript, downScript, parseComposeScript, writeScript } from "./install-script.js";

const execute = promisify(execFile);
// Run for real, by sh: a script that only reads right proves nothing.
const run = async (script: string) => {
  const result = await execute("sh", ["-c", script]).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
  );
  return result;
};

describe("the scripts an install runs on a host", () => {
  let root: string;
  let spec: InstallSpec;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-install-"));
    spec = {
      name: "App",
      slug: "app",
      image: "example/app:1",
      folder: join(root, "docker", "app's"),
      restartPolicy: "unless-stopped",
      owner: null,
      networks: [],
      port: { target: 3000, published: 3000 },
      mounts: [
        { source: "./data", target: "/data" },
        { source: join(root, "media"), target: "/media" },
      ],
      environment: [
        { name: "PUID", value: "1000" },
        { name: "NOTE", value: "two words $HOME `id`" },
      ],
      secrets: [
        { name: "DB_PASSWORD", characters: 32 },
        { name: "API_KEY", characters: 16 },
      ],
      database: null,
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes its files and folders, with secrets made on the spot that only its owner can read", async () => {
    const { code } = await run(writeScript(spec));
    expect(code).toBe(0);
    expect(readFileSync(join(spec.folder, "docker-compose.yml"), "utf8")).toBe(composeOf(spec));
    expect(existsSync(join(spec.folder, "data"))).toBe(true);
    expect(existsSync(join(root, "media"))).toBe(true);
    // Its folders stay readable to the host's people, whoever ran this; only the .env is kept to its owner.
    expect(statSync(spec.folder).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "docker")).mode & 0o777).toBe(0o755);
    expect(statSync(join(spec.folder, "data")).mode & 0o777).toBe(0o755);
    expect(statSync(join(spec.folder, "docker-compose.yml")).mode & 0o777).toBe(0o644);
    const envPath = join(spec.folder, ".env");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("PUID=1000\n");
    expect(env).toContain("NOTE='two words $HOME `id`'\n");
    expect(env).toMatch(/^DB_PASSWORD=[A-Za-z0-9]{32}$/m);
    expect(env).toMatch(/^API_KEY=[A-Za-z0-9]{16}$/m);
  });

  it("makes different secrets each time, and shows none in what it prints or in the script itself", async () => {
    const script = writeScript(spec);
    const { stdout } = await run(script);
    const first = readFileSync(join(spec.folder, ".env"), "utf8").match(/DB_PASSWORD=(.+)/)![1]!;
    expect(stdout).not.toContain(first);
    expect(script).not.toContain(first);
    rmSync(spec.folder, { recursive: true });
    await run(script);
    expect(readFileSync(join(spec.folder, ".env"), "utf8")).not.toContain(first);
  });

  it("gives its files to whoever keeps the folder when run as root, and its data to whoever the app runs as", () => {
    const script = writeScript({ ...spec, owner: "1026:100" });
    expect(script).toContain(`keeper=$(stat -L -c '%u:%g' "$(dirname "$dir")")`);
    expect(script).toContain('chown -h "$keeper" "$dir" "$dir/docker-compose.yml" "$dir/.env"');
    expect(script).toContain("chown -h 1026:100 ");
    expect(writeScript(spec)).toContain('chown -h "$keeper" ');
  });

  it("will not write over a folder that already holds an app", async () => {
    await run(writeScript(spec));
    const before = readFileSync(join(spec.folder, ".env"), "utf8");
    const { code } = await run(writeScript(spec));
    expect(code).toBe(INSTALL_EXIT.folderTaken);
    expect(readFileSync(join(spec.folder, ".env"), "utf8")).toBe(before);
  });

  it("keeps out of a folder that already holds anything, leaving what is there as it was", async () => {
    mkdirSync(spec.folder, { recursive: true });
    writeFileSync(join(spec.folder, ".env"), "SECRET=theirs\n");
    writeFileSync(join(spec.folder, "notes.txt"), "kept\n");
    const check = checkScript(spec).replace(/^if docker compose[\s\S]*?fi$/m, "compose=test");
    expect((await run(check)).stdout).toContain("taken=1");

    expect((await run(writeScript(spec))).code).toBe(INSTALL_EXIT.folderTaken);

    expect(readFileSync(join(spec.folder, ".env"), "utf8")).toBe("SECRET=theirs\n");
    expect(readFileSync(join(spec.folder, "notes.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(spec.folder, "docker-compose.yml"))).toBe(false);
  });

  it("installs into a folder already there when it is empty, and marks it as all the app's", async () => {
    mkdirSync(spec.folder, { recursive: true });
    expect((await run(writeScript(spec))).code).toBe(0);
    expect(readFileSync(join(spec.folder, OWNED_FOLDER.file), "utf8")).toBe(`${OWNED_FOLDER.text}\n`);
  });

  it("keeps out of a folder that is a link, leaving the folder it points to as it was", async () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(dirname(spec.folder), { recursive: true });
    symlinkSync(elsewhere, spec.folder);
    const check = checkScript(spec).replace(/^if docker compose[\s\S]*?fi$/m, "compose=test");
    expect((await run(check)).stdout).toContain("taken=1");

    expect((await run(writeScript(spec))).code).toBe(INSTALL_EXIT.folderTaken);

    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("as root, hands over only what it made, never through a link, to the real keeper of the folder above", async () => {
    const shims = join(root, "shims");
    const handedOver = join(root, "handed-over");
    mkdirSync(shims);
    writeFileSync(join(shims, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    writeFileSync(join(shims, "chown"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${handedOver}'\n`, { mode: 0o755 });
    // Someone's folder already there: it keeps its owner.
    mkdirSync(join(root, "media"));
    const asRoot = { env: { ...process.env, PATH: `${shims}:${process.env.PATH}` } };

    await execute("sh", ["-c", writeScript({ ...spec, owner: "1026:100" })], asRoot);

    const { uid, gid } = statSync(join(root, "docker"));
    const files = ["docker-compose.yml", ".env", OWNED_FOLDER.file].map((file) => join(spec.folder, file));
    expect(readFileSync(handedOver, "utf8").trim().split("\n").toSorted()).toEqual(
      [`-h ${uid}:${gid} ${[spec.folder, ...files].join(" ")}`, `-h 1026:100 ${join(spec.folder, "data")}`].toSorted(),
    );
  });

  it("keeps the folder of an install made before the mark, and what is in it, when its data is to go too", async () => {
    await run(writeScript(spec));
    rmSync(join(spec.folder, OWNED_FOLDER.file));
    writeFileSync(join(spec.folder, "notes.txt"), "kept\n");
    const all = downScript(spec.folder, spec.name, true).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true");

    expect((await run(all)).code).toBe(INSTALL_EXIT.folderKept);

    expect(readFileSync(join(spec.folder, "notes.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(spec.folder, "data"))).toBe(true);
    expect(existsSync(join(spec.folder, "docker-compose.yml"))).toBe(false);
    expect(existsSync(join(spec.folder, ".env"))).toBe(false);
  });

  it("holds an unsafe value as text: nothing in a spec runs", async () => {
    const evil = join(root, "pwned");
    const bad = { ...spec, environment: [{ name: "NOTE", value: `$(touch ${evil})` }], name: "App" };
    expect((await run(writeScript(bad))).code).toBe(0);
    expect(existsSync(evil)).toBe(false);
  });

  it("says where a new folder would be made, and whether it can", async () => {
    const script = checkScript(spec).replace(/^if docker compose[\s\S]*?fi$/m, "compose=test");
    const said = (await run(script)).stdout;
    expect(said).toContain("compose=test");
    expect(said).toContain(`place=${root}`);
    expect(said).toContain("writable=1");
    expect(said).not.toContain("taken=1");
    mkdirSync(spec.folder, { recursive: true });
    await run(writeScript(spec));
    expect((await run(script)).stdout).toContain("taken=1");
  });

  it("takes away its files and keeps data, or removes the lot, only when asked", async () => {
    await run(writeScript(spec));
    const keep = downScript(spec.folder, spec.name, false).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true");
    expect(keep).not.toContain("down -v");
    expect(downScript(spec.folder, spec.name, true)).toContain("down -v");
    expect((await run(keep)).code).toBe(0);
    expect(existsSync(join(spec.folder, "docker-compose.yml"))).toBe(false);
    expect(existsSync(join(spec.folder, ".env"))).toBe(false);
    expect(existsSync(join(spec.folder, OWNED_FOLDER.file))).toBe(false);
    expect(existsSync(join(spec.folder, "data"))).toBe(true);
    // The data it kept is someone's now: an install of its own takes a new folder.
    rmSync(spec.folder, { recursive: true });
    await run(writeScript(spec));
    const all = downScript(spec.folder, spec.name, true).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true");
    expect((await run(all)).code).toBe(0);
    expect(existsSync(spec.folder)).toBe(false);
    expect(existsSync(join(root, "media"))).toBe(true);
  });

  it("is taken away as any container its file names, its database too, and as no other", async () => {
    await run(writeScript({ ...spec, database: { image: "postgres:16" } }));
    const down = (name: string) =>
      run(downScript(spec.folder, name, false).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true"));
    expect((await down("Other")).code).toBe(INSTALL_EXIT.notItsFolder);
    expect(existsSync(join(spec.folder, "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(spec.folder, ".env"))).toBe(true);
    expect((await down("App-DB")).code).toBe(0);
    expect(existsSync(join(spec.folder, "docker-compose.yml"))).toBe(false);
  });

  it("removes nothing, data included, when Compose cannot take the app down", async () => {
    await run(writeScript(spec));
    const failing = downScript(spec.folder, spec.name, true).replace(/^if docker compose[\s\S]*?fi$/m, "compose=false");
    expect((await run(failing)).code).toBe(INSTALL_EXIT.notTakenDown);
    expect(existsSync(join(spec.folder, "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(spec.folder, ".env"))).toBe(true);
    expect(existsSync(join(spec.folder, "data"))).toBe(true);
  });
});

describe("taking away what Autoheal did not install", () => {
  it("leaves a folder alone whose Compose file Autoheal did not write, whatever its containers' labels say", async () => {
    const folder = mkdtempSync(join(tmpdir(), "autoheal-not-ours-"));
    writeFileSync(join(folder, "docker-compose.yml"), "services:\n  app:\n    image: example/app:1\n");
    writeFileSync(join(folder, ".env"), "SECRET=kept\n");
    const script = downScript(folder, "app", true).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true");
    expect((await run(script)).code).toBe(INSTALL_EXIT.notOurs);
    expect(existsSync(join(folder, "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(folder, ".env"))).toBe(true);
    rmSync(folder, { recursive: true, force: true });
  });
});

describe("taking an app away from a folder only when its Compose file names the container", () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "autoheal-named-"));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  // A file Autoheal wrote, naming one container in the line given, then taken down as the container named.
  const takeDown = (name: string, line: string) => {
    writeFileSync(
      join(folder, "docker-compose.yml"),
      `services:\n  app:\n${line}\n    labels:\n      ${INSTALLED_LINE}\n`,
    );
    return run(downScript(folder, name, false).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true"));
  };

  it.each([
    ["as Autoheal writes it", '    container_name: "App"'],
    ["indented otherwise and unquoted", "  container_name: App"],
    ["in single quotes, with trailing spaces and a Windows line ending", "    container_name: 'App'  \r"],
  ])("takes App away from a file naming it %s", async (_how, line) => {
    expect((await takeDown("App", line)).code).toBe(0);
    expect(existsSync(join(folder, "docker-compose.yml"))).toBe(false);
  });

  it.each([
    ["naming another container", "App", '    container_name: "Other"'],
    ["naming one whose name only begins the same", "App", '    container_name: "App-DB"'],
    ["naming it in a comment only", "App", '    # container_name: "App"'],
    ["naming one its name matches only as a pattern would", "my.app", '    container_name: "myXapp"'],
  ])("leaves a file alone %s", async (_how, name, line) => {
    expect((await takeDown(name, line)).code).toBe(INSTALL_EXIT.notItsFolder);
    expect(existsSync(join(folder, "docker-compose.yml"))).toBe(true);
  });
});

describe("reading a Compose file with an older Compose", () => {
  it("reads it without --no-env-resolution where the host's Compose does not know it, as Synology's 2.20", async () => {
    const shims = mkdtempSync(join(tmpdir(), "autoheal-old-compose-"));
    const answer = '{"services":{"app":{"image":"example/app:1"}}}';
    writeFileSync(
      join(shims, "docker"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--no-env-resolution" ] && { echo "unknown flag" >&2; exit 1; }; done\necho '${answer}'\n`,
    );
    chmodSync(join(shims, "docker"), 0o755);
    try {
      const { stdout } = await promisify(execFile)(
        "sh",
        ["-c", parseComposeScript("services:\n  app:\n    image: example/app:1\n")],
        { env: { ...process.env, PATH: `${shims}:${process.env.PATH}` } },
      );
      expect(stdout).toBe(answer);
    } finally {
      rmSync(shims, { recursive: true, force: true });
    }
  });
});
