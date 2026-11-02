import {
  APT_HISTORY,
  PACKAGE_NAME_CHARACTERS,
  PACKAGE_NAME_PATTERN,
  MILLISECONDS_PER_DAY,
  PACKAGE_VERSION_CHARACTERS,
  PACKAGE_VERSION_PATTERN,
  UNATTENDED_UPGRADE_COMMAND,
} from "../shared/constants.js";
import type { PackageChange } from "../shared/protocol.js";
import { instantOf } from "../shared/time-zones.js";

const { fields } = APT_HISTORY;

interface ListedPackage {
  name: string;
  // The versions apt wrote in brackets: "old, new" for an upgrade, "version" or "version, automatic" else.
  versions: string[];
}

const isPackageName = (name: string) => name.length <= PACKAGE_NAME_CHARACTERS && PACKAGE_NAME_PATTERN.test(name);
const isVersion = (version: string) =>
  version.length <= PACKAGE_VERSION_CHARACTERS && PACKAGE_VERSION_PATTERN.test(version);

// "openssl:amd64 (3.0.13-0ubuntu3.4, 3.0.13-0ubuntu3.5), curl:amd64 (8.5.0-2ubuntu10.6)"
function listedPackages(value: string | undefined): ListedPackage[] {
  return [...(value ?? "").matchAll(APT_HISTORY.package)]
    .map(([, qualified = "", versions = ""]) => ({
      name: qualified.split(APT_HISTORY.architectureSeparator)[0]!,
      versions: versions.split(APT_HISTORY.versionSeparator),
    }))
    .filter(({ name }) => isPackageName(name));
}

function fieldsOf(entry: string): Map<string, string> {
  const pairs = entry.split("\n").map((line): [string, string] => {
    const separator = line.indexOf(APT_HISTORY.fieldSeparator);
    return separator === -1
      ? ["", ""]
      : [line.slice(0, separator), line.slice(separator + APT_HISTORY.fieldSeparator.length).trim()];
  });
  return new Map(pairs);
}

// apt writes the host's local time without saying which zone that is.
function instantIn(date: string | undefined, timeZone: string): number | null {
  const parts = APT_HISTORY.date.exec(date ?? "");
  if (parts === null) {
    return null;
  }
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return instantOf({ year, month, day, hour, minute, second }, timeZone);
}

function changeOf(entry: string, timeZone: string): PackageChange | null {
  const values = fieldsOf(entry);
  // An interrupted run has no end: when it started is the best there is.
  const endedAt = instantIn(values.get(fields.end) ?? values.get(fields.start), timeZone);
  if (endedAt === null) {
    return null;
  }
  const upgraded = listedPackages(values.get(fields.upgrade));
  const removed = [...listedPackages(values.get(fields.remove)), ...listedPackages(values.get(fields.purge))];
  return {
    endedAt,
    byUnattendedUpgrades: (values.get(fields.command) ?? "").includes(UNATTENDED_UPGRADE_COMMAND),
    upgraded: upgraded
      .map(({ name, versions }) => ({ name, version: versions.at(-1)?.trim() ?? "" }))
      .filter(({ version }) => isVersion(version))
      .slice(0, APT_HISTORY.packagesPerEntry),
    upgradedCount: upgraded.length,
    installed: listedPackages(values.get(fields.install))
      .map(({ name }) => name)
      .slice(0, APT_HISTORY.packagesPerEntry),
    removed: removed.map(({ name }) => name).slice(0, APT_HISTORY.packagesPerEntry),
  };
}

/** apt's own record of what it changed in the last week, newest first: from history.log's text. */
export function recentPackageChanges(history: string, timeZone: string, now: number): PackageChange[] {
  const since = now - APT_HISTORY.days * MILLISECONDS_PER_DAY;
  return history
    .split(APT_HISTORY.entrySeparator)
    .map((entry) => changeOf(entry, timeZone))
    .filter((change): change is PackageChange => change !== null && change.endedAt >= since)
    .sort((first, second) => second.endedAt - first.endedAt)
    .slice(0, APT_HISTORY.entries);
}
