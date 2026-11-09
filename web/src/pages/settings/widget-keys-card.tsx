import { useAskInPlace } from "../../components/ask-in-place.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent } from "react";
import { API_ROUTES, apiPath, type CreatedWidgetKeyView, type WidgetKeyView } from "../../../../src/shared/api.js";
import { WIDGET_KEY_SCOPE, WIDGET_KEY_SCOPES, type WidgetKeyScope } from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { ErrorNotice, PlainText } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { timeAgo } from "../../format.js";

const text = TEXT.settingsPage;

export function WidgetKeysCard({ publicBaseUrl }: { publicBaseUrl: string }) {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
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
    asking.confirm(TEXT.widgetKeys.revokeConfirm(key.name), () => revoke.mutate(key.id));
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
      {asking.question}
      <ErrorNotice error={keys.error ?? create.error ?? revoke.error} />
    </section>
  );
}
