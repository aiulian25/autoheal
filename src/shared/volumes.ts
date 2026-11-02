import { z } from "zod";
import { REPORT_LIMITS, VOLUME_LOOK, VOLUME_NAME } from "./constants.js";

const reportedName = z.string().max(REPORT_LIMITS.nameCharacters);

const volumeMemberSchema = z.object({
  name: reportedName,
  running: z.boolean(),
  // Where the volume sits in that container.
  destination: z.string().max(REPORT_LIMITS.imageCharacters),
});

export const volumeReportSchema = z.object({
  name: reportedName,
  driver: reportedName,
  // Null until Docker's slower count of them has answered.
  sizeBytes: z.number().int().min(0).nullable(),
  createdAt: reportedName,
  // Docker gave it a hash for a name, for a single container.
  nameless: z.boolean(),
  project: reportedName.nullable(),
  projectHere: z.boolean(),
  // Autoheal's own: its safety records live in these, in their labels, so they look empty and are not.
  own: z.boolean(),
  // Another tool's, as its labels say.
  ownedBy: reportedName.nullable(),
  members: z.array(volumeMemberSchema).max(REPORT_LIMITS.containers),
});
export type VolumeReport = z.infer<typeof volumeReportSchema>;

export const VOLUME_SHARE = { nfs: "nfs", smb: "smb" } as const;
export type VolumeShareKind = (typeof VOLUME_SHARE)[keyof typeof VOLUME_SHARE];

export const newVolumeSchema = z.object({
  name: z.string().regex(VOLUME_NAME),
  // ponytail: no share credentials; they would sit in the job's row and in Docker's volume options. Open shares only.
  share: z
    .object({
      kind: z.enum([VOLUME_SHARE.nfs, VOLUME_SHARE.smb]),
      address: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,253}$/),
      path: z.string().regex(/^\/[^\s,]{0,1023}$/),
    })
    .nullable(),
});
export type NewVolume = z.infer<typeof newVolumeSchema>;

export const volumeRemovalSchema = z.object({
  names: z.array(z.string().regex(VOLUME_NAME)).min(1).max(REPORT_LIMITS.volumes),
  // A person was told what it holds and said yes. Otherwise only what the host then finds empty goes.
  evenWithData: z.boolean(),
});
export type VolumeRemoval = z.infer<typeof volumeRemovalSchema>;

export const volumeLookEntrySchema = z.object({
  path: z.string().max(VOLUME_LOOK.pathCharacters),
  folder: z.boolean(),
  sizeBytes: z.number().int().min(0),
  modifiedAt: z.number().int().min(0),
});
export type VolumeLookEntry = z.infer<typeof volumeLookEntrySchema>;

export const volumeLookAnswerSchema = z.object({
  error: z.string().max(REPORT_LIMITS.summaryCharacters).nullable(),
  entries: z.array(volumeLookEntrySchema).max(VOLUME_LOOK.entries),
  // It holds more than was read.
  partial: z.boolean(),
});
export type VolumeLookAnswer = z.infer<typeof volumeLookAnswerSchema>;

export interface VolumeLookRequest {
  id: string;
  name: string;
}

export const VOLUME_STATE = {
  autohealOwn: "autoheal_own",
  inUse: "in_use",
  keptForStopped: "kept_for_stopped",
  otherTool: "other_tool",
  leftBehind: "left_behind",
  projectStillHere: "project_still_here",
  notUsed: "not_used",
} as const;
export type VolumeState = (typeof VOLUME_STATE)[keyof typeof VOLUME_STATE];

export function volumeState(volume: VolumeReport): VolumeState {
  if (volume.own) return VOLUME_STATE.autohealOwn;
  if (volume.members.some((member) => member.running)) return VOLUME_STATE.inUse;
  if (volume.members.length > 0) return VOLUME_STATE.keptForStopped;
  if (volume.ownedBy !== null) return VOLUME_STATE.otherTool;
  if (volume.nameless) return VOLUME_STATE.leftBehind;
  if (volume.project === null) return VOLUME_STATE.notUsed;
  return volume.projectHere ? VOLUME_STATE.projectStillHere : VOLUME_STATE.leftBehind;
}

/** What goes without a question: nameless, attached to nothing, and known to hold nothing. */
export const isCleanableVolume = (volume: VolumeReport) =>
  volumeState(volume) === VOLUME_STATE.leftBehind && volume.nameless && volume.sizeBytes === 0;

/** A person may be asked about these; a container on it, or Autoheal's own, it cannot go at all. */
export const isRemovableVolume = (volume: VolumeReport) => !volume.own && volume.members.length === 0;
