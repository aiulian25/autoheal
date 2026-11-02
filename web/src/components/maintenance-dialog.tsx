import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import {
  MAINTENANCE_MAX_MILLISECONDS,
  MAINTENANCE_FRESH_MILLISECONDS,
  type MaintenanceView,
} from "../../../src/shared/maintenance.js";
import { api } from "../api-client.js";
import { INVENTORY_REFRESH_MILLISECONDS } from "../constants.js";
import { ErrorNotice } from "./common.js";

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
        .map(
          (window) =>
            `${window.containerName ?? "Whole host"}: ${window.reason} · ${window.owner} · until ${new Date(window.expiresAt).toLocaleString()}`,
        )
        .join("\n")}
    >
      Maintenance{pending ? " · awaiting runner" : " · runner confirmed"}
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
  const [minutes, setMinutes] = useState(60);
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
        Maintenance windows <MaintenanceBadge hostId={hostId} />
      </summary>
      <p className="small muted">
        Pause automatic recovery and changes for up to 24 hours. Reporting continues. Already running operations finish;
        wait for runner confirmation before planned work. Manual actions remain available.
      </p>
      {active.map((window) => (
        <div key={window.id} className="notice warning">
          <p>
            <strong>{window.containerName ?? "Whole host"}</strong> · {window.reason}
          </p>
          <p>
            {window.owner} · ends{" "}
            <time dateTime={new Date(window.expiresAt).toISOString()}>
              {new Date(window.expiresAt).toLocaleString()}
            </time>
          </p>
          {admin && (
            <div className="row">
              <button
                type="button"
                disabled={
                  change.isPending || window.expiresAt + 30 * 60_000 > window.startsAt + MAINTENANCE_MAX_MILLISECONDS
                }
                onClick={() =>
                  change.mutate({
                    method: "PATCH",
                    path: apiPath(API_ROUTES.maintenanceWindow, { hostId, maintenanceId: window.id }),
                    body: { expiresAt: window.expiresAt + 30 * 60_000 },
                  })
                }
              >
                Extend 30 minutes
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
                End maintenance
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
                expiresAt: Date.now() + minutes * 60_000,
              },
            });
          }}
        >
          <label htmlFor={`${id}-container`}>Container name (blank for whole host)</label>
          <input
            id={`${id}-container`}
            value={containerName}
            maxLength={256}
            onChange={(event) => setContainerName(event.target.value)}
          />
          <label htmlFor={`${id}-reason`}>Reason</label>
          <input
            id={`${id}-reason`}
            value={reason}
            required
            maxLength={240}
            onChange={(event) => setReason(event.target.value)}
          />
          <label htmlFor={`${id}-duration`}>Duration</label>
          <select id={`${id}-duration`} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
            {[15, 30, 60, 120, 240, 480, 1440].map((duration) => (
              <option key={duration} value={duration}>
                {duration} minutes
              </option>
            ))}
          </select>
          <button type="submit" disabled={change.isPending || windows.data?.acknowledged?.[hostId]?.generation == null}>
            Start maintenance
          </button>
          {windows.data?.acknowledged?.[hostId]?.generation == null && (
            <p className="notice warning">Update and connect this host’s runner before enabling maintenance.</p>
          )}
        </form>
      )}
      <ErrorNotice error={windows.error ?? change.error} />
      {change.isSuccess && (
        <p role="status">Maintenance policy saved. Await runner confirmation before planned work.</p>
      )}
    </details>
  );
}
