import type { LifecycleView } from "../../shared/api.js";
import {
  DEBIAN_RELEASE_ID,
  LIFECYCLE_ENDING_DAYS,
  LIFECYCLE_PRODUCTS,
  LIFECYCLE_STATUS,
  MILLISECONDS_PER_DAY,
  PROXMOX_DEBIAN_OFFSET,
  PROXMOX_PRODUCT,
  RELEASE_NAMES,
  VERSION_SEPARATOR,
  type LifecycleStatus,
} from "../../shared/constants.js";
import type { PackageFacts } from "../../shared/protocol.js";
import { DISTRIBUTION_LIFECYCLE, type ReleaseLifecycle } from "./distribution-lifecycle.js";

// endoflife.date's product and release; a Proxmox VE node counts by Proxmox's release, not Debian's.
function productOf(release: NonNullable<PackageFacts["release"]>, proxmox: boolean) {
  const major = release.versionId.split(VERSION_SEPARATOR)[0] ?? "";
  if (proxmox && release.id === DEBIAN_RELEASE_ID) {
    return { product: PROXMOX_PRODUCT, version: String(Number(major) - PROXMOX_DEBIAN_OFFSET) };
  }
  return { product: LIFECYCLE_PRODUCTS[release.id] ?? null, version: release.versionId };
}

// RHEL 9.6 is release 9 to endoflife.date, Ubuntu 24.04 is 24.04.
function cycleOf(product: string, version: string): ReleaseLifecycle | null {
  const cycles = DISTRIBUTION_LIFECYCLE[product] ?? [];
  const major = version.split(VERSION_SEPARATOR)[0];
  return cycles.find(({ cycle }) => cycle === version) ?? cycles.find(({ cycle }) => cycle === major) ?? null;
}

const ended = (until: string | boolean, now: number) =>
  until === true || (typeof until === "string" && Date.parse(until) <= now);
const dayOf = (until: string | boolean) => (typeof until === "string" ? until : null);

function statusOf({ eol, extendedSupport }: ReleaseLifecycle, now: number): LifecycleStatus {
  if (ended(eol, now)) {
    const extendedLeft = extendedSupport !== false && !ended(extendedSupport, now);
    return extendedLeft ? LIFECYCLE_STATUS.extended : LIFECYCLE_STATUS.unsupported;
  }
  const endsSoon = typeof eol === "string" && Date.parse(eol) - now <= LIFECYCLE_ENDING_DAYS * MILLISECONDS_PER_DAY;
  return endsSoon ? LIFECYCLE_STATUS.ending : LIFECYCLE_STATUS.supported;
}

/** How long the host's release gets security fixes; null when endoflife.date doesn't know it. */
export function lifecycleOf(facts: PackageFacts | null, now: number): LifecycleView | null {
  const release = facts?.release ?? null;
  if (release === null) {
    return null;
  }
  const { product, version } = productOf(release, facts?.proxmox === true);
  const cycle = product === null ? null : cycleOf(product, version);
  if (product === null || cycle === null) {
    return null;
  }
  return {
    release: `${RELEASE_NAMES[product] ?? product} ${cycle.cycle}`,
    status: statusOf(cycle, now),
    securityUntil: dayOf(cycle.eol),
    extendedUntil: dayOf(cycle.extendedSupport),
  };
}
