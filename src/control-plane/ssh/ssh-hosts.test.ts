import { utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSshServer } from "../../../test/fakes/fake-ssh-server.js";
import {
  TEST_BACKUP_PASSPHRASE,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, type AssignableView } from "../../shared/api.js";
import { DEFAULT_SSH_HOST_SETTINGS } from "../../shared/ssh-hosts.js";
import type { Actor } from "../audit/audit-log.js";
import { hosts, sshKeys } from "../database/schema.js";
import { SecretBox } from "../database/secret-box.js";
import { sshFingerprint } from "./ssh-session.js";

const USER = "alex";
const PASSPHRASE = "the user's own passphrase";

function readable(make: () => { private: string; public: string }, passphrase?: string) {
  for (;;) {
    const pair = make();
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
  }
}

describe("SSH keys and SSH hosts", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let actor: Actor;
  let server: FakeSshServer;
  // The user's own key, with a passphrase, which the host accepts.
  const own = readable(
    () => utils.generateKeyPairSync("rsa", { bits: 2048, passphrase: PASSPHRASE, cipher: "aes256-cbc" }),
    PASSPHRASE,
  );

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
    actor = { userId: adminId, username: "admin", ip: "127.0.0.1", requestId: "test" };
    server = await FakeSshServer.start(USER, [own.public]);
  });

  afterEach(async () => {
    await server.stop();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const keys = () => controlPlane.services.sshKeysService;
  const sshHosts = () => controlPlane.services.sshHostsService;
  const request = (keyId: string, overrides = {}) => ({
    label: "cedar2",
    address: "127.0.0.1",
    port: server.port,
    user: USER,
    keyId,
    ...overrides,
  });
  // Everything a person or a reader of the database could see.
  const everything = async () =>
    JSON.stringify([
      keys().list(),
      (await admin.get(API_ROUTES.audit)).json(),
      (await admin.get(API_ROUTES.hosts)).json(),
      controlPlane.services.databaseHandle.database.select().from(sshKeys).all(),
      controlPlane.services.databaseHandle.database.select().from(hosts).all(),
    ]);

  it("keeps the user's key and one it made sealed, shows which key each is, and never gives them back", async () => {
    const added = keys().add(actor, "alex's laptop", own.private, PASSPHRASE);
    expect(added).toMatchObject({
      name: "alex's laptop",
      fingerprint: sshFingerprint(Buffer.from(own.public.split(" ")[1]!, "base64")),
      madeByAutoheal: false,
      createdBy: "admin",
      hosts: [],
    });
    const made = keys().make(actor, "made for cedar2");
    expect(made.key).toMatchObject({ madeByAutoheal: true });
    expect(made.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(() => keys().add(actor, "alex's laptop", own.private, PASSPHRASE)).toThrow("ssh_key_name_taken");
    expect(() => keys().add(actor, "wrong", own.private, "not it")).toThrow("ssh_key_unreadable");

    const seen = await everything();
    const ownBody = own.private.split("\n")[1]!;
    const madeBody = made.privateKey.split("\n")[1]!;
    for (const secret of [ownBody, madeBody, PASSPHRASE]) expect(seen).not.toContain(secret);
    expect(seen).toContain("ssh_key.added");
    expect(seen).toContain("ssh_key.made");
    // Sealed, they still open as given.
    expect(keys().opened(added.id)).toEqual({ privateKey: own.private, passphrase: PASSPHRASE });
  });

  it("adds a host only once its key opens it and a person has trusted its host key", async () => {
    const key = keys().add(actor, "own", own.private, PASSPHRASE);
    const stranger = keys().make(actor, "not on the host");
    await expect(sshHosts().add(actor, request(stranger.key.id))).rejects.toThrow("ssh_host_refused_key");
    await expect(sshHosts().add(actor, request(key.id, { port: 1 }))).rejects.toThrow("ssh_host_unreachable");

    const pending = await sshHosts().add(actor, request(key.id));
    expect(pending.hostKeyFingerprint).toBe(sshFingerprint(Buffer.from(server.hostKeyBlob(), "base64")));
    // Nothing is stored before the person confirms, and only they can.
    expect((await admin.get(API_ROUTES.hosts)).json()).toEqual([]);
    expect(() => sshHosts().confirm({ ...actor, userId: "someone else" }, pending.pendingId)).toThrow(
      "ssh_pending_not_found",
    );

    const host = sshHosts().confirm(actor, pending.pendingId);
    expect(host.label).toBe("cedar2");
    expect(() => sshHosts().confirm(actor, pending.pendingId)).toThrow("ssh_pending_not_found");
    await expect(sshHosts().add(actor, request(key.id))).rejects.toThrow("host_label_taken");
    const row = controlPlane.services.databaseHandle.database.select().from(hosts).all()[0]!;
    expect(row).toMatchObject({
      kind: "ssh",
      sshAddress: "127.0.0.1",
      sshUser: USER,
      sshKeyId: key.id,
      sshHostKey: server.hostKeyBlob(),
      sshHostKeyFingerprint: pending.hostKeyFingerprint,
    });
    // Its runner token is kept sealed for its embedded runner, and opens to the token whose hash is stored.
    const token = SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE).open(row.sshRunnerToken!)!;
    expect(token).toMatch(/^ahk_/);
    expect(await everything()).not.toContain(token);
    expect(sshHosts().targetOf(host.id)).toMatchObject({
      privateKey: own.private,
      passphrase: PASSPHRASE,
      pinnedHostKey: server.hostKeyBlob(),
    });
    expect(
      keys()
        .list()
        .find((each) => each.id === key.id)!.hosts,
    ).toEqual(["cedar2"]);
    expect(() => keys().remove(actor, key.id)).toThrow("ssh_key_in_use");

    // One left waiting past its time can no longer be confirmed.
    const late = await sshHosts().add(actor, request(key.id, { label: "late" }));
    controlPlane.clock.now = late.expiresAt;
    expect(() => sshHosts().confirm(actor, late.pendingId)).toThrow("ssh_pending_not_found");
  });

  it("refuses a changed host key until a person trusts exactly the new one, and replaces a key only once it opens the host", async () => {
    const key = keys().add(actor, "own", own.private, PASSPHRASE);
    const host = sshHosts().confirm(actor, (await sshHosts().add(actor, request(key.id))).pendingId);

    // Another key of the user's, which the host also accepts.
    const second = readable(() => utils.generateKeyPairSync("ed25519"));
    server.acceptedKeys.push(second.public);
    server.hostKey = FakeSshServer.newHostKey();
    await server.restart();
    const replacement = keys().add(actor, "second", second.private, null);

    // The host now offers another host key: nothing changes until a person trusts it.
    await expect(sshHosts().replaceKey(actor, host.id, replacement.id)).rejects.toThrow("ssh_host_key_mismatch");
    const offered = sshFingerprint(Buffer.from(server.hostKeyBlob(), "base64"));
    await expect(sshHosts().trustHostKey(actor, host.id, "SHA256:not what it offers")).rejects.toThrow(
      "ssh_host_key_mismatch",
    );
    await sshHosts().trustHostKey(actor, host.id, offered);

    const refused = keys().make(actor, "not on the host");
    await expect(sshHosts().replaceKey(actor, host.id, refused.key.id)).rejects.toThrow("ssh_host_refused_key");
    expect(sshHosts().targetOf(host.id).privateKey).toBe(own.private);
    await sshHosts().replaceKey(actor, host.id, replacement.id);
    expect(sshHosts().targetOf(host.id)).toMatchObject({
      privateKey: second.private,
      pinnedHostKey: server.hostKeyBlob(),
    });
    keys().remove(actor, key.id);
    expect(
      keys()
        .list()
        .map((each) => each.name),
    ).toEqual(["not on the host", "second"]);
    const audit = JSON.stringify((await admin.get(API_ROUTES.audit)).json());
    for (const action of ["host.ssh_added", "host.ssh_host_key_trusted", "host.ssh_key_replaced", "ssh_key.removed"]) {
      expect(audit).toContain(action);
    }
  });

  it("keeps an SSH host's settings, as a runner's .env would give them, and refuses what a runner would", async () => {
    const key = keys().add(actor, "own", own.private, PASSPHRASE);
    const host = sshHosts().confirm(actor, (await sshHosts().add(actor, request(key.id))).pendingId);
    expect(sshHosts().settingsOf(host.id)).toEqual(DEFAULT_SSH_HOST_SETTINGS);
    const settings = {
      ...DEFAULT_SSH_HOST_SETTINGS,
      dryRun: false,
      hostPackages: "check" as const,
      protectedContainers: ["npm"],
    };
    expect(sshHosts().updateSettings(actor, host.id, settings)).toEqual(settings);
    expect(sshHosts().settingsOf(host.id)).toEqual(settings);
    expect(() => sshHosts().updateSettings(actor, host.id, { ...settings, hostPackages: "always" as never })).toThrow();
    expect(() => sshHosts().settingsOf("not a host")).toThrow("ssh_host_not_found");
  });
});
