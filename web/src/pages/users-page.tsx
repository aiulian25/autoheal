import { OperatorGrants } from "../components/operator-grants.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  API_ROUTES,
  apiPath,
  type AccountView,
  type CreatedAccountView,
  type TemporaryPasswordView,
} from "../../../src/shared/api.js";
import {
  ROLE_ADMIN,
  ROLE_VIEWER,
  ROLES,
  USER_STATUS_ACTIVE,
  USER_STATUS_DEACTIVATED,
  USERNAME_PATTERN,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { useAskInPlace } from "../components/ask-in-place.js";
import { Badge, ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { SettingsSubpage } from "../components/section-tabs.js";
import { SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { useSignedInSession } from "../session.js";

export function UsersPage() {
  const session = useSignedInSession();
  const asking = useAskInPlace();
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<{ username: string; password: string } | null>(null);
  const accounts = useQuery({ queryKey: ["users"], queryFn: () => api<AccountView[]>("GET", API_ROUTES.users) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });
  const create = useMutation({
    mutationFn: (account: { username: string; role: string }) =>
      api<CreatedAccountView>("POST", API_ROUTES.users, account),
    onSuccess: (created) => {
      setRevealed({ username: created.account.username, password: created.temporaryPassword });
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ userId, change }: { userId: string; change: Record<string, string> }) =>
      api("PATCH", apiPath(API_ROUTES.user, { userId }), change),
    onSuccess: refresh,
  });
  const resetPassword = useMutation({
    mutationFn: (account: AccountView) =>
      api<TemporaryPasswordView>("POST", apiPath(API_ROUTES.userResetPassword, { userId: account.id })),
    onSuccess: (view, account) => setRevealed({ username: account.username, password: view.temporaryPassword }),
  });
  const resetTotp = useMutation({
    mutationFn: (userId: string) => api("POST", apiPath(API_ROUTES.userResetTotp, { userId })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api("DELETE", apiPath(API_ROUTES.user, { userId })),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({ username: String(form.get("username") ?? ""), role: String(form.get("role") ?? ROLE_VIEWER) });
    event.currentTarget.reset();
  };
  return (
    <SettingsSubpage current={SETTINGS_SECTIONS.people} title={TEXT.users.title} lede={TEXT.users.lede}>
      {revealed !== null && (
        <div className="notice warning stack" role="status">
          <strong>{TEXT.users.temporaryPassword(revealed.username)}</strong>
          <span className="secret">{revealed.password}</span>
          <span>{TEXT.users.temporaryExplanation}</span>
        </div>
      )}
      {accounts.data === undefined && <Loading />}
      {accounts.data !== undefined && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.users.username}</th>
                <th>{TEXT.users.role}</th>
                <th>{TEXT.users.status}</th>
                <th>{TEXT.users.totp}</th>
                <th>{TEXT.users.lastLogin}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.data.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.username}</strong>
                    {account.id === session.user.id && <span className="muted small">{TEXT.users.you}</span>}
                    {account.role === ROLE_VIEWER && <OperatorGrants userId={account.id} username={account.username} />}
                  </td>
                  <td>{account.role}</td>
                  <td>
                    <Badge value={account.status} />
                  </td>
                  <td>{account.totpEnabled ? TEXT.yes : TEXT.no}</td>
                  <td>
                    <TimeAgo timestamp={account.lastLoginAt} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        onClick={() =>
                          update.mutate({
                            userId: account.id,
                            change: { role: account.role === ROLE_ADMIN ? ROLE_VIEWER : ROLE_ADMIN },
                          })
                        }
                      >
                        {account.role === ROLE_ADMIN ? TEXT.users.makeViewer : TEXT.users.makeAdmin}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          update.mutate({
                            userId: account.id,
                            change: {
                              status:
                                account.status === USER_STATUS_ACTIVE ? USER_STATUS_DEACTIVATED : USER_STATUS_ACTIVE,
                            },
                          })
                        }
                      >
                        {account.status === USER_STATUS_ACTIVE ? TEXT.users.deactivate : TEXT.users.reactivate}
                      </button>
                      <button type="button" onClick={() => resetPassword.mutate(account)}>
                        {TEXT.users.resetPassword}
                      </button>
                      <button type="button" onClick={() => resetTotp.mutate(account.id)}>
                        {TEXT.users.resetTotp}
                      </button>
                      <button
                        type="button"
                        className="quiet danger"
                        onClick={() =>
                          asking.confirm(TEXT.users.removeConfirm(account.username), () => remove.mutate(account.id))
                        }
                      >
                        {TEXT.users.remove}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {asking.question}
      <form className="card" onSubmit={submit}>
        <h3>{TEXT.users.create}</h3>
        <div className="inline-form">
          <label>
            {TEXT.users.username}
            <input name="username" required pattern={USERNAME_PATTERN.source} />
          </label>
          <label>
            {TEXT.users.role}
            <select name="role" defaultValue={ROLE_VIEWER}>
              {ROLES.map((role) => (
                <option key={role}>{role}</option>
              ))}
            </select>
          </label>
          <button className="primary" type="submit" disabled={create.isPending}>
            {TEXT.users.create}
          </button>
        </div>
      </form>
      <ErrorNotice
        error={accounts.error ?? create.error ?? update.error ?? resetPassword.error ?? resetTotp.error ?? remove.error}
      />
    </SettingsSubpage>
  );
}
