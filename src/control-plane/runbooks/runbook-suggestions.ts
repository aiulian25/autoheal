import { sha256Hex } from "../../shared/hash.js";
import { API_ERRORS, type RunbookSuggestionView, type RunbookView } from "../../shared/api.js";
import {
  INCIDENT_STATUS,
  RUNBOOK_CHARACTER_LIMIT,
  RUNBOOK_SCOPE_CONTAINER,
  RUNBOOK_SUGGESTION,
  RUNBOOK_SUGGESTION_TEXT,
  VERDICT_FIXED,
  WORK_ITEM_STATUS,
  type Trigger,
} from "../../shared/constants.js";
import type { Actor } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { DomainError } from "../domain-error.js";
import type { ReplayService } from "../replay/replay-service.js";
import type { RunbooksService } from "./runbooks-service.js";

// An escalation a person settled: the fix they approved ran, and the incident ended with the container restarted.
interface Settled {
  id: string;
  hostId: string;
  hostLabel: string;
  containerName: string;
  trigger: Trigger;
  detectedAt: number;
  action: string;
  target: string;
  note: string | null;
  outcome: string | null;
}

interface Case {
  key: string;
  title: string;
  settled: Settled[];
}

const SETTLED_ESCALATIONS = `
SELECT incidents.id AS id, incidents.host_id AS hostId, hosts.label AS hostLabel,
  incidents.container_name AS containerName, incidents.trigger_event AS trigger, incidents.detected_at AS detectedAt,
  approvals.choice AS action, COALESCE(approvals.target, incidents.container_name) AS target,
  approvals.note AS note, incidents.outcome AS outcome
FROM incidents
JOIN hosts ON hosts.id = incidents.host_id
JOIN work_items ON work_items.incident_id = incidents.id AND work_items.status = @done
  -- The newest approval's fix held: a late result for an expired, older one is not counted again.
  AND NOT EXISTS (SELECT 1 FROM work_items AS newer
    WHERE newer.incident_id = incidents.id AND newer.created_at > work_items.created_at)
JOIN approvals ON approvals.id = work_items.approval_id
WHERE incidents.status = @resolved AND incidents.verdict = @fixed AND incidents.detected_at >= @since
ORDER BY incidents.detected_at DESC
LIMIT @limit`;

// The latest replay that tried this draft version.
const REPLAY_OF_VERSION = `
SELECT replay_runs.id AS id FROM replay_runs, json_each(replay_runs.draft_version_ids_json) AS draft
WHERE draft.value = ? ORDER BY replay_runs.created_at DESC, replay_runs.rowid DESC LIMIT 1`;

const newestVersion = (runbook: RunbookView) =>
  runbook.versions.reduce((newest, version) => (version.version > newest.version ? version : newest));

// The instruction the model reads, then the escalations behind it, the newest first.
function bodyOf({ settled }: Case): string {
  const [newest] = settled;
  const text = RUNBOOK_SUGGESTION_TEXT;
  const lines = settled
    .slice(0, RUNBOOK_SUGGESTION.evidenceLines)
    .map((row) =>
      text.line(
        new Date(row.detectedAt).toISOString().slice(0, 10),
        (row.note ?? row.outcome ?? "").slice(0, RUNBOOK_SUGGESTION.noteCharacters),
      ),
    );
  return [
    text.instruction(newest!.containerName, newest!.trigger, newest!.action, newest!.target),
    text.evidence(settled.length),
    ...lines,
  ]
    .join("\n")
    .slice(0, RUNBOOK_CHARACTER_LIMIT);
}

export interface RunbookSuggestionsDependencies {
  databaseHandle: DatabaseHandle;
  runbooks: Pick<RunbooksService, "list" | "get" | "create">;
  replays: Pick<ReplayService, "start" | "get">;
  clock?: () => number;
}

/**
 * Recurring escalations a runbook could answer: the same container escalated three times in 30 days with the same
 * trigger, and each time the same fix a person approved held. Each is only suggested: an admin's Make a draft saves
 * it as their own unpublished runbook and replays it on those incidents; publishing it is theirs too.
 */
export class RunbookSuggestions {
  private readonly clock: () => number;

  constructor(private readonly dependencies: RunbookSuggestionsDependencies) {
    this.clock = dependencies.clock ?? Date.now;
  }

  list(): RunbookSuggestionView[] {
    const runbooks = this.dependencies.runbooks.list();
    // ponytail: a draft is found by its container name, as a runbook applies; two hosts' cases with one title share
    // it. Key drafts by host too if that ever happens.
    return this.cases()
      .flatMap((found) => {
        const runbook = runbooks.find(
          (each) =>
            each.scope === RUNBOOK_SCOPE_CONTAINER &&
            each.pattern === found.settled[0]!.containerName &&
            each.title === found.title,
        );
        // A published draft answers the case, and an archived one sets it aside.
        if (runbook !== undefined && (runbook.archived || runbook.publishedVersion !== null)) {
          return [];
        }
        return [this.view(found, runbook ?? null)];
      })
      .slice(0, RUNBOOK_SUGGESTION.shown);
  }

  /** Saves the case as the admin's unpublished runbook, unless it is already, and tries it on its incidents. */
  async draft(actor: Actor, key: string): Promise<RunbookSuggestionView> {
    const found = this.cases().find((each) => each.key === key);
    const shown = this.list().find((each) => each.key === key);
    if (found === undefined || shown === undefined) {
      throw new DomainError(API_ERRORS.runbookSuggestionNotFound);
    }
    const [newest] = found.settled;
    const runbook =
      shown.runbookId === null
        ? this.dependencies.runbooks.create(actor, {
            scope: RUNBOOK_SCOPE_CONTAINER,
            pattern: newest!.containerName,
            title: found.title,
            body: bodyOf(found),
          })
        : this.dependencies.runbooks.get(shown.runbookId);
    await this.dependencies.replays.start(actor, {
      draftVersionIds: [newestVersion(runbook).id],
      incidentCount: found.settled.length,
      incidentIds: found.settled.map((row) => row.id),
    });
    return this.view(found, runbook);
  }

  private cases(): Case[] {
    const rows = this.dependencies.databaseHandle.sqlite.prepare(SETTLED_ESCALATIONS).all({
      done: WORK_ITEM_STATUS.done,
      resolved: INCIDENT_STATUS.resolved,
      fixed: VERDICT_FIXED,
      since: this.clock() - RUNBOOK_SUGGESTION.windowMilliseconds,
      limit: RUNBOOK_SUGGESTION.scanned,
    }) as Settled[];
    const groups = new Map<string, Settled[]>();
    for (const row of rows) {
      const key = sha256Hex(JSON.stringify([row.hostId, row.containerName, row.trigger, row.action, row.target]));
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()]
      .filter(([, settled]) => settled.length >= RUNBOOK_SUGGESTION.incidents)
      .map(([key, settled]) => {
        const [newest] = settled;
        const title = RUNBOOK_SUGGESTION_TEXT.title(
          newest!.containerName,
          newest!.trigger,
          newest!.action,
          newest!.target,
        );
        return { key, title, settled };
      });
  }

  private view(found: Case, runbook: RunbookView | null): RunbookSuggestionView {
    const [newest] = found.settled;
    return {
      key: found.key,
      hostId: newest!.hostId,
      hostLabel: newest!.hostLabel,
      containerName: newest!.containerName,
      trigger: newest!.trigger,
      action: newest!.action,
      target: newest!.target,
      incidents: found.settled.map((row) => ({ id: row.id, detectedAt: row.detectedAt })),
      title: found.title,
      runbookId: runbook?.id ?? null,
      replay: runbook === null ? null : this.replayOf(runbook, found),
    };
  }

  // The draft's latest replay: how many of its decisions came out as the fix that held.
  private replayOf(runbook: RunbookView, found: Case): RunbookSuggestionView["replay"] {
    const row = this.dependencies.databaseHandle.sqlite.prepare(REPLAY_OF_VERSION).get(newestVersion(runbook).id) as
      { id: string } | undefined;
    if (row === undefined) {
      return null;
    }
    const [newest] = found.settled;
    const run = this.dependencies.replays.get(row.id);
    const matched = run.results.filter(
      (result) => result.replayAction === newest!.action && result.replayTarget === newest!.target,
    ).length;
    return { id: run.id, status: run.status, matched, incidents: run.incidentCount };
  }
}
