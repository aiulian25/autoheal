import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHASSIS_TYPE_PATH,
  MILLISECONDS_PER_SECOND,
  NVIDIA_CONTAINER_HOOK,
  NVIDIA_GPUS_PATH,
  RUNNER_COMPOSE,
  RUNNER_GPU_OVERRIDE,
  RUNNER_GPU_OVERRIDE_FILE,
  RUNNER_INSTALL_DIRECTORY,
  RUNNER_NAS_TEXT,
  SELF_UPDATE,
  SHUTDOWN_DEADLINE_MILLISECONDS,
} from "./constants.js";
import { imageCanBePulled, imageCopyCommand, installCommand, nasInstallCommand } from "./runner-install.js";

const EXECUTABLE = 0o755;
const DESKTOP = "3";
const NOTEBOOK = "10";
const STARTED = "compose up -d";
// The toolkit's hook by a name no machine has, so this machine's own toolkit stays out of it.
const HOOK = "autoheal-test-container-hook";

interface Machine {
  // Its SMBIOS chassis type; absent where the machine names none.
  chassis?: string;
  // An NVIDIA card with its driver loaded.
  card?: boolean;
  // The NVIDIA Container Toolkit's hook, which Docker hands GPUs through.
  toolkit?: boolean;
  dockerRefusesGpu?: boolean;
  // An override its owner wrote already.
  override?: string;
}

const made: string[] = [];

/**
 * The paste, run by `shell` on a made-up machine: its card, chassis and toolkit where the paste looks for them, and
 * a docker that only notes how it was called.
 */
function install(shell: string, machine: Machine) {
  const root = mkdtempSync(join(tmpdir(), "autoheal-install-"));
  made.push(root);
  const bin = join(root, "bin");
  const gpus = join(root, "gpus");
  const chassis = join(root, "chassis_type");
  const calls = join(root, "docker-calls");
  const folder = join(root, RUNNER_INSTALL_DIRECTORY);
  mkdirSync(bin);
  const executable = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), EXECUTABLE);
  };
  const refuse = machine.dockerRefusesGpu ? `[ -e ${RUNNER_GPU_OVERRIDE_FILE} ] && exit 1` : "";
  executable("docker", `echo "$*" >> ${calls}\n${refuse}\nexit 0`);
  if (machine.toolkit) {
    executable(HOOK, "exit 0");
  }
  if (machine.card) {
    mkdirSync(join(gpus, "0000:01:00.0"), { recursive: true });
  }
  if (machine.chassis !== undefined) {
    writeFileSync(chassis, `${machine.chassis}\n`);
  }
  if (machine.override !== undefined) {
    mkdirSync(folder);
    writeFileSync(join(folder, RUNNER_GPU_OVERRIDE_FILE), machine.override);
  }
  const command = installCommand("autoheal:2", "ahj_test")
    .replaceAll(NVIDIA_CONTAINER_HOOK, HOOK)
    .replaceAll(NVIDIA_GPUS_PATH, gpus)
    .replaceAll(CHASSIS_TYPE_PATH, chassis);
  const result = spawnSync(shell, ["-c", command], {
    cwd: root,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
    encoding: "utf8",
  });
  const override = join(folder, RUNNER_GPU_OVERRIDE_FILE);
  return {
    status: result.status,
    override: existsSync(override) ? readFileSync(override, "utf8") : null,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
  };
}

afterEach(() => {
  for (const root of made.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(["bash", "sh"])("the install command, pasted into %s", (shell) => {
  it("gives the runner the GPU on a desktop with an NVIDIA card and the toolkit, or one naming no chassis", () => {
    expect(install(shell, { chassis: DESKTOP, card: true, toolkit: true })).toEqual({
      status: 0,
      override: RUNNER_GPU_OVERRIDE,
      calls: [STARTED],
    });
    expect(install(shell, { card: true, toolkit: true }).override).toBe(RUNNER_GPU_OVERRIDE);
  });

  it("leaves a laptop's GPU asleep, and a host without the card or the toolkit as it was", () => {
    for (const machine of [
      { chassis: NOTEBOOK, card: true, toolkit: true },
      { chassis: DESKTOP, toolkit: true },
      { chassis: DESKTOP, card: true },
    ]) {
      expect(install(shell, machine)).toEqual({ status: 0, override: null, calls: [STARTED] });
    }
  });

  it("starts the runner without the GPU when Docker refuses it", () => {
    expect(install(shell, { chassis: DESKTOP, card: true, toolkit: true, dockerRefusesGpu: true })).toEqual({
      status: 0,
      override: null,
      calls: [STARTED, STARTED],
    });
  });

  it("never writes over an override its owner made, nor takes it away", () => {
    const own = "services: {}\n";
    expect(install(shell, { chassis: DESKTOP, card: true, toolkit: true, override: own })).toEqual({
      status: 0,
      override: own,
      calls: [STARTED],
    });
    const refused = install(shell, {
      chassis: DESKTOP,
      card: true,
      toolkit: true,
      override: own,
      dockerRefusesGpu: true,
    });
    expect(refused).toMatchObject({ override: own, calls: [STARTED] });
    expect(refused.status).not.toBe(0);
  });
});

describe("how long Docker lets Autoheal finish before killing it", () => {
  const graceIn = (compose: string) => {
    const [, seconds] = /^\s*stop_grace_period: (\d+)s$/m.exec(compose) ?? [];
    return Number(seconds) * MILLISECONDS_PER_SECOND;
  };

  it.each([
    ["the main host's docker-compose.yml", () => readFileSync("docker-compose.yml", "utf8")],
    ["docker-compose.runner.yml", () => readFileSync("docker-compose.runner.yml", "utf8")],
    ["a generated runner's", () => RUNNER_COMPOSE("autoheal:test")],
    ["a generated containers-only runner's", () => RUNNER_COMPOSE("autoheal:test", false)],
  ])("is longer than its own deadline to finish, in %s", (_name, compose) => {
    expect(graceIn(compose())).toBeGreaterThan(SHUTDOWN_DEADLINE_MILLISECONDS);
  });

  it("is longer than that deadline when it replaces itself too", () => {
    expect(SELF_UPDATE.stopTimeoutSeconds * MILLISECONDS_PER_SECOND).toBeGreaterThan(SHUTDOWN_DEADLINE_MILLISECONDS);
  });
});

describe("the install command for a NAS", () => {
  const LOCAL_IMAGE = "autoheal:dev-latest";
  const nas = (
    image: string,
    machine: { compose?: "plugin" | "old" | "none"; imageThere?: boolean; imageFile?: boolean; refusesCpu?: boolean },
  ) => {
    const root = mkdtempSync(join(tmpdir(), "autoheal-nas-"));
    made.push(root);
    const bin = join(root, "bin");
    const folder = join(root, "volume1", "docker", "autoheal");
    const calls = join(root, "calls");
    mkdirSync(bin);
    const executable = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), EXECUTABLE);
    };
    if (machine.imageFile) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "autoheal-image.tar.gz"), "image");
    }
    // Reads its input, as a program may: anything run without care would swallow the rest of the script.
    const reading = "cat > /dev/null";
    const up = machine.refusesCpu ? 'if grep -q "cpus:" docker-compose.yml; then echo refused; exit 1; fi' : ":";
    const hasPlugin = (machine.compose ?? "plugin") === "plugin";
    executable(
      "docker",
      [
        reading,
        `echo "$*" >> ${calls}`,
        `case "$*" in`,
        `"compose version") ${hasPlugin ? "exit 0" : "exit 1"};;`,
        `"compose up -d") ${up};;`,
        `image\\ inspect*) ${machine.imageThere === false ? "exit 1" : "exit 0"};;`,
        "esac",
      ].join("\n"),
    );
    if (machine.compose === "old") executable("docker-compose", `${reading}\necho "old $*" >> ${calls}`);
    executable("sudo", `echo sudo >> ${calls}\nexec "$@"`);
    const result = spawnSync("sh", ["-c", nasInstallCommand(image, "ahj_test", folder)], {
      cwd: root,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
      encoding: "utf8",
    });
    const file = (name: string) => (existsSync(join(folder, name)) ? readFileSync(join(folder, name), "utf8") : null);
    const said = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
    return { status: result.status, stderr: result.stderr, said, file, folder, root };
  };
  const ups = (said: string[]) => said.filter((line) => line.endsWith("up -d"));

  it("runs under sudo in the folder asked for, not where it was pasted, writing all it needs", () => {
    const { status, said, file, root } = nas("ghcr.io/owner/autoheal:2", {});
    expect(status).toBe(0);
    expect(said[0]).toBe("sudo");
    expect(ups(said)).toEqual(["compose up -d"]);
    expect(file("docker-compose.yml")).toContain("image: ghcr.io/owner/autoheal:2");
    expect(file(".env")).toMatch(/^AUTOHEAL_JOIN=ahj_test\nDOCKER_GID=\d+\n$/);
    expect(existsSync(join(root, "autoheal"))).toBe(false);
  });

  it("keeps its .env to its owner", () => {
    const { folder } = nas("ghcr.io/owner/autoheal:2", {});
    expect(statSync(join(folder, ".env")).mode & 0o777).toBe(0o600);
  });

  it("looks for no GPU, and reads none of the machine's files", () => {
    const command = nasInstallCommand("a/b:1", "ahj_test", "/volume1/docker/autoheal");
    expect(command).not.toContain(NVIDIA_CONTAINER_HOOK);
    expect(command).not.toContain("/host/root");
  });

  it("uses the older docker-compose where that is what it has", () => {
    const { status, said } = nas("ghcr.io/owner/autoheal:2", { compose: "old" });
    expect(status).toBe(0);
    expect(ups(said)).toEqual(["old up -d"]);
  });

  it("says so, and writes nothing, where it has no compose at all", () => {
    const { status, stderr, file } = nas("ghcr.io/owner/autoheal:2", { compose: "none" });
    expect(status).toBe(1);
    expect(stderr).toContain(RUNNER_NAS_TEXT.noCompose);
    expect(file(".env")).toBeNull();
  });

  it("starts without the CPU limit where the kernel refuses it, keeping the other limits", () => {
    const { status, said, file } = nas("ghcr.io/owner/autoheal:2", { refusesCpu: true });
    expect(status).toBe(0);
    expect(ups(said)).toHaveLength(2);
    expect(file("docker-compose.yml")).not.toContain("cpus:");
    expect(file("docker-compose.yml")).toContain("mem_limit:");
  });

  it("loads a home-built image from the file copied there", () => {
    const { status, said } = nas(LOCAL_IMAGE, { imageThere: false, imageFile: true });
    expect(status).toBe(0);
    expect(said).toContain("load -i autoheal-image.tar.gz");
    expect(ups(said)).toEqual(["compose up -d"]);
  });

  it("does not load it again once it is there", () => {
    const { said } = nas(LOCAL_IMAGE, { imageThere: true, imageFile: true });
    expect(said.some((line) => line.startsWith("load"))).toBe(false);
  });

  it("says where to put it when it is not there yet, leaving no join code behind", () => {
    const { status, stderr, said, file, folder } = nas(LOCAL_IMAGE, { imageThere: false });
    expect(status).toBe(1);
    expect(stderr).toContain(RUNNER_NAS_TEXT.noImage(folder));
    expect(ups(said)).toEqual([]);
    expect(file(".env")).toBeNull();
  });

  it("tells a home-built image from one that can be downloaded", () => {
    expect(imageCanBePulled(LOCAL_IMAGE)).toBe(false);
    expect(imageCanBePulled("ghcr.io/owner/autoheal:2")).toBe(true);
    expect(imageCopyCommand(LOCAL_IMAGE)).toBe(
      "docker save autoheal:dev-latest | gzip -1 > ~/autoheal-image.tar.gz && ls -lh ~/autoheal-image.tar.gz",
    );
  });
});
