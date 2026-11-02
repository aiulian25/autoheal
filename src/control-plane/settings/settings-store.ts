import { eq } from "drizzle-orm";
import { z } from "zod";
import { SETTING_KEYS, type SettingKey } from "../../shared/constants.js";
import { log } from "../../shared/log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { settings } from "../database/schema.js";

/**
 * What the dashboard sets rather than the environment, one JSON value per key. A value that no
 * longer fits its schema (an older shape, a hand edit) reads as unset rather than breaking a page.
 */
export class SettingsStore {
  private readonly schemas = new Map<SettingKey, z.ZodType>();
  private readonly invalid = new Map<SettingKey, "invalid JSON" | "invalid shape">();
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly clock: () => number = Date.now,
  ) {}

  read<Value>(key: SettingKey, schema: z.ZodType<Value>): Value | null {
    this.schemas.set(key, schema);
    const row = this.databaseHandle.database.select().from(settings).where(eq(settings.key, key)).get();
    if (row === undefined) {
      this.invalid.delete(key);
      return null;
    }
    return this.validate(key, row.valueJson, schema);
  }

  /** Known keys only: refresh from the current database, including after restore or a manual repair.
   * Schemas belong to the readers; unread settings can still be checked for malformed JSON.
   */
  invalidKeys(): SettingKey[] {
    const rows = new Map(
      this.databaseHandle.database
        .select()
        .from(settings)
        .all()
        .map((row) => [row.key, row.valueJson]),
    );
    return Object.values(SETTING_KEYS).filter((key) => {
      const json = rows.get(key);
      if (json === undefined) this.invalid.delete(key);
      else this.validate(key, json, this.schemas.get(key) ?? z.unknown());
      return this.invalid.has(key);
    });
  }

  private validate<Value>(key: SettingKey, json: string, schema: z.ZodType<Value>): Value | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(json);
    } catch {
      return this.invalidSetting(key, "invalid JSON");
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) return this.invalidSetting(key, "invalid shape");
    this.invalid.delete(key);
    return parsed.data;
  }

  private invalidSetting(key: SettingKey, reason: "invalid JSON" | "invalid shape"): null {
    if (this.invalid.get(key) !== reason)
      log(`Invalid saved setting ${key}: ${reason}; using environment or default configuration.`);
    this.invalid.set(key, reason);
    return null;
  }

  write(key: SettingKey, value: unknown) {
    const valueJson = JSON.stringify(value);
    const updatedAt = this.clock();
    this.databaseHandle.database
      .insert(settings)
      .values({ key, valueJson, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt } })
      .run();
    this.invalid.delete(key);
  }

  remove(key: SettingKey) {
    this.databaseHandle.database.delete(settings).where(eq(settings.key, key)).run();
    this.invalid.delete(key);
  }
}
