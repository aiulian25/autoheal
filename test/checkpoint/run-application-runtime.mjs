// Real Docker orchestration against uniquely named disposable containers/volumes. No production target is mutated.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { DockerClient } from "../../dist/server/runner/docker-client.js";
import { ApplicationBackups } from "../../dist/server/runner/application-backups.js";
import { RemedyGuard } from "../../dist/server/runner/remedy-guard.js";
import { HOST_HELPER } from "../../dist/server/shared/constants.js";
const image = process.argv[2];
if (!image) throw Error("Usage: node test/checkpoint/run-application-runtime.mjs <isolated-image>");
const docker = new DockerClient("/var/run/docker.sock"),
  prefix = `autoheal-app-proof-${randomUUID()}`;
const self = `${prefix}-runner`,
  a = `${prefix}-a`,
  b = `${prefix}-b`,
  c = `${prefix}-stopped`,
  one = `${prefix}-one`,
  two = `${prefix}-two`;
const containers = [],
  volumes = [one, two];
const mount = (source, target) => ({ Type: "volume", Source: source, Target: target, VolumeOptions: { NoCopy: true } });
async function create(name, config) {
  await docker.create(name, {
    Image: image,
    User: "0",
    NetworkDisabled: true,
    Healthcheck: { Test: ["NONE"] },
    ...config,
  });
  containers.push(name);
}
const identity = await generateX25519Identity(),
  recipient = await identityToRecipient(identity),
  artifactId = randomUUID(),
  results = [],
  artifacts = new Map();
const client = {
  authorizeApplicationBackup: async () => true,
  uploadApplicationBackup: async (_id, artifact, stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    artifacts.set(artifact, Buffer.concat(chunks));
  },
  downloadApplicationBackup: async (_id, artifact) => Readable.from([artifacts.get(artifact)]),
  reportApplicationBackup: async (result) => {
    results.push(result);
  },
};
try {
  assert.equal(
    (await docker.volumes("autoheal.application-backup.journal")).length,
    0,
    "Use an engine without existing application recovery records for this isolated fixture.",
  );
  for (const volume of volumes) await docker.createVolume(volume, { "autoheal.fixture": prefix });
  await create(self, { Cmd: ["application-copy", "wait"], Labels: { [HOST_HELPER.label]: HOST_HELPER.labelValue } });
  await docker.start(self);
  const seed = `require('node:fs').writeFileSync('/one/original','original fixture');require('node:fs').writeFileSync('/two/secondary','second fixture');`;
  const writer = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync('/data/flushed-${prefix}','clean shutdown');process.exit(0)});setInterval(()=>{},1000);`;
  const seedName = `${prefix}-seed`;
  await create(seedName, {
    Entrypoint: ["/nodejs/bin/node"],
    Cmd: ["-e", seed],
    HostConfig: { Mounts: [mount(one, "/one"), mount(two, "/two")], NetworkMode: "none" },
  });
  await docker.start(seedName);
  for (let i = 0; i < 100 && (await docker.inspect(seedName))?.State.Running; i++)
    await new Promise((r) => setTimeout(r, 20));
  await docker.removeStopped(seedName);
  for (const [name, mounts] of [
    [a, [mount(one, "/data")]],
    [b, [mount(one, "/data"), mount(two, "/second")]],
    [c, [mount(two, "/data")]],
  ])
    await create(name, {
      Entrypoint: ["/nodejs/bin/node"],
      Cmd: ["-e", writer],
      StopTimeout: 5,
      HostConfig: { Mounts: mounts, NetworkMode: "none", RestartPolicy: { Name: name === a ? "always" : "no" } },
    });
  await docker.start(a);
  await docker.start(b);
  await new Promise((r) => setTimeout(r, 300));
  const guard = new RemedyGuard(new Set([self]));
  const runtime = new ApplicationBackups({
    docker,
    guard,
    selfContainerName: self,
    protectedContainers: new Set([self]),
    dryRun: () => false,
    client,
  });
  await runtime.initialize();
  guard.externalRecoveryBlocked = (name, id) => runtime.isBlocked(name, id);
  const task = {
    id: randomUUID(),
    planId: randomUUID(),
    hostId: randomUUID(),
    operation: "capture",
    artifactId,
    recipient,
    definition: {
      version: 1,
      name: "Disposable shared fixture",
      containerName: a,
      consistency: "coordinated-clean-stop",
      exclusiveDockerWriters: true,
      sqlite: null,
      intervalHours: null,
      retain: 2,
    },
    expiresAt: Date.now() + 900000,
  };
  await runtime.run(task);
  assert.equal(results.at(-1)?.ok, true, JSON.stringify(results.at(-1)));
  assert.deepEqual(new Set(results.at(-1).writers), new Set([a, b, c]));
  assert.equal((await docker.inspect(a)).State.Running, true);
  assert.equal((await docker.inspect(b)).State.Running, true);
  assert.equal((await docker.inspect(c)).State.Running, false);
  assert.equal((await docker.inspect(a)).HostConfig.RestartPolicy.Name, "always");
  assert.equal((await docker.inspect(a)).State.OOMKilled, false);
  await runtime.run({ ...task, id: randomUUID(), operation: "drill", identity });
  assert.equal(results.at(-1)?.ok, true, JSON.stringify(results.at(-1)));
  assert.equal((await docker.inspect(a)).State.Running, true);
  assert.equal((await docker.inspect(c)).State.Running, false);
  console.log(
    JSON.stringify({
      cleanGroupCapture: true,
      transitiveWriters: 3,
      originallyStoppedPreserved: true,
      restartPolicyRestored: true,
      isolatedDrill: true,
      encryptedTransportBytes: artifacts.get(artifactId).length,
    }),
  );
} finally {
  for (const name of containers.reverse()) {
    const value = await docker.inspect(name).catch(() => null);
    if (!value) continue;
    await docker.stop(name, 5).catch(() => undefined);
    await docker.removeStopped(name).catch(() => undefined);
  }
  for (const volume of await docker.volumes("autoheal.application-backup.journal").catch(() => [])) {
    const record = JSON.parse(volume.Labels?.["autoheal.application-backup.record"] ?? "{}");
    if (record.members?.some((member) => member.name?.startsWith(prefix)))
      await docker.removeVolume(volume.Name).catch(() => undefined);
  }
  for (const volume of volumes) await docker.removeVolume(volume).catch(() => undefined);
}
