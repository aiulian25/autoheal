import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  API_ROUTES,
  apiPath,
  heldBackBy,
  type HostView,
  type SshConnectionChangeView,
  type SshHostDetailsView,
} from "../../../src/shared/api.js";
import {
  HOST_PACKAGES_SETTINGS,
  ROOT_COMMANDS,
  SSH_HOST_FIELDS,
  type HostPackagesSetting,
  type RootMethod,
} from "../../../src/shared/constants.js";
import type { SshHostSettings } from "../../../src/shared/ssh-hosts.js";
import { api } from "../api-client.js";
import { useAskInPlace } from "../components/ask-in-place.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { HeldBack } from "../components/held-back.js";
import { SSH_HOST_ANCHOR, SSH_SETUP, TEXT } from "../constants.js";
import { hostsQuery, localHostQuery, settingsQuery, sshHostQuery, sshKeysQuery } from "../queries.js";
import { SwitchToSshSteps, CommandBlock, KEY_CHOICE, keyIdOf, keyPickOf, SshKeyPicker } from "./ssh-setup.js";
import { sshConnectionText } from "./host-system.js";
import { SavedNote, useSavedNote } from "../components/saved-note.js";

const text = TEXT.ssh.host;
const addText = TEXT.ssh.add;
// Names as a person types them: separated by spaces or commas.
const NAME_SEPARATORS = /[\s,]+/;

function settingsFrom(form: FormData): SshHostSettings {
  return {
    dryRun: form.get("dryRun") === "on",
    protectedContainers: String(form.get("protectedContainers") ?? "")
      .split(NAME_SEPARATORS)
      .filter((name) => name !== ""),
    containerAccess: form.get("containerAccess") === "on",
    hostTerminal: form.get("hostTerminal") === "on",
    hostDeploy: form.get("hostDeploy") === "on",
    hostFilesystems: String(form.get("hostFilesystems") ?? "")
      .split(NAME_SEPARATORS)
      .filter((path) => path !== ""),
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
      <label className="tick">
        <input type="checkbox" name="hostTerminal" defaultChecked={settings.hostTerminal} />
        {text.hostTerminal}
      </label>
      <label className="tick">
        <input type="checkbox" name="hostDeploy" defaultChecked={settings.hostDeploy} />
        {text.hostDeploy}
      </label>
      <label>
        {text.hostFilesystems}
        <span className="hint">{text.hostFilesystemsHint}</span>
        <input className="mono" name="hostFilesystems" defaultValue={settings.hostFilesystems.join(" ")} />
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

/**
 * How the host is reached, changed in one go: its address, port, user and key, tried first and kept only once
 * Autoheal has signed in that way. Another host key there is shown to compare before it is trusted.
 */
function EditConnection({
  host,
  details,
  onSaved,
  onCancelled,
}: {
  host: HostView;
  details: SshHostDetailsView;
  onSaved: () => void;
  onCancelled: () => void;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const [where, setWhere] = useState({ address: details.address, port: details.port, user: details.user });
  const [pick, setPick] = useState(keyPickOf(details.keyId));
  const [stored, setStored] = useState<string[]>([]);
  const keepStored = (keyId: string) => setStored((keys) => [...keys, keyId]);
  const save = useMutation({
    mutationFn: async (hostKeyFingerprint: string | null) => {
      const keyId = await keyIdOf(pick, host.label);
      if (pick.choice === KEY_CHOICE.paste) {
        keepStored(keyId);
        setPick({ ...pick, choice: keyId });
      }
      return api<SshConnectionChangeView>("PUT", apiPath(API_ROUTES.sshHostConnection, { hostId: host.id }), {
        ...where,
        keyId,
        hostKeyFingerprint,
      });
    },
    onSuccess: async (result) => {
      if ("offeredHostKeyFingerprint" in result) return;
      await queryClient.invalidateQueries({ queryKey: sshHostQuery(host.id).queryKey });
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
      onSaved();
    },
  });
  // The keys this change stored go again with it, as the page shows them at the click.
  const cancel = useMutation({
    mutationFn: (keyIds: readonly string[]) =>
      Promise.all(keyIds.map((keyId) => api("DELETE", apiPath(API_ROUTES.sshKey, { keyId })).catch(() => undefined))),
    onSettled: onCancelled,
  });
  // Whatever changes after a try makes its answer stale.
  const changed =
    <Value,>(set: (value: Value) => void) =>
    (value: Value) => {
      save.reset();
      set(value);
    };
  const setWhereField = changed((patch: Partial<typeof where>) => setWhere({ ...where, ...patch }));
  const answer = save.data;
  const offered =
    answer !== undefined && "offeredHostKeyFingerprint" in answer ? answer.offeredHostKeyFingerprint : null;
  const runnerAddress = settings.data?.runnerAddress;
  const dashboardAddress = runnerAddress === undefined ? "" : new URL(runnerAddress).hostname;
  const waiting = pick.choice === KEY_CHOICE.none || pick.choice === KEY_CHOICE.make;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(null);
  };
  const word = SSH_HOST_FIELDS.word.source;
  return (
    <form className="step-form ssh-connection" onSubmit={submit} aria-label={text.edit}>
      <div className="connect-host-row with-end">
        <label>
          {addText.address}
          <input
            className="mono"
            name="address"
            required
            pattern={word}
            value={where.address}
            onChange={(event) => setWhereField({ address: event.target.value.trim() })}
          />
        </label>
        <label>
          {addText.port}
          <input
            className="mono"
            name="port"
            type="number"
            required
            min={SSH_HOST_FIELDS.lowestPort}
            max={SSH_HOST_FIELDS.highestPort}
            value={where.port}
            onChange={(event) => setWhereField({ port: Number(event.target.value) })}
          />
        </label>
      </div>
      <label>
        {addText.user}
        <input
          className="mono"
          name="user"
          required
          pattern={word}
          value={where.user}
          onChange={(event) => setWhereField({ user: event.target.value.trim() })}
        />
      </label>
      <SshKeyPicker
        label={host.label}
        pick={pick}
        onPick={changed(setPick)}
        onKeyStored={keepStored}
        currentKeyId={details.keyId}
        user={where.user || null}
        dashboardAddress={dashboardAddress}
      />
      <p className="small muted">{text.nothingUntil}</p>
      {offered !== null && (
        <div className="notice warning stack" role="alert">
          <p>{text.otherHostKey(where.address, offered)}</p>
          <CommandBlock command={SSH_SETUP.compareHostKey} />
          <p className="row">
            <button type="button" className="primary" disabled={save.isPending} onClick={() => save.mutate(offered)}>
              {text.trustAndSave}
            </button>
          </p>
        </div>
      )}
      <ErrorNotice error={save.error} />
      <p className="row">
        <button type="button" className="quiet" disabled={cancel.isPending} onClick={() => cancel.mutate(stored)}>
          {addText.cancel}
        </button>
        <button type="submit" className="primary push" disabled={waiting || save.isPending}>
          {text.testAndSave}
        </button>
      </p>
    </form>
  );
}

const rootStateOf = (method: RootMethod | null) =>
  method === null ? text.rootState.none : text.rootState.saved(method);

// How its settings stand, in the line its fold shows folded.
function settingsStateOf(settings: SshHostSettings): string {
  const words = text.settingsState;
  const protectedCount = settings.protectedContainers.length;
  return [
    settings.dryRun ? words.dryRun : words.acting,
    settings.containerAccess ? words.access : words.noAccess,
    protectedCount === 0 ? words.nothingProtected : words.protectedCount(protectedCount),
  ].join(TEXT.separator);
}

/** The password Autoheal runs root commands with: checked on the machine before it is kept, never shown back. */
function RootPassword({ hostId, method }: { hostId: string; method: RootMethod | null }) {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
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
    asking.confirm(text.rootRemoveConfirm, () => remove.mutate());
  };
  return (
    <div className="stack ssh-root">
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
      {asking.question}
      <ErrorNotice error={save.error ?? remove.error} />
    </div>
  );
}

/** What holds its runner back, and the way past it once a person has looked: only while its runner will not start. */
function Interrupted({ host }: { host: HostView }) {
  if (heldBackBy(host).length === 0) {
    return null;
  }
  return (
    <div className="stack ssh-interrupted">
      <h3>{text.interruptedTitle}</h3>
      <p className="small muted">{text.interruptedExplanation}</p>
      <HeldBack host={host} admin />
    </div>
  );
}

/**
 * An SSH host's own: how it is reached and with which key, read here and changed only through Edit connection; its
 * root password and its settings fold away, each saying how it stands. For an admin.
 */
export function SshHostCard({ host }: { host: HostView }) {
  const details = useQuery(sshHostQuery(host.id));
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const view = details.data;
  if (view === undefined) {
    return details.error ? <ErrorNotice error={details.error} /> : <Loading />;
  }
  const startEditing = () => {
    setSaved(false);
    setEditing(true);
  };
  const finished = () => {
    setEditing(false);
    setSaved(true);
  };
  return (
    <section className="card ssh-host" id={SSH_HOST_ANCHOR} aria-labelledby="ssh-host-title">
      <h2 id="ssh-host-title">{text.title}</h2>
      {host.docker === false && <p className="notice">{text.systemOnly}</p>}
      <p className="small muted">{sshConnectionText(host)}</p>
      <Interrupted host={host} />
      <dl className="facts">
        <dt>{text.signsInAsLabel}</dt>
        <dd className="mono">{text.signsInAs(view.user, view.address, view.port)}</dd>
        <dt>{text.keyLabel}</dt>
        <dd>
          <span className="mono">{view.keyFingerprint}</span>
          {view.keySharedWith.length > 0 && (
            <>
              {TEXT.separator}
              <span className="muted">{text.sharedWith(view.keySharedWith)}</span>
            </>
          )}
        </dd>
        <dt>{text.hostKey}</dt>
        <dd className="mono">{view.hostKeyFingerprint}</dd>
      </dl>
      {view.offeredHostKeyFingerprint !== null && <ChangedHostKey hostId={host.id} details={view} />}
      {editing ? (
        <EditConnection host={host} details={view} onSaved={finished} onCancelled={() => setEditing(false)} />
      ) : (
        <p className="row">
          <button type="button" onClick={startEditing}>
            {text.edit}
          </button>
          {saved && (
            <span className="small text-good" role="status">
              {text.connectionSaved}
            </span>
          )}
        </p>
      )}
      <details className="fold ssh-fold">
        <summary>
          <h3>{text.rootTitle}</h3>
          <span className="fold-state">{rootStateOf(view.rootMethod)}</span>
        </summary>
        <RootPassword hostId={host.id} method={view.rootMethod} />
      </details>
      <details className="fold ssh-fold">
        <summary>
          <h3>{text.settingsTitle}</h3>
          <span className="fold-state">{settingsStateOf(view.settings)}</span>
        </summary>
        <SettingsForm hostId={host.id} settings={view.settings} />
      </details>
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
