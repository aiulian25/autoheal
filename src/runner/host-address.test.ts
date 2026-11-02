import { describe, expect, it } from "vitest";
import { primaryAddress } from "./host-address.js";

// A workstation's tables as its kernel prints them: Wi-Fi to the router, and Docker's bridges, one of
// them in 192.168 too.
const ROUTES = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "wlo1\t00000000\t010AA8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
  "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  "br-2d7b026b59cf\t0010A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0",
  "wlo1\t000AA8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0",
].join("\n");

const LOCAL = `Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
     |-- 192.168.10.0
        /24 link UNICAST
Local:
  +-- 0.0.0.0/0 3 0 5
     +-- 127.0.0.0/8 2 0 2
           |-- 127.0.0.1
              /32 host LOCAL
     +-- 172.16.0.0/12 5 0 6
        |-- 172.17.0.1
           /32 host LOCAL
     +-- 192.168.0.0/16 3 1 2
           +-- 192.168.10.0/24 2 0 2
              |-- 192.168.10.83
                 /32 host LOCAL
              |-- 192.168.10.255
                 /32 link BROADCAST
           |-- 192.168.16.1
              /32 host LOCAL
`;

describe("the host's address", () => {
  it("is its own address in the subnet its default route leaves by", () => {
    expect(primaryAddress(ROUTES, LOCAL)).toBe("192.168.10.83");
  });

  it("is unknown without a default route, or without an address on its way out", () => {
    const withoutDefault = ROUTES.split("\n")
      .filter((line) => !line.includes("\t00000000\t010AA8C0"))
      .join("\n");
    expect(primaryAddress(withoutDefault, LOCAL)).toBeNull();
    expect(primaryAddress(ROUTES, LOCAL.replace("192.168.10.83", "192.168.20.83"))).toBeNull();
  });
});
