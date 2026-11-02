import { createServer, type Server } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownCertificate } from "../control-plane/tls/certificate.js";
import { APPLICATION_BACKUPS } from "../shared/application-backups.js";
import { HTTP_HEADERS, TAR } from "../shared/constants.js";
import { RUNNER_ROUTES } from "../shared/protocol.js";
import { ControlPlaneClient, ControlPlaneError, PinMismatchError } from "./control-plane-client.js";
import { singleEntryArchive } from "./tar.js";
const token = "ahk_synthetic_application_transport";
const taskId = "12345678-0000-4000-8000-000000000001",
  artifactId = "12345678-0000-4000-8000-000000000002";
const archive = () =>
  singleEntryArchive(
    { name: "payload.age", type: TAR.types.file, mode: 0o600, uid: 0, gid: 0 },
    Buffer.from("age-encryption.org/v1\nsynthetic encrypted fixture"),
  );
describe("pinned application backup transport", () => {
  let directory: string, server: Server;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-app-http-"));
  });
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function serve(handler: Parameters<typeof createServer>[1]) {
    const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
    server = createServer({ key: material.key, cert: material.certificate }, handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, material };
  }
  it("streams exact ciphertext with bound attempt/auth/capability and accepts only affirmative admission", async () => {
    const seen: { path: string; bytes: Buffer }[] = [];
    const data = archive();
    const { url, material } = await serve((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.headers[HTTP_HEADERS.runnerCapabilities]).toContain("application-backups");
      if (request.url!.includes("download")) {
        response.end(data);
        return;
      }
      void buffer(request).then((bytes) => {
        seen.push({ path: request.url!, bytes });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            request.url === RUNNER_ROUTES.applicationBackupWork
              ? { tasks: [] }
              : request.url!.includes("authorize")
                ? { allowed: true }
                : { ok: true },
          ),
        );
      });
    });
    const client = new ControlPlaneClient({ url, token, pin: material.pin });
    expect(await client.takeApplicationBackupWork()).toEqual([]);
    expect(await client.authorizeApplicationBackup(taskId, 3)).toBe(true);
    await client.uploadApplicationBackup(taskId, artifactId, Readable.from([data.subarray(0, 3), data.subarray(3)]), 3);
    expect(await buffer(await client.downloadApplicationBackup(taskId, artifactId, 3))).toEqual(data);
    const uploaded = seen.find((entry) => entry.path.endsWith("upload?attempt=3"));
    expect(uploaded?.bytes).toEqual(data);
    expect(JSON.parse(seen.find((entry) => entry.path.endsWith("authorize"))!.bytes.toString())).toEqual({
      attempt: 3,
    });
  });
  it("rejects wrong pins before sending credentials or payload and destroys the source", async () => {
    let requests = 0;
    const { url } = await serve((_request, response) => {
      requests++;
      response.end("{}");
    });
    const stranger = ownCertificate(join(directory, "other"), ["127.0.0.1"], Date.now()).material;
    const client = new ControlPlaneClient({ url, token, pin: stranger.pin });
    const source = Readable.from([archive()]);
    await expect(client.uploadApplicationBackup(taskId, artifactId, source)).rejects.toBeInstanceOf(PinMismatchError);
    expect(requests).toBe(0);
    expect(source.destroyed).toBe(true);
  });
  it("caps downloads and rejects plaintext before exposing a header to Docker", async () => {
    let plaintext = true;
    let closed = false;
    const { url, material } = await serve((_request, response) => {
      response.once("close", () => {
        closed = true;
      });
      Readable.from(
        plaintext ? [Buffer.alloc(1024, 120)] : [archive(), Buffer.alloc(APPLICATION_BACKUPS.payloadBytes)],
      ).pipe(response);
    });
    const client = new ControlPlaneClient({ url, token, pin: material.pin });
    let exposed = 0;
    const denied = await client.downloadApplicationBackup(taskId, artifactId);
    denied.on("data", (chunk) => {
      exposed += chunk.length;
    });
    await expect(buffer(denied)).rejects.toThrow();
    expect(exposed).toBe(0);
    expect(denied.destroyed).toBe(true);
    plaintext = false;
    await expect(buffer(await client.downloadApplicationBackup(taskId, artifactId))).rejects.toThrow("quota");
    expect(closed).toBe(true);
  });
  it("bounds uploads and destroys the producing stream on quota failure", async () => {
    let received = 0;
    const { url, material } = await serve((request, response) => {
      request.on("data", (chunk) => {
        received += chunk.length;
      });
      request.on("error", () => {});
      request.on("end", () => response.end('{"ok":true}'));
    });
    const client = new ControlPlaneClient({ url, token, pin: material.pin });
    const source = Readable.from([archive(), Buffer.alloc(APPLICATION_BACKUPS.payloadBytes)]);
    await expect(client.uploadApplicationBackup(taskId, artifactId, source)).rejects.toThrow("quota");
    expect(source.destroyed).toBe(true);
    expect(received).toBeLessThanOrEqual(APPLICATION_BACKUPS.payloadBytes);
  });

  it("denies malformed/error admission and cleans up a rejected upload", async () => {
    const { url, material } = await serve((request, response) => {
      if (request.url!.includes("authorize")) {
        response.end('{"allowed":"true"}');
        return;
      }
      response.statusCode = 403;
      response.end('{"error":"forbidden"}');
    });
    const client = new ControlPlaneClient({ url, token, pin: material.pin });
    expect(await client.authorizeApplicationBackup(taskId, 0)).toBe(false);
    const source = Readable.from([archive()]);
    await expect(client.uploadApplicationBackup(taskId, artifactId, source)).rejects.toBeInstanceOf(ControlPlaneError);
    expect(source.destroyed).toBe(true);
    await expect(client.downloadApplicationBackup(taskId, artifactId)).rejects.toBeInstanceOf(ControlPlaneError);
  });
});
