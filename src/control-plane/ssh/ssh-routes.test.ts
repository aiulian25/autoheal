import { utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSshServer } from "../../../test/fakes/fake-ssh-server.js";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type MadeSshKeyView,
  type PendingSshHostView,
  type SshHostDetailsView,
  type SshKeyView,
} from "../../shared/api.js";
import { HOST_KIND, SSH_READINESS } from "../../shared/constants.js";
import { DEFAULT_SSH_HOST_SETTINGS } from "../../shared/ssh-hosts.js";

const USER = "alex";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("the SSH keys and SSH hosts API", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let server: FakeSshServer;
  const key = FakeSshServer.newHostKey();

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    server = await FakeSshServer.start(USER, [key]);
  });

  afterEach(async () => {
    await server.stop();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const addHost = (keyId: string, client = admin) =>
    client.post(API_ROUTES.sshHosts, { label: "mini", address: "127.0.0.1", port: server.port, user: USER, keyId });

  it("adds a key, a host with it whether Docker is there or not, and then manages that host", async () => {
    const added = await admin.post(API_ROUTES.sshKeys, { name: "laptop", privateKey: key, passphrase: "" });
    expect(added.statusCode, added.body).toBe(200);
    const { id: keyId } = added.json<SshKeyView>();

    // Docker is there but this user may not use it: said, and the host can be added all the same.
    server.readiness = `${SSH_READINESS.socketMark}\n`;
    expect((await addHost(keyId)).json<PendingSshHostView>().docker).toEqual({ socket: true, usable: false });
    // No Docker at all, as on cedar2: added, its system watched alone.
    server.readiness = "";
    const ready = (await addHost(keyId)).json<PendingSshHostView>();
    expect(ready.docker).toEqual({ socket: false, usable: false });
    expect(ready).toMatchObject({ label: "mini", hostKeyFingerprint: expect.stringMatching(/^SHA256:/) });
    const confirmed = await admin.post(apiPath(API_ROUTES.sshHostConfirm, { pendingId: ready.pendingId }));
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const host = confirmed.json<HostView>();
    expect(host).toMatchObject({ label: "mini", kind: HOST_KIND.ssh });

    const details = (await admin.get(apiPath(API_ROUTES.sshHost, { hostId: host.id }))).json<SshHostDetailsView>();
    expect(details).toEqual({
      address: "127.0.0.1",
      port: server.port,
      user: USER,
      keyId,
      keyName: "laptop",
      hostKeyFingerprint: ready.hostKeyFingerprint,
      offeredHostKeyFingerprint: null,
      settings: DEFAULT_SSH_HOST_SETTINGS,
      rootMethod: null,
    });
    // Its root password is checked on the host, over the session the control plane holds: none here.
    const unconnected = await admin.put(apiPath(API_ROUTES.sshHostRoot, { hostId: host.id }), { password: "pw" });
    expect(unconnected.json()).toEqual({ error: "ssh_host_not_connected" });
    const settings = { ...DEFAULT_SSH_HOST_SETTINGS, dryRun: false, protectedContainers: ["postgres"] };
    expect((await admin.put(apiPath(API_ROUTES.sshHostSettings, { hostId: host.id }), settings)).json()).toEqual(
      settings,
    );
    expect(
      (await admin.put(apiPath(API_ROUTES.sshHostSettings, { hostId: host.id }), { ...settings, extra: 1 })).statusCode,
    ).toBe(400);

    // Another key, made here with a passphrase: its private half comes back once, encrypted with it, and the host
    // takes it only once it opens the host, signed in with the passphrase kept sealed.
    const made = (
      await admin.post(API_ROUTES.sshKeysMake, { name: "made for mini", passphrase: "made's own passphrase" })
    ).json<MadeSshKeyView>();
    expect(made.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(utils.parseKey(made.privateKey)).toBeInstanceOf(Error);
    expect(utils.parseKey(made.privateKey, "made's own passphrase")).not.toBeInstanceOf(Error);
    const refused = await admin.put(apiPath(API_ROUTES.sshHostKey, { hostId: host.id }), { keyId: made.key.id });
    expect(refused.json()).toEqual({ error: "ssh_host_refused_key" });
    server.acceptedKeys.push(made.key.publicLine);
    const replaced = await admin.put(apiPath(API_ROUTES.sshHostKey, { hostId: host.id }), { keyId: made.key.id });
    expect(replaced.statusCode, replaced.body).toBe(200);

    // The first key is free now and may go; the one in use may not.
    expect((await admin.delete(apiPath(API_ROUTES.sshKey, { keyId: made.key.id }))).json()).toEqual({
      error: "ssh_key_in_use",
    });
    expect((await admin.delete(apiPath(API_ROUTES.sshKey, { keyId }))).statusCode).toBe(204);
    const listed = (await admin.get(API_ROUTES.sshKeys)).json<SshKeyView[]>();
    expect(listed.map(({ name, hosts }) => ({ name, hosts }))).toEqual([{ name: "made for mini", hosts: ["mini"] }]);
    expect(JSON.stringify(listed)).not.toContain("PRIVATE KEY");

    // A host key that changed is trusted only by the fingerprint the host offers.
    server.hostKey = FakeSshServer.newHostKey();
    await server.restart();
    const wrong = await admin.post(apiPath(API_ROUTES.sshHostTrustHostKey, { hostId: host.id }), {
      fingerprint: ready.hostKeyFingerprint,
    });
    expect(wrong.json()).toEqual({ error: "ssh_host_key_mismatch" });
  });

  it("refuses what is not a host or a key before dialling anything", async () => {
    const { id: keyId } = (
      await admin.post(API_ROUTES.sshKeys, { name: "laptop", privateKey: key })
    ).json<SshKeyView>();
    const bad = [
      { label: "mini", address: "127.0.0.1; reboot", port: 22, user: USER, keyId },
      { label: "mini", address: "127.0.0.1", port: 70_000, user: USER, keyId },
      { label: "mini", address: "127.0.0.1", port: 22, user: "alex root", keyId },
      { label: "not a label!", address: "127.0.0.1", port: 22, user: USER, keyId },
    ];
    for (const body of bad) {
      expect((await admin.post(API_ROUTES.sshHosts, body)).statusCode).toBe(400);
    }
    expect((await admin.post(API_ROUTES.sshKeys, { name: "", privateKey: key })).statusCode).toBe(400);
    expect((await admin.post(API_ROUTES.sshKeys, { name: "public", privateKey: "ssh-ed25519 AAAA" })).json()).toEqual({
      error: "ssh_key_unreadable",
    });
    expect(server.commands).toEqual([]);
  });

  it("gives a viewer none of it", async () => {
    const viewer = (await fullySignedInUser(controlPlane, admin, "partner", "viewer")).client;
    const hostId = UNKNOWN_ID;
    const calls = [
      () => viewer.get(API_ROUTES.sshKeys),
      () => viewer.post(API_ROUTES.sshKeys, { name: "laptop", privateKey: key }),
      () => viewer.post(API_ROUTES.sshKeysMake, { name: "made" }),
      () => viewer.delete(apiPath(API_ROUTES.sshKey, { keyId: UNKNOWN_ID })),
      () => addHost(UNKNOWN_ID, viewer),
      () => viewer.post(apiPath(API_ROUTES.sshHostConfirm, { pendingId: UNKNOWN_ID })),
      () => viewer.get(apiPath(API_ROUTES.sshHost, { hostId })),
      () => viewer.post(apiPath(API_ROUTES.sshHostTrustHostKey, { hostId }), { fingerprint: "SHA256:x" }),
      () => viewer.put(apiPath(API_ROUTES.sshHostKey, { hostId }), { keyId: UNKNOWN_ID }),
      () => viewer.put(apiPath(API_ROUTES.sshHostSettings, { hostId }), DEFAULT_SSH_HOST_SETTINGS),
      () => viewer.put(apiPath(API_ROUTES.sshHostRoot, { hostId }), { password: "pw" }),
      () => viewer.delete(apiPath(API_ROUTES.sshHostRoot, { hostId })),
    ];
    expect(calls).toHaveLength(12);
    for (const call of calls) {
      expect((await call()).statusCode).toBe(403);
    }
    expect(server.commands).toEqual([]);
  });
});
