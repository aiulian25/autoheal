import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { REGISTRY_CREDENTIALS } from "../../../src/shared/constants.js";
import type { RegistryCredentialTestView, RegistryCredentialView } from "../../../src/shared/registry-credentials.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "./common.js";
import { TEXT } from "../constants.js";
import { hostsQuery, registryCredentialsQuery } from "../queries.js";

const text = TEXT.registries;

interface CredentialRequest {
  registry: string;
  repository: string | null;
  username: string;
  password: string;
  hostIds: string[];
}

const scopeOf = (credential: RegistryCredentialView) =>
  credential.repository === null ? credential.registry : `${credential.registry}/${credential.repository}`;

const hostNames = (credential: RegistryCredentialView, hosts: HostView[]) =>
  credential.hostIds.length === 0
    ? text.everyHost
    : credential.hostIds
        .map((hostId) => hosts.find((host) => host.id === hostId)?.label ?? text.goneHost)
        .join(TEXT.listComma);

const requestFrom = (form: FormData): CredentialRequest => ({
  registry: String(form.get("registry") ?? "").trim(),
  repository: String(form.get("repository") ?? "").trim() || null,
  username: String(form.get("username") ?? "").trim(),
  password: String(form.get("password") ?? ""),
  hostIds: form.getAll("hostIds").map(String),
});

/**
 * What private registries want, kept for the hosts allowed to use them. A password goes in and is never shown
 * again; each host is given only what its scope covers, from its next heartbeat on.
 */
export function RegistryCredentialsCard() {
  const queryClient = useQueryClient();
  const credentials = useQuery(registryCredentialsQuery);
  const hosts = useQuery(hostsQuery);
  const [tested, setTested] = useState<{ id: string; answer: RegistryCredentialTestView } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: registryCredentialsQuery.queryKey });
  const addCredential = useMutation({
    mutationFn: (request: CredentialRequest) => api<{ id: string }>("POST", API_ROUTES.registryCredentials, request),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: ({ id, request }: { id: string; request: CredentialRequest }) =>
      api("PUT", apiPath(API_ROUTES.registryCredential, { credentialId: id }), request),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (credentialId: string) => api("DELETE", apiPath(API_ROUTES.registryCredential, { credentialId })),
    onSuccess: refresh,
  });
  const check = useMutation({
    mutationFn: ({ id, repository }: { id: string; repository: string | null }) =>
      api<RegistryCredentialTestView>("POST", apiPath(API_ROUTES.registryCredentialTest, { credentialId: id }), {
        repository,
      }),
    onSuccess: (answer, { id }) => setTested({ id, answer }),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    addCredential.mutate(requestFrom(new FormData(event.currentTarget)));
    event.currentTarget.reset();
  };
  const submitRotation = (credential: RegistryCredentialView) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    rotate.mutate({
      id: credential.id,
      request: {
        registry: credential.registry,
        repository: credential.repository,
        username: String(form.get("username") ?? "").trim(),
        password: String(form.get("password") ?? ""),
        hostIds: credential.hostIds,
      },
    });
    event.currentTarget.reset();
  };
  const confirmRemove = (credential: RegistryCredentialView) => {
    if (window.confirm(text.removeConfirm(scopeOf(credential)))) remove.mutate(credential.id);
  };
  const list = credentials.data ?? [];
  const fleet = (hosts.data ?? []).filter(({ label }) => label !== "");
  return (
    <section className="card stack" aria-labelledby="registries-title">
      <div>
        <h3 id="registries-title">{text.title}</h3>
        <p className="small muted">{text.explanation}</p>
      </div>
      {credentials.data === undefined && (credentials.error ? <ErrorNotice error={credentials.error} /> : <Loading />)}
      {credentials.data !== undefined && list.length === 0 && <p className="muted">{text.none}</p>}
      {list.map((credential) => (
        <div key={credential.id} className="stack small">
          <div className="key-row">
            <span className="mono">{scopeOf(credential)}</span>
            <span className="small muted">
              {text.asUser(credential.username)}
              {TEXT.separator}
              {hostNames(credential, fleet)}
            </span>
            <button className="quiet danger" type="button" onClick={() => confirmRemove(credential)}>
              {text.remove}
            </button>
          </div>
          <form
            className="key-form"
            onSubmit={submitRotation(credential)}
            aria-label={text.rotateFor(scopeOf(credential))}
          >
            <label>
              {text.username}
              <input
                name="username"
                defaultValue={credential.username}
                required
                maxLength={REGISTRY_CREDENTIALS.usernameLength}
              />
            </label>
            <label>
              {text.newPassword}
              <input
                name="password"
                type="password"
                autoComplete="off"
                required
                maxLength={REGISTRY_CREDENTIALS.passwordLength}
              />
            </label>
            <button type="submit" disabled={rotate.isPending}>
              {text.rotate}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={check.isPending}
              onClick={() => check.mutate({ id: credential.id, repository: credential.repository })}
            >
              {text.test}
            </button>
          </form>
          {tested?.id === credential.id && (
            <p className={tested.answer.reached ? "text-good small" : "notice error"} role="status">
              {tested.answer.reached ? text.reached : text.notReached(tested.answer.problem ?? "")}
            </p>
          )}
        </div>
      ))}
      <ErrorNotice error={addCredential.error ?? rotate.error ?? remove.error ?? check.error} />
      <form className="step-form" onSubmit={submit} aria-label={text.add}>
        <h4>{text.add}</h4>
        <label>
          {text.registry}
          <input
            name="registry"
            required
            placeholder={text.registryPlaceholder}
            maxLength={REGISTRY_CREDENTIALS.registryLength}
          />
        </label>
        <label>
          {text.repository}
          <input
            name="repository"
            placeholder={text.repositoryPlaceholder}
            maxLength={REGISTRY_CREDENTIALS.repositoryLength}
          />
        </label>
        <label>
          {text.username}
          <input name="username" required maxLength={REGISTRY_CREDENTIALS.usernameLength} />
        </label>
        <label>
          {text.password}
          <input
            name="password"
            type="password"
            autoComplete="off"
            required
            maxLength={REGISTRY_CREDENTIALS.passwordLength}
          />
        </label>
        <fieldset>
          <legend>{text.hosts}</legend>
          <p className="small muted">{text.hostsNote}</p>
          {fleet.map((host) => (
            <label key={host.id}>
              <input type="checkbox" name="hostIds" value={host.id} /> {host.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={addCredential.isPending}>
          {text.add}
        </button>
      </form>
    </section>
  );
}
