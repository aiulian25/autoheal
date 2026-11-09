import { useAskInPlace } from "../../components/ask-in-place.js";
import { notificationHealth } from "../../components/notification-health.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES, apiPath, type IntegrationTestView, type IntegrationView } from "../../../../src/shared/api.js";
import {
  INTEGRATION_KIND,
  INTEGRATION_SOURCES,
  INTEGRATION_TOKEN_REQUIRED,
  NOTIFICATION_KINDS,
  NTFY_TOPIC_PATTERN,
  WEBHOOK_FORMAT,
  WEBHOOK_FORMATS,
  type IntegrationKind,
  type WebhookFormat,
} from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { ErrorNotice } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { homeAssistantQuery, integrationsQuery } from "../../queries.js";
import { refreshSettingsNotice } from "./refresh-settings-notice.js";

const text = TEXT.settingsPage;

const integrationPath = (kind: IntegrationKind) => apiPath(API_ROUTES.integration, { kind });

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

export function HomeAssistantCard({ view, admin }: { view: IntegrationView; admin: boolean }) {
  const homeAssistant = useQuery(homeAssistantQuery);
  const asking = useAskInPlace();
  const { remove } = useIntegration(view.kind);
  const [changing, setChanging] = useState(false);
  const configured = view.source !== null;
  const status = homeAssistant.data?.status;
  const connected = status?.connected === true;
  const editable = admin && view.source !== INTEGRATION_SOURCES.environment;
  const confirmRemove = () => {
    asking.confirm(TEXT.services.removeConfirm(TEXT.services.names[view.kind]), () => remove.mutate());
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
      {asking.question}
      <ErrorNotice error={remove.error} />
    </section>
  );
}

// --- Notifications: each channel on its row ----------------------------------------------------------

export function ChannelRow({ view, admin }: { view: IntegrationView; admin: boolean }) {
  const { remove, test } = useIntegration(view.kind);
  const asking = useAskInPlace();
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
    asking.confirm(TEXT.services.removeConfirm(name), () => remove.mutate());
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
      {asking.question}
      <ErrorNotice error={remove.error ?? test.error} />
    </li>
  );
}

export const isChannel = (view: IntegrationView) => (NOTIFICATION_KINDS as readonly string[]).includes(view.kind);
