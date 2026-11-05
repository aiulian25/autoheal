import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { IMAGE_PROVENANCE } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "./common.js";
import { TEXT } from "../constants.js";
import { imageTrustQuery, type ImageTrustView } from "../queries.js";

const text = TEXT.provenance;

const scopeOf = (rule: { registry: string; repository: string | null }) =>
  rule.repository === null ? rule.registry : `${rule.registry}/${rule.repository}`;

/**
 * Who an admin trusts to publish an image, and where Autoheal waits for a signed one. Nothing here is secret: a
 * public key is what opens a signature, never what makes one.
 */
export function ImageTrustCard() {
  const queryClient = useQueryClient();
  const trust = useQuery(imageTrustQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: imageTrustQuery.queryKey });
  const addPublisher = useMutation({
    mutationFn: (body: { name: string; publicKey: string }) => api("POST", API_ROUTES.imageTrust, body),
    onSuccess: refresh,
  });
  const removePublisher = useMutation({
    mutationFn: (name: string) => api("DELETE", apiPath(API_ROUTES.imageTrustPublisher, { name })),
    onSuccess: refresh,
  });
  const addRule = useMutation({
    mutationFn: (body: { registry: string; repository: string | null; publishers: string[] }) =>
      api<{ id: string }>("POST", API_ROUTES.imageTrustRules, body),
    onSuccess: refresh,
  });
  const removeRule = useMutation({
    mutationFn: (ruleId: string) => api("DELETE", apiPath(API_ROUTES.imageTrustRule, { ruleId })),
    onSuccess: refresh,
  });
  const submitPublisher = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    addPublisher.mutate({
      name: String(form.get("name") ?? "").trim(),
      publicKey: String(form.get("publicKey") ?? "").trim(),
    });
    event.currentTarget.reset();
  };
  const submitRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    addRule.mutate({
      registry: String(form.get("registry") ?? "").trim(),
      repository: String(form.get("repository") ?? "").trim() || null,
      publishers: form.getAll("publishers").map(String),
    });
    event.currentTarget.reset();
  };
  const view: ImageTrustView | undefined = trust.data;
  const publishers = view?.publishers ?? [];
  const rules = view?.rules ?? [];
  return (
    <section className="card stack" aria-labelledby="image-trust-title">
      <div>
        <h3 id="image-trust-title">{text.title}</h3>
        <p className="small muted">{text.explanation}</p>
      </div>
      {view === undefined && (trust.error ? <ErrorNotice error={trust.error} /> : <Loading />)}
      {view !== undefined && publishers.length === 0 && <p className="muted">{text.none}</p>}
      {publishers.map((publisher) => (
        <div key={publisher.name} className="key-row">
          <span>{publisher.name}</span>
          <span className="small muted">{text.keyType(publisher.keyType)}</span>
          <button
            className="quiet danger"
            type="button"
            aria-label={text.removePublisherFor(publisher.name)}
            onClick={() => {
              if (window.confirm(text.removePublisherConfirm(publisher.name))) removePublisher.mutate(publisher.name);
            }}
          >
            {text.removePublisher}
          </button>
        </div>
      ))}
      <ErrorNotice error={addPublisher.error ?? removePublisher.error ?? addRule.error ?? removeRule.error} />
      <form className="step-form" onSubmit={submitPublisher} aria-label={text.addPublisher}>
        <h4>{text.addPublisher}</h4>
        <label>
          {text.publisherName}
          <input name="name" required maxLength={IMAGE_PROVENANCE.publisherNameLength} />
        </label>
        <label>
          {text.publisherKey}
          <textarea
            className="mono"
            name="publicKey"
            required
            rows={3}
            placeholder={text.publisherKeyPlaceholder}
            spellCheck={false}
            maxLength={IMAGE_PROVENANCE.publisherKeyLength}
          />
        </label>
        <button type="submit" disabled={addPublisher.isPending}>
          {text.addPublisher}
        </button>
      </form>
      <h4>{text.rules}</h4>
      {view !== undefined && rules.length === 0 && <p className="muted small">{text.noRules}</p>}
      {rules.map((rule) => (
        <div key={rule.id} className="key-row">
          <span className="mono">{scopeOf(rule)}</span>
          <span className="small muted">
            {rule.publishers.length === 0 ? text.anyPublisher : rule.publishers.join(TEXT.listComma)}
          </span>
          <button
            className="quiet danger"
            type="button"
            aria-label={text.removeRuleFor(scopeOf(rule))}
            onClick={() => {
              if (window.confirm(text.removeRuleConfirm(scopeOf(rule)))) removeRule.mutate(rule.id);
            }}
          >
            {text.removeRule}
          </button>
        </div>
      ))}
      {publishers.length > 0 && (
        <form className="step-form" onSubmit={submitRule} aria-label={text.addRule}>
          <label>
            {text.registry}
            <input name="registry" required placeholder={text.registryPlaceholder} />
          </label>
          <label>
            {text.repository}
            <input name="repository" placeholder={text.repositoryPlaceholder} />
          </label>
          <fieldset>
            <legend>{text.fromPublishers}</legend>
            {publishers.map((publisher) => (
              <label key={publisher.name}>
                <input type="checkbox" name="publishers" value={publisher.name} /> {publisher.name}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={addRule.isPending}>
            {text.addRule}
          </button>
        </form>
      )}
    </section>
  );
}
