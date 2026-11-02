import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { API_ROUTES, apiPath, type HostView, type JobView } from "../../../src/shared/api.js";
import { DOCKER_OWN_NETWORKS, JOB_ACTION, JOB_STATUS, NETWORK_NAME } from "../../../src/shared/constants.js";
import { rangeOf, rangesOverlap, type NetworkReport, type NewNetwork } from "../../../src/shared/networks.js";
import { api } from "../api-client.js";
import { CopyButton, ErrorNotice, Loading } from "../components/common.js";
import { isWaiting } from "../components/container-actions.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import { hostContainersQuery } from "../queries.js";
import { Choices, Row } from "./add-container.js";

const text = TEXT.hostNetworks.create;
const BRIDGE = "bridge";
const KIND = { bridge: "bridge", internal: "internal", other: "other" } as const;
type Kind = (typeof KIND)[keyof typeof KIND];
const ADDRESSES = { automatic: "automatic", other: "other" } as const;
type Addresses = (typeof ADDRESSES)[keyof typeof ADDRESSES];

interface Check {
  ok: boolean;
  line: string;
}

function nameCheck(name: string, networks: readonly NetworkReport[]): Check {
  if (!NETWORK_NAME.test(name)) return { ok: false, line: text.nameInvalid };
  if (networks.some((network) => network.name === name)) return { ok: false, line: text.nameTaken };
  return { ok: true, line: text.nameFree };
}

// Docker keeps its own choice clear of the rest; only a range a person wrote needs looking at.
function rangeCheck(subnet: string, networks: readonly NetworkReport[]): Check {
  if (rangeOf(subnet) === null) return { ok: false, line: text.rangeInvalid };
  const clash = networks.find((network) => network.subnet !== null && rangesOverlap(network.subnet, subnet));
  return clash === undefined ? { ok: true, line: text.rangeFree } : { ok: false, line: text.rangeClash(clash.name) };
}

function Created({ job, name, host, onClose }: { job: JobView; name: string; host: string; onClose: () => void }) {
  const line = text.composeLine(name);
  return (
    <>
      <h2>{text.doneTitle(name, host)}</h2>
      <div className="connect-host-body install-body">
        <p>{job.outcome}</p>
        <div className="install-rows">
          <Row label={TEXT.hostNetworks.facts.addresses} value={<span className="mono">{job.output}</span>} />
          <Row label={text.inCompose} value={<span className="mono">{line}</span>} />
        </div>
        <CopyButton text={line} />
        <p className="small muted">{text.offered}</p>
      </div>
      <div className="connect-host-foot">
        <button type="button" onClick={onClose}>
          {text.close}
        </button>
      </div>
    </>
  );
}

/** A new network: only its name needs typing. It stays open until the host has answered. */
export function NewNetworkDialog({
  host,
  networks,
  lastJob,
  onChanged,
  onClose,
}: {
  host: HostView;
  networks: readonly NetworkReport[];
  lastJob: JobView | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const containers = useQuery(hostContainersQuery(host.id));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>(KIND.bridge);
  const [driver, setDriver] = useState("");
  const [parent, setParent] = useState("");
  const [addresses, setAddresses] = useState<Addresses>(ADDRESSES.automatic);
  const [subnet, setSubnet] = useState("");
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const create = useMutation({
    mutationFn: (network: NewNetwork) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId: host.id }), {
        action: JOB_ACTION.createNetwork,
        network,
      }),
    onSuccess: onChanged,
  });
  const job = create.data !== undefined && lastJob?.id === create.data.id ? lastJob : (create.data ?? null);
  const trimmedName = name.trim();
  const checks = [
    ...(trimmedName === "" ? [] : [nameCheck(trimmedName, networks)]),
    ...(addresses === ADDRESSES.other && subnet !== "" ? [rangeCheck(subnet, networks)] : []),
  ];
  const usable = (containers.data ?? []).filter((container) => container.handsOff === null);
  const bridges = networks.filter(
    (network) => network.driver === BRIDGE && !DOCKER_OWN_NETWORKS.has(network.name),
  ).length;
  const ready =
    trimmedName !== "" &&
    checks.every((check) => check.ok) &&
    (addresses === ADDRESSES.automatic || subnet !== "") &&
    (kind !== KIND.other || driver !== "");
  const submit = () =>
    create.mutate({
      name: trimmedName,
      driver: kind === KIND.other ? driver : BRIDGE,
      internal: kind === KIND.internal,
      subnet: addresses === ADDRESSES.other ? subnet : null,
      parent: kind === KIND.other && parent !== "" ? parent : null,
      containers: [...members],
    });
  const toggle = (member: string) =>
    setMembers((current) =>
      current.has(member) ? new Set([...current].filter((other) => other !== member)) : new Set([...current, member]),
    );
  const ended = job !== null && !isWaiting(job);
  const failed = ended && job.status === JOB_STATUS.failed;
  return (
    <dialog ref={dialog} className="connect-host add-container-dialog" onClose={onClose}>
      {ended && !failed ? (
        <Created job={job} name={trimmedName} host={host.label} onClose={onClose} />
      ) : (
        <>
          <h2>{text.title(host.label)}</h2>
          <div className="connect-host-body install-body">
            <div className="install-rows">
              <Row
                label={text.name}
                value={
                  <input
                    autoFocus
                    className="mono"
                    aria-label={text.name}
                    value={name}
                    placeholder={text.namePlaceholder}
                    onChange={(event) => setName(event.target.value)}
                  />
                }
              />
              <Row
                label={text.kind}
                value={
                  <Choices<Kind>
                    label={text.kind}
                    options={[
                      { value: KIND.bridge, label: text.kinds.bridge, note: text.kinds.bridgeNote(bridges) },
                      { value: KIND.internal, label: text.kinds.internal, note: text.kinds.internalNote },
                      { value: KIND.other, label: text.kinds.other },
                    ]}
                    selected={(value) => value === kind}
                    onChoose={setKind}
                  />
                }
              />
              {kind === KIND.other && (
                <Row
                  label={text.driver}
                  value={
                    <span className="row">
                      <input
                        className="mono"
                        aria-label={text.driver}
                        value={driver}
                        placeholder={text.driverPlaceholder}
                        onChange={(event) => setDriver(event.target.value)}
                      />
                      <input
                        className="mono"
                        aria-label={text.parent}
                        value={parent}
                        placeholder={text.parentPlaceholder}
                        onChange={(event) => setParent(event.target.value)}
                      />
                    </span>
                  }
                />
              )}
              <Row
                label={text.addresses}
                value={
                  <Choices<Addresses>
                    label={text.addresses}
                    options={[
                      { value: ADDRESSES.automatic, label: text.automatic, note: text.automaticNote },
                      { value: ADDRESSES.other, label: text.otherAddresses },
                    ]}
                    selected={(value) => value === addresses}
                    onChoose={setAddresses}
                  />
                }
              />
              {addresses === ADDRESSES.other && (
                <Row
                  label={text.range}
                  value={
                    <input
                      className="mono"
                      aria-label={text.range}
                      value={subnet}
                      placeholder={text.subnetPlaceholder}
                      onChange={(event) => setSubnet(event.target.value.trim())}
                    />
                  }
                />
              )}
              <Row
                label={text.putOn}
                value={
                  <Choices<string>
                    label={text.putOn}
                    options={usable.map((container) => ({ value: container.name, label: container.name }))}
                    selected={(value) => members.has(value)}
                    onChoose={toggle}
                  />
                }
              />
            </div>
            {checks.length > 0 && (
              <p className="install-checks small">
                {checks.map((check) => (
                  <span key={check.line} className={check.ok ? "muted" : "text-danger"}>
                    {check.ok && <span className="install-tick">✓</span>} {check.line}
                  </span>
                ))}
              </p>
            )}
            {failed && <p className="text-danger small">{job.outcome}</p>}
            <ErrorNotice error={create.error} />
          </div>
          <div className="connect-host-foot">
            {job !== null && isWaiting(job) ? (
              <Loading />
            ) : (
              <button type="button" className="primary" disabled={!ready || create.isPending} onClick={submit}>
                {text.submit}
              </button>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        className="icon-button dialog-close"
        title={text.close}
        aria-label={text.close}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </dialog>
  );
}
