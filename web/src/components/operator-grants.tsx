import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { REPORT_LIMITS } from "../../../src/shared/constants.js";
import {
  RESOURCE_GRANTS_LIMIT,
  type ResourceAction,
  type ResourceGrant,
  type ResourcePermissionsView,
} from "../../../src/shared/resource-permissions.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { enrolledHostsQuery, hostContainersQuery } from "../queries.js";
import { ErrorNotice, Loading } from "./common.js";

const text = TEXT.operatorGrants;
const ACTIONS: { action: ResourceAction; label: string }[] = [
  { action: "lifecycle", label: text.actions.lifecycle },
  { action: "update", label: text.actions.update },
  { action: "logs", label: text.actions.logs },
  { action: "terminal", label: text.actions.terminal },
  { action: "files", label: text.actions.files },
  { action: "settings", label: text.actions.settings },
];
const scopeWords = text.scopes;

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
      <summary>{text.title}</summary>
      <p className="small muted">{text.explanation(username)}</p>
      {permissions.isPending && open && <Loading />}
      {current && (
        <>
          {current.grants.length === 0 ? (
            <p className="small muted">{text.none}</p>
          ) : (
            <ul className="stack">
              {current.grants.map((grant, index) => (
                <li key={`${grant.hostId}-${grant.scope}-${grant.resource}-${index}`}>
                  <strong>{hosts.data?.find((host) => host.id === grant.hostId)?.label ?? grant.hostId}</strong>
                  {TEXT.separator}
                  {grant.scope === "host"
                    ? scopeWords.host
                    : text.scoped(scopeWords[grant.scope], grant.resource ?? "")}
                  <span className="small">
                    {TEXT.separator}
                    {grant.actions
                      .map(
                        (action) =>
                          ACTIONS.find((choice) => choice.action === action)?.label ??
                          (action === "read" ? text.actions.read : action),
                      )
                      .join(TEXT.listComma)}
                  </span>{" "}
                  <button
                    type="button"
                    className="quiet danger"
                    disabled={save.isPending}
                    onClick={() => change(current.grants.filter((_, at) => at !== index))}
                  >
                    {text.remove}
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
              <legend>{text.add}</legend>
              <label htmlFor={`${id}-host`}>{text.host}</label>
              <select
                id={`${id}-host`}
                required
                value={hostId}
                onChange={(event) => {
                  setHostId(event.target.value);
                  setResource("");
                }}
              >
                <option value="">{text.chooseHost}</option>
                {hosts.data?.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label}
                  </option>
                ))}
              </select>
              <label htmlFor={`${id}-scope`}>{text.scope}</label>
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
                  <label htmlFor={`${id}-resource`}>{scope === "stack" ? text.stackName : text.containerName}</label>
                  <input
                    id={`${id}-resource`}
                    list={`${id}-names`}
                    required
                    maxLength={REPORT_LIMITS.nameCharacters}
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
                  current.grants.length >= RESOURCE_GRANTS_LIMIT
                }
              >
                {text.addToReview}
              </button>
            </fieldset>
          </form>
          <p className="notice warning small">{text.savingEnds}</p>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={editing === null || save.isPending}
              onClick={() => editing && save.mutate(editing)}
            >
              {text.save}
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
                {text.discard}
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
          {text.discardAndReload}
        </button>
      )}
      {save.isSuccess && (
        <p className="small" role="status">
          {text.saved}
        </p>
      )}
      <ErrorNotice error={permissions.error ?? hosts.error ?? containers.error ?? save.error} />
    </details>
  );
}
