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
  name: string;
  fingerprint: string;
}

const STEPS = { where: 1, key: 2, connect: 3 } as const;
const text = TEXT.ssh.add;
const chosenOf = (key: SshKeyView): ChosenKey => ({ id: key.id, name: key.name, fingerprint: key.fingerprint });

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

/** A key Autoheal keeps, the user's own pasted in, or one made now. */
function KeyChoice({
  where,
  onChosen,
  onMade,
}: {
  where: Where;
  // A key stored by this choice is new: cancelling takes it away again.
  onChosen: (key: ChosenKey, isNew: boolean) => void;
  onMade: (made: MadeSshKeyView) => void;
}) {
  const queryClient = useQueryClient();
  const keys = useQuery(sshKeysQuery);
  const refreshKeys = () => queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
  const add = useMutation({
    mutationFn: (key: { name: string; privateKey: string; passphrase: string }) =>
      api<SshKeyView>("POST", API_ROUTES.sshKeys, key),
    onSuccess: (key) => {
      onChosen(chosenOf(key), true);
      void refreshKeys();
    },
  });
  const make = useMutation({
    mutationFn: (passphrase: string) =>
      api<MadeSshKeyView>("POST", API_ROUTES.sshKeysMake, { name: where.label, passphrase }),
    onSuccess: (made) => {
      onMade(made);
      onChosen(chosenOf(made.key), true);
      void refreshKeys();
    },
  });
  const chooseStored = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = keys.data?.find((candidate) => candidate.id === new FormData(event.currentTarget).get("keyId"));
    if (key !== undefined) onChosen(chosenOf(key), false);
  };
  const paste = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    add.mutate({
      name: String(form.get("name") ?? "").trim(),
      privateKey: String(form.get("privateKey") ?? ""),
      passphrase: String(form.get("passphrase") ?? ""),
    });
  };
  const stored = keys.data ?? [];
  return (
    <>
      {stored.length > 0 && (
        <form className="step-form" onSubmit={chooseStored}>
          <label>
            {text.storedKey}
            <select name="keyId" required defaultValue="">
              <option value="" disabled>
                {text.chooseKey}
              </option>
              {stored.map((key) => (
                <option key={key.id} value={key.id}>
                  {`${key.name} (${key.fingerprint})`}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">{text.useKey}</button>
        </form>
      )}
      <form className="step-form" onSubmit={paste}>
        <h4>{text.pasteTitle}</h4>
        <label>
          {text.keyName}
          <input name="name" required defaultValue={where.label} maxLength={SSH_KEY.nameCharacters} />
        </label>
        <label>
          {text.privateKey}
          <textarea
            className="mono"
            name="privateKey"
            required
            rows={4}
            placeholder={text.privateKeyPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          {text.passphrase}
          <input name="passphrase" type="password" autoComplete="off" />
        </label>
        <button type="submit" disabled={add.isPending}>
          {text.useKey}
        </button>
      </form>
      <form
        className="step-form"
        onSubmit={(event) => {
          event.preventDefault();
          make.mutate(String(new FormData(event.currentTarget).get("madePassphrase") ?? ""));
        }}
      >
        <h4>{text.makeTitle}</h4>
        <label>
          {TEXT.connectHost.passphrase}
          <input
            name="madePassphrase"
            type="password"
            autoComplete="new-password"
            maxLength={SSH_KEY.passphraseCharacters}
          />
          <span className="hint">{TEXT.connectHost.makePassphraseHint}</span>
        </label>
        <button type="submit" disabled={make.isPending}>
          {text.make}
        </button>
      </form>
      <ErrorNotice error={keys.error ?? add.error ?? make.error} />
    </>
  );
}

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
      <p className="small muted">{text.chosen(chosen.name, chosen.fingerprint)}</p>
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
  const keep = (key: ChosenKey, isNew: boolean) => {
    setChosen(key);
    if (isNew) setStored((keys) => [...keys, key.id]);
  };
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
          {whereDone !== null && chosen === null && <KeyChoice where={whereDone} onChosen={keep} onMade={setMade} />}
          {chosen !== null && (
            <p className="small">
              {text.chosen(chosen.name, chosen.fingerprint)}{" "}
              {switched === null && <Change onChange={() => setChosen(null)} />}
            </p>
          )}
          {whereDone !== null && made !== null && (
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
