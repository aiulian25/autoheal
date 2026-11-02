import { z } from "zod";

// A person's own Compose file and .env, written as they are. This is what crosses the wire; compose-lint.ts reads it.
export const OWN_COMPOSE_LIMITS = {
  fileCharacters: 128 * 1024,
  folderCharacters: 1024,
  issues: 64,
  messageCharacters: 512,
  lineCharacters: 4096,
  names: 128,
} as const;
export const OWN_ISSUE_LEVEL = { error: "error", warning: "warning" } as const;
export const OWN_FILE = { compose: "compose", env: "env" } as const;

const fileText = z.string().max(OWN_COMPOSE_LIMITS.fileCharacters);
const folder = z
  .string()
  .max(OWN_COMPOSE_LIMITS.folderCharacters)
  .regex(/^\/[^\n\r\0]*[^/\n\r\0]$/)
  .refine((path) => !path.split("/").includes(".."));

// What a person sends. A retry names the failed install it is the second try at, and the control plane decides.
export const ownFilesSchema = z.object({
  own: z.literal(true),
  folder,
  compose: fileText,
  env: fileText,
  retryOf: z.uuid().nullable(),
});
export type OwnFiles = z.infer<typeof ownFilesSchema>;

// Null until the host has said where its apps live.
export const ownCheckBodySchema = ownFilesSchema.omit({ folder: true }).extend({ folder: folder.nullable() });
export type OwnCheckBody = z.infer<typeof ownCheckBodySchema>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
// What the failed install wrote. Only the control plane says so: the host's folder must still hold just that.
export const ownRetrySchema = z.object({ composeSha256: sha256, envSha256: sha256 });
export type OwnRetry = z.infer<typeof ownRetrySchema>;

// What the host is given, once the control plane has admitted it.
export const ownRunSchema = ownFilesSchema.omit({ retryOf: true }).extend({ retry: ownRetrySchema.nullable() });
export type OwnRun = z.infer<typeof ownRunSchema>;
export const ownCheckRunSchema = ownRunSchema.omit({ folder: true }).extend({ folder: folder.nullable() });
export type OwnCheckRun = z.infer<typeof ownCheckRunSchema>;

const fixSchema = z.object({
  label: z.string().max(OWN_COMPOSE_LIMITS.names),
  // Whole lines replaced, numbered from 1 in the file they belong to.
  lines: z
    .array(
      z.object({
        file: z.enum([OWN_FILE.compose, OWN_FILE.env]),
        line: z.number().int().min(1),
        text: z.string().max(OWN_COMPOSE_LIMITS.lineCharacters),
      }),
    )
    .max(8),
  // Set in the .env; a null value is made up for a password and left blank for anything else.
  env: z
    .array(z.object({ name: z.string().max(OWN_COMPOSE_LIMITS.names), value: z.string().max(4096).nullable() }))
    .max(8),
});
export type OwnFix = z.infer<typeof fixSchema>;

export const ownIssueSchema = z.object({
  level: z.enum([OWN_ISSUE_LEVEL.error, OWN_ISSUE_LEVEL.warning]),
  file: z.enum([OWN_FILE.compose, OWN_FILE.env]),
  // Null where nothing points at one line.
  line: z.number().int().min(1).nullable(),
  message: z.string().max(OWN_COMPOSE_LIMITS.messageCharacters),
  fix: fixSchema.nullable(),
});
export type OwnIssue = z.infer<typeof ownIssueSchema>;

export const ownCheckSchema = z.object({
  // Whether Compose could read the files at all: until it can, nothing else is worth saying.
  readable: z.boolean(),
  issues: z.array(ownIssueSchema).max(OWN_COMPOSE_LIMITS.issues),
  // The folder its other apps live in, and how many do.
  parent: z.string().max(OWN_COMPOSE_LIMITS.folderCharacters).nullable(),
  parentProjects: z.number().int().nullable(),
  plan: z
    .object({
      project: z.string().max(OWN_COMPOSE_LIMITS.names),
      containers: z.array(z.string().max(OWN_COMPOSE_LIMITS.names)).max(OWN_COMPOSE_LIMITS.names),
      networks: z.array(z.string().max(OWN_COMPOSE_LIMITS.names)).max(OWN_COMPOSE_LIMITS.names),
      volumes: z.array(z.string().max(OWN_COMPOSE_LIMITS.names)).max(OWN_COMPOSE_LIMITS.names),
      port: z.number().int().nullable(),
    })
    .nullable(),
});
export type OwnCheck = z.infer<typeof ownCheckSchema>;
