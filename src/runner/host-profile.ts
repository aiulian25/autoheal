import { join } from "node:path";
import { COMPOSE_PROJECT_LABEL, CONTAINER_ACCESS_REFUSALS, HOST_HELPER, HOST_PROFILE } from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import type { HostProfile, HostProfileAnswer } from "../shared/protocol.js";
import type { ContainerSummary, DockerClient } from "./docker-client.js";
import type { HostFiles } from "./host-files.js";
import { containerNameOf, restartPolicyOf, type ContainerDetails } from "./incident-report.js";

const text = (value: string) => value.slice(0, HOST_PROFILE.textCharacters);

// Most common first; a tie goes to the name that sorts first, so the same containers always say the same.
function ranked(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b));
}

function habit(values: readonly string[]): HostProfile["user"] {
  const [top] = ranked(values);
  return top === undefined ? null : { value: text(top[0]), uses: top[1], of: values.length };
}

// Only ever asked for the few names HOST_PROFILE allows: the rest of a container's environment is never looked at.
function environmentValue(container: ContainerDetails, name: string): string | undefined {
  const prefix = `${name}=`;
  return container.Config.Env?.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function userOf(container: ContainerDetails): string | null {
  const user = environmentValue(container, HOST_PROFILE.userVariable);
  const group = environmentValue(container, HOST_PROFILE.groupVariable);
  const numeric =
    user !== undefined && group !== undefined && [user, group].every((id) => HOST_PROFILE.numericId.test(id));
  return numeric ? `${user}:${group}` : null;
}

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 1));
const projectOf = (container: ContainerDetails) => container.Config.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
const composeFolderOf = (container: ContainerDetails) => container.Config.Labels?.[HOST_PROFILE.composeFolderLabel];
const isWithin = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

function composeFolder(containers: readonly ContainerDetails[]): HostProfile["composeFolder"] {
  const folders = new Set(containers.map(composeFolderOf).filter((folder) => folder !== undefined));
  const [top] = ranked([...folders].map(parentOf));
  return top === undefined ? null : { path: text(top[0]), projects: top[1], of: folders.size };
}

const isSystemPlace = (path: string) =>
  HOST_PROFILE.systemPlaces.some((place) => (place === "/" ? path === "/" : isWithin(path, place)));
const placeOf = (path: string) => `/${path.split("/").filter(Boolean).slice(0, HOST_PROFILE.placeDepth).join("/")}`;

const bindsOf = (container: ContainerDetails) =>
  (container.Mounts ?? []).flatMap((mount) => (mount.Type === "bind" && mount.Source ? [mount.Source] : []));

function ownBind(container: ContainerDetails, source: string) {
  const folder = composeFolderOf(container);
  return folder !== undefined && isWithin(source, folder);
}

const networksOf = (container: ContainerDetails) => Object.keys(container.NetworkSettings?.Networks ?? {});
const appOf = (container: ContainerDetails) => projectOf(container) ?? containerNameOf(container);

function sharedNetworks(containers: readonly ContainerDetails[]): HostProfile["networks"] {
  const own: readonly string[] = HOST_PROFILE.ownNetworks;
  const names = [...new Set(containers.flatMap(networksOf))].filter((name) => !own.includes(name));
  const members = (name: string) => containers.filter((container) => networksOf(container).includes(name));
  return names
    .filter((name) => new Set(members(name).map(appOf)).size > 1)
    .map((name) => ({ name: text(name), containers: members(name).length }))
    .sort((a, b) => b.containers - a.containers || a.name.localeCompare(b.name))
    .slice(0, HOST_PROFILE.networks);
}

// "ghcr.io/owner/traefik:3@sha256:..." is called traefik.
const imageNameOf = (image: string) => (image.split("@")[0] ?? "").split("/").at(-1)!.split(":")[0]!.toLowerCase();
const imageOf = (container: ContainerDetails) => container.Config.Image ?? "";

function proxiesOf(containers: readonly ContainerDetails[], shared: HostProfile["networks"]): HostProfile["proxies"] {
  const sharedNames = shared.map((network) => network.name);
  return containers
    .flatMap((container) => {
      const known = HOST_PROFILE.proxyImages.find(({ name }) => name.test(imageNameOf(imageOf(container))));
      if (known === undefined) return [];
      // The one most apps share, where it is on several: that is the one a new app would join to reach it.
      const network = sharedNames.find((name) => networksOf(container).includes(name)) ?? null;
      return [{ kind: known.kind, container: text(containerNameOf(container)), network }];
    })
    .slice(0, HOST_PROFILE.proxies);
}

const isDatabase = (container: ContainerDetails) => HOST_PROFILE.databaseImages.test(imageNameOf(imageOf(container)));

function databasesOf(containers: readonly ContainerDetails[]): HostProfile["databases"] {
  const databases = containers.filter(isDatabase);
  const hasCompanion = (database: ContainerDetails) =>
    projectOf(database) !== null &&
    containers.some((other) => !isDatabase(other) && projectOf(other) === projectOf(database));
  const ownToAnApp = databases.filter(hasCompanion).length;
  const common = ranked(databases.map((database) => imageOf(database).split("/").at(-1) ?? ""))[0]?.[0] ?? null;
  return {
    common: common === null ? null : text(common),
    ownToAnApp,
    standingAlone: databases.length - ownToAnApp,
  };
}

/** What a host's containers show of how it is set up. Space on its disks is added to `places` by whoever can look. */
export function profileOf(all: readonly ContainerDetails[]): HostProfile {
  const containers = all.filter((container) => container.Config.Labels?.[HOST_HELPER.label] === undefined);
  const present = <Value>(values: readonly (Value | null | undefined)[]) =>
    values.filter((value): value is Value => value !== null && value !== undefined);
  const binds = containers.flatMap((container) =>
    bindsOf(container).map((source) => ({ source, own: ownBind(container, source) })),
  );
  const elsewhere = binds.filter((bind) => !bind.own && !isSystemPlace(bind.source));
  const networks = sharedNetworks(containers);
  return {
    containers: containers.length,
    user: habit(present(containers.map(userOf))),
    timeZone: habit(present(containers.map((container) => environmentValue(container, HOST_PROFILE.timeZoneVariable)))),
    restartPolicy: habit(containers.map(restartPolicyOf)),
    composeFolder: composeFolder(containers),
    mountsBesideCompose: binds.filter((bind) => bind.own).length,
    places: ranked(elsewhere.map((bind) => placeOf(bind.source)))
      .slice(0, HOST_PROFILE.places)
      .map(([path, mounts]) => ({ path: text(path), mounts, availableBytes: null })),
    networks,
    proxies: proxiesOf(containers, networks),
    databases: databasesOf(containers),
  };
}

export interface HostProfileDependencies {
  docker: Pick<DockerClient, "containerSummaries" | "inspect">;
  // What the runner's inventory already read of each, rather than asking Docker about every container again.
  details?: (summary: ContainerSummary) => Promise<ContainerDetails | null>;
  files: Pick<HostFiles, "filesystem">;
  hostRoot: string;
  containerAccess: boolean;
}

/** A host's profile, as its runner works it out when someone looks. Reads only, and only where people may reach in. */
export async function answerHostProfile({
  docker,
  details = (summary) => docker.inspect(summary.Id),
  files,
  hostRoot,
  containerAccess,
}: HostProfileDependencies): Promise<HostProfileAnswer> {
  if (!containerAccess) return { error: CONTAINER_ACCESS_REFUSALS.off, profile: null };
  try {
    const summaries = await docker.containerSummaries();
    const inspected = await Promise.all(summaries.map(details));
    const profile = profileOf(inspected.filter((container) => container !== null));
    const places = await Promise.all(
      profile.places.map(async (place) => ({
        ...place,
        availableBytes: (await files.filesystem(join(hostRoot, place.path)))?.availableBytes ?? null,
      })),
    );
    return { error: null, profile: { ...profile, places } };
  } catch (error) {
    return { error: describeError(error), profile: null };
  }
}
