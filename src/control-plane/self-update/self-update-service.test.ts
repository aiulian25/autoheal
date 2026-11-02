import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, containerIdOf } from "../../../test/fakes/fake-docker-engine.js";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { runningContainer } from "../../../test/support/embedded-ssh-host.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { DockerClient } from "../../runner/docker-client.js";
import { API_ERRORS, API_ROUTES, type AssignableView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  SELF_UPDATE,
  SELF_UPDATE_PHASE,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_TEXT,
} from "../../shared/constants.js";
import type { Actor } from "../audit/audit-log.js";
import { SelfUpdateOutcomeFile } from "./self-update-outcome.js";
import { SelfUpdateService } from "./self-update-service.js";

const NAME = "autoheal-control-plane";
const REFERENCE = "autoheal:local";
const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `sha256:${"2".repeat(64)}`;
const SOCKET_GROUP = 998;
const DATA_VOLUME = "autoheal_data";
const SOCKET = { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" };
const DATA = { Type: "volume", Name: DATA_VOLUME, Destination: "/data" };

describe("Autoheal updating itself, from the dashboard", () => {
  let engine: FakeDockerEngine;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let actor: Actor;
  let data: string;
  let outcomes: SelfUpdateOutcomeFile;

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    engine.add(
      runningContainer(NAME, {
        Id: containerIdOf(NAME),
        Image: OLD_IMAGE,
        Mounts: [SOCKET, DATA],
        Config: { Image: OLD_IMAGE, Tty: false, Env: [] },
      }),
    );
    engine.imageIds.set(REFERENCE, NEW_IMAGE);
    engine.imageLabels.set(NEW_IMAGE, {});
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
    actor = { userId: adminId, username: "admin", ip: "127.0.0.1", requestId: "test" };
    data = mkdtempSync(join(tmpdir(), "autoheal-self-update-"));
    outcomes = new SelfUpdateOutcomeFile(data);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await engine.close();
    rmSync(data, { recursive: true, force: true });
  });

  // Holds its first pull until told, as a slow registry does; what it does there stands in for the world moving on.
  class PausedDocker extends DockerClient {
    private paused = true;
    private release = () => {};
    private arrived = () => {};
    readonly reached = new Promise<void>((resolve) => {
      this.arrived = resolve;
    });
    readonly resume = () => this.release();

    override async pull(reference: string) {
      if (!this.paused) return super.pull(reference);
      this.paused = false;
      const released = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      this.arrived();
      await released;
      return super.pull(reference);
    }
  }
  const pausedDocker = () => new PausedDocker(engine.socketPath);
  const helperRemovals = () => engine.removals.filter((name) => name.startsWith(SELF_UPDATE.helperName));
  const helperCreations = () => engine.creations.filter(({ name }) => name === SELF_UPDATE.helperName);
  const stoppedHelper = (Status: string) => {
    const helper = runningContainer(SELF_UPDATE.helperName);
    return { ...helper, State: { ...helper.State, Status, Running: false } };
  };

  const service = (docker: DockerClient | null = new DockerClient(engine.socketPath)) =>
    new SelfUpdateService({
      docker,
      reference: REFERENCE,
      outcomes,
      auditLog: controlPlane.services.auditLog,
      clock: () => controlPlane.clock.now,
      ownContainer: containerIdOf(NAME),
      socketGroup: () => SOCKET_GROUP,
    });
  const audit = async () => JSON.stringify((await admin.get(API_ROUTES.audit)).json());

  describe("which image an update looks for", () => {
    const COMPOSE_TAG = "ghcr.io/example/autoheal:latest";
    const running = (config: object) => {
      engine.containers.get(NAME)!.Config = { Image: OLD_IMAGE, Tty: false, Env: [], ...config } as never;
    };

    it("is the tag its compose file names, so that tag does not stay behind on the old image", async () => {
      running({ Image: COMPOSE_TAG });
      engine.imageIds.set(COMPOSE_TAG, NEW_IMAGE);
      const view = await service().start(actor);
      expect(engine.pulls).toContain(COMPOSE_TAG);
      expect(engine.pulls).not.toContain(REFERENCE);
      expect(view.reference).toBe(COMPOSE_TAG);
      const helper = engine.creations.find(({ name }) => name === SELF_UPDATE.helperName)!.specification;
      expect(helper).toMatchObject({ Cmd: ["self-update", containerIdOf(NAME), NEW_IMAGE, COMPOSE_TAG] });
    });

    it("is the name the last update noted, where that update left it running by image id", async () => {
      running({ Labels: { [SELF_UPDATE.referenceLabel]: COMPOSE_TAG } });
      engine.imageIds.set(COMPOSE_TAG, NEW_IMAGE);
      expect((await service().view()).reference).toBe(COMPOSE_TAG);
    });

    it("is AUTOHEAL_IMAGE where the container says nothing", async () => {
      expect((await service().view()).reference).toBe(REFERENCE);
    });
  });

  it("starts a helper of the new image with the socket and the data volume alone, and says it is updating", async () => {
    const view = await service().start(actor);
    const helper = engine.creations.find(({ name }) => name === SELF_UPDATE.helperName)!.specification;
    expect(helper).toMatchObject({
      Image: NEW_IMAGE,
      Cmd: ["self-update", containerIdOf(NAME), NEW_IMAGE, REFERENCE],
      User: SELF_UPDATE.user,
      HostConfig: {
        AutoRemove: true,
        Binds: ["/var/run/docker.sock:/var/run/docker.sock", `${DATA_VOLUME}:/data`],
        GroupAdd: [String(SOCKET_GROUP)],
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        NetworkMode: "none",
      },
    });
    expect(engine.containers.get(SELF_UPDATE.helperName)!.State.Running).toBe(true);
    expect(view).toMatchObject({
      unavailable: null,
      runningImage: OLD_IMAGE,
      reference: REFERENCE,
      last: { status: SELF_UPDATE_STATUS.updating, from: OLD_IMAGE, to: NEW_IMAGE },
    });
    expect(await audit()).toContain(AUDIT_ACTIONS.selfUpdateStarted);
  });

  it("refuses when it already runs that image, when an update is going on, and without the Docker socket", async () => {
    engine.imageIds.set(REFERENCE, OLD_IMAGE);
    engine.imageLabels.set(OLD_IMAGE, {});
    await expect(service().start(actor)).rejects.toMatchObject({ code: API_ERRORS.selfUpdateNewest });

    engine.imageIds.set(REFERENCE, NEW_IMAGE);
    engine.add(runningContainer(SELF_UPDATE.helperName));
    await expect(service().start(actor)).rejects.toMatchObject({ code: API_ERRORS.selfUpdateRunning });

    await expect(service(null).start(actor)).rejects.toMatchObject({ code: API_ERRORS.selfUpdateUnavailable });
    expect(await service(null).view()).toMatchObject({ unavailable: SELF_UPDATE_TEXT.noSocket, runningImage: null });
    expect(engine.creations).toEqual([]);
  });

  describe("admitting one update at a time", () => {
    it("refuses a second request while the first waits on its image, and never touches the helper it starts", async () => {
      const docker = pausedDocker();
      const selfUpdate = service(docker);
      const first = selfUpdate.start(actor);
      await docker.reached;

      await expect(selfUpdate.start(actor)).rejects.toMatchObject({ code: API_ERRORS.selfUpdateRunning });
      expect(helperCreations()).toEqual([]);

      docker.resume();
      await first;
      expect(helperCreations()).toHaveLength(1);
      expect(engine.containers.get(SELF_UPDATE.helperName)!.State.Running).toBe(true);
      expect((await audit()).split(AUDIT_ACTIONS.selfUpdateStarted)).toHaveLength(2);
    });

    it("refuses a request that arrives before the first has reached Docker at all", async () => {
      const selfUpdate = service();
      const [first, second] = await Promise.allSettled([selfUpdate.start(actor), selfUpdate.start(actor)]);
      expect(first.status).toBe("fulfilled");
      expect(second).toMatchObject({ status: "rejected", reason: { code: API_ERRORS.selfUpdateRunning } });
      expect(helperCreations()).toHaveLength(1);
    });

    it("leaves a helper alone that came up while it waited on the image", async () => {
      const docker = pausedDocker();
      const first = service(docker).start(actor);
      await docker.reached;
      engine.add(runningContainer(SELF_UPDATE.helperName));

      docker.resume();
      await expect(first).rejects.toMatchObject({ code: API_ERRORS.selfUpdateRunning });
      expect(helperRemovals()).toEqual([]);
      expect(helperCreations()).toEqual([]);
      expect(engine.containers.get(SELF_UPDATE.helperName)!.State.Running).toBe(true);
    });

    it("treats a paused or restarting helper as still in hand, and clears only a finished or unstarted one", async () => {
      for (const Status of ["paused", "restarting", "removing", "dead"]) {
        engine.add(stoppedHelper(Status));
        await expect(service().start(actor)).rejects.toMatchObject({ code: API_ERRORS.selfUpdateRunning });
      }
      expect(helperRemovals()).toEqual([]);

      for (const Status of ["created", "exited"]) {
        engine.add(stoppedHelper(Status));
        await service().start(actor);
      }
      expect(helperRemovals()).toHaveLength(2);
      expect(helperCreations()).toHaveLength(2);
    });

    it("lets go after a refused admission, so the next request is not locked out", async () => {
      const selfUpdate = service();
      engine.imageIds.set(REFERENCE, OLD_IMAGE);
      engine.imageLabels.set(OLD_IMAGE, {});
      await expect(selfUpdate.start(actor)).rejects.toMatchObject({ code: API_ERRORS.selfUpdateNewest });

      engine.imageIds.delete(REFERENCE);
      await expect(selfUpdate.start(actor)).rejects.toMatchObject({ code: API_ERRORS.selfUpdateUnavailable });

      engine.imageIds.set(REFERENCE, NEW_IMAGE);
      await selfUpdate.start(actor);
      expect(helperCreations()).toHaveLength(1);
    });

    describe("when the helper's start is refused", () => {
      class RefusingDocker extends DockerClient {
        constructor(
          socketPath: string,
          private readonly afterwards: () => void = () => {},
        ) {
          super(socketPath);
        }

        override async start(reference: string) {
          if (reference !== SELF_UPDATE.helperName) return super.start(reference);
          this.afterwards();
          throw new Error("no such device");
        }
      }

      it("records that it failed, clears the helper, and lets the next request try", async () => {
        const selfUpdate = service(new RefusingDocker(engine.socketPath));
        await expect(selfUpdate.start(actor)).rejects.toThrow("no such device");

        expect(outcomes.read()).toMatchObject({
          status: SELF_UPDATE_STATUS.failed,
          message: SELF_UPDATE_TEXT.helperFailed("no such device"),
        });
        expect(outcomes.read()!.finishedAt).not.toBeNull();
        expect(engine.containers.has(SELF_UPDATE.helperName)).toBe(false);
        await selfUpdate.view();
        expect(await audit()).toContain(AUDIT_ACTIONS.selfUpdateFinished);

        await service().start(actor);
        expect(engine.containers.get(SELF_UPDATE.helperName)!.State.Running).toBe(true);
      });

      it("goes on when the helper is running after all: only the answer was lost", async () => {
        let removalsBeforeStart = 0;
        const docker = new RefusingDocker(engine.socketPath, () => {
          removalsBeforeStart = helperRemovals().length;
          engine.containers.get(SELF_UPDATE.helperName)!.State = { Status: "running", Running: true };
        });
        const view = await service(docker).start(actor);

        expect(view.last).toMatchObject({ status: SELF_UPDATE_STATUS.updating });
        expect(helperRemovals()).toHaveLength(removalsBeforeStart);
        expect(engine.containers.get(SELF_UPDATE.helperName)!.State.Running).toBe(true);
        expect(await audit()).toContain(AUDIT_ACTIONS.selfUpdateStarted);
      });
    });
  });

  describe("an update that stopped partway", () => {
    const partway = (original: string) =>
      outcomes.write({
        status: SELF_UPDATE_STATUS.watching,
        from: OLD_IMAGE,
        to: NEW_IMAGE,
        reference: REFERENCE,
        startedAt: 1,
        finishedAt: null,
        message: SELF_UPDATE_TEXT.watching,
        recovery: {
          version: SELF_UPDATE.recoveryVersion,
          phase: SELF_UPDATE_PHASE.watching,
          original,
          name: NAME,
          snapshot: { path: "/data/self-update-snapshot.sqlite", schemaVersion: 48 },
        },
      });

    it("reads as stopped once no helper runs, and keeps its recovery record out of the view", async () => {
      partway("the-original-container");
      const { last } = await service().view();
      expect(last).toMatchObject({ status: SELF_UPDATE_STATUS.blocked, message: SELF_UPDATE_TEXT.interrupted });
      expect(last).not.toHaveProperty("recovery");

      engine.add(runningContainer(SELF_UPDATE.helperName));
      expect((await service().view()).last).toMatchObject({ status: SELF_UPDATE_STATUS.watching });
    });

    it("takes it up with what was recorded, even with this image already the newest", async () => {
      partway("the-original-container");
      engine.imageIds.set(REFERENCE, OLD_IMAGE);
      engine.imageLabels.set(OLD_IMAGE, {});
      const pullsBefore = engine.pulls.length;
      engine.imageIds.set(NEW_IMAGE, NEW_IMAGE);
      await service().start(actor);

      expect(helperCreations()[0]!.specification).toMatchObject({
        Cmd: ["self-update", "the-original-container", NEW_IMAGE, REFERENCE],
      });
      expect(engine.pulls.length).toBe(pullsBefore);
      expect(outcomes.read()).toMatchObject({ status: SELF_UPDATE_STATUS.watching, startedAt: 1 });
    });

    it("records who it is replacing before the helper runs, so even a helper that never ran can be taken up", async () => {
      await service().start(actor);
      expect(outcomes.read()!.recovery).toMatchObject({
        phase: SELF_UPDATE_PHASE.preparing,
        original: containerIdOf(NAME),
        name: NAME,
      });
    });
  });

  it("puts a finished update in the audit log once, whichever control plane reads it first", async () => {
    outcomes.write({
      status: SELF_UPDATE_STATUS.rolledBack,
      from: OLD_IMAGE,
      to: NEW_IMAGE,
      reference: REFERENCE,
      startedAt: 1,
      finishedAt: 2,
      message: SELF_UPDATE_TEXT.notHealthy,
    });
    expect((await service().view()).last).toMatchObject({ status: SELF_UPDATE_STATUS.rolledBack });
    await service().view();
    const finished = (await audit()).split(AUDIT_ACTIONS.selfUpdateFinished).length - 1;
    expect(finished).toBe(1);
  });
});
