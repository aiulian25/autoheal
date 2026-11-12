import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect, isIP, type IPVersion } from "node:net";
import { describeError } from "../../shared/errors.js";
import { observeCertificate, trustIsUsable, type ObservedCertificate } from "./certificate-probe.js";
import {
  PROBE_KIND,
  PROBE_LIMITS,
  PROBE_SCOPE,
  PROBE_TEXT,
  PROBE_WEB_PROTOCOL,
  type ProbeBody,
  type ProbeScope,
  type ProbeTarget,
} from "../../shared/probes.js";

const MILLISECONDS_PER_SECOND = 1000;
const USER_AGENT = "Autoheal service check";

const listOf = (ranges: readonly (readonly [string, number])[]) => {
  const list = new BlockList();
  for (const [address, prefix] of ranges) {
    list.addSubnet(address, prefix, isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  return list;
};
// Never, whatever a check says: cloud metadata services and addresses that are no one's service.
const NEVER = listOf([
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["100.100.100.200", 32],
  ["168.63.129.16", 32],
  ["192.0.0.192", 32],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["::", 128],
  ["fe80::", 10],
  ["ff00::", 8],
  ["fd00:ec2::254", 128],
]);
const THIS_MACHINE = listOf([
  ["127.0.0.0", 8],
  ["::1", 128],
]);
const LOCAL_NETWORK = listOf([
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["fc00::", 7],
]);

/** Where an address lies; null for one no check may ever reach. */
export function scopeOfAddress(address: string): ProbeScope | null {
  if (isIP(address) === 0) return null;
  const version: IPVersion = isIP(address) === 6 ? "ipv6" : "ipv4";
  if (NEVER.check(address, version)) return null;
  if (THIS_MACHINE.check(address, version)) return PROBE_SCOPE.thisMachine;
  if (LOCAL_NETWORK.check(address, version)) return PROBE_SCOPE.localNetwork;
  return PROBE_SCOPE.internet;
}

export interface ProbeResult {
  ok: boolean;
  latencyMilliseconds: number | null;
  problem: string | null;
  // What a TLS check saw. A bad certificate is still an answer: judged apart from whether the endpoint answers.
  certificate?: ObservedCertificate;
}

const hostOfUrl = (url: string) => new URL(url).hostname.replace(/^\[|\]$/gu, "");

/** Every address a name has right now, only if all of them are within the scope. */
async function approvedAddresses(host: string, scope: ProbeScope) {
  const addresses = isIP(host) === 0 ? await lookup(host, { all: true }) : [{ address: host, family: isIP(host) }];
  return addresses.length > 0 && addresses.every(({ address }) => scopeOfAddress(address) === scope) ? addresses : null;
}

/** The one question a new check must answer before it is kept. A name that does not resolve yet may do so later. */
export async function destinationAllowed(body: ProbeBody) {
  const { target, scope } = body;
  if (target.kind === PROBE_KIND.tls && !trustIsUsable(target)) return false;
  const host = destinationOf(target);
  if (host === null) return true;
  return (await approvedAddresses(host, scope).catch(() => undefined)) !== null;
}

function destinationOf(target: ProbeTarget) {
  if (target.kind === PROBE_KIND.http) return hostOfUrl(target.url);
  if (target.kind === PROBE_KIND.tcp || target.kind === PROBE_KIND.tls) return target.host;
  return target.server;
}

/**
 * Rejects once the check is stopped or out of time. A signal that has already fired never fires again, so one given
 * that way is answered at once rather than waited on. `forget` takes the listener off once the race is over.
 */
function untilAborted(limit: AbortSignal, problem: string) {
  let forget = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    if (limit.aborted) {
      reject(new Error(problem));
      return;
    }
    const stop = () => reject(new Error(problem));
    limit.addEventListener("abort", stop, { once: true });
    forget = () => limit.removeEventListener("abort", stop);
  });
  return { aborted, forget: () => forget() };
}

type Answer = { problem: string | null; certificate?: ObservedCertificate };
const ANSWERED: Answer = { problem: null };

async function askWeb(target: Extract<ProbeTarget, { kind: "http" }>, scope: ProbeScope, limit: AbortSignal) {
  const addresses = await approvedAddresses(hostOfUrl(target.url), scope);
  if (addresses === null) return { problem: PROBE_TEXT.refused };
  // The address just approved is the one connected to, so a name cannot change between the two. A redirect is only an
  // answer to compare: it is never followed.
  const { address, family } = addresses[0]!;
  const send = new URL(target.url).protocol === PROBE_WEB_PROTOCOL.https ? httpsRequest : httpRequest;
  const status = await new Promise<number>((resolve, reject) => {
    const request = send(
      target.url,
      {
        method: "GET",
        agent: false,
        signal: limit,
        headers: { "user-agent": USER_AGENT, connection: "close" },
        rejectUnauthorized: !target.ignoreCertificate,
        lookup: (_host, options, done) => {
          if (options.all) (done as (error: null, all: object[]) => void)(null, [{ address, family }]);
          else done(null, address, family);
        },
      },
      (response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      },
    );
    request.on("error", reject);
    request.end();
  });
  return status === target.expectedStatus
    ? ANSWERED
    : { problem: PROBE_TEXT.wrongStatus(status, target.expectedStatus) };
}

async function askPort(target: Extract<ProbeTarget, { kind: "tcp" }>, scope: ProbeScope, limit: AbortSignal) {
  const addresses = await approvedAddresses(target.host, scope);
  if (addresses === null) return { problem: PROBE_TEXT.refused };
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: addresses[0]!.address, port: target.port, signal: limit });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
  return ANSWERED;
}

async function askName(target: Extract<ProbeTarget, { kind: "dns" }>, scope: ProbeScope, timeoutMilliseconds: number) {
  if (target.server !== null && scopeOfAddress(target.server) !== scope) return { problem: PROBE_TEXT.refused };
  const resolver = new Resolver({ timeout: timeoutMilliseconds, tries: 1 });
  if (target.server !== null) {
    const server = isIP(target.server) === 6 ? `[${target.server}]` : target.server;
    resolver.setServers([`${server}:${target.port}`]);
  }
  const asked = await Promise.allSettled([resolver.resolve4(target.name), resolver.resolve6(target.name)]);
  const answers = asked.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (answers.length === 0) {
    const failure = asked.find((result) => result.status === "rejected");
    return { problem: failure === undefined ? PROBE_TEXT.noAnswer : describeError(failure.reason) };
  }
  const wanted = target.expectedAnswer;
  return wanted === null || answers.includes(wanted) ? ANSWERED : { problem: PROBE_TEXT.wrongAnswer(wanted) };
}

async function askCertificate(
  target: Extract<ProbeTarget, { kind: "tls" }>,
  scope: ProbeScope,
  limit: AbortSignal,
): Promise<Answer> {
  const addresses = await approvedAddresses(target.host, scope);
  if (addresses === null) return { problem: PROBE_TEXT.refused };
  return { problem: null, certificate: await observeCertificate(target, addresses[0]!.address, limit) };
}

function ask(body: ProbeBody, limit: AbortSignal, timeoutMilliseconds: number): Promise<Answer> {
  const { target, scope } = body;
  if (target.kind === PROBE_KIND.http) return askWeb(target, scope, limit);
  if (target.kind === PROBE_KIND.tcp) return askPort(target, scope, limit);
  if (target.kind === PROBE_KIND.tls) return askCertificate(target, scope, limit);
  return askName(target, scope, timeoutMilliseconds);
}

/** One check, within its time. It never throws: whatever goes wrong is what was seen. */
export async function runCheck(body: ProbeBody, stop: AbortSignal): Promise<ProbeResult> {
  const { timeoutSeconds } = body;
  const timeoutMilliseconds = timeoutSeconds * MILLISECONDS_PER_SECOND;
  const limit = AbortSignal.any([stop, AbortSignal.timeout(timeoutMilliseconds)]);
  const startedAt = performance.now();
  const asked = ask(body, limit, timeoutMilliseconds);
  const stopped = untilAborted(limit, PROBE_TEXT.timedOut(timeoutSeconds));
  try {
    const answer = await Promise.race([asked, stopped.aborted]);
    const { problem, certificate } = answer;
    const latencyMilliseconds = Math.round(performance.now() - startedAt);
    return {
      ok: problem === null,
      latencyMilliseconds: problem === null ? latencyMilliseconds : null,
      problem,
      ...(certificate === undefined ? {} : { certificate }),
    };
  } catch (error) {
    asked.catch(() => undefined);
    const problem = limit.aborted ? PROBE_TEXT.timedOut(timeoutSeconds) : describeError(error);
    return { ok: false, latencyMilliseconds: null, problem: problem.slice(0, PROBE_LIMITS.problemCharacters) };
  } finally {
    stopped.forget();
  }
}
