import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES, apiPath, type HostView, type SshHostDetailsView } from "../../../src/shared/api.js";
import {
  HOST_PACKAGES_SETTINGS,
  ROOT_COMMANDS,
  type HostPackagesSetting,
  type RootMethod,
} from "../../../src/shared/constants.js";
import type { SshHostSettings } from "../../../src/shared/ssh-hosts.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { SSH_HOST_ANCHOR, SSH_SETUP, TEXT } from "../constants.js";
import { hostsQuery, localHostQuery, settingsQuery, sshHostQuery, sshKeysQuery } from "../queries.js";
import { SwitchToSshSteps, CommandBlock } from "./ssh-setup.js";
import { sshConnectionText } from "./host-system.js";
import { SavedNote, useSavedNote } from "./host-control.js";

const text = TEXT.ssh.host;
// Names as a person types them: separated by spaces or commas.
const NAME_SEPARATORS = /[\s,]+/;

function settingsFrom(form: FormData): SshHostSettings {
  return {
    dryRun: form.get("dryRun") === "on",
    protectedContainers: String(form.get("protectedContainers") ?? "")
      .split(NAME_SEPARATORS)
      .filter((name) => name !== ""),
    containerAccess: form.get("containerAccess") === "on",
    hostPackages: String(form.get("hostPackages")) as HostPackagesSetting,
    checkpointLimitGigabytes: Number(form.get("checkpointLimitGigabytes")),
  };
}

function SettingsForm({ hostId, settings }: { hostId: string; settings: SshHostSettings }) {
  const queryClient = useQueryClient();
  const saved = useSavedNote();
  const save = useMutation({
    mutationFn: (changed: SshHostSettings) =>
      api<SshHostSettings>("PUT", apiPath(API_ROUTES.sshHostSettings, { hostId }), changed),
    onSuccess: async () => {
      saved.show();
      await queryClient.invalidateQueries({ queryKey: sshHostQuery(hostId).queryKey });
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(settingsFrom(new FormData(event.currentTarget)));
  };
  return (
    <form className="step-form ssh-settings" onSubmit={submit} aria-label={text.settingsTitle}>
      <h3>{text.settingsTitle}</h3>
      <p className="small muted">{text.settingsExplanation}</p>
      <label className="tick">
        <input type="checkbox" name="dryRun" defaultChecked={settings.dryRun} />
        {text.dryRun}
      </label>
      <label>
        {text.protectedContainers}
        <span className="hint">{text.protectedHint}</span>
        <input className="mono" name="protectedContainers" defaultValue={settings.protectedContainers.join(" ")} />
      </label>
      <label className="tick">
        <input type="checkbox" name="containerAccess" defaultChecked={settings.containerAccess} />
        {text.containerAccess}
      </label>
      <label>
        {text.hostPackages}
        <select name="hostPackages" defaultValue={settings.hostPackages}>
          {HOST_PACKAGES_SETTINGS.map((setting) => (
            <option key={setting} value={setting}>
              {text.packageChoices[setting]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {text.checkpointLimit}
        <input
          name="checkpointLimitGigabytes"
          type="number"
          min={0}
          required
          defaultValue={settings.checkpointLimitGigabytes}
        />
      </label>
      <p className="row">
        <button className="primary" type="submit" disabled={save.isPending}>
          {text.save}
        </button>
        <SavedNote shown={saved.shown} />
      </p>
      <ErrorNotice error={save.error} />
    </form>
  );
}

/** Its key changed: both fingerprints, the command to compare on the host, and a person trusts the new one. */
function ChangedHostKey({ hostId, details }: { hostId: string; details: SshHostDetailsView }) {
  const queryClient = useQueryClient();
  const offered = details.offeredHostKeyFingerprint!;
  const trust = useMutation({
    mutationFn: () =>
      api<HostView>("POST", apiPath(API_ROUTES.sshHostTrustHostKey, { hostId }), { fingerprint: offered }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sshHostQuery(hostId).queryKey }),
  });
  return (
    <div className="notice danger stack" role="alert">
      <p>{text.changed(details.hostKeyFingerprint, offered)}</p>
      <CommandBlock command={SSH_SETUP.compareHostKey} />
      <p className="row">
        <button type="button" className="primary" disabled={trust.isPending} onClick={() => trust.mutate()}>
          {text.trustNew}
        </button>
      </p>
      <ErrorNotice error={trust.error} />
    </div>
  );
}

function ReplaceKey({ hostId, current }: { hostId: string; current: string }) {
  const queryClient = useQueryClient();
  const keys = useQuery(sshKeysQuery);
  const replace = useMutation({
    mutationFn: (keyId: string) => api<HostView>("PUT", apiPath(API_ROUTES.sshHostKey, { hostId }), { keyId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sshHostQuery(hostId).queryKey });
      await queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
    },
  });
  const others = (keys.data ?? []).filter((key) => key.id !== current);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    replace.mutate(String(new FormData(event.currentTarget).get("keyId")));
  };
  if (others.length === 0) {
    return <ErrorNotice error={keys.error} />;
  }
  return (
    <form className="step-form" onSubmit={submit}>
      <label>
        {text.replaceKey}
        <select name="keyId" required defaultValue={others[0]!.id}>
          {others.map((key) => (
            <option key={key.id} value={key.id}>
              {`${key.name} (${key.fingerprint})`}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={replace.isPending}>
        {text.replace}
      </button>
      <ErrorNotice error={replace.error ?? keys.error} />
    </form>
  );
}

/** The password Autoheal runs root commands with: checked on the machine before it is kept, never shown back. */
function RootPassword({ hostId, method }: { hostId: string; method: RootMethod | null }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: sshHostQuery(hostId).queryKey });
  const save = useMutation({
    mutationFn: (password: string) =>
      api<SshHostDetailsView>("PUT", apiPath(API_ROUTES.sshHostRoot, { hostId }), { password }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api("DELETE", apiPath(API_ROUTES.sshHostRoot, { hostId })),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    save.mutate(String(new FormData(form).get("password") ?? ""));
    form.reset();
  };
  const confirmRemove = () => {
    if (window.confirm(text.rootRemoveConfirm)) remove.mutate();
  };
  return (
    <div className="stack ssh-root">
      <h3>{text.rootTitle}</h3>
      <p className="small muted">{text.rootExplanation}</p>
      {method !== null && (
        <p className="row">
          <span className="text-good">{text.rootSaved(method)}</span>
          <button type="button" className="quiet danger" disabled={remove.isPending} onClick={confirmRemove}>
            {text.rootRemove}
          </button>
        </p>
      )}
      <form className="step-form" onSubmit={submit}>
        <label>
          {text.rootPassword}
          <input
            name="password"
            type="password"
            required
            autoComplete="off"
            maxLength={ROOT_COMMANDS.passwordCharacters}
          />
        </label>
        <button type="submit" disabled={save.isPending}>
          {text.rootSave}
        </button>
      </form>
      <ErrorNotice error={save.error ?? remove.error} />
    </div>
  );
}

/** An SSH host's own: how it is reached, with which key, its host key, and its settings. For an admin. */
export function SshHostCard({ host }: { host: HostView }) {
  const details = useQuery(sshHostQuery(host.id));
  const view = details.data;
  if (view === undefined) {
    return details.error ? <ErrorNotice error={details.error} /> : <Loading />;
  }
  return (
    <section className="card ssh-host" id={SSH_HOST_ANCHOR} aria-labelledby="ssh-host-title">
      <h2 id="ssh-host-title">{text.title}</h2>
      {host.docker === false && <p className="notice">{text.systemOnly}</p>}
      <p className="mono">{text.signsInAs(view.user, view.address, view.port)}</p>
      <p className="small muted">{sshConnectionText(host)}</p>
      <dl className="facts">
        <dt>{text.key}</dt>
        <dd>{view.keyName}</dd>
        <dt>{text.hostKey}</dt>
        <dd className="mono">{view.hostKeyFingerprint}</dd>
      </dl>
      {view.offeredHostKeyFingerprint !== null && <ChangedHostKey hostId={host.id} details={view} />}
      <ReplaceKey hostId={host.id} current={view.keyId} />
      <RootPassword hostId={host.id} method={view.rootMethod} />
      <SettingsForm hostId={host.id} settings={view.settings} />
    </section>
  );
}

/**
 * A runner host reached over SSH from now on, as the same host: the add-over-SSH steps with its name kept, then the
 * command that removes its runner. Not offered for the dashboard's own machine, which keeps its runner.
 */
export function SwitchToSsh({ host }: { host: HostView }) {
  const settings = useQuery(settingsQuery);
  const local = useQuery(localHostQuery);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const runnerAddress = settings.data?.runnerAddress;
  // Hidden until known not to be the machine Autoheal itself runs on, which a runner always reports.
  if (local.data === undefined || local.data.hostId === host.id || runnerAddress === undefined) {
    return null;
  }
  const closed = () => {
    setAttempt((count) => count + 1);
    setOpen(false);
  };
  return (
    <section className="card switch-to-ssh" aria-labelledby="switch-to-ssh-title">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <h2 id="switch-to-ssh-title">{TEXT.ssh.add.switchTitle}</h2>
        </summary>
        {open && (
          <SwitchToSshSteps
            key={attempt}
            dashboardAddress={new URL(runnerAddress).hostname}
            switching={{ hostId: host.id, label: host.label }}
            onCancelled={closed}
          />
        )}
      </details>
    </section>
  );
}
