import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import type {
  ResourceAction,
  ResourceGrant,
  ResourcePermissionsView,
} from "../../../src/shared/resource-permissions.js";
import { api } from "../api-client.js";
import { enrolledHostsQuery, hostContainersQuery } from "../queries.js";
import { ErrorNotice, Loading } from "./common.js";

const ACTIONS: { action: ResourceAction; label: string }[] = [
  { action: "lifecycle", label: "Start, stop, restart and recreate" },
  { action: "update", label: "Update and roll back" },
  { action: "logs", label: "Read container logs" },
  { action: "terminal", label: "Open a container terminal" },
  { action: "files", label: "Browse and edit container files" },
  { action: "settings", label: "Edit container settings" },
];
const scopeWords = {
  host: "All containers on the host",
  container: "One container",
  stack: "One Compose stack",
} as const;

/** Additional capabilities for a viewer; account roles and existing viewing access are preserved. */
export function OperatorGrants({ userId, username }: { userId: string; username: string }) {
  const id = useId();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ResourcePermissionsView | null>(null);
  const [hostId, setHostId] = useState("");
  const [scope, setScope] = useState<ResourceGrant["scope"]>("container");
  const [resource, setResource] = useState("");
  const [actions, setActions] = useState<ResourceAction[]>([]);
  const queryKey = ["user-grants", userId];
  const permissions = useQuery({
    queryKey,
    queryFn: () => api<ResourcePermissionsView>("GET", apiPath(API_ROUTES.userGrants, { userId })),
    enabled: open,
  });
  const hosts = useQuery({ ...enrolledHostsQuery, enabled: open });
  const containers = useQuery({ ...hostContainersQuery(hostId), enabled: open && hostId !== "" });
  const save = useMutation({
    mutationFn: (view: ResourcePermissionsView) =>
      api<ResourcePermissionsView>("PUT", apiPath(API_ROUTES.userGrants, { userId }), view),
    onSuccess: (view) => {
      client.setQueryData(queryKey, view);
      setEditing(null);
      void client.invalidateQueries({ queryKey: ["resource-permissions", userId] });
    },
  });
  const current = editing ?? permissions.data;
  const change = (grants: ResourceGrant[]) => {
    if (!current) return;
    setEditing({ revision: current.revision, grants });
    save.reset();
  };
  const names =
    scope === "stack"
      ? [
          ...new Set(
            (containers.data ?? []).flatMap((container) =>
              container.composeProject === null ? [] : [container.composeProject],
            ),
          ),
        ]
      : (containers.data ?? []).map((container) => container.name);
  return (
    <details className="operator-grants" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Scoped operator access</summary>
      <p className="small muted">
        Give {username} specific container actions. Viewing access stays unchanged. Global settings, users, backups and
        host package actions remain administrator-only.
      </p>
      {permissions.isPending && open && <Loading />}
      {current && (
        <>
          {current.grants.length === 0 ? (
            <p className="small muted">No delegated actions.</p>
          ) : (
            <ul className="stack">
              {current.grants.map((grant, index) => (
                <li key={`${grant.hostId}-${grant.scope}-${grant.resource}-${index}`}>
                  <strong>{hosts.data?.find((host) => host.id === grant.hostId)?.label ?? grant.hostId}</strong>
                  {" · "}
                  {grant.scope === "host" ? scopeWords.host : `${scopeWords[grant.scope]}: ${grant.resource}`}
                  <span className="small">
                    {" "}
                    ·{" "}
                    {grant.actions
                      .map(
                        (action) =>
                          ACTIONS.find((choice) => choice.action === action)?.label ??
                          (action === "read" ? "View inventory (already available to viewers)" : action),
                      )
                      .join(", ")}
                  </span>{" "}
                  <button
                    type="button"
                    className="quiet danger"
                    disabled={save.isPending}
                    onClick={() => change(current.grants.filter((_, at) => at !== index))}
                  >
                    Remove grant
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const grant: ResourceGrant = {
                hostId,
                scope,
                resource: scope === "host" ? null : resource.trim(),
                actions: [...actions],
              };
              const existing = current.grants.findIndex(
                (item) =>
                  item.hostId === grant.hostId && item.scope === grant.scope && item.resource === grant.resource,
              );
              change(
                existing < 0
                  ? [...current.grants, grant]
                  : current.grants.map((item, index) =>
                      index === existing
                        ? { ...item, actions: [...new Set([...item.actions, ...grant.actions])] }
                        : item,
                    ),
              );
              setActions([]);
              setResource("");
            }}
          >
            <fieldset disabled={save.isPending}>
              <legend>Add delegated actions</legend>
              <label htmlFor={`${id}-host`}>Host</label>
              <select
                id={`${id}-host`}
                required
                value={hostId}
                onChange={(event) => {
                  setHostId(event.target.value);
                  setResource("");
                }}
              >
                <option value="">Choose a host</option>
                {hosts.data?.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label}
                  </option>
                ))}
              </select>
              <label htmlFor={`${id}-scope`}>Scope</label>
              <select
                id={`${id}-scope`}
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as ResourceGrant["scope"]);
                  setResource("");
                }}
              >
                {Object.entries(scopeWords).map(([value, words]) => (
                  <option key={value} value={value}>
                    {words}
                  </option>
                ))}
              </select>
              {scope !== "host" && (
                <>
                  <label htmlFor={`${id}-resource`}>
                    {scope === "stack" ? "Exact Compose project name" : "Exact container name"}
                  </label>
                  <input
                    id={`${id}-resource`}
                    list={`${id}-names`}
                    required
                    maxLength={256}
                    value={resource}
                    onChange={(event) => setResource(event.target.value)}
                  />
                  <datalist id={`${id}-names`}>
                    {names.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </>
              )}
              {ACTIONS.map(({ action, label }) => (
                <label key={action} className="choice-option">
                  <input
                    type="checkbox"
                    checked={actions.includes(action)}
                    onChange={(event) =>
                      setActions((current) =>
                        event.target.checked ? [...current, action] : current.filter((value) => value !== action),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
              <button
                type="submit"
                disabled={
                  actions.length === 0 ||
                  !hostId ||
                  (scope !== "host" && !resource.trim()) ||
                  current.grants.length >= 64
                }
              >
                Add to review
              </button>
            </fieldset>
          </form>
          <p className="notice warning small">
            Saving ends this person’s current sessions and closes their container connections. They must sign in again.
            An action affecting dependent containers requires access to every affected member.
          </p>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={editing === null || save.isPending}
              onClick={() => editing && save.mutate(editing)}
            >
              Save access changes
            </button>
            {editing && (
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => {
                  setEditing(null);
                  save.reset();
                }}
              >
                Discard changes
              </button>
            )}
          </div>
        </>
      )}
      {save.isError && (
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            save.reset();
            void permissions.refetch();
          }}
        >
          Discard changes and reload
        </button>
      )}
      {save.isSuccess && (
        <p className="small" role="status">
          Access saved. The person must sign in again.
        </p>
      )}
      <ErrorNotice error={permissions.error ?? hosts.error ?? containers.error ?? save.error} />
    </details>
  );
}
