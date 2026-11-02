import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostHealthView, HostMetricsView, HostView } from "../../../src/shared/api.js";
import { HOST_KIND, HOST_SECTIONS, SSH_STATE } from "../../../src/shared/constants.js";
import { driveProblems, type DriveProblems } from "../../../src/shared/drive-health.js";
import type { DriveHealth } from "../../../src/shared/protocol.js";
import { TimeAgo } from "../components/common.js";
import { TEXT } from "../constants.js";
import { bytes, celsius, dateTimeIn, duration, loadAverage, timeAgo } from "../format.js";
import { hostPackagesQuery } from "../queries.js";

export interface Fact {
  label: string;
  value: ReactNode;
}

interface Reading {
  label: string;
  celsius: number;
}

const sumOf = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

function memoryOf(memory: HostMetricsView["memory"] | null, health: HostHealthView): string {
  if (memory === null) {
    return TEXT.hostSystem.memoryOf(
      bytes(health.memoryTotalBytes - health.memoryAvailableBytes),
      null,
      bytes(health.memoryTotalBytes),
    );
  }
  return TEXT.hostSystem.memoryOf(bytes(memory.usedBytes), bytes(memory.cacheBytes), bytes(memory.totalBytes));
}

function swapOf(memory: HostMetricsView["memory"] | null): string {
  return memory === null
    ? TEXT.none
    : TEXT.hostSystem.swapOf(bytes(memory.swapUsedBytes), bytes(memory.swapTotalBytes));
}

function diskSpaceOf(disks: HostHealthView["disks"]): string {
  if (disks.length === 0) {
    return TEXT.none;
  }
  return TEXT.hostSystem.disksOf(
    bytes(sumOf(disks.map((disk) => disk.usedBytes))),
    bytes(sumOf(disks.map((disk) => disk.availableBytes))),
    bytes(sumOf(disks.map((disk) => disk.totalBytes))),
  );
}

function Temperatures({ readings }: { readings: readonly Reading[] }) {
  if (readings.length === 0) {
    return <>{TEXT.none}</>;
  }
  return (
    <span className="temperatures">
      {readings.map((reading, index) => (
        <span key={`${reading.label}-${index}`} className="temperature">
          {TEXT.hostSystem.reading(reading.label, celsius(reading.celsius))}
        </span>
      ))}
    </span>
  );
}

// Healthy reads green; failing red; only worn amber.
function toneOf({ problems, failing }: DriveProblems): string {
  if (problems.length === 0) {
    return "text-good";
  }
  return failing ? "text-danger" : "text-warning";
}

// Each drive smartd reads: healthy or what is wrong with it, as its task words it, and how old the reading is.
function DriveHealthList({ drives }: { drives: readonly DriveHealth[] }) {
  const now = Date.now();
  return (
    <ul className="drive-health">
      {drives.map((drive) => {
        const found = driveProblems(drive, now);
        return (
          <li key={drive.device}>
            <span className="mono">{drive.device}</span>{" "}
            <span className={toneOf(found)}>
              {found.problems.length === 0 ? TEXT.hostSystem.driveHealthy : found.problems.join(TEXT.listSemicolon)}
            </span>
            {found.heat !== null && (
              <span className="text-warning">
                {TEXT.listSemicolon}
                {found.heat}
              </span>
            )}
            <span className="muted small">
              {TEXT.separator}
              {TEXT.hostSystem.driveReadAgo} <TimeAgo timestamp={drive.readAt} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// The host's own clock, which its time zone sets; unknown without one.
function hostClockOf(timeZone: string | null | undefined): string {
  if (timeZone === null || timeZone === undefined) {
    return TEXT.none;
  }
  return dateTimeIn(Date.now(), timeZone) ?? TEXT.none;
}

function HostnameAt({ name, address }: { name: string; address: string | null }) {
  return (
    <>
      {name}
      {address !== null && <span className="muted"> ({address})</span>}
    </>
  );
}

export function LoadAverages({ averages }: { averages: readonly number[] }) {
  return (
    <>
      {TEXT.hostSystem.loadPeriods.map((period, index) => (
        <span key={period}>
          {index > 0 && TEXT.separator}
          {loadAverage(averages[index] ?? 0)}
          <span className="muted">{period}</span>
        </span>
      ))}
    </>
  );
}

/** From the host's last check, else from Ubuntu's own count; waiting ones lead to the updates further down. */
function PackageUpdates({ hostId, notifierCount }: { hostId: string; notifierCount: number | null }) {
  const packages = useQuery(hostPackagesQuery(hostId));
  if (packages.isPending) {
    return <>{TEXT.none}</>;
  }
  const checked = packages.data;
  const fromCheck = checked !== undefined && checked.checkedAt !== null;
  const count = fromCheck ? checked.packages.length : notifierCount;
  const security = fromCheck ? checked.packages.filter((item) => item.security).length : 0;
  if (count === null) {
    return <>{TEXT.none}</>;
  }
  if (count === 0) {
    return <>{TEXT.hostSystem.upToDate}</>;
  }
  return <a href={`#${HOST_SECTIONS.updates}`}>{TEXT.hostSystem.updatesOf(count, security)}</a>;
}

/** "connected over SSH since 3 minutes ago", and why when it is not. */
export function sshConnectionText(host: HostView): string {
  const ssh = host.ssh ?? null;
  if (ssh === null) {
    return TEXT.ssh.states[SSH_STATE.closed];
  }
  const since = TEXT.ssh.since(TEXT.ssh.states[ssh.state], timeAgo(ssh.since));
  return ssh.reason === null ? since : `${since}${TEXT.separator}${ssh.reason}`;
}

// How the control plane reaches the host: over SSH, from inside its own container, or through the host's runner.
function connectionFact(host: HostView): Fact {
  if (host.kind === HOST_KIND.ssh) {
    return { label: TEXT.ssh.connection, value: sshConnectionText(host) };
  }
  if (host.kind === HOST_KIND.local) {
    const waiting = host.inPlace?.problem ?? null;
    const value = waiting === null ? TEXT.ssh.inPlace : `${TEXT.ssh.inPlaceWaiting}${TEXT.separator}${waiting}`;
    return { label: TEXT.ssh.connection, value };
  }
  return { label: TEXT.hostSystem.runner, value: <span className="mono">{host.runnerVersion ?? TEXT.none}</span> };
}

// Two lists side by side, as drawn: what the machine is and holds on the left, how it runs on the right.
function factsOf(host: HostView, health: HostHealthView): [Fact[], Fact[]] {
  const memory = host.metrics?.memory ?? null;
  const drives = (health.driveTemperatures ?? []).map((drive) => ({ label: drive.device, celsius: drive.celsius }));
  const left = [
    {
      label: TEXT.hostSystem.hostname,
      value: <HostnameAt name={health.hostname ?? host.label} address={health.address ?? null} />,
    },
    connectionFact(host),
    { label: TEXT.hostSystem.time, value: hostClockOf(health.packages?.timeZone) },
    { label: TEXT.hostSystem.processor, value: TEXT.hostSystem.processorOf(health.cpuModel ?? null, health.cpuCount) },
    { label: TEXT.hostSystem.processes, value: health.processes ?? TEXT.none },
    { label: TEXT.hostSystem.cpuTemperatures, value: <Temperatures readings={health.cpuTemperatures ?? []} /> },
    { label: TEXT.hostSystem.drives, value: <Temperatures readings={drives} /> },
    ...((health.drives ?? []).length === 0
      ? []
      : [{ label: TEXT.hostSystem.driveHealth, value: <DriveHealthList drives={health.drives ?? []} /> }]),
    { label: TEXT.hostSystem.memory, value: memoryOf(memory, health) },
    { label: TEXT.hostSystem.disks, value: diskSpaceOf(health.disks) },
    { label: TEXT.hosts.lastReport, value: <TimeAgo timestamp={host.lastHeartbeatAt} /> },
  ];
  const right = [
    { label: TEXT.hostSystem.operatingSystem, value: health.operatingSystem ?? TEXT.none },
    { label: TEXT.hostSystem.docker, value: <span className="mono">{health.dockerVersion ?? TEXT.none}</span> },
    {
      label: TEXT.hostSystem.kernel,
      value: <span className="mono">{TEXT.hostSystem.kernelOn(health.kernel, health.architecture)}</span>,
    },
    { label: TEXT.hostSystem.uptime, value: duration(health.uptimeSeconds) },
    { label: TEXT.hostSystem.load, value: <LoadAverages averages={health.loadAverage} /> },
    { label: TEXT.hostSystem.swap, value: swapOf(memory) },
    {
      label: TEXT.hostSystem.updates,
      value: <PackageUpdates hostId={host.id} notifierCount={health.pendingUpdates} />,
    },
  ];
  return [left, right];
}

export function FactList({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="system-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The host at a glance: what it is, how it runs, what waits. */
export function HostSystem({ host, health }: { host: HostView; health: HostHealthView }) {
  const [left, right] = factsOf(host, health);
  return (
    <section className="card host-system" aria-labelledby="host-system-title">
      <h2 id="host-system-title">{TEXT.hostSystem.title}</h2>
      <div className="system-columns">
        <FactList facts={left} />
        <FactList facts={right} />
      </div>
    </section>
  );
}
