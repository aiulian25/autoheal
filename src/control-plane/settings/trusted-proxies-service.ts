import { BlockList, isIPv6, type IPVersion } from "node:net";
import { z } from "zod";
import { proxyAddress } from "../../config/control-plane-config.js";
import { API_ERRORS, type TrustedProxiesView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  INTEGRATION_SOURCES,
  SETTING_KEYS,
  TARGET_SETTING,
  type IntegrationSource,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { DomainError } from "../domain-error.js";
import type { SettingsStore } from "./settings-store.js";

const storedSchema = z.array(proxyAddress);

const familyOf = (address: string): IPVersion => (isIPv6(address) ? "ipv6" : "ipv4");

/** "172.16.0.0/12" as its address, its prefix (null for a single address) and its family. */
export function partsOf(entry: string) {
  const [address, prefix] = entry.split("/") as [string, string | undefined];
  return { address, prefix: prefix === undefined ? null : Number(prefix), family: familyOf(address) };
}

// Entries already checked, by the .env's rules or the route's; IPv4 written as IPv6 matches its IPv4 entry.
function blockListOf(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const { address, prefix, family } = partsOf(entry);
    if (prefix === null) {
      list.addAddress(address, family);
    } else {
      list.addSubnet(address, prefix, family);
    }
  }
  return list;
}

/** How one request reached the dashboard, as its connection and its X-Forwarded-For header say. */
export interface Arrival {
  peer: string;
  forwardedFor: string | null;
  seenAs: string;
}

/**
 * The proxies whose word on a request's client is taken: the .env's list, which wins, or the one set in
 * Settings. Through one of them a request counts as from its client's address (in the sign-in throttle,
 * sessions and the audit log); any other sender is taken as the client itself. A change applies from the
 * next request on.
 */
export class TrustedProxiesService {
  private trusted: BlockList;

  constructor(
    private readonly store: SettingsStore,
    private readonly auditLog: AuditLog,
    private readonly fromEnvironment: readonly string[],
  ) {
    this.trusted = blockListOf(this.addresses());
  }

  reload() {
    this.trusted = blockListOf(this.addresses());
  }

  addresses(): string[] {
    if (this.fromEnvironment.length > 0) {
      return [...this.fromEnvironment];
    }
    return this.store.read(SETTING_KEYS.trustedProxies, storedSchema) ?? [];
  }

  // Asked by the server for every request, so it is bound and never reads the database.
  isTrusted = (address: string): boolean => this.trusted.check(address, familyOf(address));

  view(arrival: Arrival): TrustedProxiesView {
    return { source: this.source(), addresses: this.addresses(), ...arrival };
  }

  save(actor: Actor, addresses: string[]) {
    if (this.fromEnvironment.length > 0) {
      throw new DomainError(API_ERRORS.trustedProxiesFromEnvironment);
    }
    this.store.write(SETTING_KEYS.trustedProxies, addresses);
    this.trusted = blockListOf(addresses);
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.trustedProxiesSaved,
      { kind: TARGET_SETTING, id: SETTING_KEYS.trustedProxies },
      { addresses },
    );
  }

  private source(): IntegrationSource | null {
    if (this.fromEnvironment.length > 0) {
      return INTEGRATION_SOURCES.environment;
    }
    return this.store.read(SETTING_KEYS.trustedProxies, storedSchema) === null ? null : INTEGRATION_SOURCES.dashboard;
  }
}
