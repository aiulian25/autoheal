import { BACKUP_INTERVAL_MILLISECONDS, BACKUP_MESSAGES, BACKUP_ORIGIN } from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import type { BackupService } from "./backup-service.js";

/** A backup when the newest scheduled one is a day old (or missing). Checked hourly and at start. */
export async function backupIfDue(backups: BackupService, now: number): Promise<boolean> {
  const newest = (await backups.list()).find((backup) => backup.origin === BACKUP_ORIGIN.scheduled);
  if (newest !== undefined && now - newest.createdAt < BACKUP_INTERVAL_MILLISECONDS) {
    return false;
  }
  try {
    await backups.create(BACKUP_ORIGIN.scheduled, null);
    return true;
  } catch (error) {
    log(BACKUP_MESSAGES.scheduledFailed(describeError(error)));
    return false;
  }
}
