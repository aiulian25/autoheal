import {
  BYTE_VALUES,
  HOST_FILES,
  IPV4_SEPARATOR,
  LOCAL_ADDRESS_LINE,
  LOCAL_ADDRESS_MARK,
  ROUTE_TABLE,
} from "../shared/constants.js";
import { LOCAL_HOST_FILES, type HostFiles } from "./host-files.js";

interface Subnet {
  destination: number;
  mask: number;
}

// The number the route table prints for an address: its first byte lowest, as in memory.
const routeNumberOf = (address: string) =>
  address.split(IPV4_SEPARATOR).reduceRight((value, byte) => value * BYTE_VALUES + Number(byte), 0);

/** The subnets on the interface the default route leaves by. */
function defaultSubnets(routeTable: string): Subnet[] {
  const routes = routeTable
    .split("\n")
    .slice(ROUTE_TABLE.headerLines)
    .map((line) => line.trim().split(ROUTE_TABLE.separator));
  const isDefault = (destination: string | undefined) => destination === ROUTE_TABLE.defaultDestination;
  const outward = routes.find(([, destination]) => isDefault(destination))?.[0];
  return routes
    .filter(([name, destination]) => name === outward && !isDefault(destination))
    .map(([, destination = "", , , , , , mask = ""]) => ({
      destination: Number.parseInt(destination, ROUTE_TABLE.radix),
      mask: Number.parseInt(mask, ROUTE_TABLE.radix),
    }));
}

/** The host's own IPv4 addresses, from the kernel's table of local ones. */
function localAddresses(fibTrie: string): string[] {
  const lines = fibTrie.split("\n");
  return lines.flatMap((line, index) => {
    const address = LOCAL_ADDRESS_LINE.exec(line)?.[1];
    return address !== undefined && lines[index + 1]?.trim() === LOCAL_ADDRESS_MARK ? [address] : [];
  });
}

/**
 * The host's address on its default route, the one the machines around it reach it at; null without one.
 * ponytail: IPv4 only, and only where the default route's interface has a subnet route; read the
 * interfaces' addresses over netlink if an IPv6-only host or a point-to-point link needs one.
 */
export function primaryAddress(routeTable: string, fibTrie: string): string | null {
  const subnets = defaultSubnets(routeTable);
  const inSubnet = (address: string) =>
    subnets.some(({ destination, mask }) => (routeNumberOf(address) & mask) >>> 0 === destination);
  return localAddresses(fibTrie).find(inSubnet) ?? null;
}

/** The same, read from the host's own /proc under its root. */
export async function hostAddress(
  host: (file: string) => string,
  files: HostFiles = LOCAL_HOST_FILES,
): Promise<string | null> {
  const [routeTable, fibTrie] = await Promise.all([
    files.readText(host(HOST_FILES.routes)),
    files.readText(host(HOST_FILES.localAddresses)),
  ]);
  return routeTable === null || fibTrie === null ? null : primaryAddress(routeTable, fibTrie);
}
