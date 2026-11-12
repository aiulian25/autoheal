import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDockerEngine } from "../../test/fakes/fake-docker-engine.js";
import { ConfigError } from "../config/environment-schema.js";
import { loadRunnerConfig } from "../config/runner-config.js";
import { RUNNER_TOKEN_PATTERN, RUNNER_TOKEN_VOLUME } from "../shared/constants.js";
import { sha256Hex } from "../shared/hash.js";
import { encodeJoinCode, newToken, type EnrolmentDetails } from "../shared/join-code.js";
import { ControlPlaneError, JoinCodeRefusedError } from "./control-plane-client.js";
import { DockerClient } from "./docker-client.js";
import { withRunnerToken } from "./runner-token.js";
import { volumesReport } from "./volumes.js";

const PIN = "P".repeat(43);
const URL = "https://192.168.10.83:9443";
const NO_JOIN_FILE = "/nonexistent/runner.join";
const configWith = (enrolment: string) =>
  loadRunnerConfig({ AUTOHEAL_JOIN: encodeJoinCode({ url: URL, enrolment, pin: PIN }) }, NO_JOIN_FILE);
const FIRST = `ahe_${"F".repeat(43)}`;
const SECOND = `ahe_${"S".repeat(43)}`;
const noPause = async () => undefined;
// The volume a code's traded token is kept in.
const kept = (enrolment: string) =>
  `${RUNNER_TOKEN_VOLUME.prefix}${sha256Hex(enrolment).slice(0, RUNNER_TOKEN_VOLUME.codeHashCharacters)}`;

describe("a runner whose join code works once", () => {
  let engine: FakeDockerEngine;
  let docker: DockerClient;
  let traded: { code: EnrolmentDetails; token: string }[];
  const redeem = async (code: EnrolmentDetails, token: string) => {
    traded.push({ code, token });
  };

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    docker = new DockerClient(engine.socketPath);
    traded = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await engine.close();
  });

  it("trades it once for a token it made, keeps that in Docker, and asks nothing when started again", async () => {
    const joined = await withRunnerToken(configWith(FIRST), docker, redeem, noPause);
    expect(traded).toHaveLength(1);
    const token = traded[0]!.token;
    expect(token).toMatch(RUNNER_TOKEN_PATTERN);
    expect(traded[0]!.code).toEqual({ url: URL, enrolment: FIRST, pin: PIN });
    expect(joined.controlPlane).toEqual({ url: URL, pin: PIN, token });
    expect(joined.enrolment).toBeNull();
    const kept = await docker.volumes("autoheal.runner.token");
    expect(kept.map((volume) => [volume.Name, volume.Labels])).toEqual([
      [expect.stringMatching(/^autoheal-runner-[0-9a-f]{16}$/), { "autoheal.runner.token": token }],
    ]);
    // Autoheal's own, as its safety records are: never offered for removal, and its label never reported.
    const [reported] = await volumesReport(docker, new Map());
    expect(reported).toMatchObject({ own: true });
    expect(JSON.stringify(reported)).not.toContain(token);

    const again = await withRunnerToken(configWith(FIRST), new DockerClient(engine.socketPath), redeem, noPause);
    expect(again.controlPlane?.token).toBe(token);
    expect(traded).toHaveLength(1);
  });

  it("trades a new code put in its .env, keeping each code's token apart", async () => {
    const first = await withRunnerToken(configWith(FIRST), docker, redeem, noPause);
    const second = await withRunnerToken(configWith(SECOND), docker, redeem, noPause);
    expect(traded.map(({ code }) => code.enrolment)).toEqual([FIRST, SECOND]);
    expect(second.controlPlane?.token).not.toBe(first.controlPlane?.token);
    expect(await docker.volumes("autoheal.runner.token")).toHaveLength(2);
  });

  it("asks again with the same token while the control plane does not answer, then keeps it", async () => {
    const pauses: number[] = [];
    let failures = 2;
    const flaky = async (code: EnrolmentDetails, token: string) => {
      traded.push({ code, token });
      if (failures-- > 0) throw new ControlPlaneError(503, "busy");
    };
    const joined = await withRunnerToken(configWith(FIRST), docker, flaky, async (milliseconds) => {
      pauses.push(milliseconds);
    });
    expect(new Set(traded.map(({ token }) => token)).size).toBe(1);
    expect(traded).toHaveLength(3);
    expect(pauses).toEqual([30_000, 30_000]);
    expect(joined.controlPlane?.token).toBe(traded[0]!.token);
  });

  it("asks again when the control plane is too busy, but not when it calls the request wrong", async () => {
    let busy = true;
    const answering = async (code: EnrolmentDetails, token: string) => {
      traded.push({ code, token });
      if (busy) {
        busy = false;
        throw new ControlPlaneError(429, "slow down");
      }
      throw new ControlPlaneError(400, "invalid_request");
    };
    const stopped = await withRunnerToken(configWith(FIRST), docker, answering, noPause).catch((error) => error);
    expect(stopped).toBeInstanceOf(ControlPlaneError);
    expect((stopped as ControlPlaneError).status).toBe(400);
    expect(traded).toHaveLength(2);
    expect(await docker.volumes("autoheal.runner.token")).toEqual([]);
  });

  it("stops, saying what to do, when the control plane refuses the code, and keeps nothing", async () => {
    const refusing = async () => {
      throw new JoinCodeRefusedError("join_code_refused");
    };
    const stopped = await withRunnerToken(configWith(FIRST), docker, refusing, noPause).catch((error) => error);
    expect(stopped).toBeInstanceOf(ConfigError);
    expect((stopped as ConfigError).problems[0]).toMatch(/^AUTOHEAL_JOIN: works once, within an hour of being made/);
    expect(await docker.volumes("autoheal.runner.token")).toEqual([]);
  });

  it("trades the same token again when it stopped after the trade, before keeping it, and needs no new code", async () => {
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Docker keeps it as waiting, then fails to keep it as traded: as a runner stopped right after the control plane
    // took its token.
    const stoppedAfterTrade = {
      volumes: (label: string) => docker.volumes(label),
      createVolume: async (name: string, labels: Record<string, string>) => {
        if (!name.endsWith(RUNNER_TOKEN_VOLUME.waitingSuffix)) throw new Error("the runner stopped");
        return docker.createVolume(name, labels);
      },
      removeVolume: (name: string) => docker.removeVolume(name),
    };
    await withRunnerToken(configWith(FIRST), stoppedAfterTrade, redeem, noPause);
    expect(said.mock.calls.flat().join("\n")).toContain("it is kept as waiting, so a restart trades it again");

    const restarted = await withRunnerToken(configWith(FIRST), new DockerClient(engine.socketPath), redeem, noPause);

    const [first] = traded;
    expect(traded.map(({ token }) => token)).toEqual([first!.token, first!.token]);
    expect(restarted.controlPlane?.token).toBe(first!.token);
    expect((await docker.volumes(RUNNER_TOKEN_VOLUME.label)).map(({ Name }) => Name)).toEqual([kept(FIRST)]);
  });

  it("trades the token a runner left waiting when it stopped before it asked", async () => {
    const waiting = newToken();
    await docker.createVolume(`${kept(FIRST)}${RUNNER_TOKEN_VOLUME.waitingSuffix}`, {
      [RUNNER_TOKEN_VOLUME.label]: waiting,
    });

    const joined = await withRunnerToken(configWith(FIRST), docker, redeem, noPause);

    expect(traded.map(({ token }) => token)).toEqual([waiting]);
    expect(joined.controlPlane?.token).toBe(waiting);
    expect((await docker.volumes(RUNNER_TOKEN_VOLUME.label)).map(({ Name }) => Name)).toEqual([kept(FIRST)]);
  });

  it("still reports with the token when Docker will not keep it, and says it needs a new code after a restart", async () => {
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const refusingStore = {
      volumes: (label: string) => docker.volumes(label),
      createVolume: async () => {
        throw new Error("no space left on device");
      },
      removeVolume: async () => undefined,
    };
    const joined = await withRunnerToken(configWith(FIRST), refusingStore, redeem, noPause);
    expect(joined.controlPlane?.token).toBe(traded[0]!.token);
    expect(said.mock.calls.flat().join("\n")).toContain("could not keep this runner's token in Docker");
  });

  it("leaves a runner whose code carries its token, or that has no code, as it was", async () => {
    const config = loadRunnerConfig({ OLLAMA_URL: "https://ollama.lan" }, NO_JOIN_FILE);
    expect(await withRunnerToken(config, docker, redeem, noPause)).toBe(config);
    expect(traded).toEqual([]);
  });
});
