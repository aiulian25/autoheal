import { execFileSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import {
  CERTIFICATE_STATUS,
  PROBE_SCOPE,
  certificateStatusOf,
  type ProbeBody,
  type ProbeCertificate,
} from "../../shared/probes.js";
import { selfSignedCertificate } from "../tls/certificate.js";
import { tasks } from "../database/schema.js";
import { serviceProbes } from "./probe-schema.js";

const DAY = 24 * 60 * 60 * 1000;
const NAME = "wiki.home.test";
const WARN_DAYS = 30;
// How long selfSignedCertificate makes them last.
const LASTS_DAYS = 825;

const keyPair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;

describe("what a certificate means now", () => {
  const certificate: ProbeCertificate = {
    fingerprint: "AA",
    subject: "CN=x",
    issuer: "CN=y",
    validFrom: 1_000 * DAY,
    validTo: 2_000 * DAY,
    name: NAME,
    nameMatches: true,
    chainError: null,
    observedAt: 1_500 * DAY,
    firstSeenAt: 1_400 * DAY,
  };
  const at = (now: number, change: Partial<ProbeCertificate> = {}) =>
    certificateStatusOf({ ...certificate, ...change }, WARN_DAYS, now);

  it.each([
    [1_500 * DAY, CERTIFICATE_STATUS.valid],
    [(2_000 - WARN_DAYS) * DAY - 1, CERTIFICATE_STATUS.valid],
    [(2_000 - WARN_DAYS) * DAY, CERTIFICATE_STATUS.expiring],
    [2_000 * DAY - 1, CERTIFICATE_STATUS.expiring],
    [2_000 * DAY, CERTIFICATE_STATUS.expired],
    [1_000 * DAY - 1, CERTIFICATE_STATUS.notYetValid],
  ])("at %d says %s", (now, status) => {
    expect(at(now)).toBe(status);
  });

  it("says an expired one is expired, whatever else is wrong with it", () => {
    expect(at(2_001 * DAY, { nameMatches: false, chainError: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe("expired");
  });
  it("says the name before the chain, as that is what to fix first", () => {
    expect(at(1_500 * DAY, { nameMatches: false, chainError: "X" })).toBe("wrong_name");
    expect(at(1_500 * DAY, { chainError: "X" })).toBe("untrusted");
  });
});

describe("a certificate check of a local endpoint", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  let token: string;
  let servers: Server[];
  let received: Buffer[];

  const serve = async (key: KeyObject, cert: string, port = 0) => {
    const server = createServer({ key: key.export({ type: "pkcs8", format: "pem" }), cert }, (socket) => {
      socket.on("data", (data) => received.push(data));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    servers.push(server);
    return (server.address() as AddressInfo).port;
  };
  const stopAll = async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  };
  const selfSigned = (names: string[] = [NAME], now = Date.now()) => {
    const key = keyPair();
    return { key, cert: selfSignedCertificate(key, names, now) };
  };
  const bodyFor = (port: number, change: object = {}): ProbeBody => ({
    name: "Wiki",
    scope: PROBE_SCOPE.thisMachine,
    intervalSeconds: 60,
    timeoutSeconds: 2,
    failuresBeforeDown: 1,
    objectivePercent: null,
    target: { kind: "tls", host: "127.0.0.1", port, serverName: NAME, warnDays: WARN_DAYS, caPem: null, ...change },
  });
  const route = () => apiPath(API_ROUTES.hostProbes, { hostId });
  const add = async (body: ProbeBody) => {
    const response = await admin.post(route(), body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string }>().id;
  };
  // Through the service, as these jump months ahead, past any session.
  const shown = () => plane.services.probes.ofHost(hostId)[0]!;
  const check = async (milliseconds = 60_000) => {
    plane.clock.now += milliseconds;
    await plane.services.probes.tick();
    await plane.services.detectorService.run();
  };
  const heartbeat = () =>
    plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: { ...heartbeatWith({ dryRun: false, containers: [] }), maintenanceGeneration: 0 },
      headers: { authorization: `Bearer ${token}` },
    });
  const certificateTasks = () =>
    plane.services.databaseHandle.database
      .select()
      .from(tasks)
      .all()
      .filter((task) => task.resourceKind === "probe" && task.status !== "done");
  const notified = () => vi.spyOn(plane.services.notifier, "taskOpened");

  beforeEach(async () => {
    plane = await startTestControlPlane();
    plane.clock.now = Date.now();
    ({ client: admin } = await fullySignedInAdmin(plane));
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    servers = [];
    received = [];
  });
  afterEach(async () => {
    await stopAll();
    await plane.app.close();
    await plane.runnerApp.close();
  });

  it("reports a good certificate trusted by name, with its dates, and opens nothing", async () => {
    const { key, cert } = selfSigned();
    await add(bodyFor(await serve(key, cert), { caPem: cert }));
    await check();
    const probe = shown();
    expect(probe.state).toBe("up");
    expect(probe.certificateStatus).toBe(CERTIFICATE_STATUS.valid);
    expect(probe.certificate).toMatchObject({ nameMatches: true, chainError: null, name: NAME });
    expect(probe.certificate!.observedAt).toBe(plane.clock.now);
    expect(probe.certificate!.validTo).toBeGreaterThan(plane.clock.now + 800 * DAY);
    expect(certificateTasks()).toEqual([]);
  });

  it("sends nothing but the handshake, and keeps no secret", async () => {
    const { key, cert } = selfSigned();
    await add(bodyFor(await serve(key, cert), { caPem: cert }));
    await check();
    expect(received).toEqual([]);
    const stored = plane.services.databaseHandle.database.select().from(serviceProbes).get()!;
    expect(`${stored.bodyJson}${stored.certificateJson}`).not.toContain("PRIVATE KEY");
  });

  it("trusts a real private authority only when told to", async () => {
    const folder = mkdtempSync(join(tmpdir(), "autoheal-certificates-"));
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: folder, stdio: "pipe" });
    openssl(
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-subj",
      "/CN=Home authority",
      "-days",
      "30",
    );
    openssl(
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
      "-subj",
      `/CN=${NAME}`,
    );
    writeFileSync(join(folder, "san.cnf"), `subjectAltName=DNS:${NAME}\n`);
    openssl(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "leaf.pem",
      "-days",
      "20",
      "-extfile",
      "san.cnf",
    );
    const [caPem, leafPem, leafKey] = ["ca.pem", "leaf.pem", "leaf.key"].map((file) =>
      readFileSync(join(folder, file), "utf8"),
    );
    rmSync(folder, { recursive: true, force: true });
    const server = createServer({ key: leafKey!, cert: leafPem! }, () => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    await add(bodyFor(port, { warnDays: 5 }));
    await check();
    expect(shown().certificateStatus).toBe(CERTIFICATE_STATUS.untrusted);

    plane.services.databaseHandle.database.delete(serviceProbes).run();
    await add(bodyFor(port, { caPem, warnDays: 5 }));
    await check();
    const trusted = shown();
    expect(trusted.certificateStatus).toBe(CERTIFICATE_STATUS.valid);
    expect(trusted.certificate!.issuer).toContain("Home authority");
    // It lasts 20 days, so 30 days' warning would already say so.
    plane.services.databaseHandle.database.delete(serviceProbes).run();
    await add(bodyFor(port, { caPem, warnDays: WARN_DAYS }));
    await check();
    expect(shown().certificateStatus).toBe(CERTIFICATE_STATUS.expiring);
  });

  it("says when it is for another name, and untrusted when nobody named it", async () => {
    const { key, cert } = selfSigned(["other.home.test"]);
    await add(bodyFor(await serve(key, cert), { caPem: cert }));
    await check();
    expect(shown().certificateStatus).toBe(CERTIFICATE_STATUS.wrongName);
    const [task] = certificateTasks();
    expect(task!.title).toContain(`does not cover ${NAME}`);
    expect(task!.hostId).toBe(hostId);
    expect(task!.priority).toBe("high");
  });

  it("checks an address too, when that is what clients ask for", async () => {
    const { key, cert } = selfSigned(["127.0.0.1"]);
    await add(bodyFor(await serve(key, cert), { caPem: cert, serverName: null }));
    await check();
    expect(shown().certificateStatus).toBe(CERTIFICATE_STATUS.valid);
  });

  it("sees a real expired certificate as expired, though the endpoint answers", async () => {
    const { key, cert } = selfSigned([NAME], Date.now() - (LASTS_DAYS + 5) * DAY);
    await add(bodyFor(await serve(key, cert), { caPem: cert }));
    await check();
    const probe = shown();
    expect(probe.state).toBe("up");
    expect(probe.certificateStatus).toBe(CERTIFICATE_STATUS.expired);
    expect(probe.certificate!.chainError).toBe("CERT_HAS_EXPIRED");
    const [task] = certificateTasks();
    expect(task!.title).toMatch(/expired \d{4}-\d{2}-\d{2} \(seen \d{4}-\d{2}-\d{2}\)/);
  });

  it("warns once as it nears expiry, however often it looks, then says expired on that same task", async () => {
    const opened = notified();
    const { key, cert } = selfSigned();
    await add(bodyFor(await serve(key, cert), { caPem: cert }));
    await check();
    expect(certificateTasks()).toEqual([]);

    await check((LASTS_DAYS - WARN_DAYS + 1) * DAY);
    const [warned, ...others] = certificateTasks();
    expect(others).toEqual([]);
    expect(warned!.title).toMatch(/expires \d{4}-\d{2}-\d{2} \(seen /);
    expect(warned!.priority).toBe("medium");
    expect(opened).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 5; index += 1) await check();
    expect(certificateTasks()).toHaveLength(1);
    expect(opened).toHaveBeenCalledTimes(1);

    await check(WARN_DAYS * DAY);
    const [expired, ...none] = certificateTasks();
    expect(none).toEqual([]);
    expect(expired!.id).toBe(warned!.id);
    expect(expired!.title).toContain("expired");
    expect(expired!.priority).toBe("high");
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("clears on rotation to a good certificate, and shows when the new one was first seen", async () => {
    const old = selfSigned([NAME], Date.now() - (LASTS_DAYS - 10) * DAY);
    const port = await serve(old.key, old.cert);
    await add(bodyFor(port, { caPem: old.cert }));
    await check();
    const first = shown().certificate!;
    expect(shown().certificateStatus).toBe(CERTIFICATE_STATUS.expiring);
    expect(certificateTasks()).toHaveLength(1);

    await stopAll();
    const renewed = selfSigned();
    plane.services.databaseHandle.database
      .update(serviceProbes)
      .set({ bodyJson: JSON.stringify(bodyFor(port, { caPem: renewed.cert })) })
      .run();
    await serve(renewed.key, renewed.cert, port);
    await check();
    const rotated = shown();
    expect(rotated.certificateStatus).toBe(CERTIFICATE_STATUS.valid);
    expect(rotated.certificate!.fingerprint).not.toBe(first.fingerprint);
    const seenAt = plane.clock.now;
    expect(rotated.certificate!.firstSeenAt).toBe(seenAt);
    expect(certificateTasks()).toEqual([]);

    await check();
    expect(shown().certificate!.firstSeenAt).toBe(seenAt);
    expect(shown().certificate!.observedAt).toBe(plane.clock.now);
  });

  it("moves its task to a new certificate that is bad too, rather than keeping both", async () => {
    const old = selfSigned(["old.home.test"]);
    const port = await serve(old.key, old.cert);
    await add(bodyFor(port, { caPem: old.cert }));
    await check();
    const [before] = certificateTasks();

    await stopAll();
    const next = selfSigned(["other.home.test"]);
    await serve(next.key, next.cert, port);
    await check();
    const after = certificateTasks();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before!.id);
  });

  it("does not clear while the endpoint cannot be reached, keeping the last it saw, and clears on a fresh good look", async () => {
    const { key, cert } = selfSigned(["other.home.test"]);
    const port = await serve(key, cert);
    await add({ ...bodyFor(port, { caPem: cert }), failuresBeforeDown: 5 });
    await check();
    expect(certificateTasks()).toHaveLength(1);

    await stopAll();
    await check();
    await check();
    const away = shown();
    expect(away.lastProblem).toContain("ECONNREFUSED");
    expect(away.certificateStatus).toBe(CERTIFICATE_STATUS.wrongName);
    expect(away.certificate!.observedAt).toBeLessThan(away.lastCheckedAt!);
    expect(certificateTasks()).toHaveLength(1);

    const good = selfSigned();
    plane.services.databaseHandle.database
      .update(serviceProbes)
      .set({ bodyJson: JSON.stringify({ ...bodyFor(port, { caPem: good.cert }), failuresBeforeDown: 5 }) })
      .run();
    await serve(good.key, good.cert, port);
    await check();
    expect(shown().certificateStatus).toBe(CERTIFICATE_STATUS.valid);
    expect(certificateTasks()).toEqual([]);
  });

  describe("during a window over the whole host", () => {
    const openWindow = async () => {
      await heartbeat();
      const window = await admin.post(apiPath(API_ROUTES.hostMaintenance, { hostId }), {
        containerName: null,
        reason: "Planned",
        expiresAt: plane.clock.now + 60 * 60_000,
      });
      expect(window.statusCode, window.body).toBe(200);
    };

    it("looks at nothing", async () => {
      const { key, cert } = selfSigned(["other.home.test"]);
      await add(bodyFor(await serve(key, cert), { caPem: cert }));
      await openWindow();
      await check();
      expect(shown().certificate).toBeNull();
      expect(certificateTasks()).toEqual([]);
    });

    it("opens no task for what it saw before", async () => {
      const { key, cert } = selfSigned(["other.home.test"]);
      await add(bodyFor(await serve(key, cert), { caPem: cert }));
      plane.clock.now += 60_000;
      await plane.services.probes.tick();
      expect(shown().certificateStatus).toBe(CERTIFICATE_STATUS.wrongName);
      await openWindow();
      await plane.services.detectorService.run();
      expect(certificateTasks()).toEqual([]);
    });

    it("leaves an open task as it is", async () => {
      const { key, cert } = selfSigned(["other.home.test"]);
      await add(bodyFor(await serve(key, cert), { caPem: cert }));
      await check();
      expect(certificateTasks()).toHaveLength(1);
      await openWindow();
      await check();
      expect(certificateTasks()).toHaveLength(1);
    });
  });

  it("refuses a key where a certificate to trust belongs, and text that is no certificate", async () => {
    const refused = async (caPem: string) => (await admin.post(route(), bodyFor(1, { caPem }))).statusCode;
    const privateKey = keyPair().export({ type: "pkcs8", format: "pem" }).toString();
    const { cert } = selfSigned();
    expect(await refused(privateKey)).toBe(400);
    expect(await refused(`${cert}\n${privateKey}`)).toBe(400);
    expect(await refused("-----BEGIN CERTIFICATE-----\nnonsense\n-----END CERTIFICATE-----")).toBe(400);
    expect(await refused("hello")).toBe(400);
  });

  it("holds a certificate check to its scope like any other", async () => {
    const outside = await admin.post(route(), bodyFor(443, { host: "169.254.169.254", serverName: null }));
    expect(outside.statusCode).toBe(400);
    const wrong = await admin.post(route(), { ...bodyFor(443), scope: PROBE_SCOPE.internet });
    expect(wrong.statusCode).toBe(400);
  });

  it("removes its task with the check", async () => {
    const { key, cert } = selfSigned(["other.home.test"]);
    const id = await add(bodyFor(await serve(key, cert), { caPem: cert }));
    await check();
    expect(certificateTasks()).toHaveLength(1);
    await admin.delete(apiPath(API_ROUTES.hostProbe, { hostId, probeId: id }));
    await plane.services.detectorService.run();
    expect(certificateTasks()).toEqual([]);
  });
});
