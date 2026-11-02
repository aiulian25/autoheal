import { z } from "zod";

// What a person may keep, and nothing else: it only chooses among what they could already see, and grants nothing.
export const VIEW_PREFERENCES_VERSION = 1;
export const VIEW_LIMITS = { views: 20, nameCharacters: 60, searchCharacters: 120, hostIdCharacters: 64 } as const;
export const BOARD_COLUMN_KEYS = ["noticed", "autoheal", "needsYou", "done"] as const;
export type BoardColumnKey = (typeof BOARD_COLUMN_KEYS)[number];

export const savedViewBodySchema = z
  .object({
    name: z.string().trim().min(1).max(VIEW_LIMITS.nameCharacters),
    search: z.string().max(VIEW_LIMITS.searchCharacters),
    problemsOnly: z.boolean(),
    hostId: z.string().max(VIEW_LIMITS.hostIdCharacters),
  })
  .strict();
export type SavedViewBody = z.infer<typeof savedViewBodySchema>;
export const savedViewSchema = savedViewBodySchema.safeExtend({ id: z.string().min(1) });
export type SavedView = z.infer<typeof savedViewSchema>;

const columnKey = z.enum(BOARD_COLUMN_KEYS);
export const boardArrangementSchema = z
  .object({ order: z.array(columnKey), hidden: z.array(columnKey) })
  .strict()
  .refine(({ order }) => order.length === BOARD_COLUMN_KEYS.length && new Set(order).size === order.length)
  .refine(({ hidden }) => new Set(hidden).size === hidden.length && hidden.length < BOARD_COLUMN_KEYS.length);
export type BoardArrangement = z.infer<typeof boardArrangementSchema>;

export interface ViewPreferences {
  views: SavedView[];
  // Null keeps the board as it comes.
  board: BoardArrangement | null;
}

/** The board's columns as a person arranged them; as they come when they have not. */
export function arrangedColumns(board: BoardArrangement | null) {
  const order = board?.order ?? BOARD_COLUMN_KEYS;
  const hidden = board?.hidden ?? [];
  return { visible: order.filter((key) => !hidden.includes(key)), hidden };
}

/** Whether a saved view is the filter state now. */
export const isSameFilter = (view: Omit<SavedViewBody, "name">, other: Omit<SavedViewBody, "name">) =>
  view.search === other.search && view.problemsOnly === other.problemsOnly && view.hostId === other.hostId;
