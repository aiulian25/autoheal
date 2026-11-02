import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerClient } from "./docker-client.js";

// Explicitly opted-in: this fixture uses only a previously built validation image and a disposable labeled volume.
describe.runIf(process.env.AUTOHEAL_ISOLATED_DOCKER === "1")("application backup transport on isolated Docker", () => {
  const docker = new DockerClient("/var/run/docker.sock");
  let id: string;
  let volume: string;
  let temporaryDirectory: string;
  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "autoheal-backup-transport-"));
    volume = `autoheal-backup-transport-volume-${randomUUID()}`;
    await docker.createVolume(volume, { "autoheal.test": "backup-transport" });
    id = await docker.create(`autoheal-backup-transport-test-${randomUUID()}`, {
      Image: "autoheal:fix023-validation-20261027",
      Entrypoint: ["/nodejs/bin/node"],
      User: "0:0",
      Cmd: ["-e", "setInterval(()=>{},1000)"],
      Labels: { "autoheal.test": "backup-transport" },
      HostConfig: {
        AutoRemove: true,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Memory: 128 * 1024 ** 2,
        PidsLimit: 64,
        Mounts: [{ Type: "volume", Source: volume, Target: "/scratch" }],
      },
    });
    await docker.start(id);
  });
  afterEach(async () => {
    try {
      if (id) await docker.remove(id);
    } finally {
      try {
        if (volume) await docker.removeVolume(volume);
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  it("passes binary private input only through stdin, signals EOF, and separates non-TTY output", async () => {
    const privateValue = `fixture-private-${randomUUID()}`;
    const input = Buffer.concat([
      Buffer.from(privateValue),
      Buffer.from(Array.from({ length: 131_073 }, (_, i) => i % 256)),
    ]);
    const result = await docker.runInputCommand(
      id,
      [
        "/nodejs/bin/node",
        "-e",
        String.raw`
      const chunks=[];
      process.stdin.on('data',chunk=>chunks.push(chunk));
      process.stdin.on('end',()=>{
        const input=Buffer.concat(chunks);
        const marker=input.subarray(0,input.indexOf(0)).toString();
        if(JSON.stringify({args:process.argv,env:process.env}).includes(marker)){process.exitCode=9;return;}
        process.stdout.write(JSON.stringify({bytes:input.length,hash:require('node:crypto').createHash('sha256').update(input).digest('hex')})+'\n');
        process.stderr.write('fixture stderr is separate\n');
      });
    `,
      ],
      input,
      4096,
    );
    expect(result).toMatchObject({ exitCode: 0, stderr: "fixture stderr is separate\n", truncated: false });
    expect(JSON.parse(result.stdout)).toEqual({
      bytes: input.length,
      hash: createHash("sha256").update(input).digest("hex"),
    });
    const inspected = await docker.inspect(id);
    expect(JSON.stringify(inspected)).not.toContain(privateValue);
  }, 15_000);

  it("streams an archive round trip without altering ciphertext bytes", async () => {
    const create = await docker.runCommand(
      id,
      [
        "/nodejs/bin/node",
        "-e",
        `
      const fs=require('node:fs');fs.mkdirSync('/scratch/source');fs.mkdirSync('/scratch/destination');
      const bytes=Buffer.alloc(8*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
      fs.writeFileSync('/scratch/source/ciphertext.age',bytes,{mode:0o600});
      process.stdout.write(require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
    `,
      ],
      4096,
    );
    expect(create.exitCode, create.stderr).toBe(0);
    const archive = await docker.getArchiveStream(id, "/scratch/source/ciphertext.age");
    // Docker locks its filesystem during GET archive; production also stores the upload before restore.
    const file = join(temporaryDirectory, "ciphertext.tar");
    await pipeline(archive, createWriteStream(file, { mode: 0o600 }));
    expect(archive.readableEnded).toBe(true);
    await docker.putArchiveStream(id, "/scratch/destination", createReadStream(file));
    const restored = await docker.runCommand(
      id,
      [
        "/nodejs/bin/node",
        "-e",
        `
      const fs=require('node:fs');const bytes=fs.readFileSync('/scratch/destination/ciphertext.age');
      process.stdout.write(JSON.stringify({length:bytes.length,hash:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),mode:fs.statSync('/scratch/destination/ciphertext.age').mode&0o777}));
    `,
      ],
      4096,
    );
    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout)).toEqual({ length: 8 * 1024 ** 2, hash: create.stdout, mode: 0o600 });
  }, 15_000);

  it("disables and restores the daemon restart policy on a disposable container", async () => {
    const name = `autoheal-backup-restart-policy-test-${randomUUID()}`;
    const reference = await docker.create(name, {
      Image: "autoheal:fix023-validation-20261027",
      Entrypoint: ["/nodejs/bin/node"],
      Cmd: ["-e", "setInterval(()=>{},1000)"],
      Labels: { "autoheal.test": "backup-transport" },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Memory: 128 * 1024 ** 2,
        PidsLimit: 64,
      },
    });
    try {
      await docker.start(reference);
      for (const policy of [
        { Name: "always", MaximumRetryCount: 0 },
        { Name: "no", MaximumRetryCount: 0 },
        { Name: "on-failure", MaximumRetryCount: 3 },
        { Name: "no", MaximumRetryCount: 0 },
      ]) {
        await docker.setRestartPolicy(reference, policy);
        expect((await docker.inspect(reference))?.HostConfig?.RestartPolicy).toMatchObject(policy);
      }
      expect((await docker.inspect(reference))?.State.Running).toBe(true);
    } finally {
      await docker.remove(reference);
    }
  }, 15_000);

  it("rejects refused/malformed archives and closes failed input streams", async () => {
    await expect(docker.getArchiveStream(id, "/scratch/missing")).rejects.toThrow();
    const malformed = Readable.from([Buffer.from("not a tar archive")]);
    await expect(docker.putArchiveStream(id, "/scratch", malformed)).rejects.toThrow();
    expect(malformed.destroyed).toBe(true);
    const broken = new Readable({
      read() {
        this.destroy(new Error("fixture source stream failed"));
      },
    });
    await expect(docker.putArchiveStream(id, "/scratch", broken)).rejects.toThrow();
    expect(broken.destroyed).toBe(true);
    const oversize = Buffer.alloc(1024 ** 2 + 1);
    await expect(
      docker.runInputCommand(id, ["/nodejs/bin/node", "-e", "process.exit(9)"], oversize, 4096),
    ).rejects.toThrow("fixed limit");
  }, 15_000);
});
