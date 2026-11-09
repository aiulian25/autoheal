import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ERRORS, API_ROUTES } from "../../../src/shared/api.js";
import {
  ROUTER_KIND,
  type RouterCertificateView,
  type RouterProbeView,
  type RouterSettingsView,
} from "../../../src/shared/network.js";
import { ApiError, api } from "../api-client.js";
import { useAskInPlace } from "../components/ask-in-place.js";
import { ErrorNotice } from "../components/common.js";
import { TEXT } from "../constants.js";
import { routerSettingsQuery } from "../queries.js";

const text = TEXT.network.connection;

function ProbeResult({ probe }: { probe: RouterProbeView }) {
  return (
    <div className="router-probe" role="status">
      <strong>{probe.name === null ? text.asked : text.askedRouter(probe.name, probe.version)}</strong>
      {probe.capabilities.map(({ capability, works, detail }) => (
        <span key={capability} className={works ? "text-good" : "text-warning"}>
          {works ? "✓" : "!"} {text.capabilities[capability as keyof typeof text.capabilities]}
          {works && detail !== "" ? `: ${detail}` : ""}
        </span>
      ))}
      <span className="small muted">{text.speedTestNote}</span>
    </div>
  );
}

type Attempt = "probe" | "save";
type RouterBody = { url: string; username: string; password?: string; kind: string };
interface Asking extends RouterCertificateView {
  changed: boolean;
  attempt: Attempt;
  body: RouterBody;
}

function CertificateCheck({
  asking,
  onTrust,
  onCancel,
}: {
  asking: Asking;
  onTrust: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={asking.changed ? "router-trust notice warning" : "router-trust"} role="alert">
      <strong>{text.trustTitle}</strong>
      <p className="small">{asking.changed ? text.trustChanged(asking.url) : text.trustNew(asking.url)}</p>
      <span className="small muted">{text.trustFingerprint}</span>
      <code className="mono router-fingerprint">{asking.fingerprint}</code>
      <span className="row">
        <button type="button" className="primary" onClick={onTrust}>
          {text.trustConfirm}
        </button>
        <button type="button" onClick={onCancel}>
          {text.trustCancel}
        </button>
      </span>
    </div>
  );
}

/**
 * The router Autoheal reads. Its certificate comes first, with nothing sent: only once a person has compared and
 * approved it does the login go, and to that certificate alone. Then it says what this router can do.
 */
function RouterForm({ view, onSaved }: { view: RouterSettingsView; onSaved: () => void }) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const bodyOf = (form: HTMLFormElement): RouterBody => {
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    return {
      kind: ROUTER_KIND.unifi,
      url: String(values.get("url") ?? "").trim(),
      username: String(values.get("username") ?? "").trim(),
      ...(password === "" ? {} : { password }),
    };
  };
  const look = useMutation({
    mutationFn: async ({ attempt, body, changed }: { attempt: Attempt; body: RouterBody; changed: boolean }) => {
      const shown = await api<RouterCertificateView>("POST", API_ROUTES.routerCertificate, { url: body.url });
      setAsking({ ...shown, attempt, body, changed });
    },
  });
  // A router whose certificate is not the one trusted is shown to a person, in place of the error alone.
  const lookIfChanged = (attempt: Attempt, body: RouterBody) => (error: Error) => {
    if (error instanceof ApiError && error.code === API_ERRORS.routerCertificateChanged) {
      look.mutate({ attempt, body, changed: true });
    }
  };
  const probe = useMutation({
    mutationFn: (body: object) => api<RouterProbeView>("POST", API_ROUTES.routerProbe, body),
  });
  const save = useMutation({
    mutationFn: (body: object) => api("PUT", API_ROUTES.routerSettings, body),
    onSuccess: onSaved,
  });
  const send = (attempt: Attempt, body: RouterBody, trustedCertificate?: string) => {
    const sent = trustedCertificate === undefined ? body : { ...body, trustedCertificate };
    const onError = lookIfChanged(attempt, body);
    if (attempt === "probe") probe.mutate(sent, { onError });
    else save.mutate(sent, { onError });
  };
  const start = (attempt: Attempt, body: RouterBody) => {
    probe.reset();
    save.reset();
    // A router it already trusts at this address needs no new look; any other does, before anything is sent.
    if (view.configured && view.url === body.url) send(attempt, body);
    else look.mutate({ attempt, body, changed: false });
  };
  const trust = () => {
    if (asking === null) return;
    setAsking(null);
    send(asking.attempt, asking.body, asking.fingerprint);
  };
  const shownError = look.error ?? probe.error ?? save.error;
  const stillChanged = shownError instanceof ApiError && shownError.code === API_ERRORS.routerCertificateChanged;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    start("save", bodyOf(event.currentTarget));
  };
  return (
    <form className="settings-form" onSubmit={submit}>
      <label>
        {text.address}
        <input name="url" type="url" required placeholder={text.addressPlaceholder} defaultValue={view.url ?? ""} />
      </label>
      <label>
        {text.username}
        <span className="hint">{text.usernameHint}</span>
        <input name="username" required autoComplete="off" defaultValue={view.username ?? ""} />
      </label>
      <label>
        {text.password}
        <input
          name="password"
          type="password"
          required={!view.configured}
          autoComplete="new-password"
          placeholder={view.configured ? text.passwordKept : undefined}
        />
      </label>
      <div className="row">
        <button
          type="button"
          disabled={probe.isPending}
          onClick={(event) => {
            const { form } = event.currentTarget;
            if (form !== null && form.reportValidity()) start("probe", bodyOf(form));
          }}
        >
          {probe.isPending ? text.trying : text.test}
        </button>
        <button className="primary" type="submit" disabled={save.isPending}>
          {save.isPending ? text.trying : text.save}
        </button>
      </div>
      {asking !== null && <CertificateCheck asking={asking} onTrust={trust} onCancel={() => setAsking(null)} />}
      {probe.data !== undefined && <ProbeResult probe={probe.data} />}
      {asking === null && !stillChanged && <ErrorNotice error={shownError} />}
    </form>
  );
}

function ContractForm({ view, onSaved }: { view: RouterSettingsView; onSaved: () => void }) {
  const save = useMutation({
    mutationFn: (body: object) => api("PUT", API_ROUTES.routerContract, body),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    save.mutate({ downMbps: Number(values.get("down")), upMbps: Number(values.get("up")) });
  };
  return (
    <form className="settings-form settings-divided" onSubmit={submit}>
      <strong>{text.contract}</strong>
      <span className="small muted">{text.contractHint}</span>
      <span className="row">
        <label>
          {text.contractDown}
          <input name="down" type="number" min={1} required defaultValue={view.contract?.downMbps} />
        </label>
        <label>
          {text.contractUp}
          <input name="up" type="number" min={1} required defaultValue={view.contract?.upMbps} />
        </label>
      </span>
      <button type="submit" disabled={save.isPending}>
        {text.save}
      </button>
      <ErrorNotice error={save.error} />
    </form>
  );
}

/** The router, beside what else Autoheal leans on. Admins only: its details are a home's own. */
export function RouterCard() {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
  const settings = useQuery(routerSettingsQuery);
  const [changing, setChanging] = useState(false);
  const refresh = () => {
    setChanging(false);
    void queryClient.invalidateQueries();
  };
  const remove = useMutation({
    mutationFn: () => api("DELETE", API_ROUTES.routerSettings),
    onSuccess: refresh,
  });
  const view = settings.data;
  if (view === undefined) return null;
  const confirmRemove = () => {
    asking.confirm(text.removeConfirm, () => remove.mutate());
  };
  return (
    <section className="card settings-card" aria-labelledby="router-title">
      <header className="settings-card-head">
        <h3 id="router-title">{text.title}</h3>
        {view.configured && (
          <span className="badge good">
            <span className="status-dot" />
            {text.connected}
          </span>
        )}
      </header>
      <p className="settings-card-text">{text.explanation}</p>
      {view.configured && !changing && (
        <p className="small">
          <span className="mono">{view.url}</span>
          {TEXT.separator}
          <span className="mono">{view.username}</span>
          {view.certificate !== null && <span className="muted"> {text.certificate(view.certificate)}</span>}
        </p>
      )}
      {view.configured && !changing && (
        <p className="small muted">{view.logPort === null ? text.logsOff : text.logsOn(view.logPort)}</p>
      )}
      {(changing || !view.configured) && <RouterForm view={view} onSaved={refresh} />}
      {view.configured && !changing && (
        <div className="row">
          <button type="button" onClick={() => setChanging(true)}>
            {text.change}
          </button>
          <button type="button" className="quiet danger" disabled={remove.isPending} onClick={confirmRemove}>
            {text.remove}
          </button>
        </div>
      )}
      {view.configured && !changing && <ContractForm view={view} onSaved={refresh} />}
      {asking.question}
      <ErrorNotice error={settings.error ?? remove.error} />
    </section>
  );
}
