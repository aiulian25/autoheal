import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_TEXT } from "../../shared/probes.js";
import { observeCertificate, type CertificateTarget } from "./certificate-probe.js";

// A peer that answers the connect and never speaks TLS: the handshake waits until something ends it.
let stalled: Server;
let port: number;
let accepted: Socket[];

beforeEach(async () => {
  accepted = [];
  stalled = createServer((socket) => accepted.push(socket));
  await new Promise<void>((done) => stalled.listen(0, "127.0.0.1", done));
  port = (stalled.address() as { port: number }).port;
});

afterEach(async () => {
  for (const socket of accepted) socket.destroy();
  await new Promise((done) => stalled.close(done));
});

const target = (): CertificateTarget => ({
  kind: "tls",
  host: "127.0.0.1",
  port,
  serverName: null,
  warnDays: 14,
  caPem: null,
});
const SETTLE_MILLISECONDS = 150;
// What became of the promise, or that it is still waiting; never hangs the test either way.
const ended = (work: Promise<unknown>) =>
  Promise.race([
    work.then(
      () => "resolved",
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    ),
    new Promise((done) => setTimeout(() => done("still waiting"), SETTLE_MILLISECONDS)),
  ]);
const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

describe("looking at what an endpoint presents", () => {
  it("opens nothing at all when its time was already up", async () => {
    const asked = observeCertificate(target(), "127.0.0.1", AbortSignal.abort());

    expect(await ended(asked)).toBe(`rejected: ${PROBE_TEXT.cancelled}`);
    expect(accepted).toEqual([]);
  });

  it("lets go of a handshake that never finishes, and leaves no socket of its own behind", async () => {
    const limit = new AbortController();
    const asked = observeCertificate(target(), "127.0.0.1", limit.signal);
    await pause(30);
    expect(accepted).toHaveLength(1);

    limit.abort();

    expect(await ended(asked)).toBe(`rejected: ${PROBE_TEXT.cancelled}`);
    // The end this side opened is closed; the test's own copy of it is all that is left.
    await pause(20);
    expect(accepted[0]!.readyState).toBe("open");
    expect(accepted[0]!.destroyed).toBe(false);
  });

  it("settles when the peer closes before saying anything, rather than waiting for its deadline", async () => {
    // Its peer hangs up as soon as it connects, without a word of TLS.
    const closing = createServer((socket) => {
      accepted.push(socket);
      socket.end();
    });
    await new Promise<void>((done) => closing.listen(0, "127.0.0.1", done));
    const closingPort = (closing.address() as { port: number }).port;

    const asked = observeCertificate({ ...target(), port: closingPort }, "127.0.0.1", new AbortController().signal);

    expect(await ended(asked)).toBe(`rejected: ${PROBE_TEXT.closedEarly}`);
    for (const socket of accepted) socket.destroy();
    await new Promise((done) => closing.close(done));
  });

  it("stops waiting on a peer that is not there, without being told to", async () => {
    const nobody = createServer();
    await new Promise<void>((done) => nobody.listen(0, "127.0.0.1", done));
    const freePort = (nobody.address() as { port: number }).port;
    await new Promise((done) => nobody.close(done));

    const asked = observeCertificate({ ...target(), port: freePort }, "127.0.0.1", new AbortController().signal);

    expect(await ended(asked)).toContain("rejected:");
  });

  it("takes its listener off the signal once it is done, so a later abort finds nothing", async () => {
    const limit = new AbortController();
    const asked = observeCertificate(target(), "127.0.0.1", limit.signal);
    await pause(30);
    accepted[0]!.destroy();
    expect(await ended(asked)).toContain("rejected:");

    // Nothing of this check is still attached: aborting afterwards is a no-op, not a second settle or a throw.
    expect(() => limit.abort()).not.toThrow();
    expect(await ended(asked)).toContain("rejected:");
  });
});
