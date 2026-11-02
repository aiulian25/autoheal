import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerTokenOf } from "../../../test/support/control-plane.js";
import {
  runningContainer,
  startEmbeddedSshHost,
  until,
  type EmbeddedSshHost,
} from "../../../test/support/embedded-ssh-host.js";
import { heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type HostView,
  type PendingSshHostView,
  type SshHostDetailsView,
} from "../../shared/api.js";
import { HOST_KIND, SSH_TEXT } from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";

const USER = "alex";
const CHECKING_PACKAGES = {
  setting: "check" as const,
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: [],
  kernelWaiting: null,
  timeZone: "Europe/Lisbon",
  recentChanges: [],
};
// The runner Autoheal had on the host, as Docker lists it: the image's entrypoint running "runner".
const oldRunner = () =>
  runningContainer("autoheal", {
    Config: {
      Image: "autoheal:local",
      Env: [],
      Labels: {},
      Tty: false,
      Cmd: ["/nodejs/bin/node", "/app/dist/server/main.js", "runner"],
    } as never,
  });

describe("switching a runner host to SSH", () => {
  let setup: EmbeddedSshHost;
  let hostId: string;
  let token: string;

  beforeEach(async () => {
    setup = await startEmbeddedSshHost([runningContainer("paperless"), oldRunner()]);
    const { admin, controlPlane } = setup;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "delta3640" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    // What its .env said, as its runner reports it.
    const reported = await heartbeatTo(
      heartbeatWith({
        dryRun: false,
        protectedContainers: ["autoheal", "postgres"],
        containerAccess: true,
        host: hostHealth({ packages: CHECKING_PACKAGES }),
      }),
    );
    expect(reported).toBe(200);
    controlPlane.services.embeddedRunners.begin();
  });

  afterEach(() => setup.stop());

  const heartbeatTo = async (payload: object) =>
    (
      await setup.controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode;
  const host = async () =>
    (await setup.admin.get(API_ROUTES.hosts)).json<HostView[]>().find((candidate) => candidate.id === hostId)!;
  const switchIt = async () => {
    const { admin, controlPlane, server } = setup;
    const keyId = controlPlane.services.sshKeysService.list()[0]!.id;
    const pending = await admin.post(apiPath(API_ROUTES.sshHostSwitch, { hostId }), {
      address: "127.0.0.1",
      port: server.port,
      user: USER,
      keyId,
    });
    expect(pending.statusCode, pending.body).toBe(200);
    const { pendingId, label } = pending.json<PendingSshHostView>();
    expect(label).toBe("delta3640");
    const confirmed = await admin.post(apiPath(API_ROUTES.sshHostConfirm, { pendingId }));
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return confirmed.json<HostView>();
  };

  it("keeps the same host and what its runner's .env said, and its runner's token stops working", async () => {
    const before = await host();
    const switched = await switchIt();
    expect(switched).toMatchObject({
      id: hostId,
      label: "delta3640",
      kind: HOST_KIND.ssh,
      enrolledAt: before.enrolledAt,
    });
    expect(await heartbeatTo(heartbeatWith())).toBe(401);
    const details = (await setup.admin.get(apiPath(API_ROUTES.sshHost, { hostId }))).json<SshHostDetailsView>();
    expect(details.settings).toMatchObject({
      dryRun: false,
      protectedContainers: ["postgres"],
      containerAccess: true,
      hostPackages: "check",
    });
    const audit = JSON.stringify((await setup.admin.get(API_ROUTES.audit)).json());
    expect(audit).toContain("host.switched_to_ssh");
    // Hosts already over SSH, or gone, are not switched again.
    const again = await setup.admin.post(apiPath(API_ROUTES.sshHostSwitch, { hostId }), {
      address: "127.0.0.1",
      port: setup.server.port,
      user: USER,
      keyId: setup.controlPlane.services.sshKeysService.list()[0]!.id,
    });
    expect(again.json()).toEqual({ error: "host_not_found" });
  });

  it("waits while the old runner still runs there, saying so, and takes over once it is removed", async () => {
    // The test's clock stands still: what the host reports tells who reported last.
    const reportedByTheOldRunner = (await host()).health?.kernel;
    await switchIt();
    const waiting = await until(host, (view) => view.ssh?.reason === SSH_TEXT.runnerStillThere);
    // Nothing heals there twice: Autoheal's own runner for it has not reported while the old one runs.
    expect(waiting.health?.kernel).toBe(reportedByTheOldRunner);

    setup.engine.remove("autoheal");
    setup.controlPlane.services.embeddedRunners.tick();
    const took = await until(host, (view) => view.health?.kernel !== reportedByTheOldRunner);
    expect(took.ssh?.reason).toBeNull();
  });
});
