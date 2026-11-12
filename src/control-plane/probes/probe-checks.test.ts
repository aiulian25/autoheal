import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSecureServer, type Server as SecureServer } from "node:https";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROBE_SCOPE, PROBE_TEXT, type ProbeBody, type ProbeTarget } from "../../shared/probes.js";
import { destinationAllowed, runCheck, scopeOfAddress } from "./probe-checks.js";

const lookups = vi.hoisted(() => ({
  answer: null as { address: string; family: number }[] | null,
  asked: 0,
  // How long the name takes to resolve, for a check whose time runs out while it waits.
  delayMilliseconds: 0,
}));
vi.mock("node:dns/promises", async (original) => {
  const real = await original<typeof import("node:dns/promises")>();
  return {
    ...real,
    lookup: (host: string, options: { all: true }) => {
      lookups.asked += 1;
      const found = lookups.answer === null ? real.lookup(host, options) : Promise.resolve(lookups.answer);
      if (lookups.delayMilliseconds === 0) return found;
      return new Promise((done) => setTimeout(done, lookups.delayMilliseconds)).then(() => found);
    },
  };
});

const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  lookups.answer = null;
  lookups.asked = 0;
  lookups.delayMilliseconds = 0;
});
const never = new AbortController().signal;
const listening = (server: Server | SecureServer) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
  });
const webServer = async (status: number, headers: Record<string, string> = {}) => {
  let hits = 0;
  const port = await listening(
    createServer((_request, response) => {
      hits += 1;
      response.writeHead(status, headers).end();
    }),
  );
  return { port, hits: () => hits };
};
// A web service over TLS, on a certificate from the test authority the tests do not trust.
const secureWebServer = () =>
  listening(
    createSecureServer(
      {
        cert: readFileSync("test/fixtures/tls/untrusted-server.pem"),
        key: readFileSync("test/fixtures/tls/untrusted-server-key.pem"),
      },
      (_request, response) => response.writeHead(200).end(),
    ),
  );
const bodyWith = (target: ProbeTarget, change: Partial<ProbeBody> = {}): ProbeBody => ({
  name: "Wiki",
  scope: PROBE_SCOPE.thisMachine,
  vantage: null,
  intervalSeconds: 60,
  timeoutSeconds: 1,
  failuresBeforeDown: 3,
  objectivePercent: null,
  target,
  ...change,
});
const web = (url: string, expectedStatus = 200): ProbeTarget => ({
  kind: "http",
  url,
  expectedStatus,
  ignoreCertificate: false,
});

// A DNS server of its own: every A question gets `address`, or an empty answer.
const dnsServer = async (address: readonly number[] | null) => {
  const socket = createSocket("udp4");
  socket.on("message", (question, sender) => {
    const isA = question.readUInt16BE(question.length - 4) === 1;
    const answers = isA && address !== null ? 1 : 0;
    const header = Buffer.from(question.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(answers, 6);
    header.writeUInt32BE(0, 8);
    const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...(address ?? [])]);
    socket.send(
      Buffer.concat([header, question.subarray(12), ...(answers === 1 ? [record] : [])]),
      sender.port,
      sender.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  closers.push(() => socket.close());
  return socket.address().port;
};
const lookupOf = (port: number, expectedAnswer: string | null = null): ProbeTarget => ({
  kind: "dns",
  name: "wiki.home.test",
  server: "127.0.0.1",
  port,
  expectedAnswer,
});

describe("where a check may reach", () => {
  it.each([
    ["169.254.169.254", null],
    ["100.100.100.200", null],
    ["168.63.129.16", null],
    ["fd00:ec2::254", null],
    ["fe80::1", null],
    ["0.0.0.0", null],
    ["::ffff:169.254.169.254", null],
    ["224.0.0.1", null],
    ["not an address", null],
    ["127.0.0.1", PROBE_SCOPE.thisMachine],
    ["::1", PROBE_SCOPE.thisMachine],
    ["::ffff:127.0.0.1", PROBE_SCOPE.thisMachine],
    ["192.168.10.2", PROBE_SCOPE.localNetwork],
    ["10.0.0.1", PROBE_SCOPE.localNetwork],
    ["100.64.0.1", PROBE_SCOPE.localNetwork],
    ["fd12::1", PROBE_SCOPE.localNetwork],
    ["1.1.1.1", PROBE_SCOPE.internet],
  ])("puts %s in %s", (address, scope) => {
    expect(scopeOfAddress(address)).toBe(scope);
  });

  it("refuses a destination outside what was chosen, and one no check may reach, while saving", async () => {
    const check = (url: string, scope: ProbeBody["scope"]) => destinationAllowed(bodyWith(web(url), { scope }));
    expect(await check("http://127.0.0.1:1/", PROBE_SCOPE.thisMachine)).toBe(true);
    expect(await check("http://192.168.10.2/", PROBE_SCOPE.thisMachine)).toBe(false);
    expect(await check("http://127.0.0.1/", PROBE_SCOPE.internet)).toBe(false);
    for (const scope of Object.values(PROBE_SCOPE)) {
      expect(await check("http://169.254.169.254/latest/meta-data/", scope)).toBe(false);
    }
    expect(await check("http://[::1]:8080/", PROBE_SCOPE.thisMachine)).toBe(true);
    lookups.answer = [{ address: "169.254.169.254", family: 4 }];
    expect(await check("http://metadata.example.test/", PROBE_SCOPE.internet)).toBe(false);
  });
});

describe("one check of a local service", () => {
  it("passes on the status asked for, and measures it", async () => {
    const { port } = await webServer(204);
    const result = await runCheck(bodyWith(web(`http://127.0.0.1:${port}/health`, 204)), never);
    expect(result).toMatchObject({ ok: true, problem: null });
    expect(result.latencyMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it("fails on another status, saying which", async () => {
    const { port } = await webServer(500);
    expect(await runCheck(bodyWith(web(`http://127.0.0.1:${port}/`)), never)).toEqual({
      ok: false,
      latencyMilliseconds: null,
      problem: PROBE_TEXT.wrongStatus(500, 200),
    });
  });

  it("never follows a redirect: it is only an answer to compare", async () => {
    const elsewhere = await webServer(200);
    const redirecting = await webServer(302, { location: `http://127.0.0.1:${elsewhere.port}/` });
    const asked = await runCheck(bodyWith(web(`http://127.0.0.1:${redirecting.port}/`)), never);
    expect(asked.problem).toBe(PROBE_TEXT.wrongStatus(302, 200));
    expect(elsewhere.hits()).toBe(0);
    expect((await runCheck(bodyWith(web(`http://127.0.0.1:${redirecting.port}/`, 302)), never)).ok).toBe(true);
  });

  it("makes a check over HTTPS however its scheme is written, held to the same certificate", async () => {
    const port = await secureWebServer();
    const checked = (scheme: string, ignoreCertificate: boolean) =>
      runCheck(
        bodyWith({ kind: "http", url: `${scheme}://127.0.0.1:${port}/`, expectedStatus: 200, ignoreCertificate }),
        never,
      );
    for (const scheme of ["https", "HTTPS", "Https"]) {
      expect(await checked(scheme, true)).toMatchObject({ ok: true, problem: null });
    }
    const refused = await checked("https", false);
    expect(refused.ok).toBe(false);
    expect(await checked("HTTPS", false)).toEqual(refused);
  });

  it("gives up in its time on a service that never answers", async () => {
    const port = await listening(createServer(() => undefined));
    const result = await runCheck(bodyWith(web(`http://127.0.0.1:${port}/`)), never);
    expect(result).toEqual({ ok: false, latencyMilliseconds: null, problem: PROBE_TEXT.timedOut(1) });
  });

  it("fails on a closed port, by web and by port", async () => {
    const closed = await listening(createServer());
    closers.pop()!();
    expect((await runCheck(bodyWith(web(`http://127.0.0.1:${closed}/`)), never)).ok).toBe(false);
    const tcp = await runCheck(bodyWith({ kind: "tcp", host: "127.0.0.1", port: closed }), never);
    expect(tcp.ok).toBe(false);
    expect(tcp.problem).toContain("ECONNREFUSED");
  });

  it("passes when a port accepts", async () => {
    const server = createTcpServer((socket) => socket.destroy());
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
    closers.push(() => server.close());
    expect((await runCheck(bodyWith({ kind: "tcp", host: "127.0.0.1", port }), never)).ok).toBe(true);
  });

  it("asks the chosen DNS server, and holds it to the answer asked for", async () => {
    const port = await dnsServer([192, 168, 10, 9]);
    expect((await runCheck(bodyWith(lookupOf(port)), never)).ok).toBe(true);
    expect((await runCheck(bodyWith(lookupOf(port, "192.168.10.9")), never)).ok).toBe(true);
    expect((await runCheck(bodyWith(lookupOf(port, "192.168.10.8")), never)).problem).toBe(
      PROBE_TEXT.wrongAnswer("192.168.10.8"),
    );
  });

  it("fails when the name has no answer", async () => {
    const port = await dnsServer(null);
    expect((await runCheck(bodyWith(lookupOf(port)), never)).ok).toBe(false);
  });

  it("does not ask a DNS server outside its scope", async () => {
    const port = await dnsServer([192, 168, 10, 9]);
    const asked = await runCheck(bodyWith(lookupOf(port), { scope: PROBE_SCOPE.internet }), never);
    expect(asked.problem).toBe(PROBE_TEXT.refused);
  });

  it("opens nothing once its time is up, even if the name only resolves afterwards", async () => {
    // A peer that answers the connect and never speaks TLS, so only the check's own time can end this.
    const reached: unknown[] = [];
    const stalled = createTcpServer((socket) => reached.push(socket));
    await new Promise<void>((done) => stalled.listen(0, "127.0.0.1", done));
    closers.push(() => stalled.close());
    const stalledPort = (stalled.address() as AddressInfo).port;
    lookups.answer = [{ address: "127.0.0.1", family: 4 }];
    lookups.delayMilliseconds = 1200;

    const asked = await runCheck(
      bodyWith({ kind: "tls", host: "wiki.home.test", port: stalledPort, serverName: null, warnDays: 14, caPem: null }),
      never,
    );

    expect(asked.ok).toBe(false);
    expect(asked.problem).toBe(PROBE_TEXT.timedOut(1));
    // The name came back after the check was over: nothing was opened on the strength of it.
    expect(reached).toEqual([]);
  });

  it("answers at once when it was told to stop before it began, rather than waiting out its time", async () => {
    // A name server that never answers, and a long time to wait: only being already stopped can end this quickly.
    const silent = createSocket("udp4");
    await new Promise<void>((done) => silent.bind(0, "127.0.0.1", done));
    closers.push(() => silent.close());
    const body = bodyWith(lookupOf(silent.address().port), { timeoutSeconds: 30 });
    const startedAt = Date.now();

    const asked = await runCheck(body, AbortSignal.abort());

    expect(asked.ok).toBe(false);
    expect(asked.problem).toBe(PROBE_TEXT.timedOut(30));
    // Without this it waits on the resolver for the whole 30 seconds.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("stops at once when told to", async () => {
    const port = await listening(createServer(() => undefined));
    const stop = new AbortController();
    const asked = runCheck(bodyWith(web(`http://127.0.0.1:${port}/`), { timeoutSeconds: 30 }), stop.signal);
    stop.abort();
    expect((await asked).ok).toBe(false);
  });
});

describe("a name that changes where it points", () => {
  it("contacts nothing once it points outside the scope, even in part", async () => {
    const { port, hits } = await webServer(200);
    const url = `http://wiki.home.test:${port}/`;
    lookups.answer = [{ address: "127.0.0.1", family: 4 }];
    expect((await runCheck(bodyWith(web(url)), never)).ok).toBe(true);
    expect(hits()).toBe(1);

    lookups.answer = [
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    expect((await runCheck(bodyWith(web(url)), never)).problem).toBe(PROBE_TEXT.refused);
    lookups.answer = [{ address: "192.168.10.2", family: 4 }];
    expect((await runCheck(bodyWith(web(url)), never)).problem).toBe(PROBE_TEXT.refused);
    expect(hits()).toBe(1);
  });

  it("connects to the address it approved, looking the name up once", async () => {
    const { port, hits } = await webServer(200);
    lookups.answer = [{ address: "127.0.0.1", family: 4 }];
    expect((await runCheck(bodyWith(web(`http://wiki.home.test:${port}/`)), never)).ok).toBe(true);
    expect(lookups.asked).toBe(1);
    expect(hits()).toBe(1);
  });

  it("holds a port check to the same rule", async () => {
    lookups.answer = [{ address: "169.254.169.254", family: 4 }];
    const target: ProbeTarget = { kind: "tcp", host: "wiki.home.test", port: 80 };
    expect((await runCheck(bodyWith(target), never)).problem).toBe(PROBE_TEXT.refused);
  });
});
