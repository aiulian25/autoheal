import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS } from "../../shared/api.js";
import {
  BOARD_COLUMN_KEYS,
  VIEW_LIMITS,
  VIEW_PREFERENCES_VERSION,
  boardArrangementSchema,
  savedViewSchema,
  type BoardArrangement,
  type BoardColumnKey,
  type SavedView,
  type SavedViewBody,
  type ViewPreferences,
} from "../../shared/view-preferences.js";
import type { DatabaseHandle } from "../database/connection.js";
import { userViewPreferences } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

const storedSchema = z.object({
  version: z.literal(VIEW_PREFERENCES_VERSION),
  views: z.array(z.unknown()).catch([]),
  board: z.unknown().catch(null),
});
const NOTHING: ViewPreferences = { views: [], board: null };
const isColumn = (key: unknown): key is BoardColumnKey => (BOARD_COLUMN_KEYS as readonly unknown[]).includes(key);

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A column this version no longer has is dropped, and one it has gained goes last, so a saved board keeps working.
function boardFrom(stored: unknown): BoardArrangement | null {
  const shape = z.object({ order: z.array(z.unknown()), hidden: z.array(z.unknown()) }).safeParse(stored);
  if (!shape.success) return null;
  const known = shape.data.order.filter(isColumn);
  const order = [...known, ...BOARD_COLUMN_KEYS.filter((key) => !known.includes(key))];
  const result = boardArrangementSchema.safeParse({ order, hidden: shape.data.hidden.filter(isColumn) });
  return result.success ? result.data : null;
}

/** What is stored, keeping only what this version supports: anything else is ignored rather than trusted. */
function preferencesFrom(text: string): ViewPreferences {
  const stored = storedSchema.safeParse(parsed(text));
  if (!stored.success) return NOTHING;
  const views = stored.data.views.flatMap((view) => {
    const result = savedViewSchema.safeParse(view);
    return result.success ? [result.data] : [];
  });
  return { views: views.slice(0, VIEW_LIMITS.views), board: boardFrom(stored.data.board) };
}

/** A person's own views and board. Every call is about the signed-in person: no other's can be named. */
export class ViewPreferencesService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly clock: () => number,
  ) {}

  private get database() {
    return this.databaseHandle.database;
  }

  of(userId: string): ViewPreferences {
    const row = this.database.select().from(userViewPreferences).where(eq(userViewPreferences.userId, userId)).get();
    return row === undefined ? NOTHING : preferencesFrom(row.preferencesJson);
  }

  private save(userId: string, preferences: ViewPreferences) {
    const updatedAt = this.clock();
    const preferencesJson = JSON.stringify({ version: VIEW_PREFERENCES_VERSION, ...preferences });
    this.database
      .insert(userViewPreferences)
      .values({ userId, preferencesJson, updatedAt })
      .onConflictDoUpdate({ target: userViewPreferences.userId, set: { preferencesJson, updatedAt } })
      .run();
    return preferences;
  }

  /** The same name again updates that view. */
  saveView(userId: string, body: SavedViewBody): ViewPreferences {
    const current = this.of(userId);
    const same = current.views.find(({ name }) => name === body.name);
    if (same === undefined && current.views.length >= VIEW_LIMITS.views) {
      throw new DomainError(API_ERRORS.savedViewLimitReached);
    }
    const view: SavedView = { ...body, id: same?.id ?? randomUUID() };
    const views = same === undefined ? [...current.views, view] : current.views.map((v) => (v === same ? view : v));
    return this.save(userId, { ...current, views });
  }

  removeView(userId: string, viewId: string): ViewPreferences {
    const current = this.of(userId);
    const views = current.views.filter(({ id }) => id !== viewId);
    if (views.length === current.views.length) throw new DomainError(API_ERRORS.savedViewNotFound);
    return this.save(userId, { ...current, views });
  }

  /** Null puts the board back as it comes, leaving saved views alone. */
  arrangeBoard(userId: string, board: BoardArrangement | null): ViewPreferences {
    return this.save(userId, { ...this.of(userId), board });
  }
}
