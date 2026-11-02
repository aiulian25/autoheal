import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type OllamaServerModel,
  type OllamaServerView,
  type OllamaServersView,
} from "../../../src/shared/api.js";
import {
  MINIMUM_OLLAMA_CONTEXT_TOKENS,
  OLLAMA_MAXIMUM_CONTEXT_TOKENS,
  OLLAMA_MODEL_NAME_LIMIT,
  OLLAMA_SERVER_NAME_LIMIT,
  sizeText,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import {
  enrolledHostsQuery,
  homeAssistantQuery,
  ollamaQuery,
  ollamaServersQuery,
  ollamaSettingsQuery,
  routerSettingsQuery,
} from "../queries.js";

const text = TEXT.settingsPage.ollama;

export interface ServerFields {
  name?: string;
  url: string;
  model: string;
  contextTokens: number;
}

/** Each model that Ollama has, as a choice: what it weighs, and whether it is the one in use or in memory now. */
export function ModelChoices({
  name,
  models,
  chosen,
  inUse,
  disabled,
  onChoose,
}: {
  name: string;
  models: readonly OllamaServerModel[];
  chosen: string;
  inUse: string;
  disabled: boolean;
  onChoose: (model: string) => void;
}) {
  return (
    <div className="model-choices" role="radiogroup" aria-label={text.modelsLabel}>
      {models.map((model) => {
        const about = [sizeText(model.sizeBytes), model.parameterSize, model.quantization].filter(
          (part) => part !== null,
        );
        return (
          <label key={model.name} className={model.name === chosen ? "model-choice chosen" : "model-choice"}>
            <input
              type="radio"
              name={name}
              value={model.name}
              checked={model.name === chosen}
              disabled={disabled}
              onChange={() => onChoose(model.name)}
            />
            <span className="mono">{model.name}</span>
            <span className="small muted">{about.join(TEXT.separator)}</span>
            {model.name === inUse && <span className="badge good">{text.inUse}</span>}
            {model.loaded && <span className="badge">{text.inMemory}</span>}
          </label>
        );
      })}
    </div>
  );
}

const askModelsAt = (url: string) => api<OllamaServerModel[]>("POST", API_ROUTES.ollamaSettingsModels, { url });

/** Where Autoheal asks, and what: Autoheal asks that Ollama first, and saves only what it can use. */
export function ServerForm({
  initial,
  named,
  nameOptional = false,
  submit,
  onSaved,
}: {
  initial: ServerFields;
  named: boolean;
  // The default can go on being called Default; a server beside it needs a name to be told apart by.
  nameOptional?: boolean;
  submit: (fields: ServerFields) => Promise<unknown>;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(initial.url);
  const [model, setModel] = useState(initial.model);
  const models = useQuery({
    queryKey: ["ollama-models-at", url],
    queryFn: () => askModelsAt(url),
    enabled: url !== "",
    retry: false,
    refetchOnWindowFocus: false,
  });
  const listed = models.data ?? [];
  // A new address's models: the one first listed is already picked, unless the one chosen is there too.
  useEffect(() => {
    const first = listed[0]?.name;
    if (first !== undefined && !listed.some(({ name }) => name === model)) setModel(first);
  }, [models.data]);
  const save = useMutation({ mutationFn: submit, onSuccess: onSaved });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    save.mutate({
      ...(named ? { name: String(values.get("name") ?? "").trim() } : {}),
      url: String(values.get("url") ?? "").trim(),
      model: model.trim(),
      contextTokens: Number(values.get("contextTokens")),
    });
  };
  return (
    <form className="settings-form" onSubmit={onSubmit}>
      {named && (
        <label>
          {text.serverName}
          {nameOptional && <span className="hint">{text.defaultNameHint}</span>}
          <input
            name="name"
            required={!nameOptional}
            maxLength={OLLAMA_SERVER_NAME_LIMIT}
            placeholder={nameOptional ? text.defaultNamePlaceholder : text.serverNamePlaceholder}
            defaultValue={initial.name ?? ""}
          />
        </label>
      )}
      <label>
        {text.address}
        <input
          name="url"
          type="url"
          required
          placeholder={text.addressPlaceholder}
          defaultValue={initial.url}
          onBlur={(event) => setUrl(event.target.value.trim())}
        />
      </label>
      <div className="settings-field">
        {text.model}
        {url !== "" && models.isPending && <Loading />}
        {listed.length > 0 && (
          <>
            <span className="hint">{text.modelHint}</span>
            <ModelChoices
              name={named ? `model-of-${initial.name ?? "new"}` : "model"}
              models={listed}
              chosen={model}
              inUse={url === initial.url ? initial.model : ""}
              disabled={save.isPending}
              onChoose={setModel}
            />
          </>
        )}
        {url !== "" && !models.isPending && listed.length === 0 && (
          <>
            <span className="hint">{text.noModels}</span>
            <input
              aria-label={text.model}
              required
              maxLength={OLLAMA_MODEL_NAME_LIMIT}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </>
        )}
        <ErrorNotice error={models.error} />
      </div>
      <label>
        {text.contextLabel}
        <span className="hint">{text.contextHint}</span>
        <input
          name="contextTokens"
          type="number"
          required
          min={MINIMUM_OLLAMA_CONTEXT_TOKENS}
          max={OLLAMA_MAXIMUM_CONTEXT_TOKENS}
          defaultValue={initial.contextTokens}
        />
      </label>
      <button className="primary" type="submit" disabled={save.isPending}>
        {save.isPending ? text.checking : text.save}
      </button>
      <ErrorNotice error={save.error} />
    </form>
  );
}

function useServersRefresh() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ollamaServersQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: ollamaQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: ollamaSettingsQuery.queryKey });
  };
}

/**
 * Something besides a host that a server can be given to watch, ticked in the same list. A new kind of machine goes in
 * `othersWatched` below, and its work asks for the server chosen here.
 */
interface WatchedThing {
  label: string;
  // Null is the default.
  serverId: string | null;
  busy: boolean;
  assign: (serverId: string | null) => void;
}

const serverPath = (serverId: string) => apiPath(API_ROUTES.ollamaServer, { serverId });

function ServerRow({
  server,
  hosts,
  others,
  admin,
  defaultLabel,
}: {
  server: OllamaServerView;
  hosts: readonly HostView[];
  // Whatever else it can watch besides hosts.
  others: readonly WatchedThing[];
  admin: boolean;
  // What the default is called, as a person reads it.
  defaultLabel: string;
}) {
  const refresh = useServersRefresh();
  const [changing, setChanging] = useState(false);
  const fields = { name: server.name, url: server.url, model: server.model, contextTokens: server.contextTokens };
  const answering = server.status.reachable;
  const loaded = new Set(server.status.loaded.map(({ name }) => name));
  const models = server.status.models.map((model) => ({ ...model, loaded: loaded.has(model.name) }));
  const putServer = (body: ServerFields) => api("PUT", serverPath(server.id), body);
  const pickModel = useMutation({
    mutationFn: (model: string) => putServer({ ...fields, model }),
    onSuccess: refresh,
  });
  const setHosts = useMutation({
    mutationFn: (hostIds: string[]) =>
      api("PUT", apiPath(API_ROUTES.ollamaServerHosts, { serverId: server.id }), { hostIds }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api("DELETE", serverPath(server.id)),
    onSuccess: refresh,
  });
  const labelsOn = hosts.filter(({ id }) => server.hostIds.includes(id)).map(({ label }) => label);
  const confirmRemove = () => {
    if (window.confirm(text.removeServerConfirm(server.name, labelsOn))) remove.mutate();
  };
  const toggleHost = (hostId: string) =>
    setHosts.mutate(
      server.hostIds.includes(hostId) ? server.hostIds.filter((each) => each !== hostId) : [...server.hostIds, hostId],
    );
  return (
    <section className="ollama-server" aria-label={server.name}>
      <header className="settings-card-head">
        <h4>{server.name}</h4>
        <span className={answering ? "badge good" : "badge danger"}>
          <span className="status-dot" />
          {answering ? TEXT.ollama.reachable : TEXT.ollama.unreachable}
        </span>
      </header>
      <p className="small">
        <span className="mono">{server.url}</span>
        {TEXT.separator}
        {text.contextTokens(server.contextTokens.toLocaleString())}
      </p>
      {!answering && server.status.checkedAt !== null && (
        <p className="notice warning small">{text.usingDefaultForNow(defaultLabel)}</p>
      )}
      {server.plainHttp && (
        <p className="settings-warning">
          <Icon name="lockOpen" />
          {text.plainHttp}
        </p>
      )}
      {!changing && models.length > 0 && (
        <ModelChoices
          name={`model-of-${server.id}`}
          models={models}
          chosen={pickModel.isPending ? pickModel.variables : server.model}
          inUse={server.model}
          disabled={!admin || pickModel.isPending}
          onChoose={(model) => pickModel.mutate(model)}
        />
      )}
      {!changing && (
        <div className="settings-field">
          <span className="small muted">{text.watches}</span>
          <div className="host-ticks">
            {hosts.map((host) => (
              <label key={host.id} className="host-tick">
                <input
                  type="checkbox"
                  checked={server.hostIds.includes(host.id)}
                  disabled={!admin || setHosts.isPending}
                  onChange={() => toggleHost(host.id)}
                />
                {host.label}
              </label>
            ))}
            {others.map((thing) => (
              <label key={thing.label} className="host-tick">
                <input
                  type="checkbox"
                  checked={thing.serverId === server.id}
                  disabled={!admin || thing.busy}
                  onChange={() => thing.assign(thing.serverId === server.id ? null : server.id)}
                />
                {thing.label}
              </label>
            ))}
          </div>
          <span className="small muted">{text.watchesNote(defaultLabel)}</span>
        </div>
      )}
      {changing && (
        <ServerForm
          initial={fields}
          named
          submit={putServer}
          onSaved={() => {
            setChanging(false);
            void refresh();
          }}
        />
      )}
      {admin && !changing && (
        <div className="row">
          <button type="button" onClick={() => setChanging(true)}>
            {text.change}
          </button>
          <button type="button" className="quiet danger" disabled={remove.isPending} onClick={confirmRemove}>
            {text.removeServer}
          </button>
        </div>
      )}
      <ErrorNotice error={pickModel.error ?? setHosts.error ?? remove.error} />
    </section>
  );
}

/** The servers beside the default, in the Ollama card. With none, only the way to add one shows. */
export function OllamaServers({
  admin,
  defaults,
}: {
  admin: boolean;
  defaults: { url: string; model: string; contextTokens: number };
}) {
  const refresh = useServersRefresh();
  const view = useQuery(ollamaServersQuery);
  const hosts = useQuery(enrolledHostsQuery);
  const homeAssistant = useQuery(homeAssistantQuery);
  // Its details are for admins, so a viewer simply does not see its tick.
  const router = useQuery({ ...routerSettingsQuery, enabled: admin });
  const [adding, setAdding] = useState(false);
  const chooseRouter = useMutation({
    mutationFn: (serverId: string | null) => api("PUT", API_ROUTES.ollamaRouterServer, { serverId }),
    onSuccess: async () => {
      await refresh();
      await router.refetch();
    },
  });
  const chooseReview = useMutation({
    mutationFn: (serverId: string | null) => api("PUT", API_ROUTES.ollamaReviewServer, { serverId }),
    onSuccess: refresh,
  });
  const data: OllamaServersView = view.data ?? {
    extras: [],
    reviewServerId: null,
    routerServerId: null,
    defaultName: null,
  };
  const allHosts = hosts.data ?? [];
  const assigned = new Set(data.extras.flatMap(({ hostIds }) => hostIds));
  const othersWatched: WatchedThing[] = [
    ...(homeAssistant.data?.status?.configured === true
      ? [
          {
            label: text.homeAssistant,
            serverId: data.reviewServerId,
            busy: chooseReview.isPending,
            assign: (serverId: string | null) => chooseReview.mutate(serverId),
          },
        ]
      : []),
    ...(router.data?.configured === true
      ? [
          {
            label: text.router,
            serverId: data.routerServerId,
            busy: chooseRouter.isPending,
            assign: (serverId: string | null) => chooseRouter.mutate(serverId),
          },
        ]
      : []),
  ];
  const onDefault = [
    ...allHosts.filter(({ id }) => !assigned.has(id)).map(({ label }) => label),
    ...othersWatched.filter(({ serverId }) => serverId === null).map(({ label }) => label),
  ];
  const hasExtras = data.extras.length > 0;
  const defaultLabel = data.defaultName ?? text.defaultServer;
  return (
    <div className="ollama-servers">
      {hasExtras && (
        <p className="small muted">{text.defaultWatches(data.defaultName ?? text.defaultServerCapital, onDefault)}</p>
      )}
      {data.extras.map((server) => (
        <ServerRow
          key={server.id}
          server={server}
          hosts={allHosts}
          others={othersWatched}
          admin={admin}
          defaultLabel={defaultLabel}
        />
      ))}
      {admin && adding && (
        <ServerForm
          initial={{ name: "", url: "", model: "", contextTokens: defaults.contextTokens }}
          named
          submit={(fields) => api("POST", API_ROUTES.ollamaServers, fields)}
          onSaved={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
      {admin && (
        <button type="button" className={adding ? "quiet" : "add-container"} onClick={() => setAdding(!adding)}>
          {!adding && <Icon name="plus" />}
          {adding ? text.cancelAdd : text.addServer}
        </button>
      )}
      <ErrorNotice error={view.error ?? chooseReview.error ?? chooseRouter.error} />
    </div>
  );
}

/** Which server thinks for a host: worth saying only once there is more than one. */
export function HostOllamaFact({ hostId }: { hostId: string }) {
  const view = useQuery(ollamaServersQuery);
  const extras = view.data?.extras ?? [];
  if (extras.length === 0) return null;
  const server = extras.find(({ hostIds }) => hostIds.includes(hostId));
  const defaultLabel = view.data?.defaultName ?? text.defaultServer;
  return (
    <p className="small muted">
      {text.hostUses(server?.name ?? defaultLabel)}
      {server !== undefined && !server.status.reachable && ` ${text.hostFallingBack(defaultLabel)}`}
    </p>
  );
}
