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

const text = TEXT.settingsPage;

export function AlwaysRunningCard() {
  const always = text.always;
  return (
    <section className="card settings-card" aria-labelledby="always-title">
      <h3 id="always-title">{always.title}</h3>
      <dl className="settings-facts spread">
        <dt>{always.problemChecks}</dt>
        <dd>{always.everySeconds(DETECTOR_INTERVAL_MILLISECONDS / MILLISECONDS_PER_SECOND)}</dd>
        <dt>{always.imageChecks}</dt>
        <dd>{always.everyHours(UPDATE_CHECK_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR)}</dd>
        <dt>{always.liveStats}</dt>
        <dd>{always.minutes(METRICS_HISTORY_MILLISECONDS / MILLISECONDS_PER_MINUTE)}</dd>
        <dt>{always.databaseBackup}</dt>
        <dd>
          {BACKUP_INTERVAL_MILLISECONDS === MILLISECONDS_PER_DAY
            ? always.daily
            : always.everyHours(BACKUP_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR)}
        </dd>
      </dl>
    </section>
  );
}
