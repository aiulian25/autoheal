import { CONTAINER_STATE_RUNNING, HOST_STATE } from "../../shared/constants.js";
import { hasUpdate, type ContainerView, type HostView } from "../../shared/api.js";
import {
  JARVIS_KIND,
  JARVIS_LIMITS,
  safeName,
  spokenList,
  spokenName,
  type JarvisSummary,
} from "../../shared/jarvis.js";
import { isCounted } from "../inventory/host-views.js";
import { isBuildContainer, kindOf, type JarvisCandidate } from "./jarvis-filter.js";

type Facts = { say: string[]; text: string[] };

const of = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// Counted as the host's card counts them, so the two agree, and without build containers.
const counted = (containers: readonly ContainerView[]) =>
  containers.filter(isCounted).filter((container) => !isBuildContainer(container.name, container.image));
const isUp = (host: HostView) => host.state === HOST_STATE.online;
const running = (containers: readonly ContainerView[]) =>
  containers.filter(({ state }) => state === CONTAINER_STATE_RUNNING).length;

// What needs someone: every word from a template, every number counted here.
function concerns(containers: readonly ContainerView[], tasks: readonly JarvisCandidate[], withHost: boolean): Facts {
  const facts: Facts = { say: [], text: [] };
  const unwell = containers.filter(({ problem }) => problem !== null);
  if (unwell.length > JARVIS_LIMITS.namesSpoken) {
    facts.say.push(`${unwell.length} containers need a look.`);
    facts.text.push(`${unwell.length} containers need a look.`);
  } else if (unwell.length > 0) {
    const place = ({ name, hostLabel }: ContainerView) => `${name}${withHost ? ` on ${hostLabel}` : ""}`;
    const spoken = ({ name, hostLabel }: ContainerView) =>
      `${spokenName(safeName(name))}${withHost ? ` on ${spokenName(safeName(hostLabel))}` : ""}`;
    const verb = unwell.length === 1 ? "needs" : "need";
    facts.say.push(`${unwell.map(spoken).join(" and ")} ${verb} a look.`);
    facts.text.push(`${unwell.map(place).join(", ")} ${verb} a look.`);
  }
  const hostsOf = (kind: string) => [
    ...new Set(
      tasks.filter(({ detectorKey }) => kindOf(detectorKey) === kind).map(({ hostLabel }) => safeName(hostLabel)),
    ),
  ];
  const told = (hosts: readonly string[], sentence: (names: string) => string) => {
    if (hosts.length === 0) return;
    facts.say.push(sentence(withHost ? spokenList(hosts) : "It"));
    facts.text.push(sentence(withHost ? hosts.join(", ") : "It"));
  };
  told(hostsOf(JARVIS_KIND.disk), (names) => `${names} has a disk nearly full.`);
  told(hostsOf(JARVIS_KIND.drive), (names) => `${names} has a drive reporting trouble.`);
  told(hostsOf(JARVIS_KIND.reboot), (names) => `${names} would like a restart.`);
  const updates = containers.filter(hasUpdate).length;
  if (updates > 0) {
    const line = `${of(updates, "update is", "updates are")} waiting.`;
    facts.say.push(line);
    facts.text.push(line);
  }
  return facts;
}

const NOTHING = "Nothing needs you.";
const withConcerns = (opening: string, facts: Facts): JarvisSummary => ({
  say: [opening, ...(facts.say.length === 0 ? [NOTHING] : facts.say)].join(" "),
  text: [opening.replace(", sir", ""), ...(facts.text.length === 0 ? [NOTHING] : facts.text)].join(" "),
});

/** All the machines, in a couple of sentences. */
export function fleetSummary(
  hosts: readonly HostView[],
  allContainers: readonly ContainerView[],
  tasks: readonly JarvisCandidate[],
): JarvisSummary {
  const active = hosts.filter(({ state }) => state !== HOST_STATE.revoked);
  const up = active.filter(isUp);
  const down = active.filter((host) => !isUp(host)).map(({ label }) => safeName(label));
  const known = new Set(up.map(({ id }) => id));
  const containers = counted(allContainers).filter(({ hostId }) => known.has(hostId));
  const counts = `${running(containers)} of ${of(containers.length, "container", "containers")} running`;
  const machines =
    down.length === 0
      ? `${active.length === 1 ? "The 1 machine is" : `All ${active.length} machines are`} up, sir, with ${counts}.`
      : `${up.length} of ${of(active.length, "machine is", "machines are")} up, sir, with ${counts}.`;
  const facts = concerns(containers, tasks, true);
  if (down.length > 0) {
    const verb = down.length === 1 ? "is" : "are";
    facts.say.unshift(`${spokenList(down)} ${verb} not answering.`);
    facts.text.unshift(`${down.join(", ")} ${verb} not answering.`);
  }
  return withConcerns(machines, facts);
}

/** One machine. */
export function hostSummary(
  host: HostView,
  allContainers: readonly ContainerView[],
  tasks: readonly JarvisCandidate[],
): JarvisSummary {
  const name = safeName(host.label);
  const spoken = spokenName(name);
  if (!isUp(host)) {
    return { say: `${spoken} is not answering, sir.`, text: `${name} is not answering.` };
  }
  const containers = counted(allContainers).filter(({ hostId }) => hostId === host.id);
  const counts = `${running(containers)} of ${of(containers.length, "container", "containers")} running`;
  const facts = concerns(
    containers,
    tasks.filter(({ hostId }) => hostId === host.id),
    false,
  );
  const summary = withConcerns(`${spoken} is up, sir, with ${counts}.`, facts);
  return { say: summary.say, text: summary.text.replace(spoken, name) };
}
