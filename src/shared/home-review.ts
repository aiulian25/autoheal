// What Autoheal found by reading Home Assistant's configuration, mounted read-only, and what the model made of it.
export const HOME_REVIEW_RUN = { idle: "idle", running: "running", done: "done", failed: "failed" } as const;
export type HomeReviewRunStatus = (typeof HOME_REVIEW_RUN)[keyof typeof HOME_REVIEW_RUN];
export const HOME_SUGGESTION_KIND = { fix: "fix", new: "new", improve: "improve" } as const;

export interface HomeSuggestion {
  kind: (typeof HOME_SUGGESTION_KIND)[keyof typeof HOME_SUGGESTION_KIND];
  title: string;
  why: string;
  // To copy into Home Assistant by hand; empty when there is nothing to paste.
  yaml: string;
  // What the YAML names that this home does not have: the model made them up, or the device is gone.
  unknownEntities: string[];
  // Mistakes a plain reading of the YAML can see, small models being prone to them.
  problems: string[];
}

export interface HomeReviewRun {
  status: HomeReviewRunStatus;
  at: number | null;
  suggestions: HomeSuggestion[];
  error: string | null;
}

export interface HomeLogEntry {
  id: string;
  level: string;
  name: string;
  message: string;
  source: string | null;
  count: number;
  lastAt: number | null;
  run: HomeReviewRun;
}

export interface HomeDeadReference {
  file: string;
  line: number;
  entity: string;
  nearest: string | null;
}

export interface HomeRoom {
  id: string;
  name: string;
  entities: number;
  automations: number;
  run: HomeReviewRun;
}

export interface HomeLeftover {
  path: string;
  bytes: number;
  modifiedAt: number;
  folder: boolean;
}

export interface HomeCommentBlock {
  file: string;
  fromLine: number;
  toLine: number;
  preview: string;
}

export const HOME_SKIPPED_WHY = {
  link: "link",
  secondName: "second_name",
  notPlain: "not_plain",
  tooBig: "too_big",
  overBudget: "over_budget",
} as const;
export type HomeSkippedWhy = (typeof HOME_SKIPPED_WHY)[keyof typeof HOME_SKIPPED_WHY];

/** A YAML file left unread because of what it really is, whatever its name. Nothing of its contents. */
export interface HomeSkippedFile {
  path: string;
  why: HomeSkippedWhy;
}

// Why a look at the configuration stopped short: what it found is true, but it did not see everything.
export const HOME_SCAN_INCOMPLETE = { time: "time", entries: "entries", bytes: "bytes" } as const;
export type HomeScanIncomplete = (typeof HOME_SCAN_INCOMPLETE)[keyof typeof HOME_SCAN_INCOMPLETE];

export interface HomeReviewView {
  // Whether the folder holds a Home Assistant configuration.
  mounted: boolean;
  connected: boolean;
  scannedAt: number | null;
  // Null when Home Assistant would not give its log.
  log: HomeLogEntry[] | null;
  deadReferences: HomeDeadReference[];
  rooms: HomeRoom[];
  leftovers: HomeLeftover[];
  comments: HomeCommentBlock[];
  skippedFiles: HomeSkippedFile[];
  scanIncomplete: HomeScanIncomplete | null;
}
