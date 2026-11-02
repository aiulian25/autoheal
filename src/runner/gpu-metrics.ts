import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BYTES_PER_MEBIBYTE,
  CHASSIS_TYPE_PATH,
  COMMAND_NOT_FOUND,
  GPU_LIMIT,
  HOST_TEXT_LIMIT,
  NVIDIA_GPUS_PATH,
  NVIDIA_SMI,
  PORTABLE_CHASSIS_TYPES,
} from "../shared/constants.js";
import type { HostMetrics } from "../shared/protocol.js";
import { clampShare } from "./rates.js";
import type { SysfsGpus } from "./sysfs-gpus.js";

type GpuMetrics = HostMetrics["gpus"][number];

const execute = promisify(execFile);

/** Runs a command on the host and gives what it printed; fails with code ENOENT when the host has no such command. */
export type HostCommand = (command: string, commandArguments: readonly string[], timeout: number) => Promise<string>;

export const runLocally: HostCommand = async (command, commandArguments, timeout) =>
  (await execute(command, [...commandArguments], { timeout })).stdout;

// nvidia-smi writes "[N/A]" or "[Not Supported]" for what a GPU does not report, such as a laptop's power draw.
function numberOrNull(field: string | undefined): number | null {
  const value = Number(field);
  return field === undefined || field.trim() === "" || !Number.isFinite(value) ? null : value;
}

const mebibytesToBytes = (mebibytes: number | null) => Math.round(Math.max(0, mebibytes ?? 0) * BYTES_PER_MEBIBYTE);

/** nvidia-smi's CSV, one line per GPU, in the column order NVIDIA_SMI asks for. */
export function parseNvidiaSmi(output: string): GpuMetrics[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, GPU_LIMIT)
    .map((line) => {
      const fields = line.split(",");
      const [utilization, memoryUsed, memoryTotal, power, temperature] = fields
        .slice(0, NVIDIA_SMI.numericColumns)
        .map(numberOrNull);
      return {
        name: fields.slice(NVIDIA_SMI.numericColumns).join(",").trim().slice(0, HOST_TEXT_LIMIT),
        utilizationPercent: clampShare(utilization ?? 0),
        memoryUsedBytes: mebibytesToBytes(memoryUsed ?? null),
        memoryTotalBytes: mebibytesToBytes(memoryTotal ?? null),
        powerWatts: power === undefined || power === null ? null : Math.max(0, power),
        temperatureCelsius: temperature ?? null,
      };
    });
}

/** Every GPU a host's runner can see: NVIDIA's through nvidia-smi, Intel's and AMD's through the kernel. */
export async function allGpus(nvidia: Pick<NvidiaGpus, "read">, kernel: Pick<SysfsGpus, "read">) {
  const [asked, read] = await Promise.all([nvidia.read(), kernel.read()]);
  return [...asked, ...read].slice(0, GPU_LIMIT);
}

/**
 * NVIDIA GPUs, through nvidia-smi. It exists only when the runner's container was given the GPUs
 * (see the README); without it the runner stops asking after the first try.
 */
export class NvidiaGpus {
  // Null until nvidia-smi was first asked for.
  private installed: boolean | null = null;

  constructor(
    private readonly command: string = NVIDIA_SMI.command,
    private readonly run: HostCommand = runLocally,
  ) {}

  async read(): Promise<GpuMetrics[]> {
    if (this.installed === false) {
      return [];
    }
    try {
      const stdout = await this.run(this.command, NVIDIA_SMI.arguments, NVIDIA_SMI.timeoutMilliseconds);
      this.installed = true;
      return parseNvidiaSmi(stdout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === COMMAND_NOT_FOUND) {
        this.installed = false;
      }
      return [];
    }
  }

  /**
   * The host has an NVIDIA card this runner was not given, so no GPU dial, and is not a laptop, whose GPU asking
   * would keep awake: its page says how to give the card.
   */
  async notGiven(hostRoot: string): Promise<boolean> {
    if (this.installed === null) {
      await this.read();
    }
    if (this.installed !== false) {
      return false;
    }
    const cards = await readdir(join(hostRoot, NVIDIA_GPUS_PATH)).catch(() => []);
    if (cards.length === 0) {
      return false;
    }
    const chassis = Number((await readFile(join(hostRoot, CHASSIS_TYPE_PATH), "utf8").catch(() => "")).trim());
    return !PORTABLE_CHASSIS_TYPES.some((portable) => portable === chassis);
  }
}
