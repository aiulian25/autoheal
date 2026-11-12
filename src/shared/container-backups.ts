import { z } from "zod";
import { STACK_PROJECT } from "./stacks.js";

const GIBIBYTE = 1024 ** 3;

export const CONTAINER_BACKUP = {
  format: "autoheal-container-backup-v2",
  // How every age identity starts: what a sealed key must open to.
  identityPrefix: "AGE-SECRET-KEY-1",
  // Made before manifests were sealed: listed, and restored only by hand.
  unsealedFormat: "autoheal-container-backup-v1",
  manifestFile: "manifest.json",
  // Far past any real one, as it only lists what a backup holds.
  manifestBytes: 1024 * 1024,
  // How many that cannot be read a list names, as a list may be looked at by a person.
  unreadableShown: 20,
  keyFile: "key.age",
  readmeFile: "README.txt",
  settingsFile: "settings.json.age",
  unfinishedPrefix: ".unfinished-",
  stackFolderPrefix: "_stack_",
  // Each host's own folder within the backup folder, which several hosts may share. No container name starts with it.
  hostFolderPrefix: "_host_",
  defaultDirectory: "/var/backups/autoheal",
  kept: 5,
  // Above this, a folder is named and left out unless ticked: a media library is not copied by accident.
  largeBytes: 50 * GIBIBYTE,
  measureMilliseconds: 15_000,
  memoryBytes: 256 * 1024 * 1024,
  progressMilliseconds: 2_000,
  pathCharacters: 1024,
  files: 64,
  members: 64,
  helperLabel: "autoheal.container-backup.job",
  journalLabel: "autoheal.container-backup.journal",
  journalRecord: "autoheal.container-backup.record",
  journalPrefix: "autoheal-container-backup-run-",
  containerPrefix: "autoheal-backup-helper-",
  // Docker's own limits on how long a copy may take: a day, for what a person ticked.
  copyMilliseconds: 24 * 60 * 60 * 1000,
  startMilliseconds: 180_000,
  pollMilliseconds: 2_000,
} as const;

export const BACKUP_METHOD = { files: "files", dump: "dump" } as const;
export const BACKUP_WHY = { asked: "asked", safety: "safety" } as const;
// Why a backup is not offered. Never anything of what its manifest says, which may not be what Autoheal wrote.
export const BACKUP_UNREADABLE = {
  unreadable: "unreadable",
  tooBig: "too_big",
  notJson: "not_json",
  notValid: "not_valid",
} as const;
export const BACKUP_ASK = { preview: "preview", list: "list" } as const;
export const BACKUP_LEFT_OUT = { large: "large", noRoom: "no_room", unmeasured: "unmeasured" } as const;
export const COPY_COMMAND = {
  wait: "wait",
  measure: "measure",
  capture: "capture",
  store: "store",
  verify: "verify",
  finish: "finish",
  list: "list",
  read: "read",
  discard: "discard",
  empty: "empty",
  restore: "restore",
  reveal: "reveal",
} as const;

export const BACKUP_ID = /^\d{8}T\d{6}Z$/;
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
// Where backups may never go: they would be mixed into the host's own files.
const SYSTEM_FOLDERS = /^\/(bin|boot|dev|etc|lib|lib64|proc|run|sbin|sys|usr)(\/|$)/;

/** A path of the host's own that belongs to no app: never copied, and never written over. */
export const isHostFolder = (path: string) =>
  path === "/" || SYSTEM_FOLDERS.test(path) || path === "/var/run" || path.startsWith("/var/run/");

const backupFolder = z
  .string()
  .min(2)
  .max(CONTAINER_BACKUP.pathCharacters)
  .regex(/^\/[^\0\r\n]*$/)
  .refine((path) => !path.split("/").includes("..") && !isHostFolder(path));

export const backupSettingsSchema = z.object({
  directory: backupFolder,
  // A second copy, such as a mounted NAS; none when null.
  copyDirectory: backupFolder.nullable(),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export const BACKUP_SETTINGS_DEFAULT: BackupSettings = {
  directory: CONTAINER_BACKUP.defaultDirectory,
  copyDirectory: null,
};

/** A container, or a Compose project as one. */
export const backupTargetSchema = z.union([
  z.object({ container: z.string().regex(CONTAINER_NAME), stack: z.null().default(null) }),
  z.object({ container: z.null().default(null), stack: z.string().regex(STACK_PROJECT) }),
]);
export type BackupTarget = z.infer<typeof backupTargetSchema>;

const targetFolderName = ({ container, stack }: BackupTarget) =>
  stack === null ? (container as string) : `${CONTAINER_BACKUP.stackFolderPrefix}${stack}`;

/**
 * Where a target's backups go: in the folder of the host that makes them, as several hosts may share the backup folder
 * and each lets go of its oldest there. With no host, the folder every host's went in before they had their own.
 */
export const backupFolderName = (target: BackupTarget, hostId: string | null) =>
  hostId === null
    ? targetFolderName(target)
    : `${CONTAINER_BACKUP.hostFolderPrefix}${hostId}/${targetFolderName(target)}`;

const manifestFileSchema = z.object({
  file: z.string().regex(/^[a-z0-9.-]+$/),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  isTar: z.boolean(),
});
const manifestMountSchema = z.object({
  type: z.enum(["bind", "volume"]),
  source: z.string().max(CONTAINER_BACKUP.pathCharacters),
  target: z.string().max(CONTAINER_BACKUP.pathCharacters),
  file: z.string().regex(/^[a-z0-9.-]+$/),
  // A single file mounted by itself, rather than a folder.
  singleFile: z.boolean(),
  sourceBytes: z.number().int().min(0),
});
const manifestMemberSchema = z.object({
  name: z.string().regex(CONTAINER_NAME),
  image: z.string().max(CONTAINER_BACKUP.pathCharacters),
  imageId: z.string().max(128).nullable(),
  method: z.enum([BACKUP_METHOD.files, BACKUP_METHOD.dump]),
  mounts: z.array(manifestMountSchema).max(CONTAINER_BACKUP.files),
  // A database's own dump: its file, and the databases it held, to compare after a restore.
  dump: z
    .object({ file: z.string().regex(/^[a-z0-9.-]+$/), databases: z.array(z.string().max(256)).max(4096) })
    .nullable(),
});

/** What a backup holds, readable without its key. It holds no setting's value and no secret. */
export const backupManifestSchema = z
  .object({
    format: z.enum([CONTAINER_BACKUP.format, CONTAINER_BACKUP.unsealedFormat]),
    // Set as it is made final, over all the rest: see manifestSeal. The dashboard's key is needed to check it.
    seal: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    id: z.string().regex(BACKUP_ID),
    createdAt: z.number().int(),
    target: backupTargetSchema,
    why: z.enum([BACKUP_WHY.asked, BACKUP_WHY.safety]),
    members: z.array(manifestMemberSchema).min(1).max(CONTAINER_BACKUP.members),
    hasSettings: z.boolean(),
    leftOut: z.array(z.string().max(CONTAINER_BACKUP.pathCharacters)).max(CONTAINER_BACKUP.files),
    files: z.array(manifestFileSchema).max(CONTAINER_BACKUP.files),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupMember = BackupManifest["members"][number];

const sealedKey = z.string().min(40).max(4096);
const recipient = z.string().min(40).max(128);

// A sealed key opens only with the backup passphrase, which only the dashboard holds.
const keyPairSchema = z.object({ recipient, sealedKey });

export const backupJobSchema = z
  .object({
    target: backupTargetSchema,
    directory: backupFolder,
    copyDirectory: backupFolder.nullable(),
    // What a person ticked that is otherwise left out.
    include: z.array(z.string().max(CONTAINER_BACKUP.pathCharacters)).max(CONTAINER_BACKUP.files),
    // For the new backup, or a restore's safety backup.
    key: keyPairSchema,
    // Which backup a restore puts back.
    restoreId: z.string().regex(BACKUP_ID).nullable(),
    // The host it runs on, whose own folder its backups go in. None on a job from before hosts had one.
    hostId: z.uuid().nullable().default(null),
  })
  .strict();
export type BackupJobDetails = z.infer<typeof backupJobSchema>;

export const backupKeyRequestSchema = z.object({ sealedKey });
export const backupKeyAnswerSchema = z.object({ identity: z.string().min(40).max(128) });

export const backupStartBodySchema = z.object({
  target: backupTargetSchema,
  include: z.array(z.string().max(CONTAINER_BACKUP.pathCharacters)).max(CONTAINER_BACKUP.files).default([]),
});
export const backupRestoreBodySchema = z.object({
  target: backupTargetSchema,
  id: z.string().regex(BACKUP_ID),
});
export const backupAskBodySchema = z.object({
  kind: z.enum([BACKUP_ASK.preview, BACKUP_ASK.list]),
  target: backupTargetSchema,
});

export const backupRequestSchema = z.object({
  id: z.string(),
  kind: z.enum([BACKUP_ASK.preview, BACKUP_ASK.list]),
  target: backupTargetSchema,
  directory: backupFolder,
  hostId: z.uuid().nullable().default(null),
});
export type BackupRequest = z.infer<typeof backupRequestSchema>;

const previewMountSchema = z.object({
  member: z.string(),
  source: z.string().max(CONTAINER_BACKUP.pathCharacters),
  target: z.string().max(CONTAINER_BACKUP.pathCharacters),
  // Null when it could not be measured in time.
  bytes: z.number().int().min(0).nullable(),
  leftOut: z.enum([BACKUP_LEFT_OUT.large, BACKUP_LEFT_OUT.noRoom, BACKUP_LEFT_OUT.unmeasured]).nullable(),
});
export const backupPreviewSchema = z.object({
  mounts: z.array(previewMountSchema).max(CONTAINER_BACKUP.files),
  dumps: z.array(z.object({ member: z.string(), engine: z.string() })).max(CONTAINER_BACKUP.members),
  // Containers that stop while it copies, its own and any sharing its data.
  stops: z.array(z.string()).max(CONTAINER_BACKUP.members),
  savesSettings: z.boolean(),
  directory: z.string(),
  freeBytes: z.number().min(0).nullable(),
});
export type BackupPreview = z.infer<typeof backupPreviewSchema>;

/** One backup as a list shows it. */
export const backupEntrySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  why: z.enum([BACKUP_WHY.asked, BACKUP_WHY.safety]),
  bytes: z.number().min(0),
  fromStack: z.boolean(),
  members: z.array(z.object({ name: z.string(), image: z.string(), method: z.string(), sameImage: z.boolean() })),
  hasSettings: z.boolean(),
  leftOut: z.array(z.string()),
  // Made before manifests were sealed, so nothing vouches for where it would write.
  unsealed: z.boolean().default(false),
});
export type BackupEntry = z.infer<typeof backupEntrySchema>;

export const backupAnswerSchema = z.object({
  // Why not: a person is told, in these words.
  refusal: z.string().max(1000).nullable(),
  preview: backupPreviewSchema.nullable().optional(),
  backups: z.array(backupEntrySchema).nullable().optional(),
  // What is there but not offered. Older runners do not say.
  unreadable: z
    .array(z.object({ folder: z.string(), id: z.string(), reason: z.enum(Object.values(BACKUP_UNREADABLE)) }))
    .max(CONTAINER_BACKUP.unreadableShown)
    .optional(),
  unreadableCount: z.number().int().min(0).optional(),
});
export type BackupAnswer = z.infer<typeof backupAnswerSchema>;

export const BACKUP_TEXT = {
  notThere: (name: string) => `${name} is not on this host any more.`,
  protected: (name: string) => `${name} is protected, so Autoheal does not stop it.`,
  self: "Autoheal has its own database backup, and does not stop itself.",
  dryRun: "This host is in dry-run, so nothing is changed on it.",
  nothing: "This has no data of its own to save.",
  noRoom: (needed: string, free: string) => `It needs about ${needed}, and only ${free} is free where backups go.`,
  gone: "That backup is no longer there.",
  notHeld: (name: string) =>
    `This would also touch ${name}, which is not part of what was asked for, so nothing was touched. Restore ${name} by itself, or take a new backup.`,
  notSealed:
    "This backup was made before backups were sealed, so Autoheal cannot vouch for where it would write. Its README says how to restore it by hand.",
  sealBroken:
    "This backup's details do not match what was sealed when it was made, so they may have been changed. Nothing was touched.",
  mountChanged: (name: string, target: string) =>
    `${name} does not keep ${target} where this backup says it did, so nothing was touched. If it was moved on purpose, take a new backup or restore by hand.`,
  helperDied:
    "The helper doing the copy stopped without saying why. It may have run out of memory, or the folder may be on tmpfs.",
  otherRun: "Another backup or restore is running on this host.",
  dumpEmpty: "The database's dump came back empty.",
  dumpFailed: (reason: string) => `The database's dump failed: ${reason}`,
  feedFailed: (reason: string) => `Loading the dump failed, so the database was put back as it was: ${reason}`,
  feedMissing: (names: string) => `After loading the dump these databases were missing, so it was put back: ${names}`,
  notReady: (name: string) => `${name} did not come up in time.`,
  blocked: (names: string) =>
    `A restore of ${names} was interrupted, so they stay stopped rather than start on half-written data. Restore any backup to go on.`,
  backedUp: (size: string) => `Backup saved and checked: ${size}.`,
  copyFailed: (reason: string) => `The second copy failed, though this backup is fine: ${reason}`,
  restored: (when: string) => `Restored to ${when}.`,
  // The data is back, but something the restore was asked for did not happen: it is not over, and says so.
  restoredNotFinished: (when: string) =>
    `The data is back as it was at ${when}, but this restore did not finish: part of what it was asked to put back is not in place. It stays open until someone looks or it is asked again.`,
  stackNotUp: (project: string, reason: string) =>
    `${project} could not be brought up from the Compose files that came back${reason === "" ? "" : `: ${reason}`}.`,
  restoredNotUp: (names: string) => `The data is back, but ${names} did not come back healthy. See its logs.`,
  notQuiet: "A container using this data could not be confirmed stopped, so nothing was written back.",
  stillRunning: (names: string) =>
    `${names} could not be confirmed stopped and may still be running. Stop it before trying again.`,
  notStarted: (names: string) => `${names} did not start again, and needs starting by hand.`,
  failedRunning: (reason: string) => `It did not finish, and everything is running again: ${reason}`,
  failedStopped: (reason: string, names: string) => `It did not finish: ${reason}. ${names} did not start again.`,
  restoreFailedStopped: (reason: string, names: string) =>
    `The restore did not finish: ${reason}. ${names} stay stopped rather than start on half-written data. Try it again, or restore the backup taken just before it.`,
  restoreRefused: (reason: string) => `Nothing was changed: ${reason}`,
  settingsNotRestored: (reason: string) => `The data is back, but its Compose files were left as they are: ${reason}`,
  keptStoppedForSettings: (names: string) =>
    `${names} stay stopped rather than start under settings this data does not belong with. Put the files right and restore again, or start them by hand if the version they run suits this data.`,
  // A Compose file says what every service of its stack is, so putting one back and bringing the stack up would
  // recreate the rest from it, on data this restore never looked at and nobody asked about.
  // A container of no stack keeps its settings in Docker, not in a file Autoheal can put back. Its data comes back
  // under whatever it runs now, which may be a newer image than the one the data was written by.
  ownSettingsNotRestored: (names: string) =>
    `The data is back, and ${names} still runs the settings and image it runs now: a container that is not part of a stack keeps those in Docker, and this restore does not put them back. Check it is the version this data belongs with.`,
  settingsWiderThanRestore: (project: string, others: string) =>
    `The data is back, and ${project}'s Compose files were left as they are: they also say what ${others} is, which this restore does not cover. To put the files back too, restore the whole stack.`,
} as const;

export const backupReadme = (
  name: string,
) => `A backup of ${name} made by Autoheal. It does not need Autoheal to put back.

You need the backup passphrase, and the age tool (https://age-encryption.org).

1. Open this backup's key, typing the passphrase when asked:
     age -d -o key.txt key.age

2. Look in manifest.json. It says which file holds what, and where each belongs. Anyone able to write to this
   folder could have changed it, and tar writes wherever you tell it, so check each path against your container first.

3. Stop the container, then put each folder back, as root:
     age -d -i key.txt data-0.tar.age | tar -xpf - --numeric-owner --acls --xattrs -C /where/it/belongs

   A database saved by its own tool has a dump file instead. Start it empty, then:
     age -d -i key.txt dump-0.sql.age | docker exec -i <container> psql -U postgres -d postgres

   Its Compose file and .env are in settings.json.age, as JSON:
     age -d -i key.txt settings.json.age

4. Delete key.txt when you are done. Anyone with it can read this backup.
`;
