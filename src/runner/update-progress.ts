import {
  DOCKER_PULL_STATUS,
  LAYER_STATE,
  MILLISECONDS_PER_SECOND,
  PULL_PROGRESS_LIMITS,
  UPDATE_PHASE,
  type LayerState,
  type UpdatePhase,
} from "../shared/constants.js";
import type { UpdateProgress } from "../shared/protocol.js";

/** One line of Docker's pull stream, as much of it as is read. */
export interface PullLine {
  id?: string;
  status?: string;
  progress?: string;
  progressDetail?: { current?: number; total?: number };
}

type Layer = UpdateProgress["layers"][number];

// Once down, a layer's bytes are all there, whether it is still unpacking or done.
const DOWNLOADED_STATES: ReadonlySet<LayerState> = new Set([
  LAYER_STATE.downloaded,
  LAYER_STATE.extracting,
  LAYER_STATE.done,
]);

function downloadedOf(layer: Layer): number {
  if (layer.state === LAYER_STATE.downloading) {
    return layer.current;
  }
  return DOWNLOADED_STATES.has(layer.state) ? (layer.total ?? layer.current) : 0;
}

// Docker sends a layer's size with its download; the lines after it may leave it out.
function layerFrom(known: Layer | undefined, id: string, state: LayerState, line: PullLine): Layer {
  const total = line.progressDetail?.total ?? known?.total ?? null;
  const finished = state === LAYER_STATE.done || state === LAYER_STATE.downloaded;
  const current = finished ? (total ?? known?.current ?? 0) : (line.progressDetail?.current ?? 0);
  return { id, state, current, total };
}

/**
 * What an update tells the dashboard as it goes: the step the updater is at, and each layer of the new image as
 * Docker's pull lines say. Sent at most every half second, and at once when the step changes.
 */
export class UpdateReport {
  private phase: UpdatePhase = UPDATE_PHASE.pulling;
  private readonly layers = new Map<string, Layer>();
  // Docker's latest line about each layer, the newest last.
  private readonly lines = new Map<string, string>();
  private readonly samples: { at: number; downloaded: number }[] = [];
  private sentAt = -Infinity;

  constructor(
    private readonly send: (progress: UpdateProgress) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  enter(phase: UpdatePhase) {
    if (this.phase === UPDATE_PHASE.pulling && phase !== UPDATE_PHASE.pulling) {
      this.pullEnded();
    }
    this.phase = phase;
    this.flush(true);
  }

  // Docker's pull returned: every layer is in place, though its last line for a small one may say only "downloaded".
  private pullEnded() {
    for (const [id, layer] of this.layers) {
      if (layer.state !== LAYER_STATE.present) {
        this.layers.set(id, { ...layer, state: LAYER_STATE.done, current: layer.total ?? layer.current });
      }
    }
  }

  pulled(line: PullLine) {
    const state = line.status === undefined ? undefined : DOCKER_PULL_STATUS[line.status];
    if (line.id !== undefined && state !== undefined) {
      this.layers.set(line.id, layerFrom(this.layers.get(line.id), line.id, state, line));
    }
    if (line.id !== undefined && line.status !== undefined) {
      const said = [`${line.id}: ${line.status}`, line.progress].filter(Boolean).join(" ");
      this.lines.delete(line.id);
      this.lines.set(line.id, said.slice(0, PULL_PROGRESS_LIMITS.logCharacters));
    }
    this.flush(false);
  }

  private flush(force: boolean) {
    const now = this.clock();
    if (!force && now - this.sentAt < PULL_PROGRESS_LIMITS.reportMilliseconds) {
      return;
    }
    this.sentAt = now;
    this.send(this.snapshot(now));
  }

  private snapshot(now: number): UpdateProgress {
    const layers = [...this.layers.values()].slice(0, PULL_PROGRESS_LIMITS.layers);
    const downloaded = layers.reduce((sum, layer) => sum + downloadedOf(layer), 0);
    const sized = layers.filter((layer) => layer.state !== LAYER_STATE.present && layer.total !== null);
    return {
      phase: this.phase,
      layers,
      downloaded,
      total: sized.length === 0 ? null : sized.reduce((sum, layer) => sum + layer.total!, 0),
      bytesPerSecond: this.rate(now, downloaded),
      log: [...this.lines.values()].slice(-PULL_PROGRESS_LIMITS.logLines),
    };
  }

  // Bytes a second over the last few seconds; null until there are two readings to tell it by.
  private rate(now: number, downloaded: number): number | null {
    this.samples.push({ at: now, downloaded });
    while (this.samples.length > 0 && now - this.samples[0]!.at > PULL_PROGRESS_LIMITS.rateWindowMilliseconds) {
      this.samples.shift();
    }
    const first = this.samples[0]!;
    const elapsed = now - first.at;
    return elapsed <= 0 ? null : ((downloaded - first.downloaded) / elapsed) * MILLISECONDS_PER_SECOND;
  }
}
