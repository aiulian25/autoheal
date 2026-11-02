import { join } from "node:path";
import {
  APT_HISTORY,
  DNF_AUTOMATIC_APPLY,
  DNF_AUTOMATIC_TIMERS,
  PACKAGE_NAME_CHARACTERS,
  PACKAGE_NAME_PATTERN,
  FALLBACK_TIME_ZONE,
  HOST_FILES,
  HOST_PACKAGE_MANAGER,
  KERNEL_VERSION_PREFIX,
  OS_RELEASE_ID_KEY,
  OS_RELEASE_VALUE_CHARACTERS,
  OS_RELEASE_VERSION_KEY,
  PACKAGES_UNSUPPORTED,
  REBOOT_PACKAGES_LIMIT,
  RPM_KERNEL_ARCHITECTURE,
  TIME_ZONE_CHARACTERS,
  UNATTENDED_UPGRADE_OFF,
  UNATTENDED_UPGRADE_SETTING,
  ZONEINFO_MARKER,
  type HostPackageManager,
  type HostPackagesSetting,
  type PackagesUnsupported,
} from "../shared/constants.js";
import type { PackageFacts } from "../shared/protocol.js";
import { isTimeZone } from "../shared/time-zones.js";
import { recentPackageChanges } from "./apt-history.js";
import { LOCAL_HOST_FILES, osReleaseValue, type HostFiles } from "./host-files.js";

export interface PackageFactsSettings {
  // The host's own filesystem, mounted read-only into the runner's container.
  hostRoot: string;
  setting: HostPackagesSetting;
  // The running kernel: the host's own, even inside a container.
  runningKernel: string;
  // How the host's files are read; its mount here unless given.
  files?: HostFiles;
}

type PackageSupport =
  | { manager: HostPackageManager; unsupported: null }
  | { manager: HostPackageManager | null; unsupported: PackagesUnsupported };

async function managerOf(host: (file: string) => string, files: HostFiles): Promise<HostPackageManager | null> {
  if (await files.exists(host(HOST_FILES.aptGet))) {
    return HOST_PACKAGE_MANAGER.apt;
  }
  return (await files.exists(host(HOST_FILES.dnf))) ? HOST_PACKAGE_MANAGER.dnf : null;
}

/**
 * apt or dnf, whichever the host has, or why its packages are out of reach: neither, not booted by
 * systemd, or no D-Bus socket.
 */
export async function packageSupport(
  host: (file: string) => string,
  files: HostFiles = LOCAL_HOST_FILES,
): Promise<PackageSupport> {
  const manager = await managerOf(host, files);
  if (manager === null) {
    return { manager, unsupported: PACKAGES_UNSUPPORTED.noPackageManager };
  }
  if (!(await files.exists(host(HOST_FILES.systemdBooted)))) {
    return { manager, unsupported: PACKAGES_UNSUPPORTED.noSystemd };
  }
  if (!(await files.exists(host(HOST_FILES.dbusSocket)))) {
    return { manager, unsupported: PACKAGES_UNSUPPORTED.noDbus };
  }
  return { manager, unsupported: null };
}

const usableZone = (name: string | undefined) =>
  name !== undefined && name.length <= TIME_ZONE_CHARACTERS && isTimeZone(name) ? name : null;

/** Debian's /etc/timezone, else the zone /etc/localtime links to; never what the runner's own clock says. */
async function timeZoneOf(host: (file: string) => string, files: HostFiles): Promise<string | null> {
  const named = usableZone((await files.readText(host(HOST_FILES.timeZone)))?.trim());
  if (named !== null) {
    return named;
  }
  const link = (await files.readlink(host(HOST_FILES.localTime))) ?? "";
  const marker = link.lastIndexOf(ZONEINFO_MARKER);
  return marker === -1 ? null : usableZone(link.slice(marker + ZONEINFO_MARKER.length));
}

// On only where it is installed and apt's configuration says so; the last file to set it wins.
async function unattendedUpgradesOn(host: (file: string) => string, files: HostFiles): Promise<boolean> {
  if (!(await files.exists(host(HOST_FILES.unattendedUpgrade)))) {
    return false;
  }
  const directory = host(HOST_FILES.aptConfiguration);
  const names = (await files.list(directory)).sort();
  const contents = await Promise.all(names.map((file) => files.readText(join(directory, file))));
  const settings = contents.flatMap((text) => [...(text ?? "").matchAll(UNATTENDED_UPGRADE_SETTING)]);
  const last = settings.at(-1)?.[1];
  return last !== undefined && last !== UNATTENDED_UPGRADE_OFF;
}

// Its install timer always installs; its plain one only when automatic.conf says apply_updates.
async function dnfAutomaticInstalls(host: (file: string) => string, files: HostFiles): Promise<boolean> {
  const enabled = (timers: readonly string[]) =>
    Promise.all(timers.map((timer) => files.exists(host(join(HOST_FILES.enabledTimers, timer)))));
  if ((await enabled(DNF_AUTOMATIC_TIMERS.installs)).some(Boolean)) {
    return true;
  }
  if (!(await enabled(DNF_AUTOMATIC_TIMERS.configured)).some(Boolean)) {
    return false;
  }
  return DNF_AUTOMATIC_APPLY.test((await files.readText(host(HOST_FILES.dnfAutomaticConfiguration))) ?? "");
}

function releaseOf(osRelease: string | null): PackageFacts["release"] {
  const id = osReleaseValue(osRelease, OS_RELEASE_ID_KEY);
  const versionId = osReleaseValue(osRelease, OS_RELEASE_VERSION_KEY);
  if (id === null || versionId === null) {
    return null;
  }
  return { id: id.slice(0, OS_RELEASE_VALUE_CHARACTERS), versionId: versionId.slice(0, OS_RELEASE_VALUE_CHARACTERS) };
}

function packageNamesIn(text: string | null): string[] {
  const names = (text ?? "").split("\n").map((line) => line.trim());
  const valid = names.filter((name) => name.length <= PACKAGE_NAME_CHARACTERS && PACKAGE_NAME_PATTERN.test(name));
  return [...new Set(valid)].slice(0, REBOOT_PACKAGES_LIMIT);
}

const flavourOf = (kernel: string) =>
  RPM_KERNEL_ARCHITECTURE.exec(kernel)?.[1] ?? kernel.replace(KERNEL_VERSION_PREFIX, "");
const newerFirst = (first: string, second: string) => second.localeCompare(first, undefined, { numeric: true });

/**
 * A kernel installed that is newer than the running one, of the same flavour: it starts at the next boot.
 * ponytail: versions are compared as text with numbers in it, which fits Debian's, Ubuntu's, the
 * Raspberry Pi's and RPM's kernel names; an unusual scheme reads as no kernel waiting, never as a false one.
 */
async function kernelWaitingOf(
  host: (file: string) => string,
  running: string,
  files: HostFiles,
): Promise<string | null> {
  for (const directory of HOST_FILES.kernelModules) {
    const installed = await files.list(host(directory));
    const newer = installed
      .filter((kernel) => flavourOf(kernel) === flavourOf(running) && newerFirst(kernel, running) < 0)
      .sort(newerFirst);
    if (installed.length > 0) {
      return newer[0] ?? null;
    }
  }
  return null;
}

/**
 * What the host's own files say about its packages, read-only: nothing runs on the host.
 * ponytail: what changed lately comes from apt's history only; dnf hosts show none, read dnf's history
 * database when that is missed.
 */
export async function readPackageFacts(settings: PackageFactsSettings, now = Date.now()): Promise<PackageFacts> {
  const host = (file: string) => join(settings.hostRoot, file);
  const files = settings.files ?? LOCAL_HOST_FILES;
  const { manager, unsupported } = await packageSupport(host, files);
  const timeZone = await timeZoneOf(host, files);
  const history = await files.readEnd(host(HOST_FILES.aptHistory), APT_HISTORY.readBytes);
  return {
    setting: settings.setting,
    unsupported,
    manager,
    release: releaseOf(await files.readText(host(HOST_FILES.osRelease))),
    proxmox: await files.exists(host(HOST_FILES.proxmox)),
    unattendedUpgrades:
      manager === HOST_PACKAGE_MANAGER.dnf
        ? await dnfAutomaticInstalls(host, files)
        : await unattendedUpgradesOn(host, files),
    rebootPackages: packageNamesIn(await files.readText(host(HOST_FILES.rebootPackages))),
    kernelWaiting: await kernelWaitingOf(host, settings.runningKernel, files),
    timeZone,
    recentChanges: recentPackageChanges(history ?? "", timeZone ?? FALLBACK_TIME_ZONE, now),
  };
}
