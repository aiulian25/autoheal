import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NETWORK_LIMITS } from "../../shared/network.js";

export type ResolveRouter = (host: string) => Promise<string[]>;

// The receiver listens on IPv4 alone, so only those addresses can ever send to it.
const IPV4 = 4;

export const lookupRouter: ResolveRouter = async (host) =>
  (await lookup(host, { all: true, family: IPV4 })).map(({ address }) => address);

/**
 * The addresses the router's log lines may come from. A router known by name has those its name has now: all of them,
 * and for a while only, so a name that moves or stops answering leaves nobody accepted, never everybody. A sender's
 * address is what the network claims, and proves nothing more than that.
 */
export class RouterLogSenders {
  private known: { host: string; addresses: ReadonlySet<string>; at: number } | null = null;
  private failing = false;

  constructor(
    private readonly host: () => string | null,
    private readonly clock: () => number,
    private readonly resolve: ResolveRouter = lookupRouter,
  ) {}

  allows(sender: string): boolean {
    const host = this.host();
    if (host === null) return false;
    if (isIP(host) !== 0) return sender === host;
    if (this.known?.host !== host) return false;
    const current = this.clock() - this.known.at < NETWORK_LIMITS.logSendersKeptMilliseconds;
    return current && this.known.addresses.has(sender);
  }

  get unresolved(): boolean {
    return this.failing;
  }

  /** Never fails, and ends within its limit: a name server that does not answer holds up nothing else. */
  async refresh(): Promise<void> {
    const host = this.host();
    if (host === null || isIP(host) !== 0) {
      this.known = null;
      this.failing = false;
      return;
    }
    const addresses = await this.lookedUp(host);
    this.failing = addresses === null || addresses.length === 0;
    if (!this.failing) this.known = { host, addresses: new Set(addresses), at: this.clock() };
  }

  private lookedUp(host: string): Promise<string[] | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), NETWORK_LIMITS.logSenderLookupMilliseconds);
      this.resolve(host)
        .catch(() => null)
        .then((addresses) => {
          clearTimeout(timer);
          resolve(addresses);
        });
    });
  }
}
