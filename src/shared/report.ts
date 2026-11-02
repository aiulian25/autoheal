import { z } from "zod";
import {
  COMPOSE_PROJECT_PATTERN,
  HEALTH_OUTPUT_ENTRIES,
  LOG_CHARACTER_LIMIT,
  LOG_FENCE_END,
  LOG_FENCE_REMOVED,
  LOG_FENCE_START,
  REPORT_LIMITS,
  REPORT_TEXT,
  TRIGGERS,
  isParkedContainer,
} from "./constants.js";

const containerName = z.string().min(1).max(REPORT_LIMITS.nameCharacters);

/** What a host knows about one failed container, already redacted. */
export const incidentReportSchema = z.object({
  containerName,
  image: z.string().max(REPORT_LIMITS.imageCharacters),
  trigger: z.enum(TRIGGERS),
  stateSummary: z.string().max(REPORT_LIMITS.summaryCharacters),
  healthOutputs: z.array(z.string().max(REPORT_LIMITS.healthOutputCharacters)).max(HEALTH_OUTPUT_ENTRIES),
  knownContainers: z.array(containerName).max(REPORT_LIMITS.containers),
  protectedContainers: z.array(containerName).max(REPORT_LIMITS.containers),
  logs: z.string().max(LOG_CHARACTER_LIMIT),
  // Its compose project (null outside one) and the other containers in it. Absent from runners from before them.
  composeProject: z.string().max(REPORT_LIMITS.nameCharacters).regex(COMPOSE_PROJECT_PATTERN).nullable().optional(),
  projectContainers: z.array(containerName).max(REPORT_LIMITS.containers).optional(),
  // The others of its compose project as Docker shows them, with the last lines of a few in trouble.
  // Absent from runners from before them.
  neighbours: z
    .array(
      z.object({
        name: containerName,
        status: z.string().max(REPORT_LIMITS.neighbourStatusCharacters),
        logs: z.string().max(REPORT_LIMITS.neighbourLogCharacters).nullable(),
      }),
    )
    .max(REPORT_LIMITS.neighbours)
    .optional(),
});

export type IncidentReport = z.infer<typeof incidentReportSchema>;

/**
 * What the model may name as the failed container's dependency: another container of its compose project, so
 * none outside one, and none from a runner that did not say. Neither a protected container nor the old one an
 * update keeps aside is offered. (A person approving on the board may pick any container that isn't protected.)
 */
export function restartableContainers(report: IncidentReport): string[] {
  const project = new Set(report.projectContainers ?? []);
  const excluded = new Set([...report.protectedContainers, report.containerName]);
  return report.knownContainers
    .filter((name) => project.has(name) && !excluded.has(name) && !isParkedContainer(name))
    .sort();
}

// Logs come from the container, sometimes written by strangers; they must not be able to close the fence.
const neutraliseFences = (logs: string) =>
  logs.replaceAll(LOG_FENCE_START, LOG_FENCE_REMOVED).replaceAll(LOG_FENCE_END, LOG_FENCE_REMOVED);

/** Output the model reads as data: between fences it cannot close. */
export const fencedLogs = (logs: string) => [LOG_FENCE_START, neutraliseFences(logs), LOG_FENCE_END].join("\n");

function neighbourLines(neighbours: NonNullable<IncidentReport["neighbours"]>): string[] {
  if (neighbours.length === 0) {
    return [];
  }
  return [
    REPORT_TEXT.neighboursHeading,
    ...neighbours.map(({ name, status }) => REPORT_TEXT.neighbour(name, status)),
    ...neighbours.flatMap(({ name, logs }) =>
      logs === null ? [] : [REPORT_TEXT.neighbourLogs(name), LOG_FENCE_START, neutraliseFences(logs), LOG_FENCE_END],
    ),
  ];
}

/** The report as the model reads it, with what the control plane adds (`sections`) before the logs. */
export function renderReport(report: IncidentReport, sections: readonly string[] = []): string {
  return [
    REPORT_TEXT.failedContainer(report.containerName),
    REPORT_TEXT.image(report.image),
    REPORT_TEXT.trigger(report.trigger),
    REPORT_TEXT.state(report.stateSummary),
    REPORT_TEXT.healthOutput(report.healthOutputs),
    REPORT_TEXT.restartable(restartableContainers(report), report.composeProject),
    ...neighbourLines(report.neighbours ?? []),
    ...sections,
    REPORT_TEXT.logsHeading,
    LOG_FENCE_START,
    neutraliseFences(report.logs),
    LOG_FENCE_END,
  ].join("\n");
}
