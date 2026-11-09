import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

// Names set aside for tests, examples and private networks (RFC 2606, 6761 and 6762, and ICANN's .internal), which
// tests use for services they make up.
const MADE_UP = /(^|\.)(test|example|invalid|local|internal)$|(^|\.)example\.(com|net|org)$/i;

/** True for a name a test made up: one that names nothing anywhere, so nothing outside this machine is asked. */
export const isMadeUp = (hostname: unknown) =>
  typeof hostname === "string" && MADE_UP.test(hostname.replace(/\.$/, ""));

const notFound = (hostname: string) =>
  Object.assign(new Error(`getaddrinfo ${dns.NOTFOUND} ${hostname}`), {
    code: dns.NOTFOUND,
    syscall: "getaddrinfo",
    hostname,
  });

/*
 * A made-up name is answered here, at once, as not found, which is what a resolver that keeps to those RFCs answers.
 * Asked of the network instead, a test retrying a made-up Home Assistant every few milliseconds sent the LAN's DNS over
 * a thousand lookups a minute, and its rate limit cut this machine off the internet.
 */
const lookup = dns.lookup;
const lookupPromise = dns.promises.lookup;
dns.lookup = function (this: unknown, hostname: string, ...rest: unknown[]) {
  if (!isMadeUp(hostname)) return Reflect.apply(lookup, this, [hostname, ...rest]);
  const callback = rest.at(-1) as (error: Error) => void;
  process.nextTick(() => callback(notFound(hostname)));
} as typeof dns.lookup;
dns.promises.lookup = async function (this: unknown, hostname: string, ...rest: unknown[]) {
  if (isMadeUp(hostname)) throw notFound(hostname);
  return Reflect.apply(lookupPromise, this, [hostname, ...rest]);
} as typeof dns.promises.lookup;
// What imports `lookup` from node:dns or node:dns/promises by name sees this one too.
syncBuiltinESMExports();
