import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES } from "../../../src/shared/api.js";
import { backupSettingsSchema, type BackupSettings } from "../../../src/shared/container-backups.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { TEXT } from "../constants.js";

const text = TEXT.containerBackup.settings;
const QUERY_KEY = ["container-backup-settings"];

/** Where each host keeps its containers' backups. It takes effect from the next one; none are moved. */
export function ContainerBackupSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<BackupSettings>("GET", API_ROUTES.containerBackupSettings),
  });
  const [problem, setProblem] = useState(false);
  const save = useMutation({
    mutationFn: (body: BackupSettings) => api("PUT", API_ROUTES.containerBackupSettings, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  if (settings.data === undefined) return <ErrorNotice error={settings.error} />;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const copy = String(values.get("copy") ?? "").trim();
    const parsed = backupSettingsSchema.safeParse({
      directory: String(values.get("directory") ?? "").trim(),
      copyDirectory: copy === "" ? null : copy,
    });
    setProblem(!parsed.success);
    if (parsed.success) save.mutate(parsed.data);
  };
  return (
    <form className="card settings-form" onSubmit={submit}>
      <strong>{text.title}</strong>
      <span className="small muted">{text.explanation}</span>
      <label>
        {text.directory}
        <input name="directory" className="mono" required defaultValue={settings.data.directory} />
      </label>
      <label>
        {text.copy}
        <span className="hint">{text.copyHint}</span>
        <input name="copy" className="mono" defaultValue={settings.data.copyDirectory ?? ""} />
      </label>
      {problem && <p className="notice warning small">{text.badFolder}</p>}
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {text.save}
        </button>
        {save.isSuccess && !problem && <span className="small text-good">{text.saved}</span>}
      </div>
      <ErrorNotice error={save.error} />
    </form>
  );
}
