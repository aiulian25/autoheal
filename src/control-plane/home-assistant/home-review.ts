import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HOME_REVIEW_LIMITS, HOME_REVIEW_TEXT } from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import {
  HOME_REVIEW_RUN,
  HOME_SUGGESTION_KIND,
  type HomeDeadReference,
  type HomeReviewRun,
  type HomeReviewView,
  type HomeSuggestion,
} from "../../shared/home-review.js";
import { redactSecrets } from "../../shared/redaction.js";
import { charactersLeft } from "../../shared/prompt.js";
import {
  aliasOf,
  commentedOutBlocks,
  deadReferences,
  entityReferences,
  ScanBudget,
  findLeftovers,
  readYamlFiles,
  topLevelBlocks,
  yamlProblems,
} from "./home-config-scan.js";

export interface HomeFacts {
  areas: ReadonlyMap<string, string>;
  devices: readonly { id: string; area_id: string | null }[];
  entities: readonly {
    entity_id: string;
    device_id: string | null;
    disabled_by: string | null;
    area_id?: string | null;
    entity_category?: string | null;
  }[];
  states: ReadonlyMap<string, { state: string; attributes: { friendly_name?: string; device_class?: string } }>;
}

export interface HomeLogRecord {
  name?: string;
  message?: string[];
  level?: string;
  source?: [string, number];
  exception?: string;
  count?: number;
  timestamp?: number;
}

export interface HomeReviewDependencies {
  root: string;
  connected: () => boolean;
  facts: () => HomeFacts | null;
  systemLog: () => Promise<HomeLogRecord[] | null>;
  ask: (system: string, user: string, format: object) => Promise<string>;
  contextTokens: () => number;
  clock: () => number;
  // How it looks at the folder, and how long it may: real by default, tests stage a slow one.
  scanFolder?: (root: string, budget: ScanBudget) => Promise<ScannedFolder>;
  scanMilliseconds?: number;
  scanGraceMilliseconds?: number;
}

interface ScannedFolder {
  files: { path: string; text: string }[];
  skipped: HomeReviewView["skippedFiles"];
  leftovers: HomeReviewView["leftovers"];
}

const scanFolderOf = async (root: string, budget: ScanBudget): Promise<ScannedFolder> => {
  const { files, skipped } = await readYamlFiles(root, budget);
  return { files, skipped, leftovers: await findLeftovers(root, budget) };
};

const IDLE: HomeReviewRun = { status: HOME_REVIEW_RUN.idle, at: null, suggestions: [], error: null };
const MARK_OF_CONFIG = "configuration.yaml";
const answerSchema = z.object({
  suggestions: z
    .array(
      z.object({
        kind: z.enum([HOME_SUGGESTION_KIND.fix, HOME_SUGGESTION_KIND.new, HOME_SUGGESTION_KIND.improve]),
        title: z.string(),
        why: z.string(),
        yaml: z.string(),
      }),
    )
    .max(HOME_REVIEW_LIMITS.suggestions),
});
const ANSWER_FORMAT = z.toJSONSchema(answerSchema);

const idOf = (record: HomeLogRecord) =>
  createHash("sha256")
    .update(JSON.stringify([record.name, record.source, record.message?.[0]]))
    .digest("hex")
    .slice(0, HOME_REVIEW_LIMITS.idCharacters);

const messageOf = (record: HomeLogRecord) => redactSecrets((record.message ?? []).join("\n"));

function withinTime<Result>(work: Promise<Result>, milliseconds: number): Promise<Result> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(HOME_REVIEW_TEXT.tooSlow)), milliseconds).unref();
    }),
  ]);
}

interface Scan {
  at: number;
  files: { path: string; text: string }[];
  leftovers: HomeReviewView["leftovers"];
  skipped: HomeReviewView["skippedFiles"];
  comments: HomeReviewView["comments"];
  incomplete: HomeReviewView["scanIncomplete"];
}

/**
 * Home Assistant's configuration, read through a read-only mount, and what the model suggests from it. Nothing here
 * writes, to the folder or to Home Assistant: a suggestion is for a person to read and paste.
 * ponytail: answers live in memory and go with a restart, since one click brings them back. Store them if they prove slow.
 */
export class HomeReview {
  private scan: Scan | null = null;
  // Held until the look itself has ended, not until someone stopped waiting for it: never two at once.
  private scanning: { answer: Promise<Scan | null>; stop: AbortController } | null = null;
  // A look begun before a restore belongs to what was replaced: what it finds is not kept.
  private generation = 0;
  private readonly runs = new Map<string, HomeReviewRun>();

  constructor(private readonly dependencies: HomeReviewDependencies) {}

  reset() {
    this.scan = null;
    this.generation += 1;
    this.scanning?.stop.abort();
    this.runs.clear();
  }

  private async mounted(): Promise<boolean> {
    const found = await withinTime(
      stat(join(this.dependencies.root, MARK_OF_CONFIG)),
      HOME_REVIEW_LIMITS.scanMilliseconds,
    );
    return found.isFile();
  }

  private currentScan(fresh = false): Promise<Scan | null> {
    const { clock, root, scanFolder = scanFolderOf } = this.dependencies;
    const { scanMilliseconds = HOME_REVIEW_LIMITS.scanMilliseconds } = this.dependencies;
    const { scanGraceMilliseconds = HOME_REVIEW_LIMITS.scanGraceMilliseconds } = this.dependencies;
    const young = this.scan !== null && clock() - this.scan.at < HOME_REVIEW_LIMITS.scanKeptMilliseconds;
    if (!fresh && young) return Promise.resolve(this.scan);
    if (this.scanning !== null) return this.scanning.answer;
    const stop = new AbortController();
    const budget = new ScanBudget(stop.signal);
    const { generation } = this;
    const deadline = setTimeout(() => stop.abort(), scanMilliseconds);
    deadline.unref();
    const work = (async () => {
      const { files, skipped, leftovers } = await scanFolder(root, budget);
      const comments = files
        .flatMap(({ path, text }) => commentedOutBlocks(path, text))
        .slice(0, HOME_REVIEW_LIMITS.listed);
      const scan = { at: clock(), files, leftovers, comments, skipped, incomplete: budget.incomplete };
      if (generation !== this.generation) return null;
      this.scan = scan;
      return scan;
    })()
      .catch(() => null)
      .finally(() => {
        clearTimeout(deadline);
        this.scanning = null;
      });
    // A read stuck on a share keeps the look open, but nobody waits on it past this.
    const answer = Promise.race([
      work,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), scanMilliseconds + scanGraceMilliseconds).unref();
      }),
    ]);
    this.scanning = { answer, stop };
    return answer;
  }

  private entitiesByRoom(facts: HomeFacts): Map<string, HomeFacts["entities"][number][]> {
    const deviceRooms = new Map(facts.devices.map(({ id, area_id }) => [id, area_id]));
    const rooms = new Map<string, HomeFacts["entities"][number][]>();
    for (const entity of facts.entities) {
      const room = entity.area_id ?? (entity.device_id === null ? null : (deviceRooms.get(entity.device_id) ?? null));
      if (room === null || entity.disabled_by !== null || entity.entity_category != null) continue;
      rooms.set(room, [...(rooms.get(room) ?? []), entity]);
    }
    return rooms;
  }

  private knownEntities(facts: HomeFacts): ReadonlySet<string> {
    return new Set([...facts.entities.map(({ entity_id }) => entity_id), ...facts.states.keys()]);
  }

  private automationsOf(scan: Scan): string[] {
    return scan.files.filter(({ path }) => path === "automations.yaml").flatMap(({ text }) => topLevelBlocks(text));
  }

  async view(): Promise<HomeReviewView> {
    const { connected, facts: factsNow, systemLog } = this.dependencies;
    const mounted = await this.mounted().catch(() => false);
    const scan = mounted ? await this.currentScan() : null;
    const facts = factsNow();
    const records = await systemLog().catch(() => null);
    const rooms = facts === null ? new Map<string, HomeFacts["entities"][number][]>() : this.entitiesByRoom(facts);
    const automations = scan === null ? [] : this.automationsOf(scan);
    const dead: HomeDeadReference[] =
      scan !== null && facts !== null && facts.entities.length > 0
        ? deadReferences(scan.files, this.knownEntities(facts))
        : [];
    return {
      mounted,
      connected: connected(),
      scannedAt: scan?.at ?? null,
      log:
        records === null
          ? null
          : records.slice(0, HOME_REVIEW_LIMITS.listed).map((record) => {
              const id = idOf(record);
              return {
                id,
                level: record.level ?? "",
                name: record.name ?? "",
                message: messageOf(record).slice(0, HOME_REVIEW_LIMITS.messageCharacters),
                source: record.source === undefined ? null : `${record.source[0]}:${record.source[1]}`,
                count: record.count ?? 1,
                lastAt: record.timestamp === undefined ? null : record.timestamp * 1000,
                run: this.runs.get(id) ?? IDLE,
              };
            }),
      deadReferences: dead,
      rooms: [...(facts?.areas ?? new Map<string, string>())]
        .map(([id, name]) => {
          const entities = rooms.get(id) ?? [];
          const names = new Set(entities.map(({ entity_id }) => entity_id));
          return {
            id,
            name,
            entities: entities.length,
            automations: automations.filter((block) => entityReferences(block).some(({ entity }) => names.has(entity)))
              .length,
            run: this.runs.get(`room:${id}`) ?? IDLE,
          };
        })
        .toSorted((first, second) => first.name.localeCompare(second.name)),
      leftovers: scan?.leftovers ?? [],
      comments: scan?.comments ?? [],
      skippedFiles: scan?.skipped ?? [],
      scanIncomplete: scan?.incomplete ?? null,
    };
  }

  async rescan(): Promise<HomeReviewView> {
    await this.currentScan(true);
    return this.view();
  }

  // One at a time per item; its answer is checked against what this home has, and what is not there is said.
  private run(key: string, prompt: () => Promise<{ system: string; user: string }>) {
    const { ask, clock, facts } = this.dependencies;
    if (this.runs.get(key)?.status === HOME_REVIEW_RUN.running) return;
    this.runs.set(key, { ...IDLE, status: HOME_REVIEW_RUN.running, at: clock() });
    void (async () => {
      try {
        const { system, user } = await prompt();
        const parsed = answerSchema.parse(JSON.parse(await ask(system, user, ANSWER_FORMAT)));
        const known = this.knownEntities(facts() ?? { areas: new Map(), devices: [], entities: [], states: new Map() });
        const suggestions: HomeSuggestion[] = parsed.suggestions.map((suggestion) => ({
          ...suggestion,
          unknownEntities: [
            ...new Set(
              entityReferences(suggestion.yaml)
                .map(({ entity }) => entity)
                .filter((entity) => !known.has(entity)),
            ),
          ],
          problems: yamlProblems(suggestion.yaml),
        }));
        this.runs.set(key, { status: HOME_REVIEW_RUN.done, at: clock(), suggestions, error: null });
      } catch (error) {
        this.runs.set(key, { ...IDLE, status: HOME_REVIEW_RUN.failed, at: clock(), error: describeError(error) });
      }
    })();
  }

  /** Asks the model what an error in Home Assistant's log means and how to fix it, showing it what it mentions. */
  async suggestFix(id: string): Promise<boolean> {
    const records = (await this.dependencies.systemLog().catch(() => null)) ?? [];
    const record = records.find((each) => idOf(each) === id);
    if (record === undefined) return false;
    this.run(id, async () => {
      const scan = await this.currentScan();
      const message = messageOf(record);
      const words = [...message.matchAll(/[a-z_]+\.[a-z0-9_]+|'([^']{4,})'/g)].map((match) => match[1] ?? match[0]);
      const mentioned = (scan === null ? [] : this.automationsOf(scan)).filter((block) =>
        words.some((word) => block.includes(word)),
      );
      const said = [message, redactSecrets(record.exception ?? "").slice(-HOME_REVIEW_LIMITS.messageCharacters)]
        .filter((part) => part !== "")
        .join("\n");
      const facts = HOME_REVIEW_TEXT.fixFacts(record.name ?? "", record.source?.join(":") ?? "", said);
      const room = charactersLeft(this.dependencies.contextTokens(), HOME_REVIEW_TEXT.fixSystem, facts);
      return {
        system: HOME_REVIEW_TEXT.fixSystem,
        user: `${facts}\n\n${HOME_REVIEW_TEXT.relatedConfig(redactSecrets(mentioned.join("\n")).slice(0, room))}`,
      };
    });
    return true;
  }

  /** Asks the model for new automations in a room, and better ones than it has, from what is really in that room. */
  suggestForRoom(areaId: string): boolean {
    const facts = this.dependencies.facts();
    const name = facts?.areas.get(areaId);
    if (facts === null || name === undefined) return false;
    this.run(`room:${areaId}`, async () => {
      const scan = await this.currentScan();
      const entities = this.entitiesByRoom(facts).get(areaId) ?? [];
      const lines = entities.slice(0, HOME_REVIEW_LIMITS.roomEntities).map(({ entity_id }) => {
        const state = facts.states.get(entity_id);
        return [entity_id, state?.attributes.friendly_name, state?.attributes.device_class, state?.state]
          .filter((part) => part !== undefined)
          .join(" | ");
      });
      const names = new Set(entities.map(({ entity_id }) => entity_id));
      const automations = (scan === null ? [] : this.automationsOf(scan)).filter((block) =>
        entityReferences(block).some(({ entity }) => names.has(entity)),
      );
      const inventory = HOME_REVIEW_TEXT.roomFacts(
        name,
        lines.join("\n"),
        automations.flatMap((block) => aliasOf(block) ?? []).join("\n"),
      );
      const room = charactersLeft(this.dependencies.contextTokens(), HOME_REVIEW_TEXT.roomSystem, inventory);
      return {
        system: HOME_REVIEW_TEXT.roomSystem,
        user: `${inventory}\n\n${HOME_REVIEW_TEXT.relatedConfig(redactSecrets(automations.join("\n")).slice(0, room))}`,
      };
    });
    return true;
  }
}
