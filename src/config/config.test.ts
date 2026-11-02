import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { runCheckConfig } from "../commands/check-config.js";
import { encodeJoinCode } from "../shared/join-code.js";
import { loadRunnerConfig } from "./runner-config.js";
import { loadControlPlaneConfig } from "./control-plane-config.js";
import { ConfigError } from "./environment-schema.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "autoheal-config-"));
const certificateFile = join(temporaryDirectory, "certificate.pem");
const keyFile = join(temporaryDirectory, "key.pem");
writeFileSync(certificateFile, "certificate");
writeFileSync(keyFile, "key");

const homeAssistantTokenFile = join(temporaryDirectory, "home-assistant.token");
const emptyTokenFile = join(temporaryDirectory, "empty.token");
writeFileSync(homeAssistantTokenFile, "  long-lived-token-value\n");
writeFileSync(emptyTokenFile, "\n");

const passphrase = "correct-horse-battery-staple-0123456789";
const runnerToken = `ahk_${"A".repeat(43)}`;
const pin = "P".repeat(43);
// No join volume here: a runner's join code comes from the environment, or from this file when a test writes it.
const noJoinFile = join(temporaryDirectory, "no-such-join-file");

const controlPlaneEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PUBLIC_BASE_URL: "https://autoheal.example.org",
  OLLAMA_URL: "https://192.168.10.123:11443",
  ...overrides,
});

const runnerEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOST_LABEL: "HP",
  OLLAMA_URL: "https://ollama.lan",
  ...overrides,
});

function configErrorOf(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
}

const controlPlaneProblems = (overrides: NodeJS.ProcessEnv) =>
  configErrorOf(() => loadControlPlaneConfig(controlPlaneEnvironment(overrides))).problems;

const silentOutput = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
};

describe("control plane config", () => {
  it("needs only the dashboard's address and Ollama's", () => {
    expect(configErrorOf(() => loadControlPlaneConfig({})).problems).toEqual([
      "PUBLIC_BASE_URL: is required",
      "OLLAMA_URL: is required",
    ]);
  });

  it("makes its own certificate and backup passphrase unless the .env gives them", () => {
    const made = loadControlPlaneConfig(controlPlaneEnvironment());
    expect([made.tls, made.backupPassphrase, made.publicHostname]).toEqual([null, null, "autoheal.example.org"]);
    const given = loadControlPlaneConfig(
      controlPlaneEnvironment({
        TLS_CERTIFICATE_FILE: certificateFile,
        TLS_KEY_FILE: keyFile,
        BACKUP_PASSPHRASE: passphrase,
      }),
    );
    expect(given.tls).toEqual({ certificateFile, keyFile });
    expect(given.backupPassphrase).toBe(passphrase);
    expect(controlPlaneProblems({ TLS_CERTIFICATE_FILE: certificateFile })).toEqual([
      "TLS_KEY_FILE: set both TLS_CERTIFICATE_FILE and TLS_KEY_FILE, or neither",
    ]);
  });

  it("never prints the value of a rejected secret", () => {
    const shortSecret = "only-twenty-chars-xx";
    const error = configErrorOf(() =>
      loadControlPlaneConfig(controlPlaneEnvironment({ BACKUP_PASSPHRASE: shortSecret })),
    );
    expect(error.message).toContain("BACKUP_PASSPHRASE: must be at least 32 characters");
    expect(error.message).not.toContain(shortSecret);
  });

  it("takes Ollama over https or plain http, by IP or by name, and nothing else", () => {
    expect(loadControlPlaneConfig(controlPlaneEnvironment()).ollama.url).toBe("https://192.168.10.123:11443");
    expect(
      loadControlPlaneConfig(controlPlaneEnvironment({ OLLAMA_URL: "http://192.168.10.123:11434" })).ollama.url,
    ).toBe("http://192.168.10.123:11434");
    expect(controlPlaneProblems({ OLLAMA_URL: "ftp://ollama.lan" })).toEqual([
      "OLLAMA_URL: must be an http:// or https:// URL",
    ]);
  });

  it("requires the public address to be https and derives its origin", () => {
    expect(
      configErrorOf(() => loadControlPlaneConfig(controlPlaneEnvironment({ PUBLIC_BASE_URL: "http://autoheal.lan" })))
        .problems,
    ).toEqual(["PUBLIC_BASE_URL: must be an https:// URL"]);
    const config = loadControlPlaneConfig(controlPlaneEnvironment({ PUBLIC_BASE_URL: "https://autoheal.lan:8443/" }));
    expect(config.publicOrigin).toBe("https://autoheal.lan:8443");
    expect(config.publicHost).toBe("autoheal.lan:8443");
  });

  it("reports certificate files that do not exist", () => {
    const { problems } = configErrorOf(() =>
      loadControlPlaneConfig(
        controlPlaneEnvironment({
          TLS_CERTIFICATE_FILE: certificateFile,
          TLS_KEY_FILE: join(temporaryDirectory, "missing.pem"),
        }),
      ),
    );
    expect(problems).toEqual(["TLS_KEY_FILE: file does not exist"]);
  });

  it("accepts proxy addresses as IPs or CIDR ranges only", () => {
    const config = loadControlPlaneConfig(
      controlPlaneEnvironment({ TRUSTED_PROXY_ADDRESSES: " 10.0.0.1, 172.16.0.0/12 ,fd00::/8" }),
    );
    expect(config.trustedProxyAddresses).toEqual(["10.0.0.1", "172.16.0.0/12", "fd00::/8"]);
    const { problems } = configErrorOf(() =>
      loadControlPlaneConfig(controlPlaneEnvironment({ TRUSTED_PROXY_ADDRESSES: "proxy.lan" })),
    );
    expect(problems).toEqual(["TRUSTED_PROXY_ADDRESSES.0: must be IP addresses or CIDR ranges, comma separated"]);
  });

  it("wants the Gotify address and token together", () => {
    const { problems } = configErrorOf(() =>
      loadControlPlaneConfig(controlPlaneEnvironment({ GOTIFY_URL: "https://gotify.example.org" })),
    );
    expect(problems).toEqual(["GOTIFY_TOKEN: set both GOTIFY_URL and GOTIFY_TOKEN, or neither"]);
    const config = loadControlPlaneConfig(
      controlPlaneEnvironment({ GOTIFY_URL: "https://gotify.example.org", GOTIFY_TOKEN: "app-token" }),
    );
    expect(config.gotify).toEqual({ url: "https://gotify.example.org", token: "app-token" });
  });

  it("reads the Home Assistant token from its own file, over https or http, and keeps it out of errors", () => {
    const config = loadControlPlaneConfig(
      controlPlaneEnvironment({
        HOME_ASSISTANT_URL: "https://192.168.10.142",
        HOME_ASSISTANT_TOKEN_FILE: homeAssistantTokenFile,
      }),
    );
    expect(config.homeAssistant).toEqual({ url: "https://192.168.10.142", token: "long-lived-token-value" });
    expect(loadControlPlaneConfig(controlPlaneEnvironment()).homeAssistant).toBeNull();

    const plain = loadControlPlaneConfig(
      controlPlaneEnvironment({
        HOME_ASSISTANT_URL: "http://192.168.10.142:8123",
        HOME_ASSISTANT_TOKEN_FILE: homeAssistantTokenFile,
      }),
    );
    expect(plain.homeAssistant?.url).toBe("http://192.168.10.142:8123");
    expect(controlPlaneProblems({ HOME_ASSISTANT_URL: "https://192.168.10.142" })).toEqual([
      "HOME_ASSISTANT_TOKEN_FILE: set both HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN_FILE, or neither",
    ]);
    expect(
      controlPlaneProblems({ HOME_ASSISTANT_URL: "https://192.168.10.142", HOME_ASSISTANT_TOKEN_FILE: emptyTokenFile }),
    ).toEqual(["HOME_ASSISTANT_TOKEN_FILE: file is empty"]);
    const missing = controlPlaneProblems({
      HOME_ASSISTANT_URL: "https://192.168.10.142",
      HOME_ASSISTANT_TOKEN_FILE: "/nowhere/token",
    });
    expect(missing).toEqual(["HOME_ASSISTANT_TOKEN_FILE: file does not exist"]);
  });

  it("wants the ntfy address and topic together, and reads an optional token from a file", () => {
    const config = loadControlPlaneConfig(
      controlPlaneEnvironment({
        NTFY_URL: "https://ntfy.home.lan",
        NTFY_TOPIC: "autoheal",
        NTFY_TOKEN_FILE: homeAssistantTokenFile,
      }),
    );
    expect(config.ntfy).toEqual({ url: "https://ntfy.home.lan", topic: "autoheal", token: "long-lived-token-value" });
    expect(loadControlPlaneConfig(controlPlaneEnvironment()).ntfy).toBeNull();
    expect(controlPlaneProblems({ NTFY_URL: "https://ntfy.home.lan" })).toEqual([
      "NTFY_TOPIC: set both NTFY_URL and NTFY_TOPIC, or neither",
    ]);
    expect(controlPlaneProblems({ NTFY_URL: "https://ntfy.home.lan", NTFY_TOPIC: "my topic/../x" })).toEqual([
      "NTFY_TOPIC: may only use letters, digits, dashes and underscores (64 at most)",
    ]);
  });

  it("accepts the example file as it ships", () => {
    const config = loadControlPlaneConfig(parseEnv(readFileSync(".env.example", "utf8")));
    expect(config.offboxBackupDirectory).toBeNull();
    expect(config.dataDirectory).toBe("/data");
    expect(config.ollama.contextTokens).toBe(16_384);
    expect(config.autohealImage).toBe("ghcr.io/aiulian25/autoheal:1");
  });
});

describe("runner config", () => {
  it("defaults to dry run and always protects itself", () => {
    const config = loadRunnerConfig(runnerEnvironment({ PROTECTED_CONTAINERS: " npm, newt ,," }), noJoinFile);
    expect(config.dryRun).toBe(true);
    expect([...config.protectedContainers].sort()).toEqual(["autoheal", "newt", "npm"]);
    expect(config.controlPlane).toBeNull();
    expect(config.gotify).toBeNull();
  });

  it("reads DRY_RUN switches and refuses anything ambiguous", () => {
    expect(loadRunnerConfig(runnerEnvironment({ DRY_RUN: "0" })).dryRun).toBe(false);
    expect(loadRunnerConfig(runnerEnvironment({ DRY_RUN: "off" })).dryRun).toBe(false);
    expect(loadRunnerConfig(runnerEnvironment({ DRY_RUN: "yes" })).dryRun).toBe(true);
    expect(configErrorOf(() => loadRunnerConfig(runnerEnvironment({ DRY_RUN: "maybe" }))).problems).toEqual([
      "DRY_RUN: must be 1 or 0 (or true/false, yes/no, on/off)",
    ]);
  });

  it("keeps up to 2 GB of a container's data before an update unless its .env says otherwise, 0 for none", () => {
    expect(loadRunnerConfig(runnerEnvironment()).checkpointLimitBytes).toBe(2_000_000_000);
    expect(loadRunnerConfig(runnerEnvironment({ UPDATE_CHECKPOINT_LIMIT_GB: "0" })).checkpointLimitBytes).toBe(0);
    expect(
      configErrorOf(() => loadRunnerConfig(runnerEnvironment({ UPDATE_CHECKPOINT_LIMIT_GB: "-1" }))).problems,
    ).toEqual(["UPDATE_CHECKPOINT_LIMIT_GB: must be at least 0"]);
  });

  it("lets admins open a shell on the host unless its .env says HOST_TERMINAL=off", () => {
    expect(loadRunnerConfig(runnerEnvironment()).hostTerminal).toBe(true);
    expect(loadRunnerConfig(runnerEnvironment({ HOST_TERMINAL: "off" })).hostTerminal).toBe(false);
    expect(configErrorOf(() => loadRunnerConfig(runnerEnvironment({ HOST_TERMINAL: "yes" }))).problems).toEqual([
      "HOST_TERMINAL: must be off or on",
    ]);
  });

  it("lets admins reach inside containers unless its .env says CONTAINER_ACCESS=off", () => {
    expect(loadRunnerConfig(runnerEnvironment()).containerAccess).toBe(true);
    expect(loadRunnerConfig(runnerEnvironment({ CONTAINER_ACCESS: "off" })).containerAccess).toBe(false);
    expect(loadRunnerConfig(runnerEnvironment({ CONTAINER_ACCESS: "on" })).containerAccess).toBe(true);
    expect(configErrorOf(() => loadRunnerConfig(runnerEnvironment({ CONTAINER_ACCESS: "yes" }))).problems).toEqual([
      "CONTAINER_ACCESS: must be off or on",
    ]);
  });

  it("wants the control plane address and token together, without echoing the token", () => {
    const { problems } = configErrorOf(() =>
      loadRunnerConfig(runnerEnvironment({ CONTROL_PLANE_URL: "https://192.168.10.123:9443" })),
    );
    expect(problems).toEqual(["RUNNER_TOKEN: set both CONTROL_PLANE_URL and RUNNER_TOKEN, or neither"]);
    const wrongToken = "ahk_definitely-not-long-enough";
    const error = configErrorOf(() =>
      loadRunnerConfig(
        runnerEnvironment({ CONTROL_PLANE_URL: "https://192.168.10.123:9443", RUNNER_TOKEN: wrongToken }),
      ),
    );
    expect(error.problems[0]).toMatch(/^RUNNER_TOKEN: is not a runner token/);
    expect(error.message).not.toContain(wrongToken);
    const config = loadRunnerConfig(
      runnerEnvironment({ CONTROL_PLANE_URL: "https://192.168.10.123:9443", RUNNER_TOKEN: runnerToken }),
      noJoinFile,
    );
    expect(config.controlPlane).toEqual({ url: "https://192.168.10.123:9443", token: runnerToken, pin: null });
  });

  it("joins with a code from the environment or the join volume, and then needs no Ollama of its own", () => {
    const code = encodeJoinCode({ url: "https://192.168.10.83:9443", token: runnerToken, pin });
    const joined = loadRunnerConfig({ AUTOHEAL_JOIN: code }, noJoinFile);
    expect(joined.controlPlane).toEqual({ url: "https://192.168.10.83:9443", token: runnerToken, pin });
    expect([joined.ollama, joined.joinFile]).toEqual([null, null]);
    expect(
      loadRunnerConfig({ AUTOHEAL_JOIN: code, CONTROL_PLANE_URL: "https://mini.lan:9443" }, noJoinFile).controlPlane
        ?.url,
    ).toBe("https://mini.lan:9443");

    const joinFile = join(temporaryDirectory, "runner.join");
    writeFileSync(joinFile, `${code}\n`);
    const local = loadRunnerConfig({}, joinFile);
    expect([local.controlPlane?.pin, local.joinFile]).toEqual([pin, joinFile]);

    const error = configErrorOf(() => loadRunnerConfig({ AUTOHEAL_JOIN: "ahj_garbled" }, noJoinFile));
    expect(error.problems).toEqual([
      "AUTOHEAL_JOIN: is not a join code; copy the install command from the dashboard (Hosts > Add a host)",
    ]);
    expect(error.message).not.toContain("ahj_garbled");
  });

  it("needs a control plane or, on its own, an Ollama", () => {
    expect(configErrorOf(() => loadRunnerConfig({}, noJoinFile)).problems).toEqual([
      "OLLAMA_URL: set AUTOHEAL_JOIN (from the dashboard: Hosts > Add a host), or OLLAMA_URL for a runner on its own",
    ]);
  });

  it("names itself after its host unless told otherwise", () => {
    const hostRoot = join(temporaryDirectory, "host-root");
    mkdirSync(join(hostRoot, "etc"), { recursive: true });
    writeFileSync(join(hostRoot, "etc", "hostname"), "Rowan Blade\n");
    const environment = runnerEnvironment({ HOST_LABEL: "", HOST_ROOT: hostRoot });
    expect(loadRunnerConfig(environment, noJoinFile).hostLabel).toBe("Rowan-Blade");
    expect(loadRunnerConfig({ ...environment, HOST_LABEL: "HP" }, noJoinFile).hostLabel).toBe("HP");
    expect(loadRunnerConfig({ ...environment, HOST_ROOT: temporaryDirectory }, noJoinFile).hostLabel).toBe(
      "docker-host",
    );
  });

  it("refuses odd host labels and plain http to the control plane, and takes http for Ollama", () => {
    const { problems } = configErrorOf(() =>
      loadRunnerConfig(
        {
          HOST_LABEL: "my host",
          OLLAMA_URL: "http://ollama.lan",
          CONTROL_PLANE_URL: "http://192.168.10.123:9443",
          RUNNER_TOKEN: runnerToken,
        },
        noJoinFile,
      ),
    );
    expect(problems).toEqual([
      "HOST_LABEL: may only use letters, digits, dots, dashes and underscores (64 at most)",
      "CONTROL_PLANE_URL: must be an https:// URL",
    ]);
    expect(loadRunnerConfig(runnerEnvironment({ OLLAMA_URL: "http://ollama.lan" }), noJoinFile).ollama?.url).toBe(
      "http://ollama.lan",
    );
  });

  it("accepts the main host's example file, as its runner shares it", () => {
    const config = loadRunnerConfig(parseEnv(readFileSync(".env.example", "utf8")), noJoinFile);
    expect(config.ollama?.url).toBe("http://your-ollama-address:11434");
    expect(config.dockerSocketPath).toBe("/var/run/docker.sock");
    expect(config.hostRoot).toBe("/host/root");
    // None listed: every local disk the host has mounted.
    expect(config.hostFilesystems).toEqual([]);
  });

  it("reports the host filesystems listed, as absolute paths only", () => {
    const config = loadRunnerConfig(runnerEnvironment({ HOST_FILESYSTEMS: "/, /mnt/data" }), noJoinFile);
    expect(config.hostFilesystems).toEqual(["/", "/mnt/data"]);
    const { problems } = configErrorOf(() =>
      loadRunnerConfig(runnerEnvironment({ HOST_FILESYSTEMS: "/,mnt/data" }), noJoinFile),
    );
    expect(problems).toEqual([
      "HOST_FILESYSTEMS.1: must be absolute paths on the host, comma separated, like /,/mnt/data",
    ]);
  });
});

describe("check-config command", () => {
  it("exits 0 for a valid environment and 1 for an invalid one", async () => {
    const output = silentOutput();
    expect(await runCheckConfig(["runner"], runnerEnvironment(), output)).toBe(0);
    expect(output.lines).toEqual(["Configuration is valid."]);
    expect(await runCheckConfig(["control-plane"], {}, silentOutput())).toBe(1);
  });

  it("exits 2 without a known mode", async () => {
    expect(await runCheckConfig(["database"], {}, silentOutput())).toBe(2);
    expect(await runCheckConfig([], {}, silentOutput())).toBe(2);
  });
});
