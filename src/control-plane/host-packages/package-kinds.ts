import { inArray } from "drizzle-orm";
import {
  PACKAGE_KINDS_BATCH,
  PACKAGE_KINDS_JSON_SCHEMA,
  PACKAGE_KINDS_SYSTEM_PROMPT,
  PRIORITY_REPLAY,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import type { OllamaClient } from "../../ollama/ollama-client.js";
import type { DatabaseHandle } from "../database/connection.js";
import { packageKinds } from "../database/schema.js";
import type { DecisionQueue } from "../decisions/decision-queue.js";

/**
 * Which packages keep data, for the ones the rules' own lists don't know: Ollama is asked once per
 * name, from names only, and the answer is kept. Its word can only hold a package for a person.
 */
export class PackageKinds {
  private asking: Promise<void> = Promise.resolve();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly ollama: Pick<OllamaClient, "chat">,
    private readonly queue: Pick<DecisionQueue, "enqueue">,
    private readonly clock: () => number = Date.now,
  ) {}

  /** What was learnt so far: true for a package that keeps data; a name not asked yet is absent. */
  known(names: readonly string[]): Map<string, boolean> {
    if (names.length === 0) {
      return new Map();
    }
    const rows = this.databaseHandle.database
      .select()
      .from(packageKinds)
      .where(inArray(packageKinds.name, [...names]))
      .all();
    return new Map(rows.map(({ name, keepsData }) => [name, keepsData]));
  }

  /** Asks about the names not known yet, one batch after another, behind live incidents. */
  learn(names: readonly string[]): Promise<void> {
    const known = this.known(names);
    const unknown = [...new Set(names)].filter((name) => !known.has(name));
    for (let start = 0; start < unknown.length; start += PACKAGE_KINDS_BATCH) {
      const batch = unknown.slice(start, start + PACKAGE_KINDS_BATCH);
      this.asking = this.asking.then(() => this.ask(batch));
    }
    return this.asking;
  }

  private async ask(names: readonly string[]) {
    try {
      const { content } = await this.queue.enqueue(PRIORITY_REPLAY, (signal) =>
        // A lookup of names, not a judgement: thinking ran out of room on 15 of them (22 October).
        this.ollama.chat(
          PACKAGE_KINDS_SYSTEM_PROMPT,
          names.join("\n"),
          signal,
          PACKAGE_KINDS_JSON_SCHEMA(names),
          false,
        ),
      );
      const said = (JSON.parse(content) as { keepsData?: unknown }).keepsData;
      const keepingData = new Set(Array.isArray(said) ? said.filter((name) => names.includes(name)) : []);
      const decidedAt = this.clock();
      for (const name of names) {
        this.databaseHandle.database
          .insert(packageKinds)
          .values({ name, keepsData: keepingData.has(name), decidedAt })
          .onConflictDoNothing()
          .run();
      }
    } catch (error) {
      // Asked again with the next check: until then the rules decide without it.
      log(describeError(error));
    }
  }
}
