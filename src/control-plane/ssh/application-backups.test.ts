import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runningContainer,
  startEmbeddedSshHost,
  until,
  type EmbeddedSshHost,
} from "../../../test/support/embedded-ssh-host.js";
import { API_ROUTES, apiPath, type HostView } from "../../shared/api.js";
import { APPLICATION_HELPER_ERRORS, type ApplicationBackupRun } from "../../shared/application-backups.js";

// The image the test control plane runs, as its AUTOHEAL_IMAGE names it.
const AUTOHEAL_IMAGE = "autoheal:test";
const LOADED_IMAGE = `sha256:${"9".repeat(64)}`;
const definition = {
  version: 1,
  name: "Paperless",
  containerName: "paperless",
  consistency: "coordinated-clean-stop",
  exclusiveDockerWriters: true,
  sqlite: null,
  intervalHours: null,
  retain: 2,
};

describe("an application backup on an SSH host", () => {
  let setup: EmbeddedSshHost;

  beforeEach(async () => {
    setup = await startEmbeddedSshHost([
      runningContainer("paperless", {
        Id: "d".repeat(64),
        Image: `sha256:${"1".repeat(64)}`,
        Config: { Image: "example/paperless:2", Env: [], Labels: {}, Tty: false },
        Mounts: [
          {
            Type: "volume",
            Name: "paperless-data",
            Source: "/var/lib/docker/volumes/paperless-data/_data",
            Destination: "/data",
            RW: true,
          },
        ],
      }),
    ]);
    setup.engine.volumes.set("paperless-data", { Name: "paperless-data", Driver: "local", Options: {} });
    const { controlPlane, actor, hostId, admin } = setup;
    const { sshHostsService, embeddedRunners } = controlPlane.services;
    sshHostsService.updateSettings(actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    embeddedRunners.begin();
    await until(
      async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((host) => host.id === hostId)!,
      (host) => host.dryRun === false && host.runningCount === 1,
    );
  });

  afterEach(() => setup.stop());

  const capture = async () => {
    const { admin, hostId, controlPlane } = setup;
    const created = await admin.post(API_ROUTES.applicationBackups, { hostId, definition, enabled: true });
    expect(created.statusCode, created.body).toBe(200);
    const planId = controlPlane.services.applicationBackups.view().plans[0]!.id;
    const asked = await admin.post(apiPath(API_ROUTES.applicationBackupRun, { planId }), {
      operation: "capture",
      requestKey: randomUUID(),
    });
    expect(asked.statusCode, asked.body).toBe(200);
    return until(
      () => controlPlane.services.applicationBackups.view().runs[0]!,
      (run: ApplicationBackupRun) => run.status !== "queued" && run.status !== "running",
    );
  };

  it("without Autoheal's image there, is refused before the application stops, saying how to load it", async () => {
    const run = await capture();
    expect(run).toMatchObject({
      status: "failed",
      result: { ok: false, message: APPLICATION_HELPER_ERRORS.imageMissing(AUTOHEAL_IMAGE), stopped: [] },
    });
    expect(setup.engine.stops).toEqual([]);
    expect(setup.engine.containers.get("paperless")!.State.Running).toBe(true);
    expect(setup.engine.creations).toEqual([]);
  });

  it("with it loaded there, runs its helper in that image, found by the control plane's own reference", async () => {
    setup.engine.imageIds.set(AUTOHEAL_IMAGE, LOADED_IMAGE);
    setup.engine.imageLabels.set(LOADED_IMAGE, {});
    await capture();
    // The fake engine does not run the helper's program: what matters here is the image it was created in.
    const helpers = setup.engine.creations.filter(({ name }) => name.startsWith("autoheal-application-helper-"));
    expect(helpers.map(({ specification }) => specification.Image)).toEqual([LOADED_IMAGE]);
  });
});
