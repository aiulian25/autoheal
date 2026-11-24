import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type MadeSshKeyView,
  type PendingSshHostView,
  type SshKeyView,
} from "../../../src/shared/api.js";
import { SSH_HOST_FIELDS, SSH_KEY, SSH_SESSION } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { CopyButton, ErrorNotice, PlainText, Step } from "../components/common.js";
import { PATHS, SSH_HOST_ANCHOR, SSH_SETUP, TEXT } from "../constants.js";
import { hostsQuery, sshKeysQuery } from "../queries.js";

interface Where {
  label: string;
  address: string;
  port: number;
  user: string;
}

interface ChosenKey {
  id: string;
  fingerprint: string;
}

/** How a key is chosen: one Autoheal keeps, by its id, or one given now. */
export const KEY_CHOICE = { none: "", paste: "paste", make: "make" } as const;

/** What is chosen so far, with what pasting or making a key needs. */
export interface KeyPick {
  choice: string;
  privateKey: string;
  passphrase: string;
  madePassphrase: string;
  made: MadeSshKeyView | null;
}

export const keyPickOf = (choice: string): KeyPick => ({
  choice,
  privateKey: "",
  passphrase: "",
  madePassphrase: "",
  made: null,
});

const STEPS = { where: 1, key: 2, connect: 3 } as const;
const text = TEXT.ssh.add;
const pickerText = TEXT.sshKeyPicker;

function stepOf(where: Where | null, chosen: ChosenKey | null): number {
  if (where === null) return STEPS.where;
  return chosen === null ? STEPS.key : STEPS.connect;
}

/** One command to run on the host, with its copy button. */
export function CommandBlock({ command }: { command: string }) {
  return (
    <div className="command-block">
      <PlainText text={command} />
      <CopyButton text={command} />
    </div>
  );
}

/** The made key's private half goes straight to a file: it is never put on the page. */
function downloadPrivateKey(made: MadeSshKeyView) {
  const url = URL.createObjectURL(new Blob([made.privateKey], { type: SSH_SETUP.privateKeyType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = SSH_SETUP.privateKeyFile(made.key.name);
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * What to run on a host to let a key in: the folder, the key's line (or the same line held to this dashboard's
 * address), the docker group and a check; and, for a key Autoheal made just now, its private half to download, once.
 * Without a user, only the key's lines: the user is the host's.
 */
export function KeySetup({
  publicLine,
  made,
  user,
  dashboardAddress,
}: {
  publicLine: string;
  made: MadeSshKeyView | null;
  user: string | null;
  dashboardAddress: string;
}) {
  return (
    <div className="stack made-key">
      {user !== null && <p className="small">{text.madeIntro(user)}</p>}
      <CommandBlock command={SSH_SETUP.folder} />
      <CommandBlock command={SSH_SETUP.authorize(publicLine)} />
      <p className="small muted">{text.fromIntro(dashboardAddress)}</p>
      <CommandBlock command={SSH_SETUP.authorizeFrom(dashboardAddress, publicLine)} />
      {user !== null && (
        <>
          <CommandBlock command={SSH_SETUP.joinDocker(user)} />
          <p className="small muted">{text.groupNote}</p>
          <CommandBlock command={SSH_SETUP.checkDocker} />
          <p className="small muted">{text.checkNote}</p>
        </>
      )}
      {made !== null && (
        <p className="row">
          <button type="button" onClick={() => downloadPrivateKey(made)}>
            {text.download}
          </button>
          <span className="small muted">{text.downloadNote}</span>
        </p>
      )}
    </div>
  );
}

/** What its user found of Docker: informing only, as a host without it is watched for its system alone. */
export function DockerFound({ pending, user }: { pending: PendingSshHostView; user: string }) {
  if (pending.docker.usable) {
    return <p className="small text-good">{text.withDocker}</p>;
  }
  if (!pending.docker.socket) {
    return <p className="notice">{text.noDocker}</p>;
  }
  return (
    <div className="notice stack">
      <p>{text.notUsable(user)}</p>
      <CommandBlock command={SSH_SETUP.joinDocker(user)} />
    </div>
  );
}

// The host keeps its name: only where it is and as whom are asked.
function WhereForm({
  initial,
  label,
  onDone,
}: {
  initial: Where | null;
  label: string;
  onDone: (where: Where) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onDone({
      label,
      address: String(form.get("address") ?? "").trim(),
      port: Number(form.get("port")),
      user: String(form.get("user") ?? "").trim(),
    });
  };
  const word = SSH_HOST_FIELDS.word.source;
  return (
    <form className="step-form" onSubmit={submit}>
      <label>
        {text.address}
        <input
          className="mono"
          name="address"
          required
          pattern={word}
          placeholder={text.addressPlaceholder}
          defaultValue={initial?.address}
        />
      </label>
      <label>
        {text.port}
        <input
          name="port"
          type="number"
          required
          min={SSH_HOST_FIELDS.lowestPort}
          max={SSH_HOST_FIELDS.highestPort}
          defaultValue={initial?.port ?? SSH_SESSION.defaultPort}
        />
      </label>
      <label>
        {text.user}
        <input className="mono" name="user" required pattern={word} defaultValue={initial?.user} />
      </label>
      <button className="primary" type="submit">
        {text.next}
      </button>
    </form>
  );
}

// A key reads by the hosts that sign in with it, never by a typed name: the host's own, others', or one given just now.
function keyLabel(key: SshKeyView, currentKeyId: string | null): string {
  if (key.id === currentKeyId) {
    return pickerText.now(key.fingerprint);
  }
  return key.hosts.length === 0 ? pickerText.fresh(key.fingerprint) : pickerText.usedBy(key.hosts, key.fingerprint);
}

/**
 * The key a host signs in with, in one list: those Autoheal keeps, named by the hosts using them, a private key pasted
 * now, or one made now, its commands and private half shown once. A key no host uses is left out, unless chosen here.
 */
export function SshKeyPicker({
  label,
  pick,
  onPick,
  onKeyStored,
  currentKeyId = null,
  user,
  dashboardAddress,
}: {
  // The host the key is for: what a key made for it is filed under.
  label: string;
  pick: KeyPick;
  onPick: (pick: KeyPick) => void;
  // A key stored by this choice is new: the form's Cancel takes it away again.
  onKeyStored: (keyId: string) => void;
  // The key the host signs in with now, when it is being changed.
  currentKeyId?: string | null;
  user: string | null;
  dashboardAddress: string;
}) {
  const queryClient = useQueryClient();
  const keys = useQuery(sshKeysQuery);
  const make = useMutation({
    mutationFn: () =>
      api<MadeSshKeyView>("POST", API_ROUTES.sshKeysMake, { name: label, passphrase: pick.madePassphrase || null }),
    onSuccess: async (made) => {
      onKeyStored(made.key.id);
      await queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
      onPick({ ...pick, choice: made.key.id, made });
    },
  });
  // The key made here is listed at once, before the list Autoheal keeps has caught up with it.
  const madeKeys = pick.made === null ? [] : [pick.made.key];
  const known = [...(keys.data ?? []).filter((key) => !madeKeys.some((made) => made.id === key.id)), ...madeKeys];
  const offered = known.filter((key) => key.hosts.length > 0 || key.id === pick.choice || key.id === currentKeyId);
  const chosen = offered.find((key) => key.id === pick.choice && key.id !== currentKeyId) ?? null;
  const madeNow = pick.made !== null && pick.made.key.id === pick.choice;
  return (
    <>
      <label>
        {pickerText.key}
        <select
          name="key"
          required
          value={pick.choice}
          disabled={make.isPending}
          onChange={(event) => onPick({ ...pick, choice: event.target.value })}
        >
          <option value={KEY_CHOICE.none} disabled>
            {pickerText.chooseKey}
          </option>
          {offered.map((key) => (
            <option key={key.id} value={key.id}>
              {keyLabel(key, currentKeyId)}
            </option>
          ))}
          <option value={KEY_CHOICE.paste}>{pickerText.pasteKey}</option>
          <option value={KEY_CHOICE.make}>{pickerText.makeKey}</option>
        </select>
      </label>
      {pick.choice === KEY_CHOICE.paste && (
        <>
          <label>
            {pickerText.privateKey}
            <textarea
              className="mono"
              name="privateKey"
              required
              rows={4}
              maxLength={SSH_KEY.privateKeyCharacters}
              placeholder={pickerText.privateKeyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              value={pick.privateKey}
              onChange={(event) => onPick({ ...pick, privateKey: event.target.value })}
            />
          </label>
          <label>
            {pickerText.passphrase}
            <input
              name="passphrase"
              type="password"
              autoComplete="off"
              maxLength={SSH_KEY.passphraseCharacters}
              value={pick.passphrase}
              onChange={(event) => onPick({ ...pick, passphrase: event.target.value })}
            />
            <span className="hint">{pickerText.pastePassphraseHint}</span>
          </label>
        </>
      )}
      {pick.choice === KEY_CHOICE.make && (
        <div className="connect-host-row with-end">
          <label>
            {pickerText.passphrase}
            <input
              name="madePassphrase"
              type="password"
              autoComplete="new-password"
              maxLength={SSH_KEY.passphraseCharacters}
              value={pick.madePassphrase}
              onChange={(event) => onPick({ ...pick, madePassphrase: event.target.value })}
            />
            <span className="hint">{pickerText.makePassphraseHint}</span>
          </label>
          <button type="button" className="connect-host-make" disabled={make.isPending} onClick={() => make.mutate()}>
            {pickerText.make}
          </button>
        </div>
      )}
      {chosen !== null && (
        <details className="connect-host-details" open={madeNow}>
          <summary>{madeNow ? pickerText.newKeyCommands : pickerText.commands}</summary>
          <KeySetup
            publicLine={chosen.publicLine}
            made={madeNow ? pick.made : null}
            user={user}
            dashboardAddress={dashboardAddress}
          />
        </details>
      )}
      <ErrorNotice error={keys.error ?? make.error} />
    </>
  );
}

// A pasted key is stored when it is used; one already kept, by its fingerprint, comes back as it is.
const storePasted = (pick: KeyPick, label: string) =>
  api<SshKeyView>("POST", API_ROUTES.sshKeys, {
    name: label,
    privateKey: pick.privateKey,
    passphrase: pick.passphrase,
  });

/** The key to dial with: a pasted one is stored first. */
export async function keyIdOf(pick: KeyPick, label: string): Promise<string> {
  return pick.choice === KEY_CHOICE.paste ? (await storePasted(pick, label)).id : pick.choice;
}

// The key chosen, as Autoheal keeps it: one pasted is stored first, and one made here is the one it gave back.
async function chosenKey(pick: KeyPick, label: string, kept: readonly SshKeyView[]): Promise<SshKeyView | null> {
  if (pick.choice === KEY_CHOICE.paste) {
    return storePasted(pick, label);
  }
  if (pick.made?.key.id === pick.choice) {
    return pick.made.key;
  }
  return kept.find((key) => key.id === pick.choice) ?? null;
}

/** The key to sign in with, chosen in one list and used once chosen; a pasted one is stored then. */
function KeyChoice({
  where,
  dashboardAddress,
  onChosen,
  onKeyStored,
}: {
  where: Where;
  dashboardAddress: string;
  onChosen: (key: ChosenKey, made: MadeSshKeyView | null) => void;
  onKeyStored: (keyId: string) => void;
}) {
  const keys = useQuery(sshKeysQuery);
  const [pick, setPick] = useState(keyPickOf(KEY_CHOICE.none));
  const use = useMutation({
    mutationFn: () => chosenKey(pick, where.label, keys.data ?? []),
    onSuccess: (key) => {
      if (key === null) return;
      if (pick.choice === KEY_CHOICE.paste) onKeyStored(key.id);
      onChosen({ id: key.id, fingerprint: key.fingerprint }, madeAs(pick, key.id));
    },
  });
  const waiting = pick.choice === KEY_CHOICE.none || pick.choice === KEY_CHOICE.make;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    use.mutate();
  };
  return (
    <form className="step-form" onSubmit={submit}>
      <SshKeyPicker
        label={where.label}
        pick={pick}
        onPick={setPick}
        onKeyStored={onKeyStored}
        user={where.user}
        dashboardAddress={dashboardAddress}
      />
      <button type="submit" disabled={waiting || use.isPending}>
        {text.useKey}
      </button>
      <ErrorNotice error={use.error} />
    </form>
  );
}

// The key made here, while it is the one chosen: its commands and private half stay on the page.
const madeAs = (pick: KeyPick, keyId: string) => (pick.made?.key.id === keyId ? pick.made : null);

/** Connects, shows the host key to compare and what Docker is there, and switches the host once a person trusts it. */
function Connect({
  where,
  chosen,
  hostId,
  onSwitched,
}: {
  where: Where;
  chosen: ChosenKey;
  hostId: string;
  onSwitched: (host: HostView) => void;
}) {
  const queryClient = useQueryClient();
  const probe = useMutation({
    mutationFn: () => {
      const { address, port, user } = where;
      return api<PendingSshHostView>("POST", apiPath(API_ROUTES.sshHostSwitch, { hostId }), {
        address,
        port,
        user,
        keyId: chosen.id,
      });
    },
  });
  const confirm = useMutation({
    mutationFn: (pendingId: string) => api<HostView>("POST", apiPath(API_ROUTES.sshHostConfirm, { pendingId })),
    onSuccess: async (host) => {
      onSwitched(host);
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
    },
  });
  const pending = probe.data;
  return (
    <>
      <p className="small muted">{text.chosen(chosen.fingerprint)}</p>
      {pending === undefined && (
        <p className="row">
          <button type="button" className="primary" disabled={probe.isPending} onClick={() => probe.mutate()}>
            {text.connect}
          </button>
        </p>
      )}
      {pending !== undefined && (
        <div className="stack">
          <DockerFound pending={pending} user={where.user} />
          <p className="small">{text.fingerprintIntro}</p>
          <p className="mono pre-wrap">{pending.hostKeyFingerprint}</p>
          <CommandBlock command={SSH_SETUP.compareHostKey} />
          <button
            type="button"
            className="primary"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate(pending.pendingId)}
          >
            {text.switchTrust}
          </button>
        </div>
      )}
      <ErrorNotice error={probe.error ?? confirm.error} />
    </>
  );
}

function Switched({ host }: { host: HostView }) {
  return (
    <div className="stack" role="status">
      <p className="text-good">{text.switched(host.label)}</p>
      <p className="small">{text.removeRunner}</p>
      <CommandBlock command={SSH_SETUP.removeRunner} />
      <p className="small">
        {text.rootOffer}
        <Link to={`${apiPath(PATHS.host, { hostId: host.id })}#${SSH_HOST_ANCHOR}`}>{text.rootOfferLink}</Link>
      </p>
    </div>
  );
}

/** A step done can be changed: its answer comes back to be edited. */
function Change({ onChange }: { onChange: () => void }) {
  return (
    <button type="button" className="link" onClick={onChange}>
      {text.change}
    </button>
  );
}

/**
 * A runner host switched to SSH, in steps: where it is, the key to sign in with, then connect: the host key compared
 * and trusted, and it is reached over SSH from then on. Cancelled before then, the keys this attempt stored go again;
 * nothing about the host changed.
 */
export function SwitchToSshSteps({
  dashboardAddress,
  onCancelled,
  switching,
}: {
  dashboardAddress: string;
  onCancelled: () => void;
  switching: { hostId: string; label: string };
}) {
  const [where, setWhere] = useState<Where | null>(null);
  const [editingWhere, setEditingWhere] = useState(true);
  const [chosen, setChosen] = useState<ChosenKey | null>(null);
  // Kept on the page while the person runs its setup on the host.
  const [made, setMade] = useState<MadeSshKeyView | null>(null);
  const [stored, setStored] = useState<string[]>([]);
  const [switched, setSwitched] = useState<HostView | null>(null);
  // The keys go with the click, as the page shows them then: never a list from a render before it.
  const cancel = useMutation({
    mutationFn: (keyIds: readonly string[]) =>
      Promise.all(keyIds.map((keyId) => api("DELETE", apiPath(API_ROUTES.sshKey, { keyId })).catch(() => undefined))),
    onSettled: onCancelled,
  });
  const whereDone = editingWhere ? null : where;
  const step = stepOf(whereDone, chosen);
  const finish = (next: Where) => {
    setWhere(next);
    setEditingWhere(false);
  };
  const keep = (key: ChosenKey, madeHere: MadeSshKeyView | null) => {
    setChosen(key);
    setMade(madeHere);
  };
  const keepStored = (keyId: string) => setStored((keys) => [...keys, keyId]);
  return (
    <>
      <p className="add-host-explanation muted">{text.switchExplanation}</p>
      <ol className="step-cards">
        <Step number={STEPS.where} title={text.whereStep} active={step === STEPS.where}>
          {whereDone === null ? (
            <WhereForm initial={where} label={switching.label} onDone={finish} />
          ) : (
            <p className="small">
              <span className="mono">{TEXT.ssh.host.signsInAs(whereDone.user, whereDone.address, whereDone.port)}</span>{" "}
              {switched === null && <Change onChange={() => setEditingWhere(true)} />}
            </p>
          )}
        </Step>
        <Step number={STEPS.key} title={text.keyStep} active={step === STEPS.key}>
          {whereDone !== null && chosen === null && (
            <KeyChoice where={whereDone} dashboardAddress={dashboardAddress} onChosen={keep} onKeyStored={keepStored} />
          )}
          {chosen !== null && (
            <p className="small">
              {text.chosen(chosen.fingerprint)} {switched === null && <Change onChange={() => setChosen(null)} />}
            </p>
          )}
          {whereDone !== null && chosen !== null && made !== null && (
            <KeySetup
              publicLine={made.key.publicLine}
              made={made}
              user={whereDone.user}
              dashboardAddress={dashboardAddress}
            />
          )}
        </Step>
        <Step number={STEPS.connect} title={text.connectStep} active={step === STEPS.connect}>
          {switched !== null && <Switched host={switched} />}
          {switched === null && whereDone !== null && chosen !== null && (
            <Connect
              key={`${JSON.stringify(whereDone)}:${chosen.id}`}
              where={whereDone}
              chosen={chosen}
              hostId={switching.hostId}
              onSwitched={setSwitched}
            />
          )}
        </Step>
      </ol>
      <p className="row">
        <button
          type="button"
          disabled={cancel.isPending}
          onClick={() => (switched === null ? cancel.mutate(stored) : onCancelled())}
        >
          {switched === null ? text.cancel : text.close}
        </button>
      </p>
    </>
  );
}
