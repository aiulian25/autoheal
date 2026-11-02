import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeDockerEngine } from "../../../test/fakes/fake-docker-engine.js";
import type { TestClient } from "../../../test/support/control-plane.js";
import { runningContainer, startEmbeddedSshHost, until } from "../../../test/support/embedded-ssh-host.js";
import { API_ROUTES, apiPath, type HostView, type JobView } from "../../shared/api.js";
import { JOB_ACTION, JOB_OUTCOMES, JOB_STATUS } from "../../shared/constants.js";

const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;
const WEB = "example/web:2";
const DB = "example/db:16";
// An update waits this long for the new container to keep running: the updater's own settle time, and some.
const UPDATE_TEST_MILLISECONDS = 90_000;

describe("updates and roll back on an SSH host, where data cannot be kept yet", () => {
  let engine: FakeDockerEngine;
  let admin: TestClient;
  let hostId: string;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const web = runningContainer("web", {
      Id: "a".repeat(64),
      Image: OLD,
      Config: { Image: WEB, Env: [], Labels: {}, Tty: false },
      Mounts: [],
    });
    const database = runningContainer("db", {
      Id: "b".repeat(64),
      Image: OLD,
      Config: { Image: DB, Env: [], Labels: {}, Tty: false },
      Mounts: [
        {
          Type: "volume",
          Name: "db-data",
          Source: "/var/lib/docker/volumes/db-data/_data",
          Destination: "/data",
          RW: true,
        },
      ],
    });
    const started = await startEmbeddedSshHost([web, database]);
    ({ engine, admin, hostId, stop } = started);
    // The registry's tags moved on: a pull points them at the new image.
    for (const tag of [WEB, DB]) {
      engine.imageIds.set(tag, OLD);
      engine.tagsMovedOnPull.set(tag, NEW);
    }
    engine.imageLabels.set(OLD, {});
    engine.imageLabels.set(NEW, {});
    const { sshHostsService, embeddedRunners } = started.controlPlane.services;
    sshHostsService.updateSettings(started.actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    embeddedRunners.begin();
    await until(
      async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((host) => host.id === hostId)!,
      (host) => host.dryRun === false && host.runningCount === 2,
    );
  });

  afterEach(() => stop());

  const jobOf = async (containerName: string, id: string) =>
    (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}&containerName=${containerName}`))
      .json<JobView[]>()
      .find((job) => job.id === id)!;
  const ended = (job: JobView) => job.status !== JOB_STATUS.pending && job.status !== JOB_STATUS.delivered;
  const ask = async (containerName: string, action: string) => {
    const asked = await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName }), { action });
    expect(asked.statusCode, asked.body).toBe(200);
    return asked.json<JobView>().id;
  };
  const act = async (containerName: string, action: string) => {
    const id = await ask(containerName, action);
    return until(() => jobOf(containerName, id), ended);
  };

  it(
    "updates a container by hand over the session, its pull streamed, and says what it could not keep",
    async () => {
      const id = await ask("web", JOB_ACTION.update);
      // While it runs, the dashboard sees how far it is: the image's layers as Docker pulled them, over the session.
      const going = await until(
        () => jobOf("web", id),
        (job) => ended(job) || (job.progress?.layers.length ?? 0) > 0,
      );
      expect(going.progress?.layers).toEqual([expect.objectContaining({ id: "layer" })]);
      const web = await until(() => jobOf("web", id), ended);
      expect(web.status, web.outcome ?? "").toBe(JOB_STATUS.succeeded);
      expect(engine.containers.get("web")).toMatchObject({ Image: NEW, State: { Running: true } });
      expect(engine.pulls).toContain(WEB);

      // Its data: updated all the same at a person's word, the reason it was not kept said in the outcome.
      const database = await act("db", JOB_ACTION.update);
      expect(database.status, database.outcome ?? "").toBe(JOB_STATUS.succeeded);
      expect(database.outcome).toContain(JOB_OUTCOMES.checkpointSkipped(JOB_OUTCOMES.noDataCopyHere));
      expect(engine.containers.get("db")).toMatchObject({ Image: NEW, State: { Running: true } });
      // No helper of Autoheal's image was asked for: there is none on the host.
      expect(engine.creations.map((creation) => creation.name).sort()).toEqual(["db", "web"]);
    },
    UPDATE_TEST_MILLISECONDS,
  );

  it(
    "keeps the old container aside when the new one fails, and puts it back when rolled back",
    async () => {
      engine.failingImages.add(NEW);
      const update = await act("web", JOB_ACTION.update);
      expect(update.status).toBe(JOB_STATUS.failed);
      expect(engine.containers.get("web-autoheal-old")).toMatchObject({ Image: OLD });

      engine.failingImages.clear();
      const rolledBack = await act("web", JOB_ACTION.rollBack);
      expect(rolledBack.status, rolledBack.outcome ?? "").toBe(JOB_STATUS.succeeded);
      expect(rolledBack.outcome).toBe(JOB_OUTCOMES.rolledBack("web"));
      expect(engine.containers.get("web")).toMatchObject({ Id: "a".repeat(64), Image: OLD, State: { Running: true } });
      expect(engine.containers.has("web-autoheal-old")).toBe(false);
    },
    UPDATE_TEST_MILLISECONDS,
  );
});
