#!/usr/bin/env node
// Writes how long each release of the distributions Autoheal looks after gets security fixes, from
// endoflife.date, into the control plane's source. Run it now and then, and before a release:
//   node scripts/update-lifecycle.mjs && npm run prettier-format
import { writeFile } from "node:fs/promises";

const SOURCE = "https://endoflife.date/api";
const PRODUCTS = [
  "debian",
  "ubuntu",
  "proxmox-ve",
  "fedora",
  "rhel",
  "almalinux",
  "rocky-linux",
  "centos-stream",
  "oracle-linux",
];
const TARGET = new URL("../src/control-plane/host-packages/distribution-lifecycle.ts", import.meta.url);
const DATE_LENGTH = "2026-10-22".length;

async function cyclesOf(product) {
  const response = await fetch(`${SOURCE}/${product}.json`);
  if (!response.ok) {
    throw new Error(`${product}: endoflife.date answered ${response.status}`);
  }
  const cycles = await response.json();
  return cycles.map(({ cycle, eol, extendedSupport }) => ({
    cycle: String(cycle),
    eol: eol ?? false,
    extendedSupport: extendedSupport ?? false,
  }));
}

const catalog = Object.fromEntries(
  await Promise.all(PRODUCTS.map(async (product) => [product, await cyclesOf(product)])),
);
const today = new Date().toISOString().slice(0, DATE_LENGTH);
await writeFile(
  TARGET,
  `// Written by scripts/update-lifecycle.mjs from endoflife.date on ${today}: run it again to refresh.
// eol is the end of free security fixes; extendedSupport, of paid or subscription support after it.
// false means no date was announced yet, true that it ended on a date endoflife.date doesn't give.

// The day these dates were read: the host's page shows it beside them.
export const LIFECYCLE_DATES_AS_OF = "${today}";

export interface ReleaseLifecycle {
  cycle: string;
  eol: string | boolean;
  extendedSupport: string | boolean;
}

export const DISTRIBUTION_LIFECYCLE: Record<string, readonly ReleaseLifecycle[]> = ${JSON.stringify(catalog)};
`,
);
console.log(`wrote ${PRODUCTS.length} distributions to ${TARGET.pathname}`);
