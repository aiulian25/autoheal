import { OPENMETRICS, OPENMETRICS_HELP_ESCAPES, OPENMETRICS_LABEL_ESCAPES } from "../../shared/constants.js";

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

/** One gauge and its samples. */
export interface MetricFamily {
  name: string;
  help: string;
  samples: MetricSample[];
}

const escaped = (text: string, escapes: readonly (readonly [string, string])[]) =>
  escapes.reduce((result, [character, escape]) => result.replaceAll(character, escape), text);

function sampleLine(name: string, { labels, value }: MetricSample): string {
  const pairs = Object.entries(labels).map(([label, text]) => `${label}="${escaped(text, OPENMETRICS_LABEL_ESCAPES)}"`);
  const labelSet = pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
  return `${name}${labelSet} ${value}`;
}

/**
 * The text a scraper reads: each gauge's help, type and samples, then the end OpenMetrics requires. A gauge without a
 * sample, or a value that is not a number, is left out.
 */
export function renderOpenMetrics(families: readonly MetricFamily[]): string {
  const lines = families
    .map((family) => ({ ...family, samples: family.samples.filter((sample) => Number.isFinite(sample.value)) }))
    .filter((family) => family.samples.length > 0)
    .flatMap((family) => [
      `${OPENMETRICS.help} ${family.name} ${escaped(family.help, OPENMETRICS_HELP_ESCAPES)}`,
      `${OPENMETRICS.type} ${family.name} ${OPENMETRICS.gauge}`,
      ...family.samples.map((sample) => sampleLine(family.name, sample)),
    ]);
  return [...lines, OPENMETRICS.end, ""].join("\n");
}
