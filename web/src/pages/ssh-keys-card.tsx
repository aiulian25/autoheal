import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { API_ROUTES, apiPath, type MadeSshKeyView, type SshKeyView } from "../../../src/shared/api.js";
import { SSH_KEY } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { TEXT } from "../constants.js";
import { sshKeysQuery } from "../queries.js";
import { KeySetup } from "./ssh-setup.js";

const text = TEXT.ssh.keys;
const add = TEXT.ssh.add;

/** The keys Autoheal signs in to SSH hosts with: which hosts use each, and one more given or made here. */
export function SshKeysCard({ dashboardAddress }: { dashboardAddress: string }) {
  const queryClient = useQueryClient();
  const keys = useQuery(sshKeysQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
  const addKey = useMutation({
    mutationFn: (key: { name: string; privateKey: string; passphrase: string }) =>
      api<SshKeyView>("POST", API_ROUTES.sshKeys, key),
    onSuccess: refresh,
  });
  const make = useMutation({
    mutationFn: (key: { name: string; passphrase: string }) => api<MadeSshKeyView>("POST", API_ROUTES.sshKeysMake, key),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (keyId: string) => api("DELETE", apiPath(API_ROUTES.sshKey, { keyId })),
    onSuccess: refresh,
  });
  const submitAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    addKey.mutate({
      name: String(form.get("name") ?? "").trim(),
      privateKey: String(form.get("privateKey") ?? ""),
      passphrase: String(form.get("passphrase") ?? ""),
    });
    event.currentTarget.reset();
  };
  const submitMake = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    make.mutate({
      name: String(form.get("name") ?? "").trim(),
      passphrase: String(form.get("passphrase") ?? ""),
    });
    event.currentTarget.reset();
  };
  const confirmRemove = (key: SshKeyView) => {
    if (window.confirm(text.removeConfirm(key.name))) remove.mutate(key.id);
  };
  const list = keys.data ?? [];
  return (
    <section className="card keys-card" aria-labelledby="ssh-keys-title">
      <div className="keys-head">
        <h3 id="ssh-keys-title">{text.title}</h3>
        <p className="small muted">{text.explanation}</p>
      </div>
      {keys.data !== undefined && list.length === 0 && <p className="muted">{text.none}</p>}
      {list.map((key) => (
        <div key={key.id} className="key-row">
          <span>{key.name}</span>
          <span className="small muted">
            <span className="mono">{key.fingerprint}</span>
            {TEXT.separator}
            {key.madeByAutoheal ? `${text.made}${TEXT.separator}` : ""}
            <span>{text.usedBy(key.hosts)}</span>
          </span>
          <button className="quiet danger" type="button" onClick={() => confirmRemove(key)}>
            {text.remove}
          </button>
        </div>
      ))}
      {make.data !== undefined && (
        <div className="notice warning stack" role="status">
          <strong>{text.madeNotice(make.data.key.name)}</strong>
          <KeySetup
            publicLine={make.data.key.publicLine}
            made={make.data}
            user={null}
            dashboardAddress={dashboardAddress}
          />
        </div>
      )}
      <form className="step-form" onSubmit={submitAdd} aria-label={text.add}>
        <h4>{text.add}</h4>
        <label>
          {add.keyName}
          <input name="name" required maxLength={SSH_KEY.nameCharacters} />
        </label>
        <label>
          {add.privateKey}
          <textarea
            className="mono"
            name="privateKey"
            required
            rows={4}
            placeholder={add.privateKeyPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          {add.passphrase}
          <input name="passphrase" type="password" autoComplete="off" />
        </label>
        <button type="submit" disabled={addKey.isPending}>
          {text.add}
        </button>
      </form>
      <form className="key-form" onSubmit={submitMake}>
        <span className="key-form-row">
          <label>
            {text.makeName}
            <input name="name" required maxLength={SSH_KEY.nameCharacters} />
          </label>
          <label>
            {TEXT.connectHost.passphrase}
            <input
              name="passphrase"
              type="password"
              autoComplete="new-password"
              maxLength={SSH_KEY.passphraseCharacters}
              title={TEXT.connectHost.makePassphraseHint}
            />
          </label>
          <button type="submit" disabled={make.isPending}>
            {add.make}
          </button>
        </span>
      </form>
      <ErrorNotice error={keys.error ?? addKey.error ?? make.error ?? remove.error} />
    </section>
  );
}
