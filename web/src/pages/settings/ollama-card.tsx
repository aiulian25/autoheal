import { useAskInPlace } from "../../components/ask-in-place.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, type OllamaModelFacts, type OllamaServerModel } from "../../../../src/shared/api.js";
import { INTEGRATION_SOURCES } from "../../../../src/shared/constants.js";
import { ModelChoices, OllamaServers, ServerForm, type ServerFields } from "../ollama-servers.js";
import { api } from "../../api-client.js";
import { ErrorNotice, Loading } from "../../components/common.js";
import { Icon } from "../../components/icons.js";
import { TEXT } from "../../constants.js";
import { ollamaQuery, ollamaServersQuery, ollamaSettingsQuery } from "../../queries.js";
import { refreshSettingsNotice } from "./refresh-settings-notice.js";

const text = TEXT.settingsPage;

const numbers = new Intl.NumberFormat();

// --- Connections: Ollama, and the Home Assistant Autoheal reads --------------------------------------

// What the model says of itself, in a few words: whether it thinks first, and how much it reads.
function factsText(facts: OllamaModelFacts): string {
  const parts = [
    facts.answers ? null : text.ollama.cannotAnswer,
    facts.thinks ? text.ollama.thinks : text.ollama.answersStraight,
    facts.contextLength === null ? null : text.ollama.readsUpTo(numbers.format(facts.contextLength)),
  ];
  return parts.filter((part) => part !== null).join(TEXT.separator);
}

export function OllamaCard({ admin }: { admin: boolean }) {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
  const servers = useQuery(ollamaServersQuery);
  const refreshOllama = async () => {
    await queryClient.invalidateQueries({ queryKey: ollamaServersQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: ollamaSettingsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: ollamaQuery.queryKey });
    await refreshSettingsNotice(queryClient);
  };
  const ollama = useQuery(ollamaQuery);
  const settings = useQuery(ollamaSettingsQuery);
  const [changing, setChanging] = useState(false);
  const useEnvironment = useMutation({
    mutationFn: () => api("DELETE", API_ROUTES.ollamaSettings),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ollamaSettingsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: ollamaQuery.queryKey });
      await refreshSettingsNotice(queryClient);
    },
  });
  const status = ollama.data;
  const view = settings.data;
  // One click on a model, as long as that model can do what is asked of it: the same check as saving.
  const switching = useMutation({
    mutationFn: (model: string) =>
      api("PUT", API_ROUTES.ollamaSettings, { url: view?.url, model, contextTokens: view?.contextTokens }),
    onSuccess: () => refreshOllama(),
  });
  const defaultName = servers.data?.defaultName ?? null;
  // Naming it is not choosing it: the .env's stays the .env's unless its address or model really changed.
  const saveDefault = async ({ name = "", url, model, contextTokens }: ServerFields) => {
    await api("PUT", API_ROUTES.ollamaDefaultName, { name });
    const same = url === view?.url && model === view?.model && contextTokens === view?.contextTokens;
    if (!same) await api("PUT", API_ROUTES.ollamaSettings, { url, model, contextTokens });
  };
  const loadedNames = new Set(status?.loaded.map((model) => model.name));
  const inOllama: OllamaServerModel[] = (status?.models ?? []).map((model) => ({
    ...model,
    loaded: loadedNames.has(model.name),
  }));
  const answering = status?.reachable === true;
  const loaded = status?.loaded.map((model) => model.name).join(TEXT.listComma) || text.ollama.noModel;
  const confirmUseEnvironment = () => {
    asking.confirm(text.ollama.useEnvironmentConfirm, () => useEnvironment.mutate());
  };
  return (
    <section className="card settings-card" aria-labelledby="ollama-title">
      <header className="settings-card-head">
        <h3 id="ollama-title">{TEXT.ollama.title}</h3>
        {status !== undefined && (
          <span className={answering ? "badge good" : "badge danger"}>
            <span className="status-dot" />
            {answering ? TEXT.ollama.reachable : TEXT.ollama.unreachable}
          </span>
        )}
      </header>
      {view === undefined && settings.error === null && <Loading />}
      {view !== undefined && (
        <dl className="settings-facts">
          <dt>{text.ollama.nameLabel}</dt>
          <dd>{defaultName ?? text.ollama.unnamedDefault}</dd>
          <dt>{text.ollama.model}</dt>
          <dd className="mono">{view.model}</dd>
          {status?.facts !== null && status?.facts !== undefined && (
            <>
              <dt>{text.ollama.itSays}</dt>
              <dd>{factsText(status.facts)}</dd>
            </>
          )}
          <dt>{text.ollama.address}</dt>
          <dd className="mono">{view.url}</dd>
          <dt>{text.ollama.context}</dt>
          <dd>{text.ollama.contextTokens(numbers.format(view.contextTokens))}</dd>
          {status !== undefined && (
            <>
              <dt>{text.ollama.loadedNow}</dt>
              <dd>
                {loaded}
                {TEXT.separator}
                {text.ollama.available(status.models.length)}
              </dd>
            </>
          )}
        </dl>
      )}
      {view !== undefined && (
        <p className="small muted">
          {view.source === INTEGRATION_SOURCES.dashboard ? text.ollama.fromDashboard : text.ollama.fromEnvironment}
        </p>
      )}
      {status?.modelPresent === false && <p className="notice error">{TEXT.ollama.missing(status.model)}</p>}
      {status?.error !== null && status?.error !== undefined && <p className="small muted">{status.error}</p>}
      {view?.plainHttp === true && (
        <p className="settings-warning">
          <Icon name="lockOpen" />
          {text.ollama.plainHttp}
        </p>
      )}
      {view !== undefined && !changing && inOllama.length > 0 && (
        <div className="settings-field">
          <h4>{text.ollama.modelsTitle}</h4>
          <ModelChoices
            name="model-in-use"
            models={inOllama}
            chosen={switching.isPending ? switching.variables : view.model}
            inUse={view.model}
            disabled={!admin || switching.isPending}
            onChoose={(model) => switching.mutate(model)}
          />
          <ErrorNotice error={switching.error} />
        </div>
      )}
      {admin && view !== undefined && changing && (
        <ServerForm
          initial={{ ...view, name: defaultName ?? "" }}
          named
          nameOptional
          submit={saveDefault}
          onSaved={() => {
            setChanging(false);
            void refreshOllama();
          }}
        />
      )}
      {admin && view !== undefined && !changing && (
        <div className="row">
          <button type="button" onClick={() => setChanging(true)}>
            {text.ollama.change}
          </button>
          {view.source === INTEGRATION_SOURCES.dashboard && (
            <button type="button" className="quiet" disabled={useEnvironment.isPending} onClick={confirmUseEnvironment}>
              {text.ollama.useEnvironment}
            </button>
          )}
        </div>
      )}
      {view !== undefined && !changing && <OllamaServers admin={admin} defaults={view} />}
      {asking.question}
      <ErrorNotice error={ollama.error ?? settings.error ?? useEnvironment.error} />
    </section>
  );
}
