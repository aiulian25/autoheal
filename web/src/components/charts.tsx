// Dials and time charts drawn as plain SVG: shapes come from attributes and colors from classes, so
// nothing needs an inline style (the CSP allows none).

import { DIAL_LONG_VALUE, DIAL_LONGER_VALUE, TEXT } from "../constants.js";

export type Tone = "blue" | "green" | "amber" | "violet" | "warning" | "danger";

// A dial is a thick 270° arc, open at the bottom, in a 92 × 80 box: the size a fleet card shows it at.
// Its stroke is 8 wide, so the arc's outer edge touches the box's top and sides.
const DIAL = {
  width: 92,
  height: 80,
  center: 46,
  radius: 42,
  startDegrees: 135,
  sweepDegrees: 270,
  valueY: 45,
  unitY: 65,
} as const;
// A rate reads longer ("73 kB/s"), so its value is set smaller, and the two lines sit a little higher.
const RATE_TEXT = { valueY: 44, unitY: 63.5 } as const;
const DEGREES_TO_RADIANS = Math.PI / 180;
// The arc's length as SVG measures it once pathLength is set: the dash is the value's share of it.
const ARC_LENGTH = 100;

const pointAt = (radius: number, degrees: number) => ({
  x: DIAL.center + radius * Math.cos(degrees * DEGREES_TO_RADIANS),
  y: DIAL.center + radius * Math.sin(degrees * DEGREES_TO_RADIANS),
});

const arcStart = pointAt(DIAL.radius, DIAL.startDegrees);
const arcEnd = pointAt(DIAL.radius, DIAL.startDegrees + DIAL.sweepDegrees);
const ARC = `M ${arcStart.x} ${arcStart.y} A ${DIAL.radius} ${DIAL.radius} 0 1 1 ${arcEnd.x} ${arcEnd.y}`;

export interface DialProps {
  label: string;
  // How far along the arc, 0 to 1.
  fraction: number;
  value: string;
  unit: string;
  tone: Tone;
  rate: boolean;
}

// The arc's round ends still show at nothing: a dot where it starts.
export function Dial({ label, fraction, value, unit, tone, rate }: DialProps) {
  const position = Math.min(1, Math.max(0, fraction));
  const text = rate ? RATE_TEXT : DIAL;
  const valueClass = [
    "dial-value",
    rate && "rate",
    value.length > DIAL_LONG_VALUE && "long",
    value.length > DIAL_LONGER_VALUE && "longer",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className={`dial tone-${tone}`}
      viewBox={`0 0 ${DIAL.width} ${DIAL.height}`}
      role="img"
      aria-label={`${label}: ${value} ${unit}`}
    >
      <path className="dial-track" d={ARC} />
      <path
        className="dial-arc"
        d={ARC}
        pathLength={ARC_LENGTH}
        strokeDasharray={`${position * ARC_LENGTH} ${ARC_LENGTH}`}
      />
      <text className={valueClass} x={DIAL.center} y={text.valueY}>
        {value}
      </text>
      <text className="dial-unit" x={DIAL.center} y={text.unitY}>
        {unit}
      </text>
    </svg>
  );
}

/** One dial on a card, with what it measures under it and a detail beside that. */
export interface Gauge {
  label: string;
  detail: string | null;
  // A mount path reads better in the code font.
  mono: boolean;
  dial: Omit<DialProps, "label">;
}

export function GaugeFigure({ gauge }: { gauge: Gauge }) {
  return (
    <figure className="gauge">
      <Dial label={gauge.label} {...gauge.dial} />
      <figcaption>
        <span className="gauge-label">{gauge.label}</span>
        {gauge.detail !== null && (
          <span className={gauge.mono ? "gauge-detail mono" : "gauge-detail"}>{gauge.detail}</span>
        )}
      </figcaption>
    </figure>
  );
}

export interface ChartSeries {
  label: string;
  tone: Tone;
  // One per time; null where nothing was measured.
  values: readonly (number | null)[];
}

export interface ChartReference {
  label: string;
  value: number;
  from?: number;
  tone?: Tone;
}
interface TimeChartProps {
  title: string;
  // Oldest first.
  times: readonly number[];
  series: readonly ChartSeries[];
  format: (value: number) => string;
  // A fixed top for the scale, like 100 for a percentage; otherwise the highest value sets it.
  ceiling?: number;
  references?: readonly ChartReference[];
}

// A chart is drawn in a 300 × 100 box and stretched to its card's width.
const CHART = { width: 300, height: 100, gridLines: [0.25, 0.5, 0.75] } as const;
// The top of the scale when everything measured was zero.
const EMPTY_SCALE = 1;
// A line needs two points.
export const MINIMUM_POINTS = 2;

type Point = { x: number; y: number };

// Runs of measured values; a gap (null) breaks the line rather than bridging it.
function runsOf(values: readonly (number | null)[], place: (index: number, value: number) => Point): Point[][] {
  const runs: Point[][] = [[]];
  values.forEach((value, index) => {
    if (value === null) {
      runs.push([]);
      return;
    }
    runs.at(-1)!.push(place(index, value));
  });
  return runs.filter((run) => run.length > 0);
}

const pointsText = (run: Point[]) => run.map((point) => `${point.x},${point.y}`).join(" ");

// The run's line closed down to the baseline at both ends, for the shading under it.
const areaText = (run: Point[]) => `${run[0]!.x},${CHART.height} ${pointsText(run)} ${run.at(-1)!.x},${CHART.height}`;

const latestOf = (values: readonly (number | null)[]) => values.findLast((value) => value !== null) ?? null;

export function TimeChart({ title, times, series, format, ceiling, references = [] }: TimeChartProps) {
  const measured = series.flatMap((line) => line.values.filter((value) => value !== null));
  const top = ceiling ?? Math.max(EMPTY_SCALE, ...measured, ...references.map((reference) => reference.value));
  const visibleReferences = references.filter(
    (reference) => Number.isFinite(reference.value) && reference.value >= 0 && reference.value <= top,
  );
  const first = times[0] ?? 0;
  const span = Math.max(EMPTY_SCALE, (times.at(-1) ?? 0) - first);
  const place = (index: number, value: number): Point => ({
    x: (((times[index] ?? first) - first) / span) * CHART.width,
    y: CHART.height - (Math.min(value, top) / top) * CHART.height,
  });
  const legend = series.map((line) => {
    const latest = latestOf(line.values);
    return { ...line, latest: latest === null ? null : format(latest) };
  });
  return (
    <section className="card chart-card">
      <header className="chart-header">
        <h3>{title}</h3>
        <span className="small muted">{TEXT.metrics.upTo(format(top))}</span>
      </header>
      {times.length < MINIMUM_POINTS && <p className="muted small">{TEXT.metrics.collecting}</p>}
      <svg
        className="chart"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}: ${legend.map((line) => `${line.label} ${line.latest ?? ""}`).join(", ")}`}
      >
        {CHART.gridLines.map((line) => (
          <line
            key={line}
            className="chart-gridline"
            x1={0}
            y1={CHART.height * line}
            x2={CHART.width}
            y2={CHART.height * line}
          />
        ))}
        {visibleReferences.map((reference) => (
          <line
            key={reference.label}
            className={`chart-line tone-${reference.tone ?? "amber"}`}
            x1={Math.max(0, Math.min(CHART.width, (((reference.from ?? first) - first) / span) * CHART.width))}
            x2={CHART.width}
            y1={place(0, reference.value).y}
            y2={place(0, reference.value).y}
            strokeDasharray="5 4"
          >
            <title>
              {reference.label}: {format(reference.value)}
            </title>
          </line>
        ))}
        {series.map((line) => (
          <g key={line.label} className={`tone-${line.tone}`}>
            {runsOf(line.values, place).map((run) => (
              <g key={run[0]!.x}>
                <polygon className="chart-area" points={areaText(run)} />
                <polyline className="chart-line" points={pointsText(run)} />
              </g>
            ))}
          </g>
        ))}
      </svg>
      <ul className="legend">
        {visibleReferences.map((reference) => (
          <li key={reference.label}>
            {reference.label} <strong>{format(reference.value)}</strong> (dashed)
          </li>
        ))}
        {legend.map((line) => (
          <li key={line.label}>
            <span className={`swatch tone-${line.tone}`} />
            {line.label} <strong>{line.latest ?? TEXT.none}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
