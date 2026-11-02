import {
  CONTAINER_RUNTIME_PACKAGES,
  CORE_SYSTEM_PACKAGES,
  DATA_PACKAGE_PREFIXES,
  DISTRIBUTION_ORIGINS,
  DNF_DISTRIBUTION_REPOSITORIES,
  HELD_PACKAGE_KINDS,
  HOST_PACKAGES,
  KERNEL_PACKAGE_PREFIXES,
  ORIGIN_LABEL_SEPARATOR,
  ORIGIN_SUITE_SEPARATOR,
  PACKAGE_KIND,
  SECURITY_LABEL_WORD,
  SECURITY_SUITE_SUFFIX,
  type PackageKind,
} from "../../shared/constants.js";
import type { PackageCheck, PackageFacts, PackageUpdate } from "../../shared/protocol.js";

/** One package an upgrade would change, sorted by the rules. */
export interface AssessedPackage {
  name: string;
  installed: string;
  candidate: string;
  security: boolean;
  kind: PackageKind;
  held: boolean;
  summary: string | null;
  source: string | null;
}

/** Who takes care of each pending package on one host. */
export interface PackagePlan {
  packages: AssessedPackage[];
  keptBack: AssessedPackage[];
  // What nothing needs any more; removing it is always a person's call.
  removable: PackageCheck["removable"];
  // dnf's word that a reboot is needed; apt hosts say so in their own files.
  rebootRequired: boolean;
  // Security fixes nothing holds back: Autoheal installs them in the host's window.
  automatic: string[];
  // Where unattended-upgrades is on, the distribution's security fixes are its to install.
  unattended: string[];
  // Everything else waits for a person.
  forPerson: string[];
}

interface OriginParts {
  label: string;
  suite: string;
}

// "Debian-Security:13/stable-security" is the label Debian-Security and the suite stable-security.
function originParts(origin: string): OriginParts {
  const separator = origin.indexOf(ORIGIN_LABEL_SEPARATOR);
  const label = separator === -1 ? origin : origin.slice(0, separator);
  const rest = separator === -1 ? "" : origin.slice(separator + 1);
  return { label, suite: rest.slice(rest.lastIndexOf(ORIGIN_SUITE_SEPARATOR) + 1) };
}

const isDistributionLabel = (label: string) => (DISTRIBUTION_ORIGINS as readonly string[]).includes(label);

// apt's origin labels, or dnf's repository ids.
const fromDistribution = (origins: readonly string[]) =>
  origins.some((origin) => {
    const { label } = originParts(origin);
    return isDistributionLabel(label) || DNF_DISTRIBUTION_REPOSITORIES.test(label);
  });

const isSecurityOrigin = ({ label, suite }: OriginParts) =>
  suite.endsWith(SECURITY_SUITE_SUFFIX) || label.includes(SECURITY_LABEL_WORD);

export const isSecurityFix = (origins: readonly string[]) => origins.map(originParts).some(isSecurityOrigin);

// dnf knows a security fix by its advisory; apt by the archive it comes from.
const securityOf = (update: PackageUpdate) => update.security ?? isSecurityFix(update.origins);

// Where the new version comes from: the distribution's own suite (noble-security),
// another archive's label (Docker CE), dnf's repository id. A fix in -updates and -security too is a
// security fix.
function sourceOf(update: PackageUpdate, security: boolean): string | null {
  const origins = update.origins.map(originParts);
  const shown = (security ? origins.find(isSecurityOrigin) : undefined) ?? origins[0];
  if (shown === undefined) {
    return null;
  }
  return isDistributionLabel(shown.label) && shown.suite !== "" ? shown.suite : shown.label;
}

// libc6:i386 is libc6 to the rules.
const baseName = (name: string) => name.split(ORIGIN_LABEL_SEPARATOR)[0]!;
const startsWithAny = (name: string, prefixes: readonly string[]) => prefixes.some((prefix) => name.startsWith(prefix));

/** The first rule that fits, in order of how much a mistake would cost. */
export function kindOf(update: PackageUpdate, keepsData: (name: string) => boolean): PackageKind {
  const name = baseName(update.name);
  if (CONTAINER_RUNTIME_PACKAGES.has(name)) {
    return PACKAGE_KIND.containerRuntime;
  }
  if (CORE_SYSTEM_PACKAGES.has(name)) {
    return PACKAGE_KIND.coreSystem;
  }
  if (!fromDistribution(update.origins)) {
    return PACKAGE_KIND.thirdParty;
  }
  if (startsWithAny(name, DATA_PACKAGE_PREFIXES) || keepsData(name)) {
    return PACKAGE_KIND.keepsData;
  }
  return startsWithAny(name, KERNEL_PACKAGE_PREFIXES) ? PACKAGE_KIND.kernel : PACKAGE_KIND.routine;
}

export function assess(update: PackageUpdate, keepsData: (name: string) => boolean): AssessedPackage {
  const kind = kindOf(update, keepsData);
  const security = securityOf(update);
  return {
    name: update.name,
    installed: update.installed,
    candidate: update.candidate,
    security,
    kind,
    held: HELD_PACKAGE_KINDS.has(kind),
    summary: update.summary ?? null,
    source: sourceOf(update, security),
  };
}

/**
 * Who takes care of what is pending. Autoheal installs by itself only on a host whose .env allows it,
 * only security fixes the rules don't hold, only when the owner chose the window, and never where
 * unattended-upgrades or dnf-automatic already does that work.
 * ponytail: dnf-automatic set to install everything still shows the rest as waiting for a person; read
 * its upgrade_type when that matters.
 */
export function planFor(
  check: PackageCheck,
  facts: PackageFacts | null,
  securityInWindow: boolean,
  keepsData: (name: string) => boolean,
): PackagePlan {
  const packages = check.upgradable.map((update) => assess(update, keepsData));
  const unattendedOn = facts?.unattendedUpgrades === true;
  const mayInstall = facts?.setting === HOST_PACKAGES.apply && securityInWindow && !unattendedOn;
  const unattended = unattendedOn
    ? check.upgradable
        .filter((update) => securityOf(update) && fromDistribution(update.origins))
        .map(({ name }) => name)
    : [];
  const automatic = mayInstall
    ? packages.filter(({ security, held }) => security && !held).map(({ name }) => name)
    : [];
  const handled = new Set([...unattended, ...automatic]);
  return {
    packages,
    keptBack: check.keptBack.map((update) => assess(update, keepsData)),
    removable: check.removable,
    rebootRequired: check.rebootRequired === true,
    automatic,
    unattended,
    forPerson: packages.filter(({ name }) => !handled.has(name)).map(({ name }) => name),
  };
}
