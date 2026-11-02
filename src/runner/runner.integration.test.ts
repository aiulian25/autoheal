import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { FakeGotify } from "../../test/fakes/fake-gotify.js";
import { FakeOllama, answer } from "../../test/fakes/fake-ollama.js";
import { instantTime } from "../../test/support/instant-time.js";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../test/support/second-factor.js";
import { buildRunnerServer } from "../control-plane/runner-api/runner-server.js";
import { OllamaClient } from "../ollama/ollama-client.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type IncidentDetailView,
  type IncidentSummaryView,
} from "../shared/api.js";
import { RESTART_CHOICE } from "../shared/constants.js";
import { postToGotify } from "../shared/gotify.js";
import { incidentMessage } from "../shared/incident-message.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { Decider } from "./decider.js";
import { DockerClient } from "./docker-client.js";
import { Executor } from "./executor.js";
import { RemedyGuard } from "./remedy-guard.js";
import { Watcher, type WatcherDependencies } from "./watcher.js";

const PROTECTED = new Set(["autoheal", "npm"]);
const SECRET = "s3cr3t-database-password";
// paperless and tika are one compose project, so tika may be named as paperless's dependency.
const IN_PROJECT = { "com.docker.compose.project": "paperless" };

describe("the runner, end to end", () => {
  let docker: FakeDockerEngine;
  let ollama: FakeOllama;
  let gotify: FakeGotify;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let runnerServer: FastifyInstance;
  let runnerPort: number;
  let token: string;
  let stopEvents: AbortController;

  const listenRunnerServer = async (port = 0) => {
    runnerServer = await buildRunnerServer(
      { cert: readFileSync("test/fixtures/tls/server.pem"), key: readFileSync("test/fixtures/tls/server-key.pem") },
      controlPlane.services,
    );
    await runnerServer.listen({ host: "127.0.0.1", port });
    runnerPort = (runnerServer.server.address() as AddressInfo).port;
  };

  beforeEach(async () => {
    docker = await FakeDockerEngine.start();
    ollama = await FakeOllama.start();
    gotify = await FakeGotify.start();
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
    await listenRunnerServer();
    docker.add(
      exitedContainer("paperless", {
        Config: { Image: "paperless:2", Env: [`PAPERLESS_DBPASS=${SECRET}`], Labels: IN_PROJECT },
      }),
      `connecting with ${SECRET}\nConnectionError: tika:9998 refused\n`,
    );
    docker.add(exitedContainer("tika", { Config: { Image: "example/tika:1", Env: [], Labels: IN_PROJECT } }));
    docker.add(exitedContainer("npm"));
    stopEvents = new AbortController();
  });

  afterEach(async () => {
    stopEvents.abort();
    await runnerServer.close();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await Promise.all([docker.close(), ollama.close(), gotify.close()]);
  });

  const startRunner = async (
    options: {
      dryRun?: boolean;
      controlPlaneUrl?: string | null;
      ollamaUrl?: string;
      deadline?: number;
      settleMilliseconds?: number;
      // How time passes while a restarted container is watched: at once, unless a test says otherwise.
      watchTime?: { wait: (milliseconds: number) => Promise<unknown>; clock: () => number };
    } = {},
  ) => {
    const dockerClient = new DockerClient(docker.socketPath);
    const guard = new RemedyGuard(PROTECTED);
    const controlPlaneUrl =
      options.controlPlaneUrl === undefined ? `https://localhost:${runnerPort}` : options.controlPlaneUrl;
    const decider = new Decider(
      controlPlaneUrl === null ? null : new ControlPlaneClient({ url: controlPlaneUrl, token, pin: null }),
      () => ({
        client: new OllamaClient(() => ({
          url: options.ollamaUrl ?? ollama.url(),
          model: "qwen3:4b-instruct",
          contextTokens: 16_384,
        })),
        contextTokens: 16_384,
      }),
      options.deadline,
    );
    const watchTime = options.watchTime ?? instantTime();
    const dependencies: WatcherDependencies = {
      docker: dockerClient,
      guard,
      decider,
      executor: new Executor(
        dockerClient,
        guard,
        { dryRun: options.dryRun ?? false, protectedContainers: PROTECTED },
        () => RESTART_CHOICE.restart,
        watchTime.wait,
        watchTime.clock,
      ),
      // As a runner on its own words it: the control plane's own wording is tested with its notifier.
      notify: (notice) => {
        const message = incidentMessage("HP", notice, "https://autoheal.test");
        return postToGotify(gotify.settings, message.title, message.body, message.priority);
      },
      settings: { protectedContainers: PROTECTED },
      settleMilliseconds: options.settleMilliseconds ?? 5,
    };
    const watcher = new Watcher(dependencies);
    const events = await dockerClient.events(stopEvents.signal);
    void (async () => {
      for await (const event of events) {
        watcher.handleEvent(event);
      }
    })().catch(() => undefined);
    await docker.waitForEventStream();
    return { watcher, decider, dependencies };
  };

  const die = (name: string) => docker.emit({ Type: "container", Action: "die", Actor: { Attributes: { name } } });
  const eventually = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition not met in time");
  };
  const incidents = async () => (await admin.get(API_ROUTES.incidents)).json<IncidentSummaryView[]>();
  const incidentDetail = async (incidentId: string) =>
    (await admin.get(apiPath(API_ROUTES.incident, { incidentId }))).json<IncidentDetailView>();

  it("restarts what the control plane decided and tells the owner, with a link", async () => {
    ollama.handler = () => answer({ action: "restart", target: "paperless", diagnosis: "Transient database timeout." });
    const { watcher } = await startRunner();
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();

    expect(docker.restarts).toEqual(["paperless"]);
    const [message] = gotify.messages;
    expect(message).toMatchObject({ title: "Autoheal HP: paperless restarted", priority: 5 });
    const [incident] = await incidents();
    expect(message!.message).toContain(`https://autoheal.test/incidents/${incident!.id}`);
    expect(incident).toMatchObject({ status: "resolved", verdict: "restarted", decidedBy: "model" });
    const detail = await incidentDetail(incident!.id);
    expect(detail.trace.map((event) => event.kind)).toEqual([
      "reported",
      "prompt_built",
      "model_answered",
      "decided",
      "outcome_reported",
    ]);
    expect(detail.report!.logs).toContain("[REDACTED:PAPERLESS_DBPASS]");
    expect(JSON.stringify(ollama.requests)).not.toContain(SECRET);
  });

  it("comes back to you when the container stops again within the minute after its restart", async () => {
    ollama.handler = () => answer({ action: "restart", target: "paperless", diagnosis: "Transient database timeout." });
    const time = instantTime();
    let looks = 0;
    const { watcher } = await startRunner({
      watchTime: {
        clock: time.clock,
        wait: async (milliseconds) => {
          await time.wait(milliseconds);
          looks += 1;
          // Up at the first look after the restart, down again at the second.
          if (looks === 2) {
            docker.add(exitedContainer("paperless"));
          }
        },
      },
    });
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();

    expect(docker.restarts).toEqual(["paperless"]);
    expect(gotify.messages[0]).toMatchObject({ title: "Autoheal HP: paperless needs you", priority: 8 });
    const [incident] = await incidents();
    expect(incident).toMatchObject({ status: "awaiting_approval", verdict: "needs you" });
    expect((await incidentDetail(incident!.id)).outcome).toBe(
      "Restarted paperless, but it stopped again (exit 1); escalating.",
    );
  });

  it("restarts a dependency of the same compose project, then waits for the container that failed", async () => {
    ollama.handler = () => answer({ action: "restart_dependency", target: "tika", diagnosis: "Tika was not up yet." });
    const backUp = exitedContainer("paperless", {
      State: { Status: "running", Running: true },
      Config: { Image: "paperless:2", Env: [], Labels: IN_PROJECT },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    });
    docker.add({ ...backUp, State: { Status: "exited", Running: false, ExitCode: 1 } });
    const time = instantTime();
    let waits = 0;
    const { watcher } = await startRunner({
      watchTime: {
        clock: time.clock,
        wait: async (milliseconds) => {
          await time.wait(milliseconds);
          waits += 1;
          // Docker's restart policy starts paperless again a few seconds after tika's minute.
          if (waits === 35) {
            docker.add(backUp);
          }
        },
      },
    });
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();

    expect(docker.restarts).toEqual(["tika"]);
    const [incident] = await incidents();
    expect(incident).toMatchObject({ status: "resolved", verdict: "restarted" });
    expect((await incidentDetail(incident!.id)).outcome).toBe("Restarted tika; paperless is up again.");
  });

  it("only reports what it would do in dry-run mode", async () => {
    ollama.handler = () => answer({ action: "restart_dependency", target: "tika", diagnosis: "Tika is down." });
    const { watcher } = await startRunner({ dryRun: true });
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    expect(docker.restarts).toEqual([]);
    expect(gotify.messages[0]).toMatchObject({ title: "Autoheal HP: paperless would restart" });
    expect(gotify.messages[0]!.message).toContain("DRY RUN: would restart tika.");
  });

  it("asks Ollama itself when the control plane is down, and reports later", async () => {
    ollama.handler = () => answer({ action: "restart", target: "paperless", diagnosis: "Crashed once." });
    await runnerServer.close();
    const { watcher, decider } = await startRunner();
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    expect(docker.restarts).toEqual(["paperless"]);
    expect(decider.pendingHandled).toBe(1);
    expect(gotify.messages[0]!.message).not.toContain("https://autoheal.test/incidents/");

    await listenRunnerServer(runnerPort);
    await decider.flushOutbox();
    expect(decider.pendingHandled).toBe(0);
    const [incident] = await incidents();
    expect(incident).toMatchObject({ decidedBy: "agent_fallback", status: "resolved", verdict: "restarted" });
  });

  it("escalates, and says why, when neither the control plane nor Ollama answers", async () => {
    await runnerServer.close();
    const { watcher } = await startRunner({ ollamaUrl: "https://localhost:1" });
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    expect(docker.restarts).toEqual([]);
    expect(gotify.messages[0]).toMatchObject({ title: "Autoheal HP: paperless needs you", priority: 8 });
    expect(gotify.messages[0]!.message).toContain("Ollama could not be asked");
  });

  it("refuses a protected target even when the control plane asks for it", async () => {
    const { watcher, dependencies } = await startRunner();
    dependencies.decider.decide = async () => ({
      incidentId: null,
      decision: { action: "restart_dependency", target: "npm", diagnosis: "Restart the proxy." },
      decidedBy: "model",
    });
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    expect(docker.restarts).toEqual([]);
    expect(gotify.messages[0]).toMatchObject({ title: "Autoheal HP: paperless needs you" });
    expect(gotify.messages[0]!.message).toContain('"npm" is protected');
  });

  it("masks secrets that belong to other containers on the host", async () => {
    docker.add(exitedContainer("tika", { Config: { Image: "tika:1", Env: ["TIKA_API_KEY=shared-with-paperless-1"] } }));
    docker.add(exitedContainer("paperless"), "calling tika with shared-with-paperless-1\nfailed\n");
    const { watcher } = await startRunner();
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    const [incident] = await incidents();
    expect((await incidentDetail(incident!.id)).report!.logs).toContain("[REDACTED:TIKA_API_KEY]");
    expect(JSON.stringify(ollama.requests)).not.toContain("shared-with-paperless-1");
  });

  it("leaves a finished job alone, but not a service that Docker should have kept up", async () => {
    const finished = { Status: "exited", Running: false, ExitCode: 0, OOMKilled: false, Error: "" };
    docker.add(exitedContainer("nightly-backup", { State: finished, HostConfig: { RestartPolicy: { Name: "no" } } }));
    docker.add(exitedContainer("web", { State: finished, HostConfig: { RestartPolicy: { Name: "unless-stopped" } } }));
    const { watcher } = await startRunner();
    die("nightly-backup");
    die("web");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    const handled = await incidents();
    expect(handled.map((incident) => incident.containerName)).toEqual(["web"]);
    expect(gotify.messages.map((message) => message.title)).toEqual(["Autoheal HP: web needs you"]);
  });

  it("closes the control plane's record when the runner stops waiting and decides on its own", async () => {
    ollama.handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return answer({ action: "restart", target: "paperless", diagnosis: "Crashed once." });
    };
    const { watcher, decider } = await startRunner({ deadline: 50 });
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    expect(docker.restarts).toEqual(["paperless"]);
    await decider.flushOutbox();

    await eventually(async () => (await incidents()).length === 2);
    const all = await incidents();
    const abandoned = all.find((incident) => incident.status === "cancelled")!;
    const handled = all.find((incident) => incident.decidedBy === "agent_fallback")!;
    expect(handled).toMatchObject({ status: "resolved", verdict: "restarted" });
    await eventually(async () =>
      (await incidentDetail(abandoned.id)).trace.some((event) => event.kind === "runner_gave_up"),
    );
    expect(gotify.messages).toHaveLength(1);
  });

  it("stands aside when a person's action starts on the container while it settles", async () => {
    ollama.handler = () => answer({ action: "restart", target: "paperless", diagnosis: "Transient database timeout." });
    const { watcher, dependencies } = await startRunner({ settleMilliseconds: 200 });
    die("paperless");
    await new Promise((resolve) => setTimeout(resolve, 50));
    dependencies.guard.hold("paperless");
    await watcher.settled();
    dependencies.guard.release("paperless");
    expect(docker.restarts).toEqual([]);
    expect(await incidents()).toEqual([]);
  });

  it("ignores a die right after a kill, and a container that recovered", async () => {
    const { watcher } = await startRunner();
    docker.emit({ Type: "container", Action: "kill", Actor: { Attributes: { name: "paperless" } } });
    die("paperless");
    docker.add(exitedContainer("tika", { State: { Status: "running", Running: true } }));
    die("tika");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.settled();
    expect(docker.inspected).toEqual(["tika"]);
    expect(await incidents()).toEqual([]);
    expect(gotify.messages).toEqual([]);
  });
});
