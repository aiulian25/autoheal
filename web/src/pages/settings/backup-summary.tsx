import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { type SettingsView } from "../../../../src/shared/api.js";
import { INTEGRITY_OK, SECRET_SOURCES } from "../../../../src/shared/constants.js";
import { ErrorNotice } from "../../components/common.js";
import { PATHS, TEXT } from "../../constants.js";
import { dateTime } from "../../format.js";
import { backupsQuery } from "../../queries.js";

const text = TEXT.settingsPage;

// --- Backups -----------------------------------------------------------------------------------------

export function BackupSummary({ settings }: { settings: SettingsView }) {
  const backups = useQuery(backupsQuery);
  const [showing, setShowing] = useState(false);
  const last = backups.data?.[0];
  const backup = text.backup;
  const kept = last?.offboxCopied === true ? backup.copiedOffbox : backup.onThisMachine;
  const title =
    last === undefined
      ? backup.none
      : `${backup.last(dateTime(last.createdAt))}${TEXT.separator}${last.integrityCheck === INTEGRITY_OK ? backup.verified : backup.notVerified}`;
  return (
    <>
      <div className="card settings-row">
        <div className="settings-row-what">
          <strong>{title}</strong>
          <span className="small muted">
            {backup.passphrase[settings.backupPassphrase]}
            {TEXT.separator}
            {kept}
          </span>
        </div>
        <Link to={PATHS.backups}>{backup.seeAll}</Link>
      </div>
      {settings.backupPassphrase === SECRET_SOURCES.autoheal && (
        <div className="small muted stack">
          <p>{TEXT.settings.passphraseAgain}</p>
          <pre className="log">{TEXT.settings.passphraseCommand}</pre>
        </div>
      )}
      {!settings.offboxBackupsConfigured && (
        <div className="card settings-row offbox">
          <p>{backup.noOffbox}</p>
          <button type="button" className="warm" aria-expanded={showing} onClick={() => setShowing(!showing)}>
            {backup.addOffbox}
          </button>
          {showing && (
            <p className="offbox-how small">
              {backup.offboxHowBefore}
              <code>{backup.offboxSetting}</code>
              {backup.offboxHowAfter}
            </p>
          )}
        </div>
      )}
      <ErrorNotice error={backups.error} />
    </>
  );
}
