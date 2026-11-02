import { z } from "zod";
import { BYTES_PER_MEBIBYTE } from "./constants.js";
export const SEARCH_LIMITS = {
  query: 80,
  perKind: 5,
  results: 30,
  hosts: 128,
  containers: 4096,
  // A host whose container list is bigger than this is left out of a search instead of parsed.
  containersJsonBytes: BYTES_PER_MEBIBYTE,
  cacheEntries: 4,
  cacheMilliseconds: 5000,
  debounceMilliseconds: 300,
} as const;
export const SEARCH_KINDS = ["host", "container", "task", "incident", "runbook", "change"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const searchRequestSchema = z
  .object({ q: z.string().trim().min(2).max(SEARCH_LIMITS.query), hostId: z.uuid().optional() })
  .strict();
export interface SearchResult {
  kind: SearchKind;
  id: string;
  hostId: string | null;
  title: string;
  snippet: string;
  at: number | null;
  href: string;
}
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  partial: boolean;
  elapsedMilliseconds: number;
}
