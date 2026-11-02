import {
  BYTES_PER_KILOBYTE,
  LAYER_STATE,
  PERCENT,
  UPDATE_PHASE,
  type LayerState,
} from "../../../src/shared/constants.js";
import type { UpdateProgress } from "../../../src/shared/protocol.js";
import { TEXT } from "../constants.js";
import { bytes, duration, percent, percentOf } from "../format.js";
import { Bar } from "./common.js";
import { Icon } from "./icons.js";

type Layer = UpdateProgress["layers"][number];

const STREAM_TEXT = TEXT.updateStream;

// A layer's bar: violet while it comes down, blue while it unpacks, green once in place.
const LAYER_TONES: Record<LayerState, string> = {
  [LAYER_STATE.waiting]: "neutral",
  [LAYER_STATE.downloading]: "violet",
  [LAYER_STATE.downloaded]: "violet",
  [LAYER_STATE.extracting]: "blue",
  [LAYER_STATE.done]: "good",
  [LAYER_STATE.present]: "neutral",
};

const MOVING_LAYER_STATES: ReadonlySet<LayerState> = new Set([LAYER_STATE.downloading, LAYER_STATE.extracting]);
const READY_LAYER_STATES: ReadonlySet<LayerState> = new Set([LAYER_STATE.done, LAYER_STATE.present]);

// Docker writes its sizes in powers of ten, so these read as its own lines below them do.
const size = (count: number) => bytes(count, BYTES_PER_KILOBYTE);

function layerFraction(layer: Layer): number {
  if (layer.state === LAYER_STATE.waiting) {
    return 0;
  }
  if (!MOVING_LAYER_STATES.has(layer.state)) {
    return 1;
  }
  return layer.total === null ? 0 : layer.current / layer.total;
}

// The pull's size, once no layer waits its turn and each one coming down said its size: Docker says one only as
// that layer starts, so a share taken earlier would jump back. A small one it finished without a size is left out.
function wholeSize(progress: UpdateProgress): number | null {
  const unsized = progress.layers.some(
    (layer) => layer.state === LAYER_STATE.waiting || (MOVING_LAYER_STATES.has(layer.state) && layer.total === null),
  );
  return unsized ? null : progress.total;
}

// While it pulls, how fast: none before Docker sent anything, or while it sends nothing.
function speedOf(progress: UpdateProgress): number | null {
  const speed = progress.bytesPerSecond ?? 0;
  return progress.phase === UPDATE_PHASE.pulling && speed > 0 ? speed : null;
}

/** What an update is doing, in a few words: how far its pull is while it pulls, its step after that. */
export function phaseWords(progress: UpdateProgress): string {
  const whole = wholeSize(progress);
  if (progress.phase === UPDATE_PHASE.pulling && whole !== null) {
    return STREAM_TEXT.pulling(percent(percentOf(progress.downloaded, whole)));
  }
  return STREAM_TEXT.phases[progress.phase];
}

function pullFacts(progress: UpdateProgress): string[] {
  const whole = wholeSize(progress);
  const speed = speedOf(progress);
  const left = whole === null || speed === null ? null : Math.ceil(Math.max(0, whole - progress.downloaded) / speed);
  const ready = progress.layers.filter((layer) => READY_LAYER_STATES.has(layer.state)).length;
  const transferred =
    whole === null
      ? STREAM_TEXT.downloaded(size(progress.downloaded))
      : STREAM_TEXT.transferred(size(progress.downloaded), size(whole));
  return [
    speed === null ? null : STREAM_TEXT.rate(size(speed)),
    progress.downloaded > 0 || whole !== null ? transferred : null,
    left === null ? null : STREAM_TEXT.left(duration(left)),
    progress.layers.length === 0 ? null : STREAM_TEXT.layers(ready, progress.layers.length),
  ].filter((fact) => fact !== null);
}

function LayerCard({ layer }: { layer: Layer }) {
  const fraction = layerFraction(layer);
  const moving = MOVING_LAYER_STATES.has(layer.state) && layer.total !== null;
  return (
    <li className={`layer-card layer-${layer.state}`}>
      <span className="layer-head">
        <span className="mono">{layer.id}</span>
        {layer.total !== null && <span className="faint">{size(layer.total)}</span>}
      </span>
      <Bar fraction={fraction} tone={LAYER_TONES[layer.state]} />
      <span className="layer-state">
        {STREAM_TEXT.layerStates[layer.state]}
        {moving && ` ${percent(fraction * PERCENT)}`}
      </span>
    </li>
  );
}

/**
 * Under an updating container's row: the step its update is at, and while the new image comes down each of its
 * layers, the speed, how much is left, and Docker's own lines. All of it as the host's runner reports it.
 */
export function UpdateStream({ name, image, progress }: { name: string; image: string; progress: UpdateProgress }) {
  const undoing = progress.phase === UPDATE_PHASE.undoing;
  const pulling = progress.phase === UPDATE_PHASE.pulling;
  const whole = wholeSize(progress);
  return (
    <section className={undoing ? "update-stream undoing" : "update-stream"} aria-label={STREAM_TEXT.label(name)}>
      <header className="update-stream-head">
        <Icon name={undoing ? "alert" : "download"} className={pulling ? "pulse" : undefined} />
        {/* Only the step is read out as it changes: the figures beside it move twice a second. */}
        <strong role="status">{STREAM_TEXT.phases[progress.phase]}</strong>
        <span className="mono">{image}</span>
        {pullFacts(progress).map((fact) => (
          <span key={fact} className="muted">
            {fact}
          </span>
        ))}
      </header>
      {pulling && whole !== null && <Bar fraction={percentOf(progress.downloaded, whole) / PERCENT} tone="violet" />}
      {progress.layers.length > 0 && (
        <ul className="layer-cards">
          {progress.layers.map((layer) => (
            <LayerCard key={layer.id} layer={layer} />
          ))}
        </ul>
      )}
      {progress.log.length > 0 && (
        <ol className="pull-log" aria-label={STREAM_TEXT.log}>
          {progress.log.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
