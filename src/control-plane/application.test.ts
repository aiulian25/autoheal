import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import type { ControlPlaneConfig } from "../config/control-plane-config.js";
import { TLS_MESSAGES } from "../shared/constants.js";
import { eachApart, renewWhenDue } from "./application.js";
import { providedCertificate, tlsOptionsOf } from "./tls/certificate.js";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/tls");

describe("the daily look at the certificate both listeners serve", () => {
  let directory: string;
  let files: { certificateFile: string; keyFile: string };
  let config: ControlPlaneConfig;
  // The dashboard and the runner API.
  let listeners: FastifyInstance[];
  let said: MockInstance<typeof console.log>;
  let newKeys: string[];

  const replace = (file: string, fixture: string) => copyFileSync(join(FIXTURES, fixture), file);
  const renew = (served: ReturnType<typeof providedCertificate>) =>
    renewWhenDue(config, listeners, served, (pin) => newKeys.push(pin), Date.now());
  const logged = () => said.mock.calls.flat().join("\n");

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-renewal-"));
    files = {
      certificateFile: join(directory, "control-plane.pem"),
      keyFile: join(directory, "control-plane-key.pem"),
    };
    replace(files.certificateFile, "server.pem");
    replace(files.keyFile, "server-key.pem");
    config = loadControlPlaneConfig({
      PUBLIC_BASE_URL: "https://autoheal.example.test",
      OLLAMA_URL: "https://ollama.example.test",
      TLS_CERTIFICATE_FILE: files.certificateFile,
      TLS_KEY_FILE: files.keyFile,
    });
    const first = providedCertificate(files);
    listeners = [Fastify({ https: tlsOptionsOf(first) }), Fastify({ https: tlsOptionsOf(first) })];
    await Promise.all(listeners.map((listener) => listener.listen({ host: "127.0.0.1", port: 0 })));
    said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    newKeys = [];
  });

  afterEach(async () => {
    said.mockRestore();
    await Promise.all(listeners.map((listener) => listener.close()));
    rmSync(directory, { recursive: true, force: true });
  });

  it("does nothing while the operator's files hold what is served", () => {
    const served = providedCertificate(files);
    expect(renew(served)).toBe(served);
    expect(newKeys).toEqual([]);
    expect(said).not.toHaveBeenCalled();
  });

  it("takes up the operator's renewed files and hands on their new key, once", () => {
    const served = providedCertificate(files);
    replace(files.certificateFile, "untrusted-server.pem");
    replace(files.keyFile, "untrusted-server-key.pem");
    const renewed = renew(served);
    expect(renewed).toEqual(providedCertificate(files));
    expect(newKeys).toEqual([renewed.pin]);
    expect(logged()).toContain(TLS_MESSAGES.newKey);
    expect(renew(renewed)).toBe(renewed);
    expect(newKeys).toEqual([renewed.pin]);
  });

  it("says why and keeps what is served, without stopping, when the files cannot be taken up, then takes them", () => {
    const served = providedCertificate(files);
    // Caught half-way through a renewal: the new certificate is there, its key not yet, then not at all for a moment.
    replace(files.certificateFile, "untrusted-server.pem");
    expect(renew(served)).toBe(served);
    rmSync(files.keyFile);
    expect(renew(served)).toBe(served);
    expect(newKeys).toEqual([]);
    expect(said).toHaveBeenCalledTimes(2);
    expect(logged()).toContain(TLS_MESSAGES.renewFailed(""));

    replace(files.keyFile, "untrusted-server-key.pem");
    expect(renew(served).pin).toBe(providedCertificate(files).pin);
    expect(newKeys).toHaveLength(1);
  });

  it("tries the whole renewal again the next day when handing on the new key failed", () => {
    const served = providedCertificate(files);
    replace(files.certificateFile, "untrusted-server.pem");
    replace(files.keyFile, "untrusted-server-key.pem");
    const failing = (pin: string) => {
      newKeys.push(pin);
      throw new Error("the join volume is read-only");
    };
    expect(renewWhenDue(config, listeners, served, failing, Date.now())).toBe(served);
    expect(logged()).toContain(TLS_MESSAGES.renewFailed("the join volume is read-only"));
    expect(renew(served).pin).toBe(newKeys[0]);
    expect(newKeys).toHaveLength(2);
  });
});

describe("the parts of one scheduled round", () => {
  it("runs every part in turn, each failure apart: one that throws stops none after it", () => {
    const ran: string[] = [];
    const failures: unknown[] = [];
    const broken = new Error("its token was sealed with another backup passphrase");
    eachApart(
      [
        () => ran.push("packages"),
        () => {
          throw broken;
        },
        () => ran.push("power"),
        () => ran.push("jarvis"),
      ],
      (error) => failures.push(error),
    );
    expect(ran).toEqual(["packages", "power", "jarvis"]);
    expect(failures).toEqual([broken]);
  });
});
