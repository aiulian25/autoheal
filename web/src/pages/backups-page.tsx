import { ApplicationBackupPlans } from "../components/application-backup-plan.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import {
  API_ROUTES,
  apiPath,
  type BackupView,
  type RestorePreviewView,
  type RestoreResultView,
} from "../../../src/shared/api.js";
import { BACKUP_EXTENSION, INTEGRITY_OK, wordsOf } from "../../../src/shared/constants.js";
import { api, upload } from "../api-client.js";
import { Badge, ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { SettingsSubpage } from "../components/section-tabs.js";
import { SESSION_QUERY_KEY, SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { bytes } from "../format.js";
import { backupsQuery } from "../queries.js";

function RestorePreview({ preview, onDone }: { preview: RestorePreviewView; onDone: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useMutation({
    mutationFn: () =>
      api<RestoreResultView>("POST", apiPath(API_ROUTES.restoreConfirm, { restoreId: preview.restoreId })),
    // Every session ends with a restore, including this one: back to sign-in.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
  });
  const cancel = useMutation({
    mutationFn: () => api("DELETE", apiPath(API_ROUTES.restore, { restoreId: preview.restoreId })),
    onSettled: onDone,
  });
  const warnings = [
    preview.usersReactivated.length > 0 && TEXT.backups.reactivated(preview.usersReactivated),
    preview.usersAdded.length > 0 && TEXT.backups.added(preview.usersAdded),
    preview.hostsRestored.length > 0 && TEXT.backups.hosts(preview.hostsRestored),
  ].filter((warning): warning is string => typeof warning === "string");
  return (
    <section className="card">
      <h3>{TEXT.backups.previewTitle}</h3>
      <p>
        <strong>{TEXT.backups.previewFile(preview.fileName)}</strong>
        <br />
        <span className="muted">
          {TEXT.backups.dataAsOf} <TimeAgo timestamp={preview.dataAsOf} />
          {TEXT.separator}
          {TEXT.backups.contents(preview.counts)}
        </span>
      </p>
      {warnings.map((warning) => (
        <p key={warning} className="notice warning">
          {warning}
        </p>
      ))}
      <p className="notice warning">{TEXT.backups.consequences}</p>
      {confirm.isPending && (
        <p className="notice warning" role="status">
          {TEXT.backups.restoring}
        </p>
      )}
      <ErrorNotice error={confirm.error ?? cancel.error} />
      <div className="row">
        <button type="button" className="primary" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
          {TEXT.backups.confirm}
        </button>
        <button type="button" onClick={() => cancel.mutate()} disabled={confirm.isPending}>
          {TEXT.backups.cancel}
        </button>
      </div>
    </section>
  );
}

export function BackupsPage() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const backups = useQuery(backupsQuery);
  const create = useMutation({
    mutationFn: () => api<BackupView>("POST", API_ROUTES.backups),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: backupsQuery.queryKey }),
  });
  const prepareStored = useMutation({
    mutationFn: (fileName: string) => api<RestorePreviewView>("POST", apiPath(API_ROUTES.backupRestore, { fileName })),
  });
  const prepareUpload = useMutation({
    mutationFn: (file: File) => upload<RestorePreviewView>(API_ROUTES.restoreUpload, file),
  });
  const preview = prepareStored.data ?? prepareUpload.data;
  const clearPreview = () => {
    prepareStored.reset();
    prepareUpload.reset();
  };
  const checkFile = () => {
    const file = fileInput.current?.files?.[0];
    if (file !== undefined) {
      prepareStored.reset();
      prepareUpload.mutate(file);
    }
  };
  return (
    <SettingsSubpage
      current={SETTINGS_SECTIONS.backups}
      title={TEXT.backups.title}
      lede={TEXT.backups.explanation}
      action={
        <button type="button" className="primary" onClick={() => create.mutate()} disabled={create.isPending}>
          {TEXT.backups.create}
        </button>
      }
    >
      {preview !== undefined && <RestorePreview preview={preview} onDone={clearPreview} />}
      {backups.data === undefined && <Loading />}
      {backups.data !== undefined && backups.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.backups.when}</th>
                <th>{TEXT.backups.by}</th>
                <th>{TEXT.backups.kind}</th>
                <th>{TEXT.backups.size}</th>
                <th>{TEXT.backups.check}</th>
                <th>{TEXT.backups.offbox}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {backups.data.map((backup) => (
                <tr key={backup.fileName}>
                  <td>
                    <TimeAgo timestamp={backup.createdAt} />
                    <div className="muted small mono">{backup.fileName}</div>
                  </td>
                  <td>{backup.createdBy}</td>
                  <td>{wordsOf(backup.origin)}</td>
                  <td>{bytes(backup.sizeBytes)}</td>
                  <td>
                    <Badge
                      value={backup.integrityCheck}
                      tone={backup.integrityCheck === INTEGRITY_OK ? "good" : "danger"}
                    />
                  </td>
                  <td>{backup.offboxCopied ? TEXT.yes : TEXT.no}</td>
                  <td>
                    <div className="row-actions">
                      <a href={apiPath(API_ROUTES.backupDownload, { fileName: backup.fileName })} download>
                        {TEXT.backups.download}
                      </a>
                      <button type="button" onClick={() => prepareStored.mutate(backup.fileName)}>
                        {TEXT.backups.restore}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="card inline-form">
        <label>
          {TEXT.backups.uploadLabel}
          <input ref={fileInput} type="file" accept={BACKUP_EXTENSION} />
        </label>
        <button type="button" onClick={checkFile} disabled={prepareUpload.isPending}>
          {TEXT.backups.uploadButton}
        </button>
      </section>
      <ErrorNotice error={backups.error ?? create.error ?? prepareStored.error ?? prepareUpload.error} />
      <ApplicationBackupPlans />
    </SettingsSubpage>
  );
}
