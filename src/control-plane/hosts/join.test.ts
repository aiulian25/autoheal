import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type AssignableView,
  type EnrolledHostView,
  type HostView,
  type SettingsView,
} from "../../shared/api.js";
import { DEFAULT_AUTOHEAL_IMAGE, RUNNER_COMPOSE, SECRET_FILE_MODE, SETTING_KEYS } from "../../shared/constants.js";
import { decodeJoinCode, encodeJoinCode } from "../../shared/join-code.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { auditEvents } from "../database/schema.js";
import { HostsService } from "./hosts-service.js";

const FILE_MODE_BITS = 0o777;
const LOCAL_URL = "https://control-plane:9443";
const HOST_ROOT_MOUNT = "/:/host/root:ro";

describe("joining runners", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let directory: string;

  const heartbeat = (token: string, hostLabel?: string) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ hostLabel }),
      headers: { authorization: `Bearer ${token}` },
    });
  const labels = async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>().map((host) => host.label);

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    directory = mkdtempSync(join(tmpdir(), "autoheal-join-"));
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("gives a new host one paste: its compose file and a join code with the address, token and key", async () => {
    expect((await admin.get(API_ROUTES.settings)).json<SettingsView>().runnerAddress).toBe("https://localhost:9443");
    const enrolled = (
      await admin.post(API_ROUTES.hosts, { label: "Alder", address: "https://192.168.10.83:9443" })
    ).json<EnrolledHostView>();
    const details = decodeJoinCode(enrolled.joinCode)!;
    expect(details.url).toBe("https://192.168.10.83:9443");
    expect(details.pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(enrolled.installCommand).toContain(RUNNER_COMPOSE(DEFAULT_AUTOHEAL_IMAGE).trimEnd());
    expect(enrolled.installCommand).toContain(`AUTOHEAL_JOIN=${enrolled.joinCode}\nDOCKER_GID=$(stat -c %g`);
    expect((await heartbeat(details.token)).statusCode).toBe(200);
    // The next host is offered the same address.
    expect((await admin.get(API_ROUTES.settings)).json<SettingsView>().runnerAddress).toBe(
      "https://192.168.10.83:9443",
    );
  });

  it("gives a revoked host's name back, however it ended, and shows which it was", async () => {
    const first = (await admin.post(API_ROUTES.hosts, { label: "DS923" })).json<EnrolledHostView>();
    expect((await admin.post(API_ROUTES.hosts, { label: "DS923" })).statusCode).toBe(409);
    expect((await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: first.host.id }))).statusCode).toBe(200);

    const second = await admin.post(API_ROUTES.hosts, { label: "DS923" });
    expect(second.statusCode, second.body).toBe(200);
    const all = (await admin.get(API_ROUTES.hosts)).json<HostView[]>();
    const gone = all.find(({ id }) => id === first.host.id);
    expect(gone?.label ?? "").not.toBe("DS923");
    expect(all.filter(({ label }) => label === "DS923").map(({ id }) => id)).toEqual([
      second.json<EnrolledHostView>().host.id,
    ]);
    // Revoked twice, it is not marked twice.
    await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: first.host.id }));
    const again = (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find(({ id }) => id === first.host.id);
    expect(again?.label ?? "").toBe(gone?.label ?? "");
  });

  it("gives a NAS a runner without the host's own files, under sudo, in the folder asked for", async () => {
    const full = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    const nas = (
      await admin.post(API_ROUTES.hosts, { label: "Synology", nasFolder: "/volume1/docker/autoheal" })
    ).json<EnrolledHostView>();
    expect(full.installCommand).toContain(HOST_ROOT_MOUNT);
    expect(full.installCommand).not.toContain("sudo");
    expect(nas.installCommand).toContain(RUNNER_COMPOSE(DEFAULT_AUTOHEAL_IMAGE, false).trimEnd());
    expect(nas.installCommand).not.toContain(HOST_ROOT_MOUNT);
    expect(nas.installCommand.startsWith("sudo sh")).toBe(true);
    expect(nas.installCommand).toContain("mkdir -p /volume1/docker/autoheal &&");
    expect(nas.installCommand).toContain(`AUTOHEAL_JOIN=${nas.joinCode}`);
    expect(full.imageCopyCommand).toBeNull();
    // This image is in a registry, so there is nothing to copy.
    expect(nas.imageCopyCommand).toBeNull();
  });

  it.each(["relative/path", "/volume1/../etc", "/volume1/docker/$(reboot)", "/volume1/my folder", "/a;b"])(
    "refuses %s as a NAS folder, as it goes into a script",
    async (nasFolder) => {
      expect((await admin.post(API_ROUTES.hosts, { label: "Synology", nasFolder })).statusCode).toBe(400);
    },
  );

  it("offers the dashboard's new name once it moved, not the address used before it did", async () => {
    await admin.post(API_ROUTES.hosts, { label: "Alder", address: "https://192.168.10.83:9443" });
    const { databaseHandle, auditLog, settingsStore } = controlPlane.services;
    const join = { pin: "pin", image: DEFAULT_AUTOHEAL_IMAGE };
    const moved = new HostsService(databaseHandle, auditLog, settingsStore, {
      ...join,
      publicBaseUrl: "https://autoheal.example.org",
    });
    expect(moved.runnerAddress()).toBe("https://autoheal.example.org:9443");

    // One stored before addresses carried their dashboard's is from an unknown one.
    settingsStore.write(SETTING_KEYS.runnerAddress, "https://192.168.10.83:9443");
    expect(moved.runnerAddress()).toBe("https://autoheal.example.org:9443");
  });

  it("ships the same runner compose file the dashboard hands out", () => {
    expect(readFileSync("docker-compose.runner.yml", "utf8")).toBe(RUNNER_COMPOSE(DEFAULT_AUTOHEAL_IMAGE));
  });

  it("names a host added without a name after its runner, once, and never twice the same", async () => {
    const first = (await admin.post(API_ROUTES.hosts, {})).json<EnrolledHostView>();
    const second = (await admin.post(API_ROUTES.hosts, {})).json<EnrolledHostView>();
    expect(first.host.label).toMatch(/^new-host-[0-9a-f]{6}$/);
    await heartbeat(decodeJoinCode(first.joinCode)!.token, "Rowan");
    await heartbeat(decodeJoinCode(second.joinCode)!.token, "Rowan");
    expect((await labels()).sort()).toEqual(["Rowan", "Rowan-2"]);
    await heartbeat(decodeJoinCode(first.joinCode)!.token, "renamed");
    expect((await labels()).sort()).toEqual(["Rowan", "Rowan-2"]);
  });

  it("renames a host as an admin asks, by the rules of adding one: unique, audited, and never by its runner", async () => {
    const alder = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    const pending = (await admin.post(API_ROUTES.hosts, {})).json<EnrolledHostView>();
    const rename = (hostId: string, label: string, client = admin) =>
      client.patch(apiPath(API_ROUTES.host, { hostId }), { label });

    const renamed = await rename(alder.host.id, "Alder-NAS");
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<HostView>().label).toBe("Alder-NAS");
    // One added without a name keeps the name given before its runner first reports.
    expect((await rename(pending.host.id, "Rowan")).statusCode).toBe(200);
    await heartbeat(decodeJoinCode(pending.joinCode)!.token, "delta3640");
    expect((await labels()).sort()).toEqual(["Alder-NAS", "Rowan"]);

    expect((await rename(alder.host.id, "Rowan")).json()).toEqual({ error: "host_label_taken" });
    expect((await rename(alder.host.id, "two words")).statusCode).toBe(400);
    expect((await rename(randomUUID(), "Elsewhere")).statusCode).toBe(404);
    const viewer = (await fullySignedInUser(controlPlane, admin, "partner", "viewer")).client;
    expect((await rename(alder.host.id, "Mine", viewer)).statusCode).toBe(403);
    expect((await labels()).sort()).toEqual(["Alder-NAS", "Rowan"]);

    const audited = controlPlane.services.databaseHandle.database
      .select()
      .from(auditEvents)
      .all()
      .filter((event) => event.action === "host.renamed")
      .map((event) => JSON.parse(event.detailsJson) as unknown);
    expect(audited).toEqual([
      { from: "Alder", to: "Alder-NAS" },
      { from: pending.host.label, to: "Rowan" },
    ]);
  });

  it("joins this machine's own runner by itself, keeps it, and does not bring back a revoked one", async () => {
    const hosts = controlPlane.services.hostsService;
    hosts.ensureLocalRunner(join(directory, "not-mounted"));
    expect(await labels()).toEqual([]);

    hosts.ensureLocalRunner(directory);
    const file = join(directory, "runner.join");
    const written = readFileSync(file, "utf8");
    const details = decodeJoinCode(written)!;
    expect(details.url).toBe(LOCAL_URL);
    expect(statSync(file).mode & FILE_MODE_BITS).toBe(SECRET_FILE_MODE);
    expect((await heartbeat(details.token, "Rowan")).statusCode).toBe(200);
    expect(await labels()).toEqual(["Rowan"]);

    hosts.ensureLocalRunner(directory);
    expect(readFileSync(file, "utf8")).toBe(written);

    const [host] = (await admin.get(API_ROUTES.hosts)).json<HostView[]>();
    await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: host!.id }));
    hosts.ensureLocalRunner(directory);
    expect(readFileSync(file, "utf8")).toBe(written);
  });

  it("gives this machine's runner a new code when the database no longer knows the old one", async () => {
    const stale = { url: LOCAL_URL, token: `ahk_${"Z".repeat(43)}`, pin: "Q".repeat(43) };
    const file = join(directory, "runner.join");
    writeFileSync(file, encodeJoinCode(stale));
    controlPlane.services.hostsService.ensureLocalRunner(directory);
    const fresh = decodeJoinCode(readFileSync(file, "utf8"))!;
    expect(fresh.token).not.toBe(stale.token);
    expect((await heartbeat(fresh.token)).statusCode).toBe(200);
  });

  it("adds this machine's revoked runner again as the same host, with a new token its runner reads", async () => {
    const hosts = controlPlane.services.hostsService;
    const adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
    const actor = { userId: adminId, username: "admin", ip: "127.0.0.1", requestId: "test" };
    hosts.ensureLocalRunner(directory);
    const file = join(directory, "runner.join");
    const before = decodeJoinCode(readFileSync(file, "utf8"))!;
    expect((await heartbeat(before.token, "Rowan")).statusCode).toBe(200);
    const [host] = (await admin.get(API_ROUTES.hosts)).json<HostView[]>();
    expect(hosts.localHost(directory)).toEqual({ hostId: host!.id, revoked: false });
    expect(() => hosts.reenrollLocalRunner(actor, directory)).toThrow("not_local_runner");

    await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: host!.id }));
    expect(hosts.localHost(directory)).toEqual({ hostId: host!.id, revoked: true });
    expect((await heartbeat(before.token)).statusCode).toBe(401);

    expect(hosts.reenrollLocalRunner(actor, directory)).toMatchObject({ id: host!.id, label: "Rowan" });
    // Should another have taken the name meanwhile, it stays marked rather than take it from them.
    expect(hosts.labelWhenBack({ id: host!.id, label: `Rowan-revoked-${host!.id.slice(0, 8)}` })).toBe(
      `Rowan-revoked-${host!.id.slice(0, 8)}`,
    );
    const after = decodeJoinCode(readFileSync(file, "utf8"))!;
    expect(after.token).not.toBe(before.token);
    expect(after).toEqual({ ...before, token: after.token });
    expect(statSync(file).mode & FILE_MODE_BITS).toBe(SECRET_FILE_MODE);
    expect((await heartbeat(before.token)).statusCode).toBe(401);
    expect((await heartbeat(after.token)).statusCode).toBe(200);
    expect(hosts.localHost(directory)).toEqual({ hostId: host!.id, revoked: false });
    const audited = controlPlane.services.databaseHandle.database
      .select()
      .from(auditEvents)
      .all()
      .find((event) => event.action === "host.reenrolled");
    expect(audited).toMatchObject({ actorLabel: "admin", targetKind: "host", targetId: host!.id });
  });

  it("says there is no runner of this machine to add again where none joined through the volume, and lets only an admin try", async () => {
    expect((await admin.get(API_ROUTES.localHost)).json()).toEqual({ hostId: null, revoked: false });
    const refused = await admin.post(API_ROUTES.localHostReenroll);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "not_local_runner" });
    const viewer = (await fullySignedInUser(controlPlane, admin, "partner", "viewer")).client;
    expect((await viewer.get(API_ROUTES.localHost)).statusCode).toBe(200);
    expect((await viewer.post(API_ROUTES.localHostReenroll)).statusCode).toBe(403);
  });
});
