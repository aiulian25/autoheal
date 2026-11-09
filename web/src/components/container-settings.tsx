import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ROUTES, apiPath, type JobView, type ResourceAdviceView } from "../../../src/shared/api.js";
import {
  JOB_STATUS,
  MOUNT_KIND,
  MOUNT_KINDS,
  PORT_PROTOCOL,
  PORT_PROTOCOLS,
  RESOURCE_ADVICE_TEXT,
  RESTART_POLICIES,
  RESTART_POLICY_ON_FAILURE,
  sizeText,
  type PortProtocol,
} from "../../../src/shared/constants.js";
import type { ContainerSettings, SettingsAnswer } from "../../../src/shared/protocol.js";
import { ReadableError, api } from "../api-client.js";
import { JOB_REFRESH_MILLISECONDS, NEW_PORT_DEFAULTS, TEXT } from "../constants.js";
import { useAskInPlace } from "./ask-in-place.js";
import { ErrorNotice, Loading } from "./common.js";
import { LatestJob, isWaiting } from "./container-actions.js";
import { Icon } from "./icons.js";

type Pair = ContainerSettings["environment"][number];
type Port = ContainerSettings["ports"][number];
type Mount = ContainerSettings["mounts"][number];

const text = TEXT.containerSettings;
const replaced = <Item,>(items: readonly Item[], index: number, item: Item) =>
  items.map((each, at) => (at === index ? item : each));
const without = <Item,>(items: readonly Item[], index: number) => items.filter((_each, at) => at !== index);
const BLANK_PAIR: Pair = { name: "", value: "" };
const BLANK_PORT: Port = { ...NEW_PORT_DEFAULTS, protocol: PORT_PROTOCOL.tcp, address: "" };
const BLANK_MOUNT: Mount = { kind: MOUNT_KIND.bind, source: "", target: "", readOnly: false };

// What each field of a list's rows holds, above the first, in the rows' order: fields share the width, then the
// narrower menus and tick boxes.
function Heading({ fields, choices = [], checks = [] }: { fields: string[]; choices?: string[]; checks?: string[] }) {
  return (
    <div className="setting-entry setting-heading" aria-hidden="true">
      {fields.map((field) => (
        <span key={field}>{field}</span>
      ))}
      {choices.map((choice) => (
        <span key={choice} className="setting-choice">
          {choice}
        </span>
      ))}
      {checks.map((check) => (
        <span key={check} className="setting-check">
          {check}
        </span>
      ))}
    </div>
  );
}

function RemoveRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-button danger" title={label} aria-label={label} onClick={onClick}>
      <Icon name="trash" />
    </button>
  );
}

// Names and values, as the environment and the labels are.
function PairsEditor({ title, pairs, onChange }: { title: string; pairs: Pair[]; onChange: (pairs: Pair[]) => void }) {
  return (
    <fieldset className="settings-section">
      <legend>{title}</legend>
      {pairs.length > 0 && <Heading fields={[text.name, text.value]} />}
      {pairs.map((pair, index) => (
        <div className="setting-entry" key={index}>
          <input
            className="mono"
            aria-label={`${title} ${text.name} ${index + 1}`}
            value={pair.name}
            spellCheck={false}
            onChange={(event) => onChange(replaced(pairs, index, { ...pair, name: event.target.value }))}
          />
          <input
            className="mono"
            aria-label={`${title} ${text.value} ${index + 1}`}
            value={pair.value}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onChange(replaced(pairs, index, { ...pair, value: event.target.value }))}
          />
          <RemoveRow label={text.removeRow(pair.name)} onClick={() => onChange(without(pairs, index))} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...pairs, BLANK_PAIR])}>
        {text.add}
      </button>
    </fieldset>
  );
}

function PortsEditor({ ports, onChange }: { ports: Port[]; onChange: (ports: Port[]) => void }) {
  const number = (value: string) => Number.parseInt(value, 10) || 0;
  return (
    <fieldset className="settings-section">
      <legend>{text.ports}</legend>
      {ports.length > 0 && <Heading fields={[text.published, text.address, text.target]} choices={[text.protocol]} />}
      {ports.map((port, index) => (
        <div className="setting-entry" key={index}>
          <input
            type="number"
            aria-label={`${text.published} ${index + 1}`}
            value={port.published}
            onChange={(event) => onChange(replaced(ports, index, { ...port, published: number(event.target.value) }))}
          />
          <input
            aria-label={`${text.address} ${index + 1}`}
            placeholder={text.anyAddress}
            value={port.address}
            onChange={(event) => onChange(replaced(ports, index, { ...port, address: event.target.value.trim() }))}
          />
          <input
            type="number"
            aria-label={`${text.target} ${index + 1}`}
            value={port.target}
            onChange={(event) => onChange(replaced(ports, index, { ...port, target: number(event.target.value) }))}
          />
          <select
            aria-label={`${text.protocol} ${index + 1}`}
            value={port.protocol}
            onChange={(event) =>
              onChange(replaced(ports, index, { ...port, protocol: event.target.value as PortProtocol }))
            }
          >
            {PORT_PROTOCOLS.map((protocol) => (
              <option key={protocol} value={protocol}>
                {protocol}
              </option>
            ))}
          </select>
          <RemoveRow label={text.removeRow(String(port.published))} onClick={() => onChange(without(ports, index))} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...ports, BLANK_PORT])}>
        {text.add}
      </button>
    </fieldset>
  );
}

function MountsEditor({ mounts, onChange }: { mounts: Mount[]; onChange: (mounts: Mount[]) => void }) {
  return (
    <fieldset className="settings-section">
      <legend>{text.mounts}</legend>
      {mounts.length > 0 && (
        <Heading fields={[text.source, text.mountTarget]} choices={[text.kind]} checks={[text.readOnly]} />
      )}
      {mounts.map((mount, index) => (
        <div className="setting-entry" key={index}>
          <input
            className="mono"
            aria-label={`${text.source} ${index + 1}`}
            value={mount.source}
            spellCheck={false}
            onChange={(event) => onChange(replaced(mounts, index, { ...mount, source: event.target.value }))}
          />
          <input
            className="mono"
            aria-label={`${text.mountTarget} ${index + 1}`}
            value={mount.target}
            spellCheck={false}
            onChange={(event) => onChange(replaced(mounts, index, { ...mount, target: event.target.value }))}
          />
          <select
            aria-label={`${text.kind} ${index + 1}`}
            value={mount.kind}
            onChange={(event) =>
              onChange(replaced(mounts, index, { ...mount, kind: event.target.value as Mount["kind"] }))
            }
          >
            {MOUNT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {text.kinds[kind]}
              </option>
            ))}
          </select>
          <span className="setting-check">
            <input
              type="checkbox"
              aria-label={`${text.readOnly} ${index + 1}`}
              checked={mount.readOnly}
              onChange={(event) => onChange(replaced(mounts, index, { ...mount, readOnly: event.target.checked }))}
            />
          </span>
          <RemoveRow label={text.removeRow(mount.target)} onClick={() => onChange(without(mounts, index))} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...mounts, BLANK_MOUNT])}>
        {text.add}
      </button>
    </fieldset>
  );
}

function RestartEditor({
  restart,
  onChange,
}: {
  restart: ContainerSettings["restart"];
  onChange: (restart: ContainerSettings["restart"]) => void;
}) {
  return (
    <fieldset className="settings-section">
      <legend>{text.restart}</legend>
      <div className="setting-entry">
        <select
          aria-label={text.restart}
          value={restart.policy}
          onChange={(event) =>
            onChange({ ...restart, policy: event.target.value as ContainerSettings["restart"]["policy"] })
          }
        >
          {RESTART_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {text.policies[policy]}
            </option>
          ))}
        </select>
        {restart.policy === RESTART_POLICY_ON_FAILURE && (
          <label>
            {text.retries}
            <input
              type="number"
              min={0}
              value={restart.retries}
              onChange={(event) => onChange({ ...restart, retries: Number.parseInt(event.target.value, 10) || 0 })}
            />
          </label>
        )}
      </div>
    </fieldset>
  );
}

async function readSettings(path: string): Promise<ContainerSettings> {
  const answer = await api<SettingsAnswer>("GET", path);
  if (answer.settings === null) {
    throw new ReadableError(answer.error ?? "");
  }
  return answer.settings;
}

// Its limit as last read: nothing to say until a reading came.
function limitSentence(limitBytes: number | null | undefined): string[] {
  if (limitBytes === undefined) {
    return [];
  }
  if (limitBytes === null) {
    return [RESOURCE_ADVICE_TEXT.noLimit];
  }
  return [RESOURCE_ADVICE_TEXT.limit(sizeText(limitBytes))];
}

// What its memory readings suggest for its limit, and how often it ran out: advice for where it is defined.
function ResourceAdvice({ hostId, containerName }: { hostId: string; containerName: string }) {
  const advice = useQuery({
    queryKey: ["resource-advice", hostId, containerName],
    queryFn: () =>
      api<ResourceAdviceView>("GET", apiPath(API_ROUTES.containerResourceAdvice, { hostId, containerName })),
  });
  if (advice.data === undefined) {
    return null;
  }
  const { memory, limitBytes, oomKills } = advice.data;
  const sentences = [
    RESOURCE_ADVICE_TEXT.advice(memory),
    ...limitSentence(limitBytes),
    ...(oomKills > 0 ? [RESOURCE_ADVICE_TEXT.oomKills(oomKills)] : []),
  ];
  return (
    <p className={oomKills > 0 ? "notice warning small" : "muted small"} role="note">
      {sentences.join(" ")}
    </p>
  );
}

/**
 * A container's own settings under its row, as its runner read them: its environment and labels, published
 * ports, volumes and folders, and what Docker does when it stops. Applying recreates it, as an update does.
 */
export function ContainerSettingsEditor({
  hostId,
  containerName,
  onClose,
}: {
  hostId: string;
  containerName: string;
  onClose: () => void;
}) {
  const asking = useAskInPlace();
  const path = apiPath(API_ROUTES.containerSettings, { hostId, containerName });
  const read = useQuery({
    queryKey: ["container-settings", hostId, containerName],
    queryFn: () => readSettings(path),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<ContainerSettings | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const apply = useMutation({
    mutationFn: (settings: ContainerSettings) => api<JobView>("PUT", path, settings),
    onSuccess: (job) => setJobId(job.id),
  });
  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api<JobView>("GET", apiPath(API_ROUTES.job, { jobId: jobId! })),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data !== undefined && !isWaiting(query.state.data) ? false : JOB_REFRESH_MILLISECONDS,
  });
  // Once the container runs with its new settings, they are read again from it.
  const finished = job.data?.status === JOB_STATUS.succeeded;
  useEffect(() => {
    if (finished) {
      setDraft(null);
      void read.refetch();
    }
  }, [finished]);
  if (read.data === undefined) {
    return read.error ? <ErrorNotice error={read.error} /> : <Loading />;
  }
  const settings = draft ?? read.data;
  const change = (part: Partial<ContainerSettings>) => setDraft({ ...settings, ...part });
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(read.data);
  const confirmApply = () => {
    asking.confirm(text.confirm(containerName), () => apply.mutate(settings));
  };
  return (
    <section className="settings-panel stack" aria-label={text.title(containerName)}>
      <header className="terminal-head">
        <strong>{text.title(containerName)}</strong>
        <button type="button" className="icon-button" title={text.close} aria-label={text.close} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <ResourceAdvice hostId={hostId} containerName={containerName} />
      <p className="muted small">{text.hidden}</p>
      <PairsEditor
        title={text.environment}
        pairs={settings.environment}
        onChange={(environment) => change({ environment })}
      />
      <PortsEditor ports={settings.ports} onChange={(ports) => change({ ports })} />
      <MountsEditor mounts={settings.mounts} onChange={(mounts) => change({ mounts })} />
      <RestartEditor restart={settings.restart} onChange={(restart) => change({ restart })} />
      <PairsEditor title={text.labels} pairs={settings.labels} onChange={(labels) => change({ labels })} />
      <p className="muted small">{text.composeNote}</p>
      <div className="row">
        <button type="button" className="primary" disabled={!changed || apply.isPending} onClick={confirmApply}>
          {text.apply}
        </button>
        {!changed && <span className="muted small">{text.unchanged}</span>}
      </div>
      {asking.question}
      <ErrorNotice error={apply.error} />
      {job.data !== undefined && <LatestJob job={job.data} />}
    </section>
  );
}
