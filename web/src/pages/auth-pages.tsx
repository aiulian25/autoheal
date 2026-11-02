import { browserSupportsWebAuthn, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { API_ROUTES, type SessionView, type TotpEnabledView, type TotpSetupView } from "../../../src/shared/api.js";
import { BRAND_ASSETS } from "../../../src/shared/constants.js";
import { api, rememberCsrfToken } from "../api-client.js";
import { ErrorNotice, PasswordInput } from "../components/common.js";
import { PATHS, QR_MARGIN_MODULES, QR_PIXELS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { answerWithPasskey } from "../passkey-prompt.js";
import { passkeyStatusQuery } from "../queries.js";
import { useRefreshSession } from "../session.js";

const valueOf = (form: FormData, name: string) => String(form.get(name) ?? "");

// The screens before the dashboard opens: the logo above what each asks.
function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="centered">
      <img className="auth-logo" src={BRAND_ASSETS.logo} alt={TEXT.appName} />
      {children}
    </main>
  );
}

// Offered once someone here has a passkey, and the browser can use one: no name asked first.
function PasskeySignIn({ onSignedIn }: { onSignedIn: (session: SessionView) => void }) {
  const status = useQuery(passkeyStatusQuery);
  const signIn = useMutation({
    mutationFn: async () => {
      const options = await api<PublicKeyCredentialRequestOptionsJSON>("POST", API_ROUTES.passkeySignInOptions);
      const response = await answerWithPasskey(options);
      return api<SessionView>("POST", API_ROUTES.passkeySignIn, { response });
    },
    onSuccess: onSignedIn,
  });
  if (status.data?.offered !== true || !browserSupportsWebAuthn()) {
    return null;
  }
  return (
    <div className="stack">
      <p className="divider small muted">{TEXT.login.orContinue}</p>
      <button type="button" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
        {TEXT.login.passkey}
      </button>
      <ErrorNotice error={signIn.error} />
    </div>
  );
}

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signedIn = (session: SessionView) => {
    rememberCsrfToken(session.csrfToken);
    queryClient.setQueryData(SESSION_QUERY_KEY, session);
    void navigate(PATHS.home);
  };
  const login = useMutation({
    mutationFn: (form: FormData) =>
      api<SessionView>("POST", API_ROUTES.login, {
        username: valueOf(form, "username"),
        password: valueOf(form, "password"),
      }),
    onSuccess: signedIn,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    login.mutate(new FormData(event.currentTarget));
  };
  return (
    <AuthScreen>
      <form className="panel" onSubmit={submit}>
        <h1>{TEXT.login.title}</h1>
        <label>
          {TEXT.login.username}
          <input name="username" autoComplete="username" required autoFocus />
        </label>
        <PasswordInput label={TEXT.login.password} name="password" autoComplete="current-password" />
        <ErrorNotice error={login.error} />
        <button className="primary" type="submit" disabled={login.isPending}>
          {TEXT.login.submit}
        </button>
        <PasskeySignIn onSignedIn={signedIn} />
      </form>
    </AuthScreen>
  );
}

export function SecondFactorPage() {
  const refreshSession = useRefreshSession();
  const verify = useMutation({
    mutationFn: (code: string) => api("POST", API_ROUTES.secondFactor, { code }),
    onSuccess: refreshSession,
    onError: refreshSession,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    verify.mutate(valueOf(new FormData(event.currentTarget), "code"));
  };
  return (
    <AuthScreen>
      <form className="panel" onSubmit={submit}>
        <h1>{TEXT.secondFactor.title}</h1>
        <p className="muted">{TEXT.secondFactor.explanation}</p>
        <label>
          {TEXT.secondFactor.code}
          <input name="code" autoComplete="one-time-code" inputMode="text" required autoFocus />
        </label>
        <ErrorNotice error={verify.error} />
        <button className="primary" type="submit" disabled={verify.isPending}>
          {TEXT.secondFactor.submit}
        </button>
      </form>
    </AuthScreen>
  );
}

export function ChangePasswordPage() {
  const refreshSession = useRefreshSession();
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: (passwords: { currentPassword: string; newPassword: string }) =>
      api("POST", API_ROUTES.changePassword, passwords),
    onSuccess: refreshSession,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const passwordsDiffer = valueOf(form, "newPassword") !== valueOf(form, "repeat");
    setMismatch(passwordsDiffer);
    if (!passwordsDiffer) {
      change.mutate({ currentPassword: valueOf(form, "currentPassword"), newPassword: valueOf(form, "newPassword") });
    }
  };
  return (
    <AuthScreen>
      <form className="panel" onSubmit={submit}>
        <h1>{TEXT.changePassword.title}</h1>
        <p className="muted">{TEXT.changePassword.explanation}</p>
        <PasswordInput label={TEXT.changePassword.current} name="currentPassword" autoComplete="current-password" />
        <PasswordInput label={TEXT.changePassword.next} name="newPassword" autoComplete="new-password" />
        <PasswordInput label={TEXT.changePassword.repeat} name="repeat" autoComplete="new-password" />
        {mismatch && (
          <p className="notice error" role="alert">
            {TEXT.changePassword.mismatch}
          </p>
        )}
        <ErrorNotice error={change.error} />
        <button className="primary" type="submit" disabled={change.isPending}>
          {TEXT.changePassword.submit}
        </button>
      </form>
    </AuthScreen>
  );
}

/** The QR code and the key behind it, for an authenticator app to add. */
export function AuthenticatorKey({ setup }: { setup: TotpSetupView }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(setup.otpauthUri, { width: QR_PIXELS, margin: QR_MARGIN_MODULES }).then(setImage);
  }, [setup.otpauthUri]);
  return (
    <>
      {image !== null && <img className="qr" src={image} alt={TEXT.totpSetup.qrDescription} />}
      <div className="stack">
        <span className="small muted">{TEXT.totpSetup.secretLabel}</span>
        <span className="secret">{setup.secret}</span>
      </div>
    </>
  );
}

export function TotpSetupPage() {
  const refreshSession = useRefreshSession();
  const navigate = useNavigate();
  const setup = useMutation({ mutationFn: () => api<TotpSetupView>("POST", API_ROUTES.totpSetup) });
  const confirm = useMutation({
    mutationFn: (code: string) => api<TotpEnabledView>("POST", API_ROUTES.totpConfirm, { code }),
  });
  const finish = async () => {
    await refreshSession();
    void navigate(PATHS.home);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    confirm.mutate(valueOf(new FormData(event.currentTarget), "code"));
  };

  if (confirm.data !== undefined) {
    return (
      <AuthScreen>
        <section className="panel">
          <h1>{TEXT.totpSetup.recoveryTitle}</h1>
          <p className="muted">{TEXT.totpSetup.recoveryExplanation}</p>
          <pre className="log secret">{confirm.data.recoveryCodes.join("\n")}</pre>
          {confirm.data.backupPassphrase !== null && (
            <>
              <h2>{TEXT.totpSetup.passphraseTitle}</h2>
              <p className="muted">{TEXT.totpSetup.passphraseExplanation}</p>
              <pre className="log secret">{confirm.data.backupPassphrase}</pre>
            </>
          )}
          <button className="primary" type="button" onClick={() => void finish()}>
            {TEXT.totpSetup.done}
          </button>
        </section>
      </AuthScreen>
    );
  }
  return (
    <AuthScreen>
      <form className="panel" onSubmit={submit}>
        <h1>{TEXT.totpSetup.title}</h1>
        <p className="muted">{TEXT.totpSetup.explanation}</p>
        {setup.data === undefined ? (
          <button className="primary" type="button" onClick={() => setup.mutate()} disabled={setup.isPending}>
            {TEXT.totpSetup.start}
          </button>
        ) : (
          <>
            <AuthenticatorKey setup={setup.data} />
            <label>
              {TEXT.totpSetup.code}
              <input name="code" autoComplete="one-time-code" inputMode="numeric" required autoFocus />
            </label>
            <button className="primary" type="submit" disabled={confirm.isPending}>
              {TEXT.totpSetup.confirm}
            </button>
          </>
        )}
        <ErrorNotice error={setup.error ?? confirm.error} />
      </form>
    </AuthScreen>
  );
}
