import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { MILLISECONDS_PER_MINUTE } from "../../../src/shared/constants.js";
import {
  MAINTENANCE_LIMITS,
  MAINTENANCE_MAX_MILLISECONDS,
  MAINTENANCE_FRESH_MILLISECONDS,
  type MaintenanceView,
} from "../../../src/shared/maintenance.js";
import { api } from "../api-client.js";
import { INVENTORY_REFRESH_MILLISECONDS, MAINTENANCE_FORM, TEXT } from "../constants.js";
import { ErrorNotice } from "./common.js";

const text = TEXT.maintenance;
const EXTEND_MILLISECONDS = MAINTENANCE_FORM.extendMinutes * MILLISECONDS_PER_MINUTE;

export const maintenanceQuery = {
  queryKey: ["maintenance"],
  queryFn: () => api<MaintenanceView>("GET", API_ROUTES.maintenance),
  refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
};

export function MaintenanceBadge({ hostId, containerName }: { hostId: string; containerName?: string }) {
  const { data } = useQuery(maintenanceQuery);
  const windows = (data?.windows ?? []).filter(
    (window) =>
      window.hostId === hostId &&
      (containerName === undefined || window.containerName === null || window.containerName === containerName),
  );
  if (!windows.length) return null;
  const ack = data?.acknowledged?.[hostId];
  const pending =
    ack?.generation !== data?.generation || ack?.at == null || Date.now() - ack.at > MAINTENANCE_FRESH_MILLISECONDS;
  return (
    <span
      className="badge warning"
      title={windows
        .map((window) =>
          text.windowTitle(
            window.containerName ?? text.wholeHost,
            window.reason,
            window.owner,
            new Date(window.expiresAt).toLocaleString(),
          ),
        )
        .join("\n")}
    >
      {text.badge}
      {TEXT.separator}
      {pending ? text.awaitingRunner : text.runnerConfirmed}
    </span>
  );
}

/** Uses the existing inline card/form layout; no extra modal or scheduler. */
export function MaintenanceDialog({ hostId, admin }: { hostId: string; admin: boolean }) {
  const id = useId();
  const client = useQueryClient();
  const windows = useQuery(maintenanceQuery);
  const [reason, setReason] = useState("");
  const [containerName, setContainerName] = useState("");
  const [minutes, setMinutes] = useState<number>(MAINTENANCE_FORM.defaultMinutes);
  const change = useMutation({
    mutationFn: ({ method, path, body }: { method: string; path: string; body?: unknown }) =>
      api<MaintenanceView>(method, path, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: maintenanceQuery.queryKey });
    },
  });
  const active = (windows.data?.windows ?? []).filter((window) => window.hostId === hostId);
  return (
    <details className="card">
      <summary>
        {text.title} <MaintenanceBadge hostId={hostId} />
      </summary>
      <p className="small muted">{text.explanation}</p>
      {active.map((window) => (
        <div key={window.id} className="notice warning">
          <p>
            <strong>{window.containerName ?? text.wholeHost}</strong>
            {TEXT.separator}
            {window.reason}
          </p>
          <p>
            {window.owner}
            {TEXT.separator}
            {text.ends}
            <time dateTime={new Date(window.expiresAt).toISOString()}>
              {new Date(window.expiresAt).toLocaleString()}
            </time>
          </p>
          {admin && (
            <div className="row">
              <button
                type="button"
                disabled={
                  change.isPending ||
                  window.expiresAt + EXTEND_MILLISECONDS > window.startsAt + MAINTENANCE_MAX_MILLISECONDS
                }
                onClick={() =>
                  change.mutate({
                    method: "PATCH",
                    path: apiPath(API_ROUTES.maintenanceWindow, { hostId, maintenanceId: window.id }),
                    body: { expiresAt: window.expiresAt + EXTEND_MILLISECONDS },
                  })
                }
              >
                {text.extend(MAINTENANCE_FORM.extendMinutes)}
              </button>
              <button
                type="button"
                disabled={change.isPending}
                onClick={() =>
                  change.mutate({
                    method: "DELETE",
                    path: apiPath(API_ROUTES.maintenanceWindow, { hostId, maintenanceId: window.id }),
                  })
                }
              >
                {text.end}
              </button>
            </div>
          )}
        </div>
      ))}
      {admin && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            change.mutate({
              method: "POST",
              path: apiPath(API_ROUTES.hostMaintenance, { hostId }),
              body: {
                containerName: containerName.trim() || null,
                reason: reason.trim(),
                expiresAt: Date.now() + minutes * MILLISECONDS_PER_MINUTE,
              },
            });
          }}
        >
          <label htmlFor={`${id}-container`}>{text.containerName}</label>
          <input
            id={`${id}-container`}
            value={containerName}
            maxLength={MAINTENANCE_LIMITS.containerNameCharacters}
            onChange={(event) => setContainerName(event.target.value)}
          />
          <label htmlFor={`${id}-reason`}>{text.reason}</label>
          <input
            id={`${id}-reason`}
            value={reason}
            required
            maxLength={MAINTENANCE_LIMITS.reasonCharacters}
            onChange={(event) => setReason(event.target.value)}
          />
          <label htmlFor={`${id}-duration`}>{text.duration}</label>
          <select id={`${id}-duration`} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
            {MAINTENANCE_FORM.durationMinutes.map((duration) => (
              <option key={duration} value={duration}>
                {text.minutes(duration)}
              </option>
            ))}
          </select>
          <button type="submit" disabled={change.isPending || windows.data?.acknowledged?.[hostId]?.generation == null}>
            {text.start}
          </button>
          {windows.data?.acknowledged?.[hostId]?.generation == null && (
            <p className="notice warning">{text.runnerNeeded}</p>
          )}
        </form>
      )}
      <ErrorNotice error={windows.error ?? change.error} />
      {change.isSuccess && <p role="status">{text.saved}</p>}
    </details>
  );
}
