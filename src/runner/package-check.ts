import {
  APT_ORIGIN_SEPARATOR,
  APT_SIMULATED_INSTALL,
  APT_SIMULATED_REMOVE,
  DNF_FORMAT,
  DNF_REBOOT_NEEDED_EXIT,
  DNF_REBOOT_NEEDED_TEXT,
  ERROR_TEXT_LIMIT,
  HOST_PACKAGE_CHECK_SECTION,
  HOST_PACKAGE_EXIT_MARK,
  HOST_PACKAGE_LIMIT,
  HOST_PACKAGE_MANAGER,
  HOST_PACKAGE_SECTION_MARK,
  PACKAGE_ARCHITECTURE_SEPARATOR,
  PACKAGE_ERROR_PREFIXES,
  PACKAGE_NAME_CHARACTERS,
  PACKAGE_NAME_PATTERN,
  PACKAGE_ORIGIN_CHARACTERS,
  PACKAGE_ORIGINS_PER_PACKAGE,
  PACKAGE_SUMMARY_CHARACTERS,
  PACKAGE_SUMMARY_SEPARATOR,
  PACKAGE_VERSION_CHARACTERS,
  PACKAGE_VERSION_PATTERN,
  type HostPackageManager,
} from "../shared/constants.js";
import type { PackageCheck, PackageUpdate } from "../shared/protocol.js";

interface Section {
  lines: string[];
  // Null when the log ends before the section does.
  exitCode: number | null;
}

type Sections = Map<string, Section>;
type Removable = PackageCheck["removable"][number];

/** The check's log, cut into its sections: "== name", what the command printed, "== exit <code>". */
function sectionsOf(log: string): Sections {
  const sections: Sections = new Map();
  let current: Section | null = null;
  for (const line of log.split("\n")) {
    if (line.startsWith(HOST_PACKAGE_EXIT_MARK) && current !== null) {
      current.exitCode = Number(line.slice(HOST_PACKAGE_EXIT_MARK.length));
      current = null;
      continue;
    }
    if (line.startsWith(HOST_PACKAGE_SECTION_MARK)) {
      current = { lines: [], exitCode: null };
      sections.set(line.slice(HOST_PACKAGE_SECTION_MARK.length).trim(), current);
      continue;
    }
    current?.lines.push(line);
  }
  return sections;
}

const fits = (text: string, limit: number, pattern: RegExp) => text.length <= limit && pattern.test(text);
const isName = (text: string) => fits(text, PACKAGE_NAME_CHARACTERS, PACKAGE_NAME_PATTERN);
const isVersion = (text: string) => fits(text, PACKAGE_VERSION_CHARACTERS, PACKAGE_VERSION_PATTERN);
const isNewer = (version: string, than: string) => version.localeCompare(than, undefined, { numeric: true }) > 0;
const isPresent = <Value>(value: Value | null): value is Value => value !== null;
const printedIn = (lines: readonly string[]) => lines.map((line) => line.trim()).filter((line) => line !== "");

/** What went wrong, in the package manager's own words: its last error line, or its last line at all. */
export function problemIn(log: string): string {
  const printed = printedIn(log.split("\n"));
  const errors = printed.filter((line) => PACKAGE_ERROR_PREFIXES.some((prefix) => line.startsWith(prefix)));
  return (errors.at(-1) ?? printed.at(-1) ?? "").slice(0, ERROR_TEXT_LIMIT);
}

// A refresh that failed still leaves a result, from the lists the host had.
function refreshOf(refresh: Section | undefined): Pick<PackageCheck, "refreshed" | "refreshProblem"> {
  const refreshed = refresh?.exitCode === 0;
  if (refreshed || refresh === undefined) {
    return { refreshed, refreshProblem: null };
  }
  return { refreshed, refreshProblem: problemIn(refresh.lines.join("\n")) || `exit ${refresh.exitCode}` };
}

function aptUpdateOf(line: string): PackageUpdate | null {
  const [, name = "", installed = "", candidate = "", origins = ""] = APT_SIMULATED_INSTALL.exec(line) ?? [];
  if (!isName(name) || !isVersion(installed) || !isVersion(candidate)) {
    return null;
  }
  return {
    name,
    installed,
    candidate,
    origins: origins
      .split(APT_ORIGIN_SEPARATOR)
      .map((origin) => origin.slice(0, PACKAGE_ORIGIN_CHARACTERS))
      .slice(0, PACKAGE_ORIGINS_PER_PACKAGE),
  };
}

function aptRemovableOf(line: string): Removable | null {
  const [, name = "", installed = ""] = APT_SIMULATED_REMOVE.exec(line) ?? [];
  return isName(name) && isVersion(installed) ? { name, installed } : null;
}

const aptUpdatesIn = (section: Section | undefined) => (section?.lines ?? []).map(aptUpdateOf).filter(isPresent);

// "name summary", a package to a line; a name's first summary is kept.
function summariesIn(section: Section | undefined): Map<string, string> {
  const summaries = new Map<string, string>();
  for (const line of printedIn(section?.lines ?? [])) {
    const separator = line.indexOf(PACKAGE_SUMMARY_SEPARATOR);
    const name = line.slice(0, separator);
    if (separator > 0 && isName(name) && !summaries.has(name)) {
      summaries.set(
        name,
        line
          .slice(separator + 1)
          .trim()
          .slice(0, PACKAGE_SUMMARY_CHARACTERS),
      );
    }
  }
  return summaries;
}

// dpkg names libc6:i386 plain libc6.
const describedBy = (summaries: ReadonlyMap<string, string>) => (update: PackageUpdate) => {
  const summary =
    summaries.get(update.name) ?? summaries.get(update.name.split(PACKAGE_ARCHITECTURE_SEPARATOR)[0] ?? "");
  return summary === undefined ? update : { ...update, summary };
};

/** apt's simulations. Kept back is what a full upgrade would change but a plain one leaves alone. */
function parseAptCheck(sections: Sections): PackageCheck {
  const described = describedBy(summariesIn(sections.get(HOST_PACKAGE_CHECK_SECTION.summaries)));
  const upgradable = aptUpdatesIn(sections.get(HOST_PACKAGE_CHECK_SECTION.upgrade)).map(described);
  const offered = new Set(upgradable.map(({ name }) => name));
  const removals = sections.get(HOST_PACKAGE_CHECK_SECTION.autoremove)?.lines ?? [];
  return {
    ...refreshOf(sections.get(HOST_PACKAGE_CHECK_SECTION.refresh)),
    needsRepair: printedIn(sections.get(HOST_PACKAGE_CHECK_SECTION.audit)?.lines ?? []).length > 0,
    upgradable: upgradable.slice(0, HOST_PACKAGE_LIMIT),
    keptBack: aptUpdatesIn(sections.get(HOST_PACKAGE_CHECK_SECTION.distUpgrade))
      .filter(({ name }) => !offered.has(name))
      .map(described)
      .slice(0, HOST_PACKAGE_LIMIT),
    removable: removals.map(aptRemovableOf).filter(isPresent).slice(0, HOST_PACKAGE_LIMIT),
    // The host's own files say it.
    rebootRequired: null,
  };
}

/**
 * The lines dnf printed in the given format, one per name with its newest version: a kernel is installed
 * once per version, and a package for two architectures (glibc) is upgraded by its name.
 */
function newestByName(section: Section | undefined, format: string): Map<string, readonly string[]> {
  const fieldCount = format.split(" ").length;
  const newest = new Map<string, readonly string[]>();
  for (const fields of printedIn(section?.lines ?? []).map((line) => line.split(" "))) {
    const [name = "", version = ""] = fields;
    const known = newest.get(name)?.[1];
    const wanted = fields.length === fieldCount && isName(name) && isVersion(version);
    if (wanted && (known === undefined || isNewer(version, known))) {
      newest.set(name, fields);
    }
  }
  return newest;
}

function rebootRequiredOf(section: Section | undefined): boolean | null {
  if (section?.exitCode === 0) {
    return false;
  }
  const said = printedIn(section?.lines ?? []).some((line) => line.startsWith(DNF_REBOOT_NEEDED_TEXT));
  return section?.exitCode === DNF_REBOOT_NEEDED_EXIT && said ? true : null;
}

/** dnf's answers: what is installed, what upgrades it and from where, which of it is a security fix. */
function parseDnfCheck(sections: Sections): PackageCheck {
  const section = (name: string) => sections.get(name);
  const installed = newestByName(section(HOST_PACKAGE_CHECK_SECTION.installed), DNF_FORMAT.installed);
  const security = new Set(printedIn(section(HOST_PACKAGE_CHECK_SECTION.security)?.lines ?? []));
  const upgrades = newestByName(section(HOST_PACKAGE_CHECK_SECTION.upgrades), DNF_FORMAT.upgrade);
  const described = describedBy(summariesIn(section(HOST_PACKAGE_CHECK_SECTION.summaries)));
  const upgradable = [...upgrades.values()].flatMap(([name = "", candidate = "", , repository = ""]) => {
    const current = installed.get(name)?.[1];
    if (current === undefined) {
      return [];
    }
    const origins = [repository.slice(0, PACKAGE_ORIGIN_CHARACTERS)];
    return [described({ name, installed: current, candidate, origins, security: security.has(name) })];
  });
  const unneeded = newestByName(section(HOST_PACKAGE_CHECK_SECTION.unneeded), DNF_FORMAT.removable);
  return {
    ...refreshOf(section(HOST_PACKAGE_CHECK_SECTION.refresh)),
    // dpkg's half-done state has no dnf counterpart: rpm finishes or rolls back.
    needsRepair: false,
    upgradable: upgradable.slice(0, HOST_PACKAGE_LIMIT),
    keptBack: [],
    removable: [...unneeded.values()]
      .map(([name = "", version = ""]) => ({ name, installed: version }))
      .slice(0, HOST_PACKAGE_LIMIT),
    rebootRequired: rebootRequiredOf(section(HOST_PACKAGE_CHECK_SECTION.reboot)),
  };
}

/** What the check's log says, read the way its package manager wrote it. */
export function parseCheck(manager: HostPackageManager, log: string): PackageCheck {
  const sections = sectionsOf(log);
  return manager === HOST_PACKAGE_MANAGER.dnf ? parseDnfCheck(sections) : parseAptCheck(sections);
}
