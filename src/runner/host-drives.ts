import { basename, join } from "node:path";
import {
  BLOCK_DIRECTORY,
  DRIVE_KIND,
  DRIVE_KINDS,
  DRIVE_NAME_JOINER,
  DRIVE_NAME_SEPARATORS,
  DRIVE_SENSOR_NAMES,
  HARDWARE_DEVICE_LINK,
  HOST_DISK_LIMIT,
  HOST_FILES,
  HOST_TEXT_LIMIT,
  LOCAL_FILESYSTEM,
  MILLIDEGREES_PER_DEGREE,
  MILLISECONDS_PER_SECOND,
  MOUNT_ESCAPE_PATTERN,
  MOUNT_FIELD_SEPARATOR,
  NVME_NAMESPACE_PATTERN,
  OCTAL_RADIX,
  SENSOR_FILES,
  SMART_ATTRIBUTE_LOG,
  SMART_FIELDS,
  SMART_STATE,
  SMART_TEST_WARNING,
  SMART_WARNING_KINDS,
  SYS_PATHS,
  type DriveKind,
} from "../shared/constants.js";
import type { DriveHealth, HostHealth } from "../shared/protocol.js";
import { LOCAL_HOST_FILES, numberIn, type HostFiles } from "./host-files.js";

type DriveTemperature = NonNullable<HostHealth["driveTemperatures"]>[number];

const unescapeMountField = (field: string) =>
  field.replace(MOUNT_ESCAPE_PATTERN, (_escape, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, OCTAL_RADIX)),
  );

// What makes two mounts the same disk: its device, or a ZFS dataset's pool. Null for what is no local disk.
function diskOf(source: string, type: string): string | null {
  if (type === LOCAL_FILESYSTEM.zfsType) {
    return source.split(LOCAL_FILESYSTEM.poolSeparator)[0] ?? null;
  }
  const isBlockDevice =
    source.startsWith(LOCAL_FILESYSTEM.devicePrefix) && !source.startsWith(LOCAL_FILESYSTEM.loopPrefix);
  return isBlockDevice ? source : null;
}

/** Where the host's local disks are mounted, in its mount table's order, each disk once. */
export function localFilesystems(mountTable: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of mountTable.split("\n")) {
    const [source = "", path = "", type = ""] = line.split(MOUNT_FIELD_SEPARATOR).map(unescapeMountField);
    const disk = diskOf(source, type);
    if (disk === null || seen.has(disk)) {
      continue;
    }
    seen.add(disk);
    paths.push(path);
  }
  return paths.slice(0, HOST_DISK_LIMIT);
}

async function driveNameOf(device: string, files: HostFiles): Promise<string | null> {
  const namespace = (await files.list(device)).find((entry) => NVME_NAMESPACE_PATTERN.test(entry));
  return namespace ?? (await files.list(join(device, BLOCK_DIRECTORY)))[0] ?? null;
}

async function driveTemperature(sensor: string, files: HostFiles): Promise<DriveTemperature | null> {
  const name = (await files.readText(join(sensor, SENSOR_FILES.name)))?.trim() ?? "";
  if (!DRIVE_SENSOR_NAMES.includes(name)) {
    return null;
  }
  const millidegrees = numberIn(await files.readText(join(sensor, SENSOR_FILES.temperature)));
  if (millidegrees === null) {
    return null;
  }
  const device = (await driveNameOf(join(sensor, HARDWARE_DEVICE_LINK), files)) ?? name;
  // The highest its device declares it may run at; none when it declares none.
  const maximum = numberIn(await files.readText(join(sensor, SENSOR_FILES.maximum)));
  return {
    device: device.slice(0, HOST_TEXT_LIMIT),
    celsius: millidegrees / MILLIDEGREES_PER_DEGREE,
    maximumCelsius: maximum === null || maximum <= 0 ? null : maximum / MILLIDEGREES_PER_DEGREE,
  };
}

// The drives the kernel has a temperature sensor for: NVMe ones, and SATA ones once drivetemp is loaded.
async function sensorTemperatures(sysRoot: string, files: HostFiles): Promise<DriveTemperature[]> {
  const directory = join(sysRoot, SYS_PATHS.sensors);
  const sensors = await files.list(directory);
  const readings = await Promise.all(sensors.map((sensor) => driveTemperature(join(directory, sensor), files)));
  return readings.filter((reading) => reading !== null);
}

const driveKeyOf = (name: string) => name.replace(DRIVE_NAME_SEPARATORS, DRIVE_NAME_JOINER);
const driveLink = (kind: DriveKind, rest: string) => `${kind}:${driveKeyOf(rest)}`;

// udev's link for each drive, by its kind, model and serial: ata-WDC_WD180EMFZ-11AFXA0_3WHE12GJ → sda,
// nvme-SM2P41C8-256GC6_2P0629ABA4RE → nvme0n1.
async function driveDevices(hostRoot: string, files: HostFiles): Promise<Map<string, string>> {
  const directory = join(hostRoot, HOST_FILES.diskIds);
  const links = (await files.list(directory)).flatMap((name) => {
    const kind = DRIVE_KINDS.find((candidate) => name.startsWith(SMART_STATE.diskIdPrefixes[candidate]));
    return kind === undefined
      ? []
      : [{ name, key: driveLink(kind, name.slice(SMART_STATE.diskIdPrefixes[kind].length)) }];
  });
  const devices = await Promise.all(
    links.map(async ({ name, key }) => {
      const target = await files.readlink(join(directory, name));
      return [key, target === null ? "" : basename(target)] as const;
    }),
  );
  return new Map(devices.filter(([, device]) => device !== ""));
}

/** What a smartd state file holds: its attributes' raw values, its other counters, and its warnings by kind. */
interface SmartState {
  attributes: Map<number, number>;
  fields: Map<string, number>;
  warnings: Map<number, { count: number; lastAt: number | null }>;
}

// "ata-smart-attribute.13.id = 194", that attribute's ".raw = …" (left out when 0), "nvme-percentage-used = 2",
// and smartd's warnings, "mail.1.count = 21" and "mail.1.last-sent-time = 1792544606".
function parseSmartState(text: string): SmartState {
  const ids = new Map<string, number>();
  const raws = new Map<string, number>();
  const fields = new Map<string, number>();
  const warnings = new Map<number, { count: number; lastAt: number | null }>();
  for (const line of text.split("\n").map((entry) => entry.trim())) {
    const attribute = SMART_STATE.attributeLine.exec(line);
    if (attribute !== null) {
      const [, index = "", field, value = ""] = attribute;
      (field === "id" ? ids : raws).set(index, Number(value));
      continue;
    }
    const warning = SMART_STATE.warningLine.exec(line);
    if (warning !== null) {
      const [, kind = "", field, value = ""] = warning;
      const known = warnings.get(Number(kind)) ?? { count: 0, lastAt: null };
      const seconds = Number(value);
      warnings.set(
        Number(kind),
        field === "count" ? { ...known, count: seconds } : { ...known, lastAt: seconds * MILLISECONDS_PER_SECOND },
      );
      continue;
    }
    const counter = SMART_STATE.fieldLine.exec(line);
    if (counter !== null) {
      fields.set(counter[1] ?? "", Number(counter[2]));
    }
  }
  const attributes = new Map([...ids].map(([index, id]): [number, number] => [id, raws.get(index) ?? 0]));
  return { attributes, fields, warnings };
}

function smartTemperatureIn(state: SmartState): number | null {
  const raw = SMART_STATE.temperatureAttributes
    .map((id) => state.attributes.get(id))
    .find((value) => value !== undefined);
  const celsius = raw === undefined ? 0 : raw & SMART_STATE.temperatureMask;
  return celsius > 0 ? celsius : null;
}

const sectorsOf = (state: SmartState, attribute: number) =>
  (state.attributes.get(attribute) ?? 0) % SMART_STATE.countModulo;

// The critical warning bits an NVMe drive raised at smartd's checks of the last week; null without its attribute log.
async function criticalWarningsIn(path: string, files: HostFiles): Promise<number | null> {
  const end = await files.readEnd(path, SMART_ATTRIBUTE_LOG.tailBytes);
  if (end === null) {
    return null;
  }
  return end
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-SMART_ATTRIBUTE_LOG.samples)
    .reduce((bits, line) => bits | Number(SMART_ATTRIBUTE_LOG.criticalWarning.exec(line)?.[1] ?? 0), 0);
}

function driveHealthOf(
  device: string,
  kind: DriveKind,
  readAt: number,
  state: SmartState,
  criticalWarnings: number | null,
): DriveHealth {
  const field = (name: string) => state.fields.get(name) ?? null;
  const nvme = kind === DRIVE_KIND.nvme;
  const warnings = [...state.warnings]
    .filter(([number]) => number !== SMART_TEST_WARNING)
    .map(([number, warning]) => ({ kind: SMART_WARNING_KINDS[number] ?? String(number), ...warning }));
  return {
    device: device.slice(0, HOST_TEXT_LIMIT),
    kind,
    readAt,
    reallocatedSectors: sectorsOf(state, SMART_STATE.sectorAttributes.reallocated),
    pendingSectors: sectorsOf(state, SMART_STATE.sectorAttributes.pending),
    uncorrectableSectors: sectorsOf(state, SMART_STATE.sectorAttributes.uncorrectable),
    selfTestErrors: field(SMART_FIELDS.selfTestErrors) ?? 0,
    errorLogEntries: field(nvme ? SMART_FIELDS.nvmeErrors : SMART_FIELDS.ataErrors) ?? 0,
    percentageUsed: nvme ? field(SMART_FIELDS.nvmeUsed) : null,
    availableSpare: nvme ? field(SMART_FIELDS.nvmeSpare) : null,
    criticalWarnings,
    warnings: warnings.slice(0, SMART_WARNING_KINDS.length),
  };
}

/**
 * Every drive smartd watches, where it runs (it checks every half hour): its health, and a SATA drive's
 * temperature. A drive asleep keeps its last reading, which `readAt` dates.
 */
async function smartDrives(
  hostRoot: string,
  files: HostFiles,
): Promise<{ temperatures: DriveTemperature[]; health: DriveHealth[] }> {
  const directory = join(hostRoot, HOST_FILES.smartStates);
  const states = (await files.list(directory)).filter((file) => SMART_STATE.filePattern.test(file));
  if (states.length === 0) {
    return { temperatures: [], health: [] };
  }
  const devices = await driveDevices(hostRoot, files);
  const drives = await Promise.all(
    states.map(async (file) => {
      const [, name = "", kind] = SMART_STATE.filePattern.exec(file) ?? [];
      const driveKind = kind as DriveKind;
      const device = devices.get(driveLink(driveKind, name));
      if (device === undefined) {
        return null;
      }
      const nvme = driveKind === DRIVE_KIND.nvme;
      const [text, modifiedAt, criticalWarnings] = await Promise.all([
        files.readText(join(directory, file)),
        files.modifiedAt(join(directory, file)),
        nvme ? criticalWarningsIn(join(directory, SMART_ATTRIBUTE_LOG.file(name, driveKind)), files) : null,
      ]);
      if (text === null || modifiedAt === null) {
        return null;
      }
      const state = parseSmartState(text);
      return {
        device,
        health: driveHealthOf(device, driveKind, Math.round(modifiedAt), state, criticalWarnings),
        celsius: smartTemperatureIn(state),
      };
    }),
  );
  const read = drives.filter((drive) => drive !== null);
  return {
    temperatures: read.flatMap(({ device, celsius }) => (celsius === null ? [] : [{ device, celsius }])),
    health: read.map(({ health }) => health).sort((first, second) => first.device.localeCompare(second.device)),
  };
}

/**
 * Every drive's temperature the host knows (its kernel's sensors first, then smartd's for the rest), and each
 * drive's health as smartd last read it.
 */
export async function readDrives(
  sysRoot: string,
  hostRoot: string | null,
  files: HostFiles = LOCAL_HOST_FILES,
): Promise<{ temperatures: DriveTemperature[]; health: DriveHealth[] }> {
  const sensed = await sensorTemperatures(sysRoot, files);
  const known = new Set(sensed.map(({ device }) => device));
  const smart = hostRoot === null ? { temperatures: [], health: [] } : await smartDrives(hostRoot, files);
  const temperatures = [...sensed, ...smart.temperatures.filter(({ device }) => !known.has(device))]
    .sort((first, second) => first.device.localeCompare(second.device))
    .slice(0, HOST_DISK_LIMIT);
  return { temperatures, health: smart.health.slice(0, HOST_DISK_LIMIT) };
}
