import { z } from "zod";
import { REPORT_LIMITS, STACK_LIMITS } from "./constants.js";

export const STACK_PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
export const STACK_FILE_KIND = { compose: "compose", env: "env" } as const;

const reportedText = () => z.string().max(REPORT_LIMITS.imageCharacters);
const projectName = z.string().regex(STACK_PROJECT);
const filePath = z.string().min(1).max(STACK_LIMITS.pathCharacters);
const fileText = z.string().max(STACK_LIMITS.fileCharacters);

export const stackFileSchema = z.object({
  // Beside its Compose file, or under its folder: never anywhere else.
  path: filePath,
  kind: z.enum([STACK_FILE_KIND.compose, STACK_FILE_KIND.env]),
  // Null when it is not there yet: a stack with no .env can be given one.
  text: fileText.nullable(),
  // What was read, so a save cannot overwrite a change made on the host meanwhile.
  hash: z.string().max(STACK_LIMITS.hashCharacters).nullable(),
  // The last version is kept beside it, to put back.
  hasPrevious: z.boolean(),
});
export type StackFile = z.infer<typeof stackFileSchema>;

export const stackFilesSchema = z.object({
  project: reportedText(),
  folder: reportedText(),
  files: z.array(stackFileSchema).max(STACK_LIMITS.files),
  // Built on the host: an update means building it again.
  builds: z.boolean(),
});
export type StackFiles = z.infer<typeof stackFilesSchema>;

export const stackCheckSchema = z.object({
  // Compose's own words; null when the file reads.
  problem: z.string().max(REPORT_LIMITS.summaryCharacters).nullable(),
  // By Compose's own hash of each service against what the container runs.
  recreate: z.array(reportedText()).max(REPORT_LIMITS.containers),
  unchanged: z.array(reportedText()).max(REPORT_LIMITS.containers),
  added: z.array(reportedText()).max(REPORT_LIMITS.containers),
  removed: z.array(reportedText()).max(REPORT_LIMITS.containers),
  // What it would be worth knowing first, none of which stops a save.
  warnings: z.array(z.string().max(REPORT_LIMITS.summaryCharacters)).max(STACK_LIMITS.warnings),
});
export type StackCheck = z.infer<typeof stackCheckSchema>;

export const STACK_DATA_KEPT = { shared: "shared", unresolved: "unresolved", host: "host" } as const;

export const stackRemovalFactsSchema = z.object({
  containers: z.array(reportedText()).max(REPORT_LIMITS.containers),
  networks: z.array(reportedText()).max(REPORT_LIMITS.networks),
  sharedNetworks: z.array(reportedText()).max(REPORT_LIMITS.networks),
  // Folders inside its own, which go when its data does.
  data: z
    .array(z.object({ path: reportedText(), sizeBytes: z.number().int().min(0).nullable() }))
    .max(STACK_LIMITS.files),
  // Folders inside its own that stay, even with its data removed, and why: only what is verifiably its alone goes.
  kept: z
    .array(
      z.object({
        path: reportedText(),
        why: z.enum([STACK_DATA_KEPT.shared, STACK_DATA_KEPT.unresolved, STACK_DATA_KEPT.host]),
        // The containers that also use it.
        usedBy: z.array(reportedText()).max(REPORT_LIMITS.containers),
      }),
    )
    .max(STACK_LIMITS.files)
    .default([]),
  // Folders it uses elsewhere, which never go.
  outside: z.array(reportedText()).max(REPORT_LIMITS.containers),
});
export type StackRemovalFacts = z.infer<typeof stackRemovalFactsSchema>;

export const stackAnswerSchema = z.object({
  error: z.string().max(REPORT_LIMITS.summaryCharacters).nullable(),
  files: stackFilesSchema.nullable().optional(),
  check: stackCheckSchema.nullable().optional(),
  removal: stackRemovalFactsSchema.nullable().optional(),
  logs: z.string().max(STACK_LIMITS.logCharacters).nullable().optional(),
});
export type StackAnswer = z.infer<typeof stackAnswerSchema>;

const editedFileSchema = z.object({
  path: filePath,
  text: fileText,
  hash: z.string().max(STACK_LIMITS.hashCharacters).nullable(),
});
export type EditedStackFile = z.infer<typeof editedFileSchema>;

export const STACK_ASK = {
  read: "read",
  check: "check",
  save: "save",
  restore: "restore",
  logs: "logs",
  removal: "removal",
} as const;

/** What a person asks of a stack's files: answered at once, and none of it kept on the way. */
export const stackAskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(STACK_ASK.read) }),
  z.object({ kind: z.literal(STACK_ASK.logs) }),
  z.object({ kind: z.literal(STACK_ASK.removal) }),
  z.object({ kind: z.literal(STACK_ASK.restore) }),
  z.object({ kind: z.literal(STACK_ASK.check), files: z.array(editedFileSchema).max(STACK_LIMITS.files) }),
  z.object({ kind: z.literal(STACK_ASK.save), files: z.array(editedFileSchema).min(1).max(STACK_LIMITS.files) }),
]);
export type StackAsk = z.infer<typeof stackAskSchema>;
export type StackRequest = StackAsk & { id: string; project: string };

// How a stack's files and its containers differ, found on its host: names only, never a value or a hash of one.
export const STACK_DRIFT = {
  checkEveryMilliseconds: 10 * 60 * 1000,
  firstCheckMilliseconds: 60 * 1000,
  scriptMilliseconds: 2 * 60 * 1000,
  projects: 64,
  services: 64,
  names: 32,
  nameCharacters: 200,
  revision: /^[a-f0-9]{64}$/,
} as const;
export const STACK_DRIFT_KIND = {
  // Compose's own hash says the files changed since this container was made.
  source: "source",
  // The files have not changed by that hash, yet the container differs from them: by hand, by another tool, or a .env.
  runtime: "runtime",
  // Its files declare it, and it has no container.
  missing: "missing",
  // A container of a service no longer in its files.
  extra: "extra",
  // Compose made no record to compare, or could not read its files.
  unknown: "unknown",
} as const;
export const STACK_DRIFT_FIELD = {
  image: "image",
  environment: "environment",
  labels: "labels",
  ports: "ports",
  mounts: "mounts",
  restart: "restart",
} as const;
const driftName = z.string().max(STACK_DRIFT.nameCharacters);
export const stackDriftSchema = z.object({
  project: projectName,
  revision: z.string().regex(STACK_DRIFT.revision),
  files: z.array(driftName).max(STACK_LIMITS.files),
  // Its files could not be read at all, so nothing can be said of its services.
  unreadable: z.boolean(),
  services: z
    .array(
      z.object({
        service: driftName,
        container: driftName.nullable(),
        kind: z.enum(Object.values(STACK_DRIFT_KIND)),
        fields: z
          .array(
            z.object({
              field: z.enum(Object.values(STACK_DRIFT_FIELD)),
              names: z.array(driftName).max(STACK_DRIFT.names),
            }),
          )
          .max(Object.keys(STACK_DRIFT_FIELD).length),
      }),
    )
    .max(STACK_DRIFT.services),
});
export type StackDrift = z.infer<typeof stackDriftSchema>;
export type StackDriftService = StackDrift["services"][number];
export const stackDriftReportSchema = z.object({
  checkedAt: z.number().int().positive(),
  stacks: z.array(stackDriftSchema).max(STACK_DRIFT.projects),
});
export type StackDriftReport = z.infer<typeof stackDriftReportSchema>;
export interface StackDriftView extends StackDrift {
  firstSeenAt: number;
  lastObservedAt: number;
}
// The reviewed difference a reconcile acts on: refused if what is there now is not what was reviewed.
export const stackJobSchema = z.object({
  project: projectName,
  removeData: z.boolean(),
  reconcile: z.object({ revision: z.string().regex(STACK_DRIFT.revision) }).optional(),
});
export type StackJobDetails = z.infer<typeof stackJobSchema>;

/** Whether a Compose file's text builds an image on the host. */
export const composeBuilds = (text: string) => /^\s*build\s*:/m.test(text);

/** The settings files a Compose file names: only ones beside it, as it is all a person may edit from here. */
export function envFilesNamedIn(text: string): string[] {
  const named = new Set<string>();
  let inList = false;
  for (const line of text.split("\n")) {
    const inline = /^\s*env_file\s*:\s*(\S+)\s*$/.exec(line)?.[1];
    if (inline !== undefined) {
      named.add(inline);
      inList = false;
      continue;
    }
    if (/^\s*env_file\s*:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const item = /^\s*-\s*(?:path\s*:\s*)?(\S+)\s*$/.exec(line)?.[1];
    if (item !== undefined) named.add(item);
    else if (!/^\s*(required\s*:|format\s*:)/.test(line)) inList = false;
  }
  return [...named]
    .map((path) => path.replace(/^["']|["']$/g, "").replace(/^\.\//, ""))
    .filter((path) => !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("$"));
}
