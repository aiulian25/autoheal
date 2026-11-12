import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type HostView,
  type MadeSshKeyView,
  type PendingSshHostView,
  type SshKeyView,
} from "../../../src/shared/api.js";
import {
  HOST_KIND,
  HOST_LABEL_PATTERN,
  HOST_STATE,
  RUNNER_NAS_FOLDER,
  SSH_HOST_FIELDS,
  SSH_KEY,
  SSH_SESSION,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { SSH_SETUP, TEXT } from "../constants.js";
import { timeOfDay } from "../format.js";
import { hostsQuery, settingsQuery, sshKeysQuery } from "../queries.js";
import { CommandBlock, DockerFound, KeySetup } from "./ssh-setup.js";

type Connection = typeof HOST_KIND.ssh | typeof HOST_KIND.runner;

const text = TEXT.connectHost;
// The key list's two ways to a key not stored yet; every other value is a stored key's id.
const KEY_CHOICE = { none: "", paste: "paste", make: "make" } as const;

/** Name and how Autoheal reaches the host: the top of either form. */
function NameAndConnection({
  label,
  connection,
  locked,
  onLabel,
  onConnection,
}: {
  label: string;
  connection: Connection;
  // A runner host already made for this attempt keeps its way in.
  locked: boolean;
  onLabel: (label: string) => void;
  onConnection: (connection: Connection) => void;
}) {
  return (
    <div className="connect-host-row">
      <label>
        {text.name}
        <input
          name="label"
          required={connection === HOST_KIND.ssh}
          pattern={HOST_LABEL_PATTERN.source}
          title={TEXT.hosts.nameRule}
          placeholder={text.namePlaceholder}
          value={label}
          onChange={(event) => onLabel(event.target.value)}
        />
        {connection === HOST_KIND.runner && <span className="hint">{text.nameOptional}</span>}
      </label>
      <label>
        {text.connection}
        <select
          name="connection"
          value={connection}
          disabled={locked}
          onChange={(event) => onConnection(event.target.value as Connection)}
        >
          {([HOST_KIND.ssh, HOST_KIND.runner] as const).map((kind) => (
            <option key={kind} value={kind}>
              {text.via[kind].label}
            </option>
          ))}
        </select>
        <span className="hint">{text.via[connection].note}</span>
      </label>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <footer className="connect-host-foot">{children}</footer>;
}

/** What signing in found: Docker, and the host key to compare before trusting it. */
function Probed({ pending, user }: { pending: PendingSshHostView; user: string }) {
  return (
    <div className="connect-host-result good" role="status">
      <strong>{text.signedIn(user)}</strong>
      <DockerFound pending={pending} user={user} />
      <p className="small">{TEXT.ssh.add.fingerprintIntro}</p>
      <p className="mono pre-wrap">{pending.hostKeyFingerprint}</p>
      <CommandBlock command={SSH_SETUP.compareHostKey} />
    </div>
  );
}

/**
 * Over SSH: where the host is, as whom, with which key (stored, pasted with its passphrase, or made now with one);
 * Test connection signs in and shows the host key, which a person trusts to add the host.
 */
function SshForm({
  header,
  label,
  dashboardAddress,
  onKeyStored,
  onCancel,
  onAdded,
}: {
  header: ReactNode;
  label: string;
  dashboardAddress: string;
  onKeyStored: (keyId: string) => void;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const queryClient = useQueryClient();
  const keys = useQuery(sshKeysQuery);
  const [where, setWhere] = useState<{ address: string; port: number; user: string }>({
    address: "",
    port: SSH_SESSION.defaultPort,
    user: "",
  });
  const [keyChoice, setKeyChoice] = useState<string>(KEY_CHOICE.none);
  const [pasted, setPasted] = useState({ privateKey: "", passphrase: "" });
  const [madePassphrase, setMadePassphrase] = useState("");
  const [made, setMade] = useState<MadeSshKeyView | null>(null);
  const refreshKeys = () => queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
  const make = useMutation({
    mutationFn: () =>
      api<MadeSshKeyView>("POST", API_ROUTES.sshKeysMake, {
        name: label.trim() || text.namePlaceholder,
        passphrase: madePassphrase || null,
      }),
    onSuccess: async (key) => {
      onKeyStored(key.key.id);
      setMade(key);
      await refreshKeys();
      setKeyChoice(key.key.id);
    },
  });
  // A pasted key is stored first, then used as any stored one.
  const probe = useMutation({
    mutationFn: async () => {
      const keyId =
        keyChoice === KEY_CHOICE.paste
          ? (
              await api<SshKeyView>("POST", API_ROUTES.sshKeys, {
                name: label.trim(),
                privateKey: pasted.privateKey,
                passphrase: pasted.passphrase,
              })
            ).id
          : keyChoice;
      if (keyChoice === KEY_CHOICE.paste) {
        onKeyStored(keyId);
        setKeyChoice(keyId);
        void refreshKeys();
      }
      return api<PendingSshHostView>("POST", API_ROUTES.sshHosts, { label: label.trim(), ...where, keyId });
    },
  });
  const confirm = useMutation({
    mutationFn: (pendingId: string) => api<HostView>("POST", apiPath(API_ROUTES.sshHostConfirm, { pendingId })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
      await refreshKeys();
      onAdded();
    },
  });
  // Whatever changes after a test makes it stale: the host must be signed in to again.
  const changed =
    <Value,>(set: (value: Value) => void) =>
    (value: Value) => {
      probe.reset();
      set(value);
    };
  const setWhereField = changed((patch: Partial<typeof where>) => setWhere({ ...where, ...patch }));
  const stored = keys.data ?? [];
  const chosen = stored.find((key) => key.id === keyChoice) ?? null;
  const pending = probe.data;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    probe.mutate();
  };
  const word = SSH_HOST_FIELDS.word.source;
  return (
    <form className="connect-host-body" onSubmit={submit}>
      {header}
      <div className="connect-host-row with-end">
        <label>
          {text.address}
          <input
            className="mono"
            name="address"
            required
            pattern={word}
            placeholder={text.addressPlaceholder}
            value={where.address}
            onChange={(event) => setWhereField({ address: event.target.value.trim() })}
          />
        </label>
        <label>
          {text.port}
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
      <div className="connect-host-row">
        <label>
          {text.user}
          <input
            className="mono"
            name="user"
            required
            pattern={word}
            value={where.user}
            onChange={(event) => setWhereField({ user: event.target.value.trim() })}
          />
        </label>
        <label>
          {text.key}
          <select
            name="key"
            required
            value={keyChoice}
            disabled={make.isPending}
            onChange={(event) => changed(setKeyChoice)(event.target.value)}
          >
            <option value={KEY_CHOICE.none} disabled>
              {text.chooseKey}
            </option>
            {stored.map((key) => (
              <option key={key.id} value={key.id}>
                {`${key.name} · ${key.fingerprint}`}
              </option>
            ))}
            <option value={KEY_CHOICE.paste}>{text.pasteKey}</option>
            <option value={KEY_CHOICE.make}>{text.makeKey}</option>
          </select>
        </label>
      </div>
      {keyChoice === KEY_CHOICE.paste && (
        <>
          <label>
            {text.privateKey}
            <textarea
              className="mono"
              name="privateKey"
              required
              rows={4}
              maxLength={SSH_KEY.privateKeyCharacters}
              placeholder={text.privateKeyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              value={pasted.privateKey}
              onChange={(event) => changed(setPasted)({ ...pasted, privateKey: event.target.value })}
            />
          </label>
          <label>
            {text.passphrase}
            <input
              name="passphrase"
              type="password"
              autoComplete="off"
              maxLength={SSH_KEY.passphraseCharacters}
              value={pasted.passphrase}
              onChange={(event) => changed(setPasted)({ ...pasted, passphrase: event.target.value })}
            />
            <span className="hint">{text.pastePassphraseHint}</span>
          </label>
        </>
      )}
      {keyChoice === KEY_CHOICE.make && (
        <div className="connect-host-row with-end">
          <label>
            {text.passphrase}
            <input
              name="madePassphrase"
              type="password"
              autoComplete="new-password"
              maxLength={SSH_KEY.passphraseCharacters}
              value={madePassphrase}
              onChange={(event) => setMadePassphrase(event.target.value)}
            />
            <span className="hint">{text.makePassphraseHint}</span>
          </label>
          <button type="button" className="connect-host-make" disabled={make.isPending} onClick={() => make.mutate()}>
            {text.make}
          </button>
        </div>
      )}
      {chosen !== null && (
        <details className="connect-host-details" open={made?.key.id === chosen.id}>
          <summary>{made?.key.id === chosen.id ? text.newKeyCommands : text.commands}</summary>
          <KeySetup
            publicLine={chosen.publicLine}
            made={made?.key.id === chosen.id ? made : null}
            user={where.user || null}
            dashboardAddress={dashboardAddress}
          />
        </details>
      )}
      {probe.isPending && (
        <p className="connect-host-result" role="status">
          {text.testing(where.address, where.port, where.user)}
        </p>
      )}
      {pending !== undefined && <Probed pending={pending} user={where.user} />}
      <ErrorNotice error={keys.error ?? make.error ?? probe.error ?? confirm.error} />
      <Footer>
        <button type="button" className="quiet" onClick={onCancel}>
          {text.cancel}
        </button>
        <button type="submit" disabled={probe.isPending || keyChoice === KEY_CHOICE.make}>
          {text.test}
        </button>
        <button
          type="button"
          className="primary"
          disabled={pending === undefined || confirm.isPending}
          onClick={() => pending !== undefined && confirm.mutate(pending.pendingId)}
        >
          {pending === undefined ? text.add : text.trust}
        </button>
      </Footer>
    </form>
  );
}

/** With a runner: its install command, then the wait until it joins, and a new command should its code expire first. */
function RunnerForm({
  header,
  label,
  hosts,
  onEnrolled,
  onCancel,
  onDone,
}: {
  header: ReactNode;
  label: string;
  hosts: readonly HostView[];
  onEnrolled: (hostId: string) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const [isNas, setIsNas] = useState(false);
  const [nasFolder, setNasFolder] = useState<string>(RUNNER_NAS_FOLDER);
  const add = useMutation({
    mutationFn: (address: string) =>
      api<EnrolledHostView>("POST", API_ROUTES.hosts, {
        address,
        ...(isNas ? { nasFolder } : {}),
        ...(label.trim() === "" ? {} : { label: label.trim() }),
      }),
    onSuccess: async (enrolled) => {
      onEnrolled(enrolled.host.id);
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
    },
  });
  // The same host, address and folder: only the code is new.
  const renew = useMutation({
    mutationFn: (hostId: string) =>
      api<EnrolledHostView>("POST", apiPath(API_ROUTES.hostJoinCode, { hostId }), {
        address: add.variables,
        ...(isNas ? { nasFolder } : {}),
      }),
  });
  const added = renew.data ?? add.data;
  const arrived =
    added !== undefined && hosts.some((host) => host.id === added.host.id && host.state === HOST_STATE.online);
  // Read again as the host list refreshes, so a code that runs out while this waits says so.
  const expired = added !== undefined && !arrived && Date.now() >= added.joinCodeExpiresAt;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    add.mutate(String(new FormData(event.currentTarget).get("address") ?? ""));
  };
  const joined = TEXT.hosts.add;
  return (
    <form className="connect-host-body" onSubmit={submit}>
      {header}
      {added === undefined && settings.data !== undefined && (
        <>
          <label>
            {text.runnerAddress}
            <input className="mono" name="address" type="url" required defaultValue={settings.data.runnerAddress} />
          </label>
          <label className="tick">
            <input type="checkbox" name="nas" checked={isNas} onChange={(event) => setIsNas(event.target.checked)} />
            <span>
              {joined.nas}
              <span className="hint">{joined.nasHint}</span>
            </span>
          </label>
          {isNas && (
            <label>
              {joined.nasFolder}
              <input
                className="mono"
                required
                value={nasFolder}
                onChange={(event) => setNasFolder(event.target.value)}
              />
            </label>
          )}
        </>
      )}
      {added !== undefined && (
        <>
          {added.imageCopyCommand !== null && (
            <>
              <p className="small">{joined.nasCopyTitle}</p>
              <p className="small muted">{joined.nasCopySave}</p>
              <CommandBlock command={added.imageCopyCommand} />
              <p className="small muted">{joined.nasCopyPut(nasFolder)}</p>
            </>
          )}
          {!expired && (
            <>
              <p className="small muted">{isNas ? joined.nasPaste : text.paste(added.host.label)}</p>
              <CommandBlock command={added.installCommand} />
            </>
          )}
          {!arrived && (
            <p className="small muted">
              {expired
                ? joined.expired(timeOfDay(added.joinCodeExpiresAt))
                : joined.worksUntil(timeOfDay(added.joinCodeExpiresAt))}
            </p>
          )}
          <div className={arrived ? "connect-host-result good" : "connect-host-result"} role="status">
            <strong>{arrived ? joined.connected(added.host.label) : joined.waiting(added.host.label)}</strong>
            {arrived && (
              <p className="small">
                {joined.dryRunBefore}
                <code>{joined.dryRunSetting}</code>
                {joined.dryRunMiddle}
                <code>{isNas ? joined.nasAfter(nasFolder) : joined.dryRunCommand}</code>
                {joined.dryRunAfter}
              </p>
            )}
            {arrived && isNas && <p className="small muted">{joined.nasEnv(nasFolder)}</p>}
          </div>
        </>
      )}
      <ErrorNotice error={settings.error ?? add.error ?? renew.error} />
      <Footer>
        {!arrived && (
          <button type="button" className="quiet" onClick={onCancel}>
            {text.cancel}
          </button>
        )}
        {expired && (
          <button
            type="button"
            className="primary"
            disabled={renew.isPending}
            onClick={() => renew.mutate(added.host.id)}
          >
            {joined.makeAgain}
          </button>
        )}
        {added === undefined && (
          <button type="submit" className="primary" disabled={add.isPending || settings.data === undefined}>
            {text.makeCommand}
          </button>
        )}
        {arrived && (
          <button type="button" className="primary" onClick={onDone}>
            {text.done}
          </button>
        )}
      </Footer>
    </form>
  );
}

/**
 * The dialog: name and connection, then either way's own fields. Closed without adding, by Cancel or Escape, it takes
 * back what this attempt left: keys it stored, and a runner host that never joined, whose join code then opens nothing.
 */
function ConnectHostDialog({ hosts, onClosed }: { hosts: readonly HostView[]; onClosed: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const [label, setLabel] = useState("");
  const [connection, setConnection] = useState<Connection>(HOST_KIND.ssh);
  const [storedKeys, setStoredKeys] = useState<string[]>([]);
  const [enrolled, setEnrolled] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // The dashboard decides what to take back, not what this dialog last saw: a runner host that joined meanwhile stays,
  // offline or not. Closed only once that is settled, so a failure stays on screen to try again.
  const cancel = useMutation({
    mutationFn: async () => {
      await Promise.all(
        storedKeys.map((keyId) => api("DELETE", apiPath(API_ROUTES.sshKey, { keyId })).catch(() => undefined)),
      );
      if (enrolled !== null) await api("POST", apiPath(API_ROUTES.hostCancelEnrollment, { hostId: enrolled }));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: sshKeysQuery.queryKey });
      onClosed();
    },
  });
  const header = (
    <NameAndConnection
      label={label}
      connection={connection}
      locked={enrolled !== null}
      onLabel={setLabel}
      onConnection={setConnection}
    />
  );
  const runnerAddress = settings.data?.runnerAddress;
  return (
    <dialog
      ref={dialog}
      className="connect-host"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        cancel.mutate();
      }}
    >
      <h2 id={titleId}>{text.title}</h2>
      {connection === HOST_KIND.ssh && runnerAddress !== undefined && (
        <SshForm
          header={header}
          label={label}
          dashboardAddress={new URL(runnerAddress).hostname}
          onKeyStored={(keyId) => setStoredKeys((keys) => [...keys, keyId])}
          onCancel={() => cancel.mutate()}
          onAdded={onClosed}
        />
      )}
      {connection === HOST_KIND.runner && (
        <RunnerForm
          header={header}
          label={label}
          hosts={hosts}
          onEnrolled={setEnrolled}
          onCancel={() => cancel.mutate()}
          onDone={onClosed}
        />
      )}
      <ErrorNotice error={settings.error ?? cancel.error} />
    </dialog>
  );
}

/** The dashed tile at the end of the host grid: it opens the dialog that connects a new host. */
export function ConnectHostTile({ hosts }: { hosts: readonly HostView[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="connect-host-tile" onClick={() => setOpen(true)}>
        <span className="connect-host-plus" aria-hidden>
          <Icon name="plus" />
        </span>
        <span>{text.tile}</span>
      </button>
      {open && <ConnectHostDialog hosts={hosts} onClosed={() => setOpen(false)} />}
    </>
  );
}
