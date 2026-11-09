import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeDockerEngine } from "../../test/fakes/fake-docker-engine.js";
import { heartbeatWith } from "../../test/support/inventory.js";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../test/support/second-factor.js";
import { ConfigError } from "../config/environment-schema.js";
import { loadRunnerConfig } from "../config/runner-config.js";
import { buildRunnerServer } from "../control-plane/runner-api/runner-server.js";
import { API_ROUTES, type EnrolledHostView, type HostView } from "../shared/api.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { DockerClient } from "./docker-client.js";
import { withRunnerToken } from "./runner-token.js";

const NO_JOIN_FILE = "/nonexistent/runner.join";
const AN_HOUR = 60 * 60 * 1000;

let engine: FakeDockerEngine;
let controlPlane: TestControlPlane;
let admin: TestClient;
let runnerServer: FastifyInstance;
let address: string;

beforeEach(async () => {
  engine = await FakeDockerEngine.start();
  controlPlane = await startTestControlPlane();
  admin = (await fullySignedInAdmin(controlPlane)).client;
  runnerServer = await buildRunnerServer(
    { cert: readFileSync("test/fixtures/tls/server.pem"), key: readFileSync("test/fixtures/tls/server-key.pem") },
    controlPlane.services,
  );
  await runnerServer.listen({ host: "127.0.0.1", port: 0 });
  address = `https://localhost:${(runnerServer.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await runnerServer.close();
  await controlPlane.app.close();
  await controlPlane.runnerApp.close();
  await engine.close();
});

it("joins with the code it was installed with, reports, and starts again on the token it kept", async () => {
  const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder", address })).json<EnrolledHostView>();
  const environment = { AUTOHEAL_JOIN: enrolled.joinCode };
  const started = () =>
    withRunnerToken(loadRunnerConfig(environment, NO_JOIN_FILE), new DockerClient(engine.socketPath));

  const joined = await started();
  const client = new ControlPlaneClient(joined.controlPlane!);
  await client.heartbeat(heartbeatWith({}));
  const [host] = (await admin.get(API_ROUTES.hosts)).json<HostView[]>();
  expect(host).toMatchObject({ label: "Alder", state: "online", tokenHint: joined.controlPlane!.token.slice(-4) });

  // Started again with the same .env, it asks for nothing: the code is used, and its token was kept.
  const again = await started();
  expect(again.controlPlane).toEqual(joined.controlPlane);
  await new ControlPlaneClient(again.controlPlane!).heartbeat(heartbeatWith({}));

  // Its Docker volumes gone, the used code opens nothing, and the runner says what to do.
  const fresh = await FakeDockerEngine.start();
  try {
    const stopped = await withRunnerToken(
      loadRunnerConfig(environment, NO_JOIN_FILE),
      new DockerClient(fresh.socketPath),
    ).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(ConfigError);
  } finally {
    await fresh.close();
  }
});

it("cannot join with a code an hour old", async () => {
  const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Cedar", address })).json<EnrolledHostView>();
  controlPlane.clock.now += AN_HOUR;
  const stopped = await withRunnerToken(
    loadRunnerConfig({ AUTOHEAL_JOIN: enrolled.joinCode }, NO_JOIN_FILE),
    new DockerClient(engine.socketPath),
  ).catch((error: unknown) => error);
  expect((stopped as ConfigError).problems).toEqual([
    expect.stringMatching(/^AUTOHEAL_JOIN: works once, within an hour of being made/),
  ]);
  expect(await new DockerClient(engine.socketPath).volumes("autoheal.runner.token")).toEqual([]);
});
