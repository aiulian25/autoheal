import { updateVersions, type ContainerView, type UpdateVersions } from "../../shared/api.js";
import {
  APP_KIND,
  APP_KINDS,
  ASSESSMENT_JSON_SCHEMA,
  ASSESSMENT_REASON_CHARACTERS,
  ASSESSMENT_TEXT,
  JSON_INDENT,
  PRIORITY_REPLAY,
  UPDATE_ASSESSMENT,
  UPDATE_SYSTEM_PROMPT,
  VERSION_IN_TAG_PATTERN,
  VERSION_SERIES_PATTERN,
  type AppKind,
  type UpdateAssessment,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { imageTag } from "../../shared/image-reference.js";
import type { HostModels } from "../ollama/ollama-pool.js";

export interface Assessment {
  // Null when Ollama could not be asked, or gave no usable answer.
  decision: UpdateAssessment | null;
  reason: string;
}

const isAppKind = (value: unknown): value is AppKind => APP_KINDS.some((kind) => kind === value);

/**
 * Whether two versions are of one release series: the same major, and below 1.0 the same minor too
 * (1.120.1 → 1.120.2 and 0.9.1 → 0.9.2 are; 1 → 2 and 0.9 → 0.10 are not). Null when either does not read
 * as major.minor, calendar versions such as 2024.10 included.
 */
export function sameSeries(running: string, next: string): boolean | null {
  const [, runningMajor, runningMinor] = VERSION_SERIES_PATTERN.exec(running) ?? [];
  const [, nextMajor, nextMinor] = VERSION_SERIES_PATTERN.exec(next) ?? [];
  if (runningMajor === undefined || nextMajor === undefined) {
    return null;
  }
  if (Number(runningMajor) !== Number(nextMajor)) {
    return false;
  }
  return Number(runningMajor) > 0 || Number(runningMinor) === Number(nextMinor);
}

// For an app that keeps data, its versions decide when both read as major.minor.
function bySeries(description: string, versions: UpdateVersions | null): Assessment | null {
  if (versions === null) {
    return null;
  }
  const same = sameSeries(versions.from, versions.to);
  if (same === null) {
    return null;
  }
  return same
    ? {
        decision: UPDATE_ASSESSMENT.update,
        reason: ASSESSMENT_TEXT.sameSeries(description, versions.from, versions.to),
      }
    : { decision: UPDATE_ASSESSMENT.hold, reason: ASSESSMENT_TEXT.newSeries(description, versions.from, versions.to) };
}

/**
 * The version both images name, when the newer one is a rebuild of it (on a newer base image, say): its labels
 * are its own, naming its source or revision too. A version alone may be its base image's (Ubuntu's 24.04 on
 * Ollama), the same while the app changed.
 */
function rebuiltVersion(container: ContainerView): string | null {
  const remote = container.update.remote;
  if (remote === null || remote.version === null || remote.version !== container.version) {
    return null;
  }
  const ownLabels = remote.source !== null || remote.revision !== null;
  return ownLabels ? remote.version : null;
}

/** What a person should look at first. Ollama only says what kind of app it is; the rules are here. */
function judge(kind: AppKind, description: string, container: ContainerView): Assessment {
  if (kind === APP_KIND.database) {
    return { decision: UPDATE_ASSESSMENT.hold, reason: ASSESSMENT_TEXT.database(description) };
  }
  const rebuilt = kind === APP_KIND.keepsData ? rebuiltVersion(container) : null;
  if (rebuilt !== null) {
    return { decision: UPDATE_ASSESSMENT.update, reason: ASSESSMENT_TEXT.rebuilt(description, rebuilt) };
  }
  const judgedBySeries = kind === APP_KIND.keepsData ? bySeries(description, updateVersions(container)) : null;
  if (judgedBySeries !== null) {
    return judgedBySeries;
  }
  const tag = imageTag(container.image);
  const namesNoVersion = !VERSION_IN_TAG_PATTERN.test(tag);
  if (kind === APP_KIND.keepsData && namesNoVersion) {
    return { decision: UPDATE_ASSESSMENT.hold, reason: ASSESSMENT_TEXT.movingTag(description, tag) };
  }
  return { decision: UPDATE_ASSESSMENT.update, reason: ASSESSMENT_TEXT.routine(description) };
}

/**
 * Whether an image update looks routine. A container in trouble waits for a person without asking;
 * otherwise Ollama names the kind of app from names and images only, never logs or settings.
 * Background work: it waits behind live incidents in its server's queue.
 */
export class UpdateAssessor {
  constructor(private readonly models: Pick<HostModels, "askFor">) {}

  async assess(container: ContainerView, neighbours: readonly ContainerView[]): Promise<Assessment> {
    if (container.problem !== null) {
      return { decision: UPDATE_ASSESSMENT.hold, reason: ASSESSMENT_TEXT.troubled(container.problem) };
    }
    const versions = updateVersions(container);
    const facts = {
      container: container.name,
      image: container.image,
      runningVersion: versions?.from ?? null,
      newVersion: versions?.to ?? null,
      composeProject: container.composeProject,
      otherServicesInProject: neighbours.map((neighbour) => ({ name: neighbour.name, image: neighbour.image })),
    };
    try {
      const { content } = await this.models.askFor(container.hostId, PRIORITY_REPLAY, (server, signal) =>
        server.client.chat(
          UPDATE_SYSTEM_PROMPT,
          JSON.stringify(facts, null, JSON_INDENT),
          signal,
          ASSESSMENT_JSON_SCHEMA,
        ),
      );
      const parsed = JSON.parse(content) as { kind?: unknown; reason?: unknown };
      if (!isAppKind(parsed.kind) || typeof parsed.reason !== "string") {
        return { decision: null, reason: ASSESSMENT_TEXT.unusableAnswer };
      }
      const assessment = judge(parsed.kind, parsed.reason.trim(), container);
      return { ...assessment, reason: assessment.reason.slice(0, ASSESSMENT_REASON_CHARACTERS) };
    } catch (error) {
      return { decision: null, reason: describeError(error) };
    }
  }
}
