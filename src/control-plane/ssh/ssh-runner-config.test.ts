import { describe, expect, it } from "vitest";
import { loadRunnerConfig } from "../../config/runner-config.js";
import { BYTES_PER_GIGABYTE, HOST_PACKAGES } from "../../shared/constants.js";
import { DEFAULT_SSH_HOST_SETTINGS } from "../../shared/ssh-hosts.js";
import { sshRunnerConfig } from "./ssh-runner-config.js";

const CONTROL_PLANE = { url: "https://127.0.0.1:9443", pin: "B".repeat(43) };

describe("an SSH host's runner configuration", () => {
  it("maps every setting the host's page sets, and leaves the rest to the control plane as a bare .env would", () => {
    const config = sshRunnerConfig(
      {
        label: "mini",
        token: "the host's runner token",
        root: null,
        settings: {
          dryRun: false,
          protectedContainers: ["postgres", "npm"],
          containerAccess: false,
          hostPackages: HOST_PACKAGES.check,
          checkpointLimitGigabytes: 7,
        },
      },
      CONTROL_PLANE,
    );
    expect(config).toEqual({
      hostLabel: "mini",
      selfContainerName: "autoheal",
      controlPlane: { ...CONTROL_PLANE, token: "the host's runner token" },
      joinFile: null,
      publicBaseUrl: null,
      ollama: null,
      gotify: null,
      dryRun: false,
      protectedContainers: new Set(["postgres", "npm", "autoheal"]),
      dockerSocketPath: "/var/run/docker.sock",
      hostRoot: "/",
      hostFilesystems: [],
      hostPackages: HOST_PACKAGES.check,
      hostDbusDirectory: "/run/dbus",
      containerAccess: false,
      hostTerminal: true,
      hostTerminalUser: null,
      hostDeploy: true,
      checkpointLimitBytes: 7 * BYTES_PER_GIGABYTE,
    });
  });

  it("gives a new host the same configuration a runner's .env with only its control plane gives", () => {
    const runner = loadRunnerConfig(
      { CONTROL_PLANE_URL: CONTROL_PLANE.url, RUNNER_TOKEN: `ahk_${"a".repeat(43)}` },
      "/no-join",
    );
    const ssh = sshRunnerConfig(
      { label: "mini", token: "token", settings: DEFAULT_SSH_HOST_SETTINGS, root: null },
      CONTROL_PLANE,
    );
    const shared = (config: typeof runner) => ({
      dryRun: config.dryRun,
      protectedContainers: config.protectedContainers,
      containerAccess: config.containerAccess,
      hostTerminal: config.hostTerminal,
      hostPackages: config.hostPackages,
      checkpointLimitBytes: config.checkpointLimitBytes,
      ollama: config.ollama,
      gotify: config.gotify,
      publicBaseUrl: config.publicBaseUrl,
    });
    expect(shared(ssh)).toEqual(shared(runner));
  });
});
