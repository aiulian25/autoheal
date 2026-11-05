import { z } from "zod";

export const REBOOT_PLAN_STATUS = {
  running: "running",
  paused: "paused",
  completed: "completed",
  cancelled: "cancelled",
} as const;
export const REBOOT_STEP_STATUS = {
  waiting: "waiting",
  // A reboot was asked of the host. Nothing can take that back.
  asked: "asked",
  // The host's new boot was seen, and it or a required check is not ready yet.
  back: "back",
  done: "done",
  refused: "refused",
  cancelled: "cancelled",
} as const;
export type RebootPlanStatus = (typeof REBOOT_PLAN_STATUS)[keyof typeof REBOOT_PLAN_STATUS];
export type RebootStepStatus = (typeof REBOOT_STEP_STATUS)[keyof typeof REBOOT_STEP_STATUS];

export const REBOOT_PLAN = {
  members: { minimum: 2, maximum: 16 },
  checks: 16,
  nameCharacters: 80,
  returnMinutes: { minimum: 1, maximum: 120, usual: 15 },
  retained: 20,
  reasonCharacters: 500,
  // How old a host's last word may be and still count as healthy now: its live stats come every 5 seconds.
  freshMilliseconds: 60_000,
  tickMilliseconds: 15_000,
} as const;
/** The status kept beside a plan whose saved form this version cannot read: never one a plan itself may have. */
export const REBOOT_PLAN_UNREADABLE = "unreadable";

export const REBOOT_PLAN_ROUTES = {
  plans: "/api/reboot-plans",
  preview: "/api/reboot-plans/preview",
  resume: "/api/reboot-plans/:planId/resume",
  cancel: "/api/reboot-plans/:planId/cancel",
} as const;

// Explicit, whatever Compose or a host's name might suggest. It never changes once approved.
export const rebootPlanBodySchema = z
  .object({
    name: z.string().trim().min(1).max(REBOOT_PLAN.nameCharacters),
    hostIds: z
      .array(z.string().min(1))
      .min(REBOOT_PLAN.members.minimum)
      .max(REBOOT_PLAN.members.maximum)
      .refine((ids) => new Set(ids).size === ids.length),
    minimumHealthy: z.number().int().min(1),
    probeIds: z
      .array(z.string().min(1))
      .max(REBOOT_PLAN.checks)
      .refine((ids) => new Set(ids).size === ids.length),
    returnMinutes: z.number().int().min(REBOOT_PLAN.returnMinutes.minimum).max(REBOOT_PLAN.returnMinutes.maximum),
    notBefore: z.number().int().positive().nullable(),
    notAfter: z.number().int().positive().nullable(),
  })
  .strict()
  // Rebooting one at a time, so one fewer than all is the most that can stay up.
  .refine(({ hostIds, minimumHealthy }) => minimumHealthy < hostIds.length)
  .refine(({ notBefore, notAfter }) => notBefore === null || notAfter === null || notBefore < notAfter);
export type RebootPlanBody = z.infer<typeof rebootPlanBodySchema>;

export const rebootStepSchema = z.object({
  hostId: z.string(),
  hostLabel: z.string(),
  status: z.enum(Object.values(REBOOT_STEP_STATUS)),
  jobId: z.string().nullable(),
  // From when it may take its time to come back: when it was asked, or when a person last said to keep waiting.
  followingSince: z.number().nullable(),
  backAt: z.number().nullable(),
  doneAt: z.number().nullable(),
});
export const rebootPlanViewSchema = z.object({
  id: z.string(),
  body: rebootPlanBodySchema,
  status: z.enum(Object.values(REBOOT_PLAN_STATUS)),
  createdBy: z.object({ userId: z.string(), username: z.string() }),
  createdAt: z.number(),
  updatedAt: z.number(),
  cancelAsked: z.boolean(),
  reason: z.string().nullable(),
  steps: z.array(rebootStepSchema),
});
export type RebootStep = z.infer<typeof rebootStepSchema>;
export type RebootPlanView = z.infer<typeof rebootPlanViewSchema>;

export interface RebootPlanPreview {
  hosts: {
    hostId: string;
    label: string;
    // Null when it is healthy now.
    problem: string | null;
    rebootRequired: boolean | null;
    openJobs: number;
  }[];
  checks: { probeId: string; name: string; problem: string | null }[];
  // Why it would not start now; null when it would.
  problem: string | null;
}

export const REBOOT_PLAN_TEXT = {
  notFresh: (host: string) => `${host} has not reported recently.`,
  notActive: (host: string) => `${host} is no longer part of the fleet.`,
  stillStarting: (host: string) => `${host} has not finished starting.`,
  rebooting: (host: string) => `${host} is being rebooted or shut down.`,
  tooFew: (healthy: number, minimum: number, host: string) =>
    `Rebooting ${host} would leave ${healthy} healthy, and this plan needs ${minimum}.`,
  // A saved plan this version cannot read. Its own contents are never repeated: only that it is there, and that
  // whether a reboot is going on under it cannot be told, so nothing new may start beside it.
  unreadable: (count: number) =>
    `${count} saved reboot ${count === 1 ? "plan" : "plans"} cannot be read by this version of Autoheal, so whether a reboot is still going on under ${count === 1 ? "it" : "them"} is unknown. No new plan starts until that is resolved; the ${count === 1 ? "record is" : "records are"} kept.`,
  // Only that this row is unreadable, never a word of what is in it.
  unreadableRow: (id: string) => `Reboot plan ${id} could not be read; it is kept as it is and nothing acts on it.`,
  checkGone: "A check this plan requires no longer exists.",
  checkDown: (name: string) => `${name} is not answering.`,
  // Nothing shows it either way: a check made from a host whose runner has not reported it.
  checkUnknown: (name: string) => `Nothing shows whether ${name} is answering.`,
  checkHeld: (name: string) => `${name} is under maintenance, so nothing shows it is answering.`,
  checkStale: (name: string) => `${name} has not been checked recently.`,
  windowOver: "Its time to start reboots has passed.",
  noLongerAllowed: "The person who approved this plan can no longer reboot hosts.",
  jobGone: (host: string) => `The reboot asked of ${host} can no longer be found.`,
  refused: (host: string, outcome: string | null) =>
    `${host} did not take the reboot: ${outcome ?? "no reason given"}.`,
  jobRefusals: {
    host_packages_busy: "another of its jobs is still open",
    host_packages_unsupported: "it has not said it can be rebooted from here",
  } as Record<string, string>,
  couldNotAsk: (host: string, problem: string) => `The reboot could not be asked of ${host}: ${problem}.`,
  notBack: (host: string, minutes: number) => `${host} was not back and ready within ${minutes} minutes.`,
  restored: "The database was restored, so this plan was paused rather than carried on from an earlier state.",
  taskTitle: (name: string) => `Reboot plan ${name} is paused`,
  taskDetails: (reason: string | null) =>
    `${reason ?? "It is waiting for a person."} Nothing more is rebooted until someone resumes or cancels it.`,
} as const;
