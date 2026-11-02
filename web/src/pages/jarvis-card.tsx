import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { API_ROUTES } from "../../../src/shared/api.js";
import type { JarvisConnected, JarvisHostNames, JarvisView } from "../../../src/shared/jarvis.js";
import { api } from "../api-client.js";
import { CopyButton, ErrorNotice, TimeAgo } from "../components/common.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { jarvisQuery } from "../queries.js";

const text = TEXT.jarvis;

function SetupBlock({ setup }: { setup: string }) {
  return (
    <div className="jarvis-setup">
      <p className="small muted">{text.setupNote}</p>
      <pre className="mono compose-problem">{setup}</pre>
      <CopyButton text={setup} />
    </div>
  );
}

function HostNames({ host, onSaved }: { host: JarvisHostNames; onSaved: () => Promise<unknown> }) {
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (aliases: string[]) => api("PUT", API_ROUTES.jarvisAliases, { hostId: host.id, aliases }),
    onSuccess: async () => {
      setSaved(true);
      await onSaved();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    const typed = String(new FormData(event.currentTarget).get("aliases") ?? "");
    save.mutate(
      typed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    );
  };
  return (
    <form className="jarvis-name" onSubmit={submit}>
      <label className="small" htmlFor={`names-${host.id}`}>
        {host.label}
      </label>
      <input
        id={`names-${host.id}`}
        name="aliases"
        aria-label={text.namesOf(host.label)}
        defaultValue={host.aliases.join(", ")}
        key={host.aliases.join(",")}
      />
      <button type="submit" disabled={save.isPending}>
        {text.saveNames}
      </button>
      {saved && !save.isPending && <span className="small muted">{text.namesSaved}</span>}
      {save.isError && <span className="small text-danger">{text.nameTaken}</span>}
    </form>
  );
}

function testLine(view: JarvisView, sent: { delivered: boolean } | null): string | null {
  if (view.lastTestMilliseconds !== null) return text.answered(view.lastTestMilliseconds);
  if (view.testing) return text.testing;
  if (sent === null) return null;
  return sent.delivered ? text.notAnswered : text.notDelivered;
}

/** Connecting Jarvis: one button, one block to add to Home Assistant, and a test that proves both ways work. */
export function JarvisCard() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: jarvisQuery.queryKey });
  const [secret, setSecret] = useState<string | null>(null);
  const [setupShown, setSetupShown] = useState(false);
  const [sent, setSent] = useState<{ delivered: boolean } | null>(null);
  const jarvis = useQuery({
    ...jarvisQuery,
    refetchInterval: (query) => (query.state.data?.testing ? JOB_REFRESH_MILLISECONDS : false),
  });
  const connect = useMutation({
    mutationFn: () => api<JarvisConnected>("POST", API_ROUTES.jarvisConnect),
    onSuccess: async (answer) => {
      setSecret(answer.secret);
      setSetupShown(true);
      await refresh();
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ delivered: boolean }>("POST", API_ROUTES.jarvisTest),
    onSuccess: async (answer) => {
      setSent(answer);
      await refresh();
    },
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api("PUT", API_ROUTES.jarvisPause, { paused }),
    onSuccess: refresh,
  });
  const disconnect = useMutation({
    mutationFn: () => api("DELETE", API_ROUTES.jarvis),
    onSuccess: async () => {
      setSecret(null);
      setSent(null);
      setSetupShown(false);
      await refresh();
    },
  });
  const heard = jarvis.data?.lastTestMilliseconds ?? null;
  useEffect(() => {
    if (heard !== null) setSecret(null);
  }, [heard]);
  const view = jarvis.data;
  if (view === undefined) return <ErrorNotice error={jarvis.error} />;
  const line = testLine(view, sent);
  const confirmDisconnect = () => {
    if (window.confirm(text.disconnectConfirm)) disconnect.mutate();
  };
  return (
    <section className={view.connected ? "card settings-card" : "card settings-card dashed"} aria-labelledby="jarvis">
      <header className="settings-card-head">
        <h3 id="jarvis">{text.title}</h3>
        <span className={view.connected ? "small" : "small muted"}>
          {view.paused && text.paused}
          {view.connected && !view.paused && text.connected}
          {!view.connected && text.notConnected}
        </span>
      </header>
      <p className="settings-card-text">{text.explanation}</p>
      {!view.homeAssistantSet && <p className="small muted">{text.needsHomeAssistant}</p>}
      {view.homeAssistantSet && !view.connected && (
        <p>
          <button type="button" className="primary" disabled={connect.isPending} onClick={() => connect.mutate()}>
            {text.connect}
          </button>
        </p>
      )}
      {view.connected && (
        <>
          {secret !== null && (
            <div className="jarvis-setup">
              <p className="small text-warning">{text.keyOnce}</p>
              <pre className="mono compose-problem">{secret}</pre>
              <CopyButton text={secret} />
            </div>
          )}
          {setupShown && view.setup !== null && <SetupBlock setup={view.setup} />}
          <p className="small muted">
            {view.lastHeardAt === null ? (
              text.never
            ) : (
              <>
                {text.lastHeard} <TimeAgo timestamp={view.lastHeardAt} />
              </>
            )}
          </p>
          {line !== null && (
            <p className="small" role="status">
              {line}
            </p>
          )}
          <div className="row">
            <button type="button" disabled={test.isPending || view.testing} onClick={() => test.mutate()}>
              {text.test}
            </button>
            <button type="button" onClick={() => setSetupShown(!setupShown)}>
              {setupShown ? text.hideSetup : text.showSetup}
            </button>
            <button type="button" onClick={() => pause.mutate(!view.paused)}>
              {view.paused ? text.resume : text.pause}
            </button>
            <button type="button" className="danger" onClick={confirmDisconnect}>
              {text.disconnect}
            </button>
          </div>
          {view.waiting > 0 && <p className="small muted">{text.waiting(view.waiting)}</p>}
          {view.notConfirmed > 0 && <p className="small text-warning">{text.notConfirmed(view.notConfirmed)}</p>}
          <p className="small">
            <span className="muted">{text.summaryNow}:</span> {view.summary}
          </p>
          <details className="jarvis-names">
            <summary className="small">{text.names}</summary>
            <p className="small muted">{text.namesHint}</p>
            {view.hosts.map((host) => (
              <HostNames key={host.id} host={host} onSaved={refresh} />
            ))}
          </details>
          {view.recent.length > 0 && (
            <div className="jarvis-recent">
              <h4 className="small">{text.recent}</h4>
              <ul className="plain-list small">
                {view.recent.map((item) => (
                  <li key={item.id} className={item.tier === "urgent" ? "text-danger" : undefined}>
                    {item.text}{" "}
                    <span className="muted">
                      <TimeAgo timestamp={item.sentAt} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <ErrorNotice error={connect.error ?? test.error ?? pause.error ?? disconnect.error} />
    </section>
  );
}
