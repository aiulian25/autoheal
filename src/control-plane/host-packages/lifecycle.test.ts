import { describe, expect, it } from "vitest";
import type { PackageFacts } from "../../shared/protocol.js";
import { DISTRIBUTION_LIFECYCLE } from "./distribution-lifecycle.js";
import { lifecycleOf } from "./lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;
const facts = (id: string, versionId: string, proxmox = false) =>
  ({ release: { id, versionId }, proxmox }) as PackageFacts;
// Dates from the catalog itself, so a newer one from endoflife.date changes nothing here.
const eolOf = (product: string, cycle: string) =>
  Date.parse(String(DISTRIBUTION_LIFECYCLE[product]?.find((entry) => entry.cycle === cycle)?.eol));

describe("how long a host's release gets security fixes", () => {
  it("finds a release by its whole version, else by its major one", () => {
    expect(lifecycleOf(facts("ubuntu", "24.04"), eolOf("ubuntu", "24.04") - 365 * DAY)).toMatchObject({
      release: "Ubuntu 24.04",
      status: "supported",
    });
    expect(lifecycleOf(facts("almalinux", "9.6"), eolOf("almalinux", "9") - 365 * DAY)?.release).toBe("AlmaLinux 9");
    expect(lifecycleOf(facts("raspbian", "12"), eolOf("debian", "12") - 365 * DAY)?.release).toBe("Debian 12");
  });

  it("warns half a year ahead, then tells extended support from none", () => {
    const debianEnd = eolOf("debian", "12");
    expect(lifecycleOf(facts("debian", "12"), debianEnd - 200 * DAY)?.status).toBe("supported");
    expect(lifecycleOf(facts("debian", "12"), debianEnd - 30 * DAY)?.status).toBe("ending");
    expect(lifecycleOf(facts("debian", "12"), debianEnd + DAY)).toMatchObject({
      status: "extended",
      securityUntil: new Date(debianEnd).toISOString().slice(0, "2028-06-30".length),
    });
    expect(lifecycleOf(facts("fedora", "42"), eolOf("fedora", "42") + DAY)?.status).toBe("unsupported");
  });

  it("counts a Proxmox VE node by Proxmox's own dates, not Debian's", () => {
    const proxmoxEnd = eolOf("proxmox-ve", "8");
    expect(lifecycleOf(facts("debian", "12", true), proxmoxEnd + DAY)).toMatchObject({
      release: "Proxmox VE 8",
      status: "unsupported",
    });
    expect(lifecycleOf(facts("debian", "12"), proxmoxEnd + DAY)?.status).toBe("supported");
  });

  it("knows nothing of a release endoflife.date doesn't list, or a host that did not say", () => {
    expect(lifecycleOf(facts("arch", "rolling"), Date.now())).toBeNull();
    expect(lifecycleOf(facts("debian", "99"), Date.now())).toBeNull();
    expect(lifecycleOf({ release: null } as unknown as PackageFacts, Date.now())).toBeNull();
    expect(lifecycleOf(null, Date.now())).toBeNull();
  });
});
