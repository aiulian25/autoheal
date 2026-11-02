import { browserSupportsWebAuthn, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import {
  API_ROUTES,
  apiPath,
  type AccountSessionView,
  type OwnAccountView,
  type PasskeyView,
  type RecoveryCodesView,
  type TotpSetupView,
} from "../../../src/shared/api.js";
import { PASSKEY_NAME_CHARACTERS, USERNAME_PATTERN } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { asksFirst, chooseAskFirst } from "../ask-first.js";
import { ChoiceCard, choicesOf } from "../components/choice-card.js";
import { CurrentCodeForm } from "../components/current-code-form.js";
import { Badge, ErrorNotice, Loading, PasswordInput, TimeAgo } from "../components/common.js";
import { SettingsSubpage } from "../components/section-tabs.js";
import { SESSION_QUERY_KEY, SETTINGS_SECTIONS, TEXT, THEMES, type Theme } from "../constants.js";
import { browserName } from "../format.js";
import { makePasskey } from "../passkey-prompt.js";
import { passkeyStatusQuery } from "../queries.js";
import { chooseTheme, chosenTheme } from "../theme.js";
import { AuthenticatorKey } from "./auth-pages.js";

const accountQuery = {
  queryKey: ["account"],
  queryFn: () => api<OwnAccountView>("GET", API_ROUTES.account),
} as const;

const valueOf = (form: FormData, name: string) => String(form.get(name) ?? "");

const passkeysQuery = {
  queryKey: ["account-passkeys"],
  queryFn: () => api<PasskeyView[]>("GET", API_ROUTES.accountPasskeys),
} as const;

// The list, and whether the sign-in page offers a passkey, follow every change.
function useRefreshPasskeys() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: passkeyStatusQuery.queryKey });
  };
}

function useRefreshAccount() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: accountQuery.queryKey });
}

function RenameForm({ username }: { username: string }) {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: (body: { username: string; currentPassword: string }) =>
      api<OwnAccountView>("PATCH", API_ROUTES.account, body),
    onSuccess: async (view) => {
      queryClient.setQueryData(accountQuery.queryKey, view);
      // The menu shows the name too.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    rename.mutate(
      { username: valueOf(values, "username"), currentPassword: valueOf(values, "currentPassword") },
      { onSuccess: () => form.reset() },
    );
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>{TEXT.account.name}</h3>
      <label>
        {TEXT.account.username}
        <input
          name="username"
          defaultValue={username}
          autoComplete="username"
          pattern={USERNAME_PATTERN.source}
          required
        />
      </label>
      <PasswordInput label={TEXT.account.currentPassword} name="currentPassword" autoComplete="current-password" />
      <p className="small muted">{TEXT.account.renameHint}</p>
      {rename.isSuccess && (
        <p className="notice success" role="status">
          {TEXT.account.saved}
        </p>
      )}
      <ErrorNotice error={rename.error} />
      <div className="row">
        <button type="submit" disabled={rename.isPending}>
          {TEXT.account.save}
        </button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const refreshAccount = useRefreshAccount();
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: (passwords: { currentPassword: string; newPassword: string }) =>
      api("POST", API_ROUTES.changePassword, passwords),
    // The other sessions end: the list below shrinks.
    onSuccess: refreshAccount,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const passwordsDiffer = valueOf(values, "newPassword") !== valueOf(values, "repeat");
    setMismatch(passwordsDiffer);
    if (passwordsDiffer) {
      return;
    }
    change.mutate(
      { currentPassword: valueOf(values, "currentPassword"), newPassword: valueOf(values, "newPassword") },
      { onSuccess: () => form.reset() },
    );
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>{TEXT.account.password}</h3>
      <PasswordInput label={TEXT.changePassword.current} name="currentPassword" autoComplete="current-password" />
      <PasswordInput label={TEXT.changePassword.next} name="newPassword" autoComplete="new-password" />
      <PasswordInput label={TEXT.changePassword.repeat} name="repeat" autoComplete="new-password" />
      <p className="small muted">{TEXT.account.passwordHint}</p>
      {mismatch && (
        <p className="notice error" role="alert">
          {TEXT.changePassword.mismatch}
        </p>
      )}
      {change.isSuccess && (
        <p className="notice success" role="status">
          {TEXT.account.passwordChanged}
        </p>
      )}
      <ErrorNotice error={change.error} />
      <div className="row">
        <button type="submit" disabled={change.isPending}>
          {TEXT.changePassword.submit}
        </button>
      </div>
    </form>
  );
}

function MoveAuthenticator() {
  const refreshAccount = useRefreshAccount();
  const [open, setOpen] = useState(false);
  const begin = useMutation({
    mutationFn: (code: string) => api<TotpSetupView>("POST", API_ROUTES.accountAuthenticator, { code }),
  });
  const confirm = useMutation({
    mutationFn: (code: string) => api("POST", API_ROUTES.accountAuthenticatorConfirm, { code }),
    onSuccess: refreshAccount,
  });
  const cancel = () => {
    setOpen(false);
    begin.reset();
  };
  const submitNewCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    confirm.mutate(valueOf(new FormData(event.currentTarget), "code"));
  };
  if (confirm.isSuccess) {
    return (
      <p className="notice success" role="status">
        {TEXT.account.moved}
      </p>
    );
  }
  if (!open) {
    return (
      <div className="row">
        <button type="button" onClick={() => setOpen(true)}>
          {TEXT.account.move}
        </button>
      </div>
    );
  }
  if (begin.data === undefined) {
    return (
      <CurrentCodeForm
        action={TEXT.account.next}
        pending={begin.isPending}
        error={begin.error}
        onCode={(code) => begin.mutate(code)}
        onCancel={cancel}
      />
    );
  }
  return (
    <form className="stack" onSubmit={submitNewCode}>
      <AuthenticatorKey setup={begin.data} />
      <label>
        {TEXT.account.newCode}
        <input name="code" autoComplete="one-time-code" inputMode="numeric" required autoFocus />
      </label>
      <ErrorNotice error={confirm.error} />
      <div className="row">
        <button className="primary" type="submit" disabled={confirm.isPending}>
          {TEXT.account.confirmMove}
        </button>
        <button type="button" onClick={cancel}>
          {TEXT.account.cancel}
        </button>
      </div>
    </form>
  );
}

function RenewRecoveryCodes() {
  const refreshAccount = useRefreshAccount();
  const [open, setOpen] = useState(false);
  const renew = useMutation({
    mutationFn: (code: string) => api<RecoveryCodesView>("POST", API_ROUTES.accountRecoveryCodes, { code }),
    onSuccess: refreshAccount,
  });
  const close = () => {
    setOpen(false);
    renew.reset();
  };
  if (renew.data !== undefined) {
    return (
      <div className="notice warning stack" role="status">
        <strong>{TEXT.totpSetup.recoveryTitle}</strong>
        <span>{TEXT.totpSetup.recoveryExplanation}</span>
        <pre className="log secret">{renew.data.recoveryCodes.join("\n")}</pre>
        <div className="row">
          <button type="button" onClick={close}>
            {TEXT.totpSetup.done}
          </button>
        </div>
      </div>
    );
  }
  if (!open) {
    return (
      <div className="row">
        <button type="button" onClick={() => setOpen(true)}>
          {TEXT.account.renewCodes}
        </button>
      </div>
    );
  }
  return (
    <CurrentCodeForm
      action={TEXT.account.renewCodes}
      pending={renew.isPending}
      error={renew.error}
      onCode={(code) => renew.mutate(code)}
      onCancel={close}
    />
  );
}

function TwoStep({ account }: { account: OwnAccountView }) {
  return (
    <section className="card">
      <h3>{TEXT.account.twoStep}</h3>
      <p>{TEXT.account.authenticatorEntry(account.authenticatorName)}</p>
      <MoveAuthenticator />
      <p className="small muted">{TEXT.account.moveHint}</p>
      <p>{TEXT.account.recoveryLeft(account.recoveryCodesLeft)}</p>
      <RenewRecoveryCodes />
      <p className="small muted">{TEXT.account.renewHint}</p>
    </section>
  );
}

// A current code, then the browser's own prompt; the passkey names itself after the password manager
// that keeps it, or else this browser.
function AddPasskey() {
  const refreshPasskeys = useRefreshPasskeys();
  const [open, setOpen] = useState(false);
  const add = useMutation({
    mutationFn: async (code: string) => {
      const options = await api<PublicKeyCredentialCreationOptionsJSON>("POST", API_ROUTES.accountPasskeyOptions, {
        code,
      });
      const response = await makePasskey(options);
      const name = browserName(navigator.userAgent).slice(0, PASSKEY_NAME_CHARACTERS);
      return api<PasskeyView>("POST", API_ROUTES.accountPasskeys, { response, name });
    },
    onSuccess: () => {
      setOpen(false);
      refreshPasskeys();
    },
  });
  const start = () => {
    add.reset();
    setOpen(true);
  };
  const cancel = () => {
    setOpen(false);
    add.reset();
  };
  if (open) {
    return (
      <CurrentCodeForm
        action={TEXT.account.next}
        pending={add.isPending}
        error={add.error}
        onCode={(code) => add.mutate(code)}
        onCancel={cancel}
      />
    );
  }
  return (
    <div className="stack">
      {add.data !== undefined && (
        <p className="notice success" role="status">
          {TEXT.passkeys.added(add.data.name)}
        </p>
      )}
      <div className="row">
        <button type="button" onClick={start}>
          {TEXT.passkeys.add}
        </button>
      </div>
    </div>
  );
}

function PasskeyRow({ passkey }: { passkey: PasskeyView }) {
  const refreshPasskeys = useRefreshPasskeys();
  const [renaming, setRenaming] = useState(false);
  const path = apiPath(API_ROUTES.accountPasskey, { passkeyId: passkey.id });
  const rename = useMutation({
    mutationFn: (name: string) => api<PasskeyView>("PATCH", path, { name }),
    onSuccess: () => {
      setRenaming(false);
      refreshPasskeys();
    },
  });
  const remove = useMutation({ mutationFn: () => api("DELETE", path), onSuccess: refreshPasskeys });
  const submitName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    rename.mutate(valueOf(new FormData(event.currentTarget), "name"));
  };
  const confirmRemove = () => {
    if (window.confirm(TEXT.passkeys.confirmRemove(passkey.name))) {
      remove.mutate();
    }
  };
  return (
    <li className="stack">
      {renaming ? (
        <form className="row" onSubmit={submitName}>
          <input
            name="name"
            defaultValue={passkey.name}
            maxLength={PASSKEY_NAME_CHARACTERS}
            aria-label={TEXT.passkeys.newName(passkey.name)}
            required
            autoFocus
          />
          <button className="primary" type="submit" disabled={rename.isPending}>
            {TEXT.passkeys.save}
          </button>
          <button type="button" onClick={() => setRenaming(false)}>
            {TEXT.account.cancel}
          </button>
        </form>
      ) : (
        <div className="row spread">
          <span className="row">
            <strong>{passkey.name}</strong>
            {passkey.synced && <Badge value={TEXT.passkeys.synced} tone="neutral" />}
          </span>
          <span className="row">
            <button type="button" className="link" onClick={() => setRenaming(true)}>
              {TEXT.passkeys.rename}
            </button>
            <button type="button" className="link" onClick={confirmRemove} disabled={remove.isPending}>
              {TEXT.passkeys.remove}
            </button>
          </span>
        </div>
      )}
      <span className="small muted">
        {TEXT.passkeys.addedOn} <TimeAgo timestamp={passkey.createdAt} />
        {TEXT.separator}
        {passkey.lastUsedAt === null ? (
          TEXT.passkeys.neverUsed
        ) : (
          <>
            {TEXT.passkeys.lastUsed} <TimeAgo timestamp={passkey.lastUsedAt} />
          </>
        )}
      </span>
      {passkey.otherAddress !== null && (
        <span className="small muted">{TEXT.passkeys.otherAddress(passkey.otherAddress)}</span>
      )}
      <ErrorNotice error={rename.error ?? remove.error} />
    </li>
  );
}

/** Signing in with the device's own lock: what this account has, and adding one. */
function Passkeys() {
  const status = useQuery(passkeyStatusQuery);
  const list = useQuery(passkeysQuery);
  const usable = status.data?.usable === true;
  const supported = browserSupportsWebAuthn();
  return (
    <section className="card stack" aria-labelledby="passkeys-title">
      <h3 id="passkeys-title">{TEXT.passkeys.title}</h3>
      <p className="small muted">{TEXT.passkeys.explanation}</p>
      {status.data?.usable === false && <p className="notice warning">{TEXT.passkeys.needsName}</p>}
      {list.data?.length === 0 && <p className="small muted">{TEXT.passkeys.empty}</p>}
      {list.data !== undefined && list.data.length > 0 && (
        <ul className="plain-list">
          {list.data.map((passkey) => (
            <PasskeyRow key={passkey.id} passkey={passkey} />
          ))}
        </ul>
      )}
      {usable && supported && <AddPasskey />}
      {usable && !supported && <p className="small muted">{TEXT.passkeys.unsupported}</p>}
      <ErrorNotice error={list.error ?? status.error} />
    </section>
  );
}

function Sessions({ sessions }: { sessions: AccountSessionView[] }) {
  const refreshAccount = useRefreshAccount();
  const end = useMutation({
    mutationFn: (sessionId: string) => api("DELETE", apiPath(API_ROUTES.accountSession, { sessionId })),
    onSuccess: refreshAccount,
  });
  const endOthers = useMutation({
    mutationFn: () => api("DELETE", API_ROUTES.accountOtherSessions),
    onSuccess: refreshAccount,
  });
  const hasOthers = sessions.some((session) => !session.current);
  return (
    <section className="card">
      <h3>{TEXT.account.sessions}</h3>
      <p className="muted small">{TEXT.account.sessionShells}</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{TEXT.account.where}</th>
              <th>{TEXT.account.address}</th>
              <th>{TEXT.account.lastUsed}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const where = browserName(session.userAgent);
              return (
                <tr key={session.id}>
                  <td>{session.current ? TEXT.account.thisBrowser(where) : where}</td>
                  <td className="mono">{session.ip ?? TEXT.none}</td>
                  <td>
                    <TimeAgo timestamp={session.lastSeenAt} />
                  </td>
                  <td>
                    {!session.current && (
                      <button
                        type="button"
                        aria-label={TEXT.account.signOutSession(where)}
                        disabled={end.isPending}
                        onClick={() => end.mutate(session.id)}
                      >
                        {TEXT.signOut}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasOthers && (
        <div className="row">
          <button type="button" disabled={endOthers.isPending} onClick={() => endOthers.mutate()}>
            {TEXT.account.signOutOthers}
          </button>
        </div>
      )}
      <ErrorNotice error={end.error ?? endOthers.error} />
    </section>
  );
}

const THEME_CHOICES = choicesOf(Object.values(THEMES), TEXT.account.themes);

/** Light, dark, or as the device is set: shown at once, and kept in this browser. */
function Appearance() {
  const [theme, setTheme] = useState(chosenTheme);
  const choose = (chosen: Theme) => {
    chooseTheme(chosen);
    setTheme(chosen);
  };
  return (
    <div className="appearance">
      <ChoiceCard
        title={TEXT.account.appearance}
        name="theme"
        choices={THEME_CHOICES}
        chosen={theme}
        disabled={false}
        onChoose={choose}
      >
        <p className="small muted">{TEXT.account.themeKept}</p>
      </ChoiceCard>
    </div>
  );
}

/** Whether stop and remove ask once first, in this browser only: off unless chosen here. */
function AskFirst() {
  const [on, setOn] = useState(asksFirst);
  const titleId = useId();
  const choose = (wanted: boolean) => {
    chooseAskFirst(wanted);
    // Read back: where storage is off nothing was kept, and the box says so.
    setOn(asksFirst());
  };
  return (
    <section className="card choice-card" aria-labelledby={titleId}>
      <h3 id={titleId}>{TEXT.account.containerActions}</h3>
      <div className="choice-options">
        <label className="choice-option">
          <input type="checkbox" checked={on} onChange={(event) => choose(event.target.checked)} />
          <span className="choice-words">
            {TEXT.account.askFirst}
            <span className="small faint">{TEXT.account.askFirstNote}</span>
          </span>
        </label>
      </div>
    </section>
  );
}

/** The signed-in person's own look, name, password, second step, passkeys and sessions. */
export function AccountPage() {
  const account = useQuery(accountQuery);
  const lede = account.data === undefined ? null : TEXT.account.signedInAs(account.data.username, account.data.role);
  return (
    <SettingsSubpage current={SETTINGS_SECTIONS.account} title={TEXT.account.title} lede={lede}>
      <Appearance />
      <AskFirst />
      {account.data === undefined && <Loading />}
      {account.data !== undefined && (
        <>
          <RenameForm username={account.data.username} />
          <PasswordForm />
          <TwoStep account={account.data} />
          <Passkeys />
          <Sessions sessions={account.data.sessions} />
        </>
      )}
      <ErrorNotice error={account.error} />
    </SettingsSubpage>
  );
}
