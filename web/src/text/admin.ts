import {
  APPLICATION_BACKUPS,
  APPLICATION_BACKUP_FAILURE,
  type ApplicationBackupFailure,
} from "../../../src/shared/application-backups.js";
import { MILLISECONDS_PER_MINUTE } from "../../../src/shared/constants.js";

/** Users, the audit log, and backups. */
export const ADMIN_TEXT = {
  users: {
    title: "Users",
    lede: "Who can sign in. Admins change things; viewers only look.",
    username: "Username",
    role: "Role",
    status: "Status",
    totp: "Two-step",
    lastLogin: "Last sign-in",
    create: "Add user",
    temporaryPassword: (username: string) => `One-time password for ${username}`,
    temporaryExplanation:
      "Give it to them privately. They must change it and set up two-step sign-in at first sign-in.",
    makeAdmin: "Make admin",
    makeViewer: "Make viewer",
    deactivate: "Deactivate",
    reactivate: "Reactivate",
    resetPassword: "Reset password",
    resetTotp: "Reset two-step",
    remove: "Delete",
    removeConfirm: (username: string) => `Delete ${username}? Only possible for accounts that never did anything.`,
    you: " (you)",
  },
  backups: {
    title: "Backups",
    explanation:
      "Encrypted with the backup passphrase and checked right after they are made. Daily, plus one before every restore.",
    create: "Make a backup now",
    when: "Made",
    by: "By",
    kind: "Kind",
    size: "Size",
    check: "Check",
    offbox: "Off-box copy",
    download: "Download",
    restore: "Restore…",
    uploadLabel: "Restore from a backup file (.sqlite.age)",
    uploadButton: "Check this file",
    previewTitle: "Before you restore",
    previewFile: (name: string | null) => (name === null ? "An uploaded file" : name),
    dataAsOf: "Data as of",
    contents: (counts: { users: number; hosts: number; incidents: number; runbooks: number }) =>
      `${counts.users} users, ${counts.hosts} hosts, ${counts.incidents} incidents, ${counts.runbooks} runbooks`,
    reactivated: (names: string[]) => `These deactivated accounts would be active again: ${names.join(", ")}.`,
    added: (names: string[]) => `These accounts would come back: ${names.join(", ")}.`,
    hosts: (names: string[]) => `These hosts' runner tokens would work again: ${names.join(", ")}.`,
    consequences:
      "Everyone is signed out, and you will need the admin password that was valid when the backup was made. " +
      "Escalations and approved actions waiting at the time of the backup are cancelled. " +
      "A safety backup of the current data is made first. Work pauses during restore; host actions already handed to runners can continue and must be checked afterward.",
    restoring:
      "Pausing work, making a safety backup and restoring. Live views will disconnect; sign in again when the restore finishes.",
    confirm: "Restore now",
    cancel: "Cancel",
  },
  applicationBackups: {
    plans: {
      unavailable: "Application backup plans are unavailable. Refresh after updating the dashboard.",
      title: "Application backup plans",
      explanation:
        "Application data is separate from the dashboard database backup above. These plans stop every service that " +
        "shares writable data, require clean exits, and encrypt both file data and the backup manifest. This is a " +
        "coordinated file backup, not a database-native dump.",
      budget: (storedMebibytes: number, sourceMebibytes: number, mounts: number) =>
        `Storage budget: ${storedMebibytes} MiB of encrypted application artifacts per dashboard. Initial limit: ` +
        `${sourceMebibytes} MiB of source data per plan, up to ${mounts} local Docker directory volumes. Bind ` +
        "mounts, remote/aliased drivers and shutdown grace periods over 30 seconds are unsupported. Larger data, " +
        "unsupported metadata and unclean shutdowns are refused. Schedules cause service downtime. A restore drill " +
        "uses isolated copies and leaves live data unchanged.",
      needsPassphrase:
        "Set a protected backup passphrase before creating application plans. A connected, updated runner is required.",
      create: "Create application plan",
      name: "Plan name",
      host: "Host",
      chooseHost: "Choose host",
      containerName: "Container name",
      repeat: "Repeat every (hours; blank for manual)",
      sqliteMount: "Optional SQLite mount target",
      sqliteMountExample: "/data",
      sqliteFile: "SQLite file within that mount",
      sqliteFileExample: "app.sqlite",
      sqliteNote:
        "SQLite drills run only the fixed read-only integrity check. No commands, SQL or credentials are accepted. " +
        "Keep the dashboard backup passphrase separately: it protects the independent application backup keys.",
      exclusive:
        "I confirm that only Docker containers write these local volumes; no host process or external export writes " +
        "to them.",
      save: "Save plan",
      paused: "Paused",
      manual: "Manual captures",
      every: (hours: number) => (hours === 1 ? "Every hour" : `Every ${hours} hours`),
      keep: (count: number) => `Keep ${count} backups`,
      capture: "Capture application backup",
      pause: "Pause plan",
      enable: "Enable plan",
      notDrilled: "Not yet restore-drilled",
      retained: "Retained for recovery",
      drill: "Run isolated restore drill",
      reviewRestore: "Review live restore",
      restoreReview: "Application restore review",
      replacement: "Review live data replacement",
      awaitingWriters: "Waiting for the runner to discover every shared-data writer…",
      willStop:
        "These services will stop. All covered data will be replaced after an isolated integrity drill and an " +
        "encrypted safety backup. This review expires after one minute.",
      approve: "I approve replacing this application’s live data",
      restore: "Restore reviewed application data",
      expired: "Review expired. Cancel and request a fresh review.",
      cancel: "Cancel",
      stillBlocks: (containers: string) => `Recovery still blocks: ${containers}`,
      resume: "Resume interrupted recovery",
    },
    boot: {
      allow: "Allow boot drills: start this application from a restored copy, on request",
      allowNote:
        "It runs with no network and no host folders, on the image it was backed up with, with none of the live container's settings but its user. Applications that need another service or a real setting will fail here, which says nothing against the backup.",
      readySeconds: "Seconds it must stay up to count as started",
      healthCheckNote: "Only an image with its own health check can earn Application boot verified.",
      environment: "Test settings, one NAME=value a line",
      environmentNote: "Test values only, never a real password: they are stored unsealed.",
      verified: "Application boot verified",
      notVerified: "Application boot not verified",
      integrityVerified: "Integrity verified",
      run: "Run boot drill",
      confirm:
        "This starts a copy of the application, isolated, for up to 5 minutes, using its memory and CPU on this host. Live data and containers are not touched.",
      confirmRun: "Start the boot drill",
      cancel: "Cancel",
      readiness: {
        healthy: (_seconds: number) => "Started: its health check passed.",
        "stayed-running": (seconds: number) =>
          `Started, not proven: it stayed up for ${seconds} seconds, but it has no health check, so the application itself was not tested. Its last log lines are below.`,
      },
      left: (names: string) => `Could not be removed, and needs removing by hand: ${names}.`,
    },
    failure: {
      [APPLICATION_BACKUP_FAILURE.requesterLostAccess]:
        "Not run: the person who asked for it lost admin access before the runner collected it (deactivated, no longer an admin, or their password or two-step sign-in was reset). Ask again if it is still needed.",
      [APPLICATION_BACKUP_FAILURE.planChanged]:
        "Not run: its plan was turned off or edited after this capture was scheduled. Scheduled captures follow the plan as it is now.",
      [APPLICATION_BACKUP_FAILURE.expired]: `Not run: the host's runner did not collect it within ${APPLICATION_BACKUPS.taskMilliseconds / MILLISECONDS_PER_MINUTE} minutes. Check that the host is online, then ask again.`,
      [APPLICATION_BACKUP_FAILURE.notPrepared]:
        "Not run: the dashboard could not save its encryption key. Check that the dashboard's data and off-box backup folders are writable and not full, then ask again.",
      [APPLICATION_BACKUP_FAILURE.databaseRestored]:
        "Ended by a dashboard restore: the restored data is from before this run finished, so its outcome is not known here. Check the application's live data and retained backups before asking again.",
    } satisfies Record<ApplicationBackupFailure, string>,
  },
  audit: {
    title: "Audit log",
    explanation: "Everything people, hosts and the system did. Also written to the container's output.",
    when: "When",
    who: "Who",
    what: "What",
    target: "On",
    details: "Details",
    from: "From",
    older: "Older events",
    newest: "Newest events",
  },
} as const;
