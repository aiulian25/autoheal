import { join } from "node:path";
import {
  CORE_LABEL,
  CORE_LABEL_PATTERN,
  CPU_SENSOR_NAMES,
  CPU_TEMPERATURE_LIMIT,
  HOST_TEXT_LIMIT,
  MILLIDEGREES_PER_DEGREE,
  SENSOR_FILES,
  SENSOR_INPUT_FILE,
  SENSOR_INPUT_PATTERN,
  SENSOR_LABEL_FILE,
  SYS_PATHS,
} from "../shared/constants.js";
import type { HostHealth } from "../shared/protocol.js";
import { LOCAL_HOST_FILES, numberIn, type HostFiles } from "./host-files.js";

type CpuTemperature = NonNullable<HostHealth["cpuTemperatures"]>[number];

interface Sensor {
  directory: string;
  name: string;
}

const celsiusOf = (millidegrees: number) => millidegrees / MILLIDEGREES_PER_DEGREE;

// The CPU's sensor, by its driver's name, in order of preference.
async function cpuSensor(sysRoot: string, files: HostFiles): Promise<Sensor | null> {
  const directory = join(sysRoot, SYS_PATHS.sensors);
  const sensors = await files.list(directory);
  const names = await Promise.all(
    sensors.map((sensor) => files.readText(join(directory, sensor, SENSOR_FILES.name)).then((name) => name?.trim())),
  );
  const name = CPU_SENSOR_NAMES.find((wanted) => names.includes(wanted));
  return name === undefined ? null : { directory: join(directory, sensors[names.indexOf(name)]!), name };
}

/** The CPU package's temperature: its sensor's first reading. */
export async function cpuTemperature(sysRoot: string, files: HostFiles = LOCAL_HOST_FILES): Promise<number | null> {
  const sensor = await cpuSensor(sysRoot, files);
  const millidegrees =
    sensor === null ? null : numberIn(await files.readText(join(sensor.directory, SENSOR_FILES.temperature)));
  return millidegrees === null ? null : celsiusOf(millidegrees);
}

/** Each core's temperature, numbered from 1, where the sensor has them; else each reading. */
export async function cpuTemperatures(sysRoot: string, files: HostFiles = LOCAL_HOST_FILES): Promise<CpuTemperature[]> {
  const sensor = await cpuSensor(sysRoot, files);
  if (sensor === null) {
    return [];
  }
  const indexes = (await files.list(sensor.directory))
    .flatMap((file) => SENSOR_INPUT_PATTERN.exec(file)?.[1] ?? [])
    .sort((first, second) => Number(first) - Number(second));
  const readings = await Promise.all(
    indexes.map(async (index) => ({
      label: (await files.readText(join(sensor.directory, SENSOR_LABEL_FILE(index))))?.trim() || sensor.name,
      millidegrees: numberIn(await files.readText(join(sensor.directory, SENSOR_INPUT_FILE(index)))),
    })),
  );
  const known = readings.flatMap(({ label, millidegrees }) =>
    millidegrees === null ? [] : [{ label: label.slice(0, HOST_TEXT_LIMIT), celsius: celsiusOf(millidegrees) }],
  );
  const cores = known.filter(({ label }) => CORE_LABEL_PATTERN.test(label));
  const shown =
    cores.length === 0 ? known : cores.map((core, position) => ({ ...core, label: CORE_LABEL(position + 1) }));
  return shown.slice(0, CPU_TEMPERATURE_LIMIT);
}
