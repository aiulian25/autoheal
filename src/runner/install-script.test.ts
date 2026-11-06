import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeOf, type InstallSpec } from "../shared/install.js";
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
    expect(script).toContain(`keeper=$(stat -c '%u:%g' "$(dirname "$dir")")`);
    expect(script).toContain('chown "$keeper" "$dir" "$dir/docker-compose.yml" "$dir/.env"');
    expect(script).toContain("chown 1026:100 ");
    expect(writeScript(spec)).toContain('chown "$keeper" ');
  });

  it("will not write over a folder that already holds an app", async () => {
    await run(writeScript(spec));
    const before = readFileSync(join(spec.folder, ".env"), "utf8");
    const { code } = await run(writeScript(spec));
    expect(code).toBe(INSTALL_EXIT.folderTaken);
    expect(readFileSync(join(spec.folder, ".env"), "utf8")).toBe(before);
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
    const keep = downScript(spec.folder, false).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true");
    expect(keep).not.toContain("down -v");
    expect(downScript(spec.folder, true)).toContain("down -v");
    expect((await run(keep)).code).toBe(0);
    expect(existsSync(join(spec.folder, "docker-compose.yml"))).toBe(false);
    expect(existsSync(join(spec.folder, ".env"))).toBe(false);
    expect(existsSync(join(spec.folder, "data"))).toBe(true);
    await run(writeScript(spec));
    const all = downScript(spec.folder, true).replace(/^if docker compose[\s\S]*?fi$/m, "compose=true");
    expect((await run(all)).code).toBe(0);
    expect(existsSync(spec.folder)).toBe(false);
    expect(existsSync(join(root, "media"))).toBe(true);
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
