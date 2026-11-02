import {
  DRIVE_HEALTH_LIMITS,
  DRIVE_KIND,
  DRIVE_PROBLEM_TEXT,
  NVME_TEMPERATURE_WARNING,
  SMART_FAILURE_WARNINGS,
  SMART_HEALTH_WARNING,
  SMART_HEAT_WARNING,
} from "./constants.js";
import type { DriveHealth } from "./protocol.js";
import { utcMinute } from "./time-zones.js";

/** What a drive's smartd records say is wrong with it, and whether that says failing rather than worn. */
export interface DriveProblems {
  problems: string[];
  failing: boolean;
  // smartd's warnings of the last week that it ran too hot: heat, which its temperature watches, not wear.
  heat: string | null;
}

type Warning = DriveHealth["warnings"][number];

const LIST_JOINER = ", ";

// An NVMe drive's "Health" warnings were heat alone when its attribute log saw no other critical warning bit.
const heatOnly = (drive: DriveHealth) =>
  drive.kind === DRIVE_KIND.nvme &&
  drive.criticalWarnings !== null &&
  drive.criticalWarnings !== undefined &&
  (drive.criticalWarnings & ~NVME_TEMPERATURE_WARNING) === 0;

const isHeat = (drive: DriveHealth, warning: Warning) =>
  warning.kind === SMART_HEAT_WARNING || (warning.kind === SMART_HEALTH_WARNING && heatOnly(drive));

const countOf = (warnings: readonly Warning[]) => warnings.reduce((sum, warning) => sum + warning.count, 0);
const lastOf = (warnings: readonly Warning[]) => utcMinute(Math.max(...warnings.map((warning) => warning.lastAt ?? 0)));

// smartd's warnings of the last week, each summed in one phrase: heat, and the rest with their kinds.
function recentWarnings(drive: DriveHealth, now: number) {
  const recent = drive.warnings.filter(
    (warning) => warning.lastAt !== null && now - warning.lastAt <= DRIVE_HEALTH_LIMITS.recentWarningMilliseconds,
  );
  const heat = recent.filter((warning) => isHeat(drive, warning));
  const others = recent.filter((warning) => !isHeat(drive, warning));
  const kinds = others.map((warning) => warning.kind).join(LIST_JOINER);
  return {
    phrase: others.length === 0 ? null : DRIVE_PROBLEM_TEXT.warned(countOf(others), kinds, lastOf(others)),
    heat: heat.length === 0 ? null : DRIVE_PROBLEM_TEXT.heat(countOf(heat), lastOf(heat)),
    failing: others.some((warning) => SMART_FAILURE_WARNINGS.has(warning.kind)),
  };
}

/**
 * The signs of wear or failure in a drive's smartd records, worded for its task and its host's page alike.
 * Its error log counts only beside another sign: NVMe drives also log harmless entries, such as a command
 * they do not support.
 */
export function driveProblems(drive: DriveHealth, now: number): DriveProblems {
  const warned = recentWarnings(drive, now);
  const worn = drive.percentageUsed !== null && drive.percentageUsed >= DRIVE_HEALTH_LIMITS.wornPercent;
  const short = drive.availableSpare !== null && drive.availableSpare <= DRIVE_HEALTH_LIMITS.sparePercent;
  const signs = [
    drive.reallocatedSectors > 0 ? DRIVE_PROBLEM_TEXT.reallocated(drive.reallocatedSectors) : null,
    drive.pendingSectors > 0 ? DRIVE_PROBLEM_TEXT.pending(drive.pendingSectors) : null,
    drive.uncorrectableSectors > 0 ? DRIVE_PROBLEM_TEXT.uncorrectable(drive.uncorrectableSectors) : null,
    drive.selfTestErrors > 0 ? DRIVE_PROBLEM_TEXT.selfTest(drive.selfTestErrors) : null,
    worn ? DRIVE_PROBLEM_TEXT.worn(drive.percentageUsed ?? 0) : null,
    short ? DRIVE_PROBLEM_TEXT.spare(drive.availableSpare ?? 0) : null,
    warned.phrase,
  ].filter((sign) => sign !== null);
  const logged = signs.length > 0 && drive.errorLogEntries > 0;
  const sectors = drive.reallocatedSectors + drive.pendingSectors + drive.uncorrectableSectors;
  return {
    problems: logged ? [...signs, DRIVE_PROBLEM_TEXT.errorLog(drive.errorLogEntries)] : signs,
    failing: sectors > 0 || drive.selfTestErrors > 0 || warned.failing,
    heat: warned.heat,
  };
}
