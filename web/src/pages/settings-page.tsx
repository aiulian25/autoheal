import { ContainerBackupSettings } from "./container-backup-settings.js";
import { NotificationRoutingEditor } from "../components/notification-deliveries.js";
import { notificationHealth } from "../components/notification-health.js";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type AccountView,
  type CreatedWidgetKeyView,
  type DataView,
  type HostUpdateSettingsView,
  type IntegrationTestView,
  type IntegrationView,
  type OllamaModelFacts,
  type OllamaServerModel,
  type SelfUpdateView,
  type SettingsView,
  type TrustedProxiesView,
  type WidgetKeyView,
} from "../../../src/shared/api.js";
import {
  BACKUP_INTERVAL_MILLISECONDS,
  DETECTOR_INTERVAL_MILLISECONDS,
  INTEGRATION_KIND,
  INTEGRATION_SOURCES,
  INTEGRATION_TOKEN_REQUIRED,
  INTEGRITY_OK,
  METRICS_HISTORY_MILLISECONDS,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
  NOTIFICATION_KINDS,
  NTFY_TOPIC_PATTERN,
  SECRET_SOURCES,
  SELF_UPDATE_FINAL,
  SELF_UPDATE_STATUS,
  UPDATE_CHECK_INTERVAL_MILLISECONDS,
  WEBHOOK_FORMAT,
  WEBHOOK_FORMATS,
  WIDGET_KEY_SCOPE,
  WIDGET_KEY_SCOPES,
  wordsOf,
  type IntegrationKind,
  type WebhookFormat,
  type WidgetKeyScope,
} from "../../../src/shared/constants.js";
import { JarvisCard } from "./jarvis-card.js";
import { RouterCard } from "./router-card.js";
import { ModelChoices, OllamaServers, ServerForm, type ServerFields } from "./ollama-servers.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading, PlainText } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { SettingsFrame, useScrollToHash, type SettingsSection } from "../components/section-tabs.js";
import {
  JOB_REFRESH_MILLISECONDS,
  MILLISECONDS_PER_HOUR,
  PATHS,
  REFRESH_MILLISECONDS,
  SETTINGS_SECTIONS,
  TEXT,
} from "../constants.js";
import { bytes, dateTime, shortImageId, timeAgo, wholeNumber } from "../format.js";
import {
  backupsQuery,
  homeAssistantQuery,
  hostUpdatesQuery,
  integrationsQuery,
  ollamaQuery,
  ollamaServersQuery,
  ollamaSettingsQuery,
  selfUpdateQuery,
  settingsQuery,
} from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { SshKeysCard } from "./ssh-keys-card.js";

const text = TEXT.settingsPage;
const integrationPath = (kind: IntegrationKind) => apiPath(API_ROUTES.integration, { kind });
const numbers = new Intl.NumberFormat();

function refreshSettingsNotice(queryClient: QueryClient) {
  if (queryClient.getQueryData<SettingsView>(settingsQuery.queryKey)?.invalidSettings?.length)
    return queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
  return Promise.resolve();
}

function SettingsBlock({
  section,
  children,
}: {
  section: Exclude<SettingsSection, typeof SETTINGS_SECTIONS.account>;
  children: ReactNode;
}) {
  const { title, lede } = text.sections[section];
  return (
    <section id={section} className="settings-block" aria-labelledby={`${section}-title`}>
      <h2 id={`${section}-title`}>{title}</h2>
      <p className="settings-lede">{lede}</p>
      {children}
    </section>
  );
}

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

function OllamaCard({ admin }: { admin: boolean }) {
  const queryClient = useQueryClient();
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
    if (window.confirm(text.ollama.useEnvironmentConfirm)) {
      useEnvironment.mutate();
    }
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
      <ErrorNotice error={ollama.error ?? settings.error ?? useEnvironment.error} />
    </section>
  );
}

/** Saving, testing and removing one integration: Home Assistant, Gotify, ntfy or a webhook. */
function useIntegration(kind: IntegrationKind) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: integrationsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: homeAssistantQuery.queryKey });
    await refreshSettingsNotice(queryClient);
  };
  const save = useMutation({
    mutationFn: (body: { url: string; topic?: string; token?: string; format?: WebhookFormat }) =>
      api("PUT", integrationPath(kind), body),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => api("DELETE", integrationPath(kind)), onSuccess: refresh });
  const test = useMutation({
    mutationFn: () => api<IntegrationTestView>("POST", apiPath(API_ROUTES.integrationTest, { kind })),
    onMutate: () => queryClient.getQueryState(integrationsQuery.queryKey),
    onSuccess: async (result, _variables, snapshot) => {
      // A delayed test response must not attach observations to an edited/refreshed configuration.
      if (
        result.delivery !== undefined &&
        snapshot !== undefined &&
        queryClient.getQueryState(integrationsQuery.queryKey) === snapshot
      )
        queryClient.setQueryData<IntegrationView[]>(integrationsQuery.queryKey, (views) =>
          views?.map((view) => (view.kind === kind ? { ...view, delivery: result.delivery } : view)),
        );
      await queryClient.invalidateQueries({ queryKey: integrationsQuery.queryKey });
    },
  });
  return { save, remove, test };
}

// A webhook's address never comes back, so its host stands in for it; Home Assistant's shows its form.
function addressPlaceholder(view: IntegrationView): string {
  if (view.kind === INTEGRATION_KIND.webhook) {
    return view.url ?? "";
  }
  if (view.kind === INTEGRATION_KIND.homeAssistant) {
    return text.homeAssistant.addressPlaceholder;
  }
  return "";
}

/** Where it is, a topic for ntfy, a format for a webhook, and a token: kept when left empty, never shown again. */
function IntegrationForm({
  view,
  submitLabel,
  tokenLabel,
  tokenHint,
  onSaved,
}: {
  view: IntegrationView;
  submitLabel: string;
  tokenLabel: string;
  tokenHint: string;
  onSaved?: () => void;
}) {
  const { save } = useIntegration(view.kind);
  const webhook = view.kind === INTEGRATION_KIND.webhook;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const token = String(values.get("token") ?? "").trim();
    const topic = String(values.get("topic") ?? "").trim();
    const format = String(values.get("format")) as WebhookFormat;
    save.mutate(
      {
        url: String(values.get("url") ?? "").trim(),
        ...(view.kind === INTEGRATION_KIND.ntfy ? { topic } : {}),
        ...(webhook ? { format } : {}),
        ...(token === "" ? {} : { token }),
      },
      {
        onSuccess: () => {
          form.reset();
          onSaved?.();
        },
      },
    );
  };
  const tokenNeeded = INTEGRATION_TOKEN_REQUIRED[view.kind] && !view.tokenSet;
  return (
    <form className="settings-form" onSubmit={submit}>
      <label>
        {TEXT.services.address}
        {webhook && <span className="hint">{TEXT.services.webhook.addressHint}</span>}
        <input
          name="url"
          type="url"
          required
          defaultValue={webhook ? "" : (view.url ?? "")}
          placeholder={addressPlaceholder(view)}
        />
      </label>
      {webhook && (
        <label>
          {TEXT.services.webhook.format}
          <select name="format" defaultValue={view.format ?? WEBHOOK_FORMAT.json}>
            {WEBHOOK_FORMATS.map((format) => (
              <option key={format} value={format}>
                {TEXT.services.webhook.formats[format]}
              </option>
            ))}
          </select>
        </label>
      )}
      {view.kind === INTEGRATION_KIND.ntfy && (
        <label>
          {TEXT.services.topic}
          <input name="topic" required pattern={NTFY_TOPIC_PATTERN.source} defaultValue={view.topic ?? ""} />
        </label>
      )}
      <label>
        {tokenLabel}
        <span className="hint">{tokenHint}</span>
        <input
          name="token"
          type="password"
          autoComplete="off"
          required={tokenNeeded}
          placeholder={view.tokenSet ? TEXT.services.tokenKept : ""}
        />
      </label>
      <button className="primary" type="submit" disabled={save.isPending}>
        {submitLabel}
      </button>
      <ErrorNotice error={save.error} />
    </form>
  );
}

function HomeAssistantCard({ view, admin }: { view: IntegrationView; admin: boolean }) {
  const homeAssistant = useQuery(homeAssistantQuery);
  const { remove } = useIntegration(view.kind);
  const [changing, setChanging] = useState(false);
  const configured = view.source !== null;
  const status = homeAssistant.data?.status;
  const connected = status?.connected === true;
  const editable = admin && view.source !== INTEGRATION_SOURCES.environment;
  const confirmRemove = () => {
    if (window.confirm(TEXT.services.removeConfirm(TEXT.services.names[view.kind]))) {
      remove.mutate();
    }
  };
  return (
    <section className={configured ? "card settings-card" : "card settings-card dashed"} aria-labelledby="ha-title">
      <header className="settings-card-head">
        <h3 id="ha-title">{TEXT.services.names.homeAssistant}</h3>
        {configured ? (
          <span className={connected ? "badge good" : "badge danger"}>
            <span className="status-dot" />
            {connected ? TEXT.nav.homeAssistant.connected : TEXT.nav.homeAssistant.notAnswering}
          </span>
        ) : (
          <span className="small muted">{TEXT.attention.homeAssistant.notConnected}</span>
        )}
      </header>
      <p className="settings-card-text">{text.homeAssistant.explanation}</p>
      {configured && (
        <p className="mono small muted">
          {view.url}
          {view.tokenSet ? `${TEXT.separator}${TEXT.services.tokenSet}` : ""}
        </p>
      )}
      {view.source === INTEGRATION_SOURCES.environment && (
        <p className="small muted">{TEXT.services.fromEnvironment}</p>
      )}
      {status !== undefined && !connected && status.error !== null && (
        <p className="notice warning small">{TEXT.services.notConnected(status.error)}</p>
      )}
      {editable && (!configured || changing) && (
        <IntegrationForm
          view={view}
          submitLabel={text.homeAssistant.connect}
          tokenLabel={text.homeAssistant.token}
          tokenHint={text.homeAssistant.tokenHint}
          onSaved={() => setChanging(false)}
        />
      )}
      {editable && configured && !changing && (
        <div className="row">
          <button type="button" onClick={() => setChanging(true)}>
            {text.homeAssistant.change}
          </button>
          <button type="button" className="quiet danger" onClick={confirmRemove}>
            {TEXT.services.remove}
          </button>
        </div>
      )}
      <ErrorNotice error={remove.error} />
    </section>
  );
}

// --- Notifications: each channel on its row ----------------------------------------------------------

function ChannelRow({ view, admin }: { view: IntegrationView; admin: boolean }) {
  const { remove, test } = useIntegration(view.kind);
  const [open, setOpen] = useState(false);
  const name = TEXT.services.names[view.kind];
  const configured = view.source !== null;
  const health = notificationHealth(view.delivery);
  const editable = admin && view.source !== INTEGRATION_SOURCES.environment;
  const detail = [
    view.url,
    view.topic,
    view.format === null ? null : TEXT.services.webhook.shortFormats[view.format],
    view.tokenSet ? TEXT.services.tokenSet : null,
  ]
    .filter((part) => part !== null)
    .join(TEXT.separator);
  const confirmRemove = () => {
    if (window.confirm(TEXT.services.removeConfirm(name))) {
      remove.mutate();
    }
  };
  return (
    <li className="channel">
      <div className="channel-row">
        <span className={configured ? "status-dot tone-good" : "status-dot off"} />
        <span className="channel-what">
          <strong>{name}</strong>
          {configured ? (
            <span className="mono small muted">{detail}</span>
          ) : (
            <span className="muted">{text.channels.notSetUp}</span>
          )}
        </span>
        {editable && configured && (
          <span className="channel-actions">
            <button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
              {TEXT.services.test}
            </button>
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? text.channels.cancel : text.channels.change}
            </button>
            <button type="button" className="quiet danger" onClick={confirmRemove}>
              {TEXT.services.remove}
            </button>
          </span>
        )}
        {editable && !configured && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? text.channels.cancel : text.channels.setUp(name)}
          </button>
        )}
      </div>
      {view.source === INTEGRATION_SOURCES.environment && (
        <p className="small muted">{TEXT.services.fromEnvironment}</p>
      )}
      {view.plainHttp && <p className="notice warning small">{TEXT.services.plainHttp(name)}</p>}
      {configured && (
        <p
          className={health.tone === "danger" ? "notice error small" : "small muted"}
          role="status"
          title={health.detail}
        >
          {health.text}
        </p>
      )}
      {open && (
        <IntegrationForm
          view={view}
          submitLabel={TEXT.services.save}
          tokenLabel={INTEGRATION_TOKEN_REQUIRED[view.kind] ? TEXT.services.token : TEXT.services.tokenOptional}
          tokenHint={TEXT.services.tokenHints[view.kind]}
          onSaved={() => setOpen(false)}
        />
      )}
      <ErrorNotice error={remove.error ?? test.error} />
    </li>
  );
}

const isChannel = (view: IntegrationView) => (NOTIFICATION_KINDS as readonly string[]).includes(view.kind);

// --- Schedules ---------------------------------------------------------------------------------------

const WINDOW_FIELDS = { start: "windowStart", end: "windowEnd", security: "securityInWindow" } as const;

/** Each host's nightly window, and whether security fixes go in on their own: saved as soon as changed. */
function PackageWindowCard({ admin }: { admin: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery(hostUpdatesQuery);
  const save = useMutation({
    // One save after another, each on top of what the last one kept: a quick move from From to To keeps both.
    scope: { id: API_ROUTES.hostUpdateSettings },
    mutationFn: (changed: Partial<HostUpdateSettingsView>) => {
      const kept = queryClient.getQueryData<HostUpdateSettingsView>(hostUpdatesQuery.queryKey);
      return api<HostUpdateSettingsView>("PUT", API_ROUTES.hostUpdateSettings, { ...kept, ...changed });
    },
    onSuccess: (view) => {
      queryClient.setQueryData(hostUpdatesQuery.queryKey, view);
      void queryClient.invalidateQueries({ queryKey: ["host-packages"] });
      void refreshSettingsNotice(queryClient);
    },
  });
  const current = settings.data;
  return (
    <section className="card settings-card" aria-labelledby="window-title">
      <h3 id="window-title">{text.window.title}</h3>
      <p className="settings-card-text small">{text.window.explanation}</p>
      {current === undefined && <Loading />}
      {current !== undefined && (
        <>
          <div className="window-times">
            <label>
              {text.window.from}
              <input
                type="time"
                name={WINDOW_FIELDS.start}
                defaultValue={current.windowStart}
                disabled={!admin}
                required
                onBlur={(event) =>
                  event.target.value !== current.windowStart && save.mutate({ windowStart: event.target.value })
                }
              />
            </label>
            <label>
              {text.window.to}
              <input
                type="time"
                name={WINDOW_FIELDS.end}
                defaultValue={current.windowEnd}
                disabled={!admin}
                required
                onBlur={(event) =>
                  event.target.value !== current.windowEnd && save.mutate({ windowEnd: event.target.value })
                }
              />
            </label>
          </div>
          <label className="choice-option security-fixes">
            <input
              type="checkbox"
              name={WINDOW_FIELDS.security}
              defaultChecked={current.securityInWindow}
              disabled={!admin}
              onChange={(event) => save.mutate({ securityInWindow: event.target.checked })}
            />
            <span className="choice-words">{text.window.securityFixes}</span>
          </label>
        </>
      )}
      {save.isSuccess && <span className="small saved-note">{TEXT.hostControl.saved}</span>}
      <ErrorNotice error={save.error ?? settings.error} />
    </section>
  );
}

function AlwaysRunningCard() {
  const always = text.always;
  return (
    <section className="card settings-card" aria-labelledby="always-title">
      <h3 id="always-title">{always.title}</h3>
      <dl className="settings-facts spread">
        <dt>{always.problemChecks}</dt>
        <dd>{always.everySeconds(DETECTOR_INTERVAL_MILLISECONDS / MILLISECONDS_PER_SECOND)}</dd>
        <dt>{always.imageChecks}</dt>
        <dd>{always.everyHours(UPDATE_CHECK_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR)}</dd>
        <dt>{always.liveStats}</dt>
        <dd>{always.minutes(METRICS_HISTORY_MILLISECONDS / MILLISECONDS_PER_MINUTE)}</dd>
        <dt>{always.databaseBackup}</dt>
        <dd>
          {BACKUP_INTERVAL_MILLISECONDS === MILLISECONDS_PER_DAY
            ? always.daily
            : always.everyHours(BACKUP_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR)}
        </dd>
      </dl>
    </section>
  );
}

// --- Backups -----------------------------------------------------------------------------------------

function BackupSummary({ settings }: { settings: SettingsView }) {
  const backups = useQuery(backupsQuery);
  const [showing, setShowing] = useState(false);
  const last = backups.data?.[0];
  const backup = text.backup;
  const kept = last?.offboxCopied === true ? backup.copiedOffbox : backup.onThisMachine;
  const title =
    last === undefined
      ? backup.none
      : `${backup.last(dateTime(last.createdAt))}${TEXT.separator}${last.integrityCheck === INTEGRITY_OK ? backup.verified : backup.notVerified}`;
  return (
    <>
      <div className="card settings-row">
        <div className="settings-row-what">
          <strong>{title}</strong>
          <span className="small muted">
            {backup.passphrase[settings.backupPassphrase]}
            {TEXT.separator}
            {kept}
          </span>
        </div>
        <Link to={PATHS.backups}>{backup.seeAll}</Link>
      </div>
      {settings.backupPassphrase === SECRET_SOURCES.autoheal && (
        <div className="small muted stack">
          <p>{TEXT.settings.passphraseAgain}</p>
          <pre className="log">{TEXT.settings.passphraseCommand}</pre>
        </div>
      )}
      {!settings.offboxBackupsConfigured && (
        <div className="card settings-row offbox">
          <p>{backup.noOffbox}</p>
          <button type="button" className="warm" aria-expanded={showing} onClick={() => setShowing(!showing)}>
            {backup.addOffbox}
          </button>
          {showing && (
            <p className="offbox-how small">
              {backup.offboxHowBefore}
              <code>{backup.offboxSetting}</code>
              {backup.offboxHowAfter}
            </p>
          )}
        </div>
      )}
      <ErrorNotice error={backups.error} />
    </>
  );
}

// --- Data --------------------------------------------------------------------------------------------

const keptOf = (kept: number | null) =>
  kept === null ? text.data.keptWhole : text.data.window(Math.round(kept / MILLISECONDS_PER_DAY));

// The database's size, then the last clean-up and how much it removed.
function dataLine(view: DataView): string {
  const words = text.data;
  const size = words.size(bytes(view.bytes));
  if (view.lastSweep === null) {
    return [size, words.notCleaned].join(TEXT.separator);
  }
  return [
    size,
    `${words.cleaned} ${timeAgo(view.lastSweep.at)}`,
    words.removed(wholeNumber(view.lastSweep.removed)),
  ].join(TEXT.separator);
}

// What the database holds, and how long it keeps each kind of record: its growth followed without SQL.
function DataCard() {
  const data = useQuery({
    queryKey: ["data-housekeeping"],
    queryFn: () => api<DataView>("GET", API_ROUTES.dataHousekeeping),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  const words = text.data;
  const view = data.data;
  return (
    <>
      <section className="card settings-card" aria-labelledby="data-title">
        <h3 id="data-title">{words.title}</h3>
        <p className="settings-card-text small">{words.explanation}</p>
        {view === undefined ? <Loading /> : <p className="small muted">{dataLine(view)}</p>}
        <ErrorNotice error={data.error} />
      </section>
      {view !== undefined && (
        <dl className="card system-grid" aria-label={words.title}>
          {view.kinds.map((kind) => (
            <div key={kind.kind}>
              <dt>{`${words.kinds[kind.kind]}${TEXT.separator}${keptOf(kind.keptMilliseconds)}`}</dt>
              <dd>{wholeNumber(kind.rows)}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

// --- People and keys ---------------------------------------------------------------------------------

function PeopleSummary() {
  const people = useQuery({ queryKey: ["users"], queryFn: () => api<AccountView[]>("GET", API_ROUTES.users) });
  const list = people.data ?? [];
  const byRole = new Map<string, number>();
  for (const person of list) {
    byRole.set(person.role, (byRole.get(person.role) ?? 0) + 1);
  }
  const roles = [...byRole.entries()]
    .map(([role, count]) => text.people.roles(count, wordsOf(role)))
    .join(TEXT.listComma);
  return (
    <div className="card settings-row">
      <p>
        <strong>{text.people.count(list.length)}</strong>
        {roles !== "" && <span className="muted">{`${TEXT.separator}${roles}`}</span>}
      </p>
      <Link to={PATHS.users}>{text.people.manage}</Link>
      <ErrorNotice error={people.error} />
    </div>
  );
}

function WidgetKeysCard({ publicBaseUrl }: { publicBaseUrl: string }) {
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ["widget-keys"],
    queryFn: () => api<WidgetKeyView[]>("GET", API_ROUTES.widgetKeys),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["widget-keys"] });
  const create = useMutation({
    mutationFn: (key: { name: string; scope: WidgetKeyScope }) =>
      api<CreatedWidgetKeyView>("POST", API_ROUTES.widgetKeys, key),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (keyId: string) => api("DELETE", apiPath(API_ROUTES.widgetKey, { keyId })),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    create.mutate({ name: String(values.get("name") ?? ""), scope: String(values.get("scope")) as WidgetKeyScope });
    event.currentTarget.reset();
  };
  const created = create.data;
  const confirmRevoke = (key: WidgetKeyView) => {
    if (window.confirm(TEXT.widgetKeys.revokeConfirm(key.name))) {
      revoke.mutate(key.id);
    }
  };
  return (
    <section className="card keys-card" aria-labelledby="keys-title">
      <div className="keys-head">
        <h3 id="keys-title">{text.keys.title}</h3>
        <p className="small muted">{text.keys.explanation}</p>
      </div>
      {created !== undefined && (
        <div className="notice warning stack keys-created" role="status">
          <strong>{TEXT.widgetKeys.created(created.key.name)}</strong>
          <span className="secret">{created.secret}</span>
          {created.key.scope === WIDGET_KEY_SCOPE.metrics ? (
            <>
              <span>{TEXT.widgetKeys.metricsIntro(publicBaseUrl)}</span>
              <PlainText text={TEXT.widgetKeys.metricsSnippet(publicBaseUrl, created.secret)} />
            </>
          ) : (
            <>
              <span>{TEXT.widgetKeys.snippetIntro}</span>
              <PlainText text={TEXT.widgetKeys.snippet(publicBaseUrl, created.secret)} />
            </>
          )}
        </div>
      )}
      {keys.data?.map((key) => (
        <div key={key.id} className="key-row">
          <span className="mono">{key.name}</span>
          <span className="small muted">
            {text.keys.shortScopes[key.scope]}
            {TEXT.separator}
            {key.lastUsedAt === null ? text.keys.neverUsed : text.keys.lastUsed(timeAgo(key.lastUsedAt))}
          </span>
          <button className="quiet danger" type="button" onClick={() => confirmRevoke(key)}>
            {TEXT.widgetKeys.revoke}
          </button>
        </div>
      ))}
      <form className="key-form" onSubmit={submit}>
        <label>
          {text.keys.newName}
          <span className="key-form-row">
            <input name="name" required />
            <select name="scope" aria-label={text.keys.reads} defaultValue={WIDGET_KEY_SCOPE.widget}>
              {WIDGET_KEY_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {text.keys.scopes[scope]}
                </option>
              ))}
            </select>
            <button type="submit" disabled={create.isPending}>
              {text.keys.create}
            </button>
          </span>
        </label>
      </form>
      <ErrorNotice error={keys.error ?? create.error ?? revoke.error} />
    </section>
  );
}

// --- System ------------------------------------------------------------------------------------------

function SystemFacts({ settings }: { settings: SettingsView }) {
  const facts = text.systemFacts;
  const rows: { label: string; value: string; mono: boolean }[] = [
    { label: facts.version, value: settings.version, mono: true },
    { label: facts.address, value: settings.publicBaseUrl, mono: true },
    { label: facts.certificate, value: TEXT.settings.madeBy.certificate[settings.certificate], mono: false },
    { label: facts.proxies, value: settings.trustedProxies.addresses.join(TEXT.listComma) || TEXT.none, mono: true },
    { label: facts.passphrase, value: TEXT.settings.madeBy.passphrase[settings.backupPassphrase], mono: false },
    {
      label: facts.offbox,
      value: settings.offboxBackupsConfigured ? TEXT.settings.configured : TEXT.settings.notConfigured,
      mono: false,
    },
  ];
  return (
    <dl className="card system-grid">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.mono ? "mono" : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// While an update goes on, it is read again every few seconds; the dashboard may be away for a moment meanwhile.
function updating(view: SelfUpdateView | undefined): boolean {
  const last = view?.last ?? null;
  return last !== null && !SELF_UPDATE_FINAL.includes(last.status) && last.status !== SELF_UPDATE_STATUS.blocked;
}

/** Autoheal updating itself, on the machine it runs on: the image it would run, and how the last update went. */
function SelfUpdateCard() {
  const queryClient = useQueryClient();
  const status = useQuery({
    ...selfUpdateQuery,
    refetchInterval: (query) => (updating(query.state.data) ? JOB_REFRESH_MILLISECONDS : false),
  });
  const start = useMutation({
    mutationFn: () => api<SelfUpdateView>("POST", API_ROUTES.selfUpdate),
    onSuccess: (view) => queryClient.setQueryData(selfUpdateQuery.queryKey, view),
  });
  const view = status.data;
  const words = text.selfUpdate;
  if (view === undefined) {
    return <ErrorNotice error={status.error} />;
  }
  const last = view.last;
  return (
    <section className="card stack" aria-labelledby="self-update-title">
      <h3 id="self-update-title">{words.title}</h3>
      {view.unavailable !== null && <p className="small muted">{view.unavailable}</p>}
      {view.unavailable === null && (
        <>
          <p className="small muted">{words.explanation(view.reference)}</p>
          {view.runningImage !== null && <p className="small mono">{words.runs(shortImageId(view.runningImage))}</p>}
          <button
            type="button"
            className="primary"
            disabled={start.isPending || updating(view)}
            onClick={() => start.mutate()}
          >
            {words.update}
          </button>
        </>
      )}
      <ErrorNotice error={start.error} />
      {last !== null && (
        <p className="small" role="status">
          {words.last}
          {TEXT.separator}
          {timeAgo(last.finishedAt ?? last.startedAt)}
          {TEXT.separator}
          {last.message}
        </p>
      )}
    </section>
  );
}

// How the person's own request came in: straight from their browser, through a proxy Autoheal does not
// trust yet, or through one it trusts.
function arrivalLine(view: TrustedProxiesView): string {
  const proxies = text.proxies;
  if (view.forwardedFor === null) {
    return proxies.direct(view.peer);
  }
  return view.seenAs === view.peer
    ? proxies.notTrusted(view.peer, view.forwardedFor)
    : proxies.trusted(view.peer, view.seenAs);
}

// The proxy this request came through, when Autoheal does not take its word yet: the one to offer trusting.
const untrustedProxyOf = (view: TrustedProxiesView) =>
  view.forwardedFor !== null && view.seenAs === view.peer ? view.peer : null;

function TrustedProxiesCard({ view }: { view: TrustedProxiesView }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    // One change after another, each on top of the list the last one kept: two quick ones keep each other.
    scope: { id: API_ROUTES.trustedProxies },
    mutationFn: (change: (addresses: string[]) => string[]) => {
      const kept = queryClient.getQueryData<SettingsView>(settingsQuery.queryKey)?.trustedProxies.addresses ?? [];
      return api<TrustedProxiesView>("PUT", API_ROUTES.trustedProxies, { addresses: change(kept) });
    },
    onSuccess: (trustedProxies) => {
      queryClient.setQueryData<SettingsView>(
        settingsQuery.queryKey,
        (settings) => settings && { ...settings, trustedProxies },
      );
      void refreshSettingsNotice(queryClient);
    },
  });
  const proxies = text.proxies;
  const fixed = view.source === INTEGRATION_SOURCES.environment;
  const offered = fixed ? null : untrustedProxyOf(view);
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entry = String(new FormData(event.currentTarget).get("address") ?? "").trim();
    save.mutate((addresses) => [...addresses, entry]);
    event.currentTarget.reset();
  };
  return (
    <section className="card keys-card" aria-labelledby="proxies-title">
      <div className="keys-head">
        <h3 id="proxies-title">{proxies.title}</h3>
        <p className="small muted">{proxies.explanation}</p>
      </div>
      <div className="key-row">
        <span className="arrival small">{arrivalLine(view)}</span>
        {offered !== null && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate((addresses) => [...addresses, offered])}
          >
            {proxies.trust(offered)}
          </button>
        )}
      </div>
      {view.addresses.map((address) => (
        <div key={address} className="key-row">
          <span className="mono">{address}</span>
          {!fixed && (
            <button
              className="quiet danger"
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate((addresses) => addresses.filter((other) => other !== address))}
            >
              {proxies.remove}
            </button>
          )}
        </div>
      ))}
      {fixed ? (
        <p className="key-form small muted">{proxies.fromEnvironment}</p>
      ) : (
        <form className="key-form" onSubmit={add}>
          <label>
            {proxies.newAddress}
            <span className="key-form-row">
              <input name="address" required placeholder={proxies.placeholder} />
              <button type="submit" disabled={save.isPending}>
                {proxies.add}
              </button>
            </span>
          </label>
        </form>
      )}
      <ErrorNotice error={save.error} />
    </section>
  );
}

/** Everything Autoheal is set up with, one section under the other, the sections down the side. */
export function SettingsPage() {
  const admin = isAdmin(useSignedInSession());
  const settings = useQuery(settingsQuery);
  const integrations = useQuery(integrationsQuery);
  useScrollToHash(settings.data !== undefined && integrations.data !== undefined);
  const view = settings.data;
  const homeAssistant = integrations.data?.find((integration) => integration.kind === INTEGRATION_KIND.homeAssistant);
  return (
    <SettingsFrame current={null}>
      {view === undefined && (settings.error ? <ErrorNotice error={settings.error} /> : <Loading />)}
      {view !== undefined && (
        <>
          {admin && view.invalidSettings !== undefined && view.invalidSettings.length > 0 && (
            <p className="notice warning" role="status">
              {text.invalidSettings(view.invalidSettings.map((key) => text.settingNames[key]).join(TEXT.listComma))}
            </p>
          )}
          <SettingsBlock section={SETTINGS_SECTIONS.connections}>
            <OllamaCard admin={admin} />
            {homeAssistant !== undefined && <HomeAssistantCard view={homeAssistant} admin={admin} />}
            {admin && <RouterCard />}
            {admin && <JarvisCard />}
          </SettingsBlock>
          <SettingsBlock section={SETTINGS_SECTIONS.notifications}>
            <NotificationRoutingEditor admin={admin} />
            <ul className="card channels">
              {integrations.data?.filter(isChannel).map((channel) => (
                <ChannelRow key={channel.kind} view={channel} admin={admin} />
              ))}
            </ul>
            <ErrorNotice error={integrations.error} />
          </SettingsBlock>
          <SettingsBlock section={SETTINGS_SECTIONS.schedules}>
            <PackageWindowCard admin={admin} />
            <AlwaysRunningCard />
          </SettingsBlock>
          {admin && (
            <SettingsBlock section={SETTINGS_SECTIONS.backups}>
              <BackupSummary settings={view} />
              <ContainerBackupSettings />
              <DataCard />
            </SettingsBlock>
          )}
          {admin && (
            <SettingsBlock section={SETTINGS_SECTIONS.people}>
              <PeopleSummary />
              <WidgetKeysCard publicBaseUrl={view.publicBaseUrl} />
              <SshKeysCard dashboardAddress={new URL(view.runnerAddress).hostname} />
            </SettingsBlock>
          )}
          <SettingsBlock section={SETTINGS_SECTIONS.system}>
            <SystemFacts settings={view} />
            {admin && <SelfUpdateCard />}
            {admin && <TrustedProxiesCard view={view.trustedProxies} />}
          </SettingsBlock>
        </>
      )}
    </SettingsFrame>
  );
}
