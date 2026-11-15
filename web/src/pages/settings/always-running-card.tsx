import {
  BACKUP_INTERVAL_MILLISECONDS,
  DETECTOR_INTERVAL_MILLISECONDS,
  METRICS_HISTORY_MILLISECONDS,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
  UPDATE_CHECK_INTERVAL_MILLISECONDS,
} from "../../../../src/shared/constants.js";
import { MILLISECONDS_PER_HOUR, TEXT } from "../../constants.js";
import { SettingsFold } from "./settings-fold.js";

const text = TEXT.settingsPage;

export function AlwaysRunningCard() {
  const always = text.always;
  const problemsEvery = always.everySeconds(DETECTOR_INTERVAL_MILLISECONDS / MILLISECONDS_PER_SECOND);
  const imagesEvery = always.everyHours(UPDATE_CHECK_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR);
  const backupEvery =
    BACKUP_INTERVAL_MILLISECONDS === MILLISECONDS_PER_DAY
      ? always.daily
      : always.everyHours(BACKUP_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR);
  const state = [
    always.shortProblemChecks(problemsEvery),
    always.shortImageChecks(imagesEvery),
    always.shortDatabaseBackup(backupEvery),
  ].join(TEXT.separator);
  return (
    <SettingsFold title={always.title} state={state}>
      <dl className="settings-facts spread">
        <dt>{always.problemChecks}</dt>
        <dd>{problemsEvery}</dd>
        <dt>{always.imageChecks}</dt>
        <dd>{imagesEvery}</dd>
        <dt>{always.liveStats}</dt>
        <dd>{always.minutes(METRICS_HISTORY_MILLISECONDS / MILLISECONDS_PER_MINUTE)}</dd>
        <dt>{always.databaseBackup}</dt>
        <dd>{backupEvery}</dd>
      </dl>
    </SettingsFold>
  );
}
