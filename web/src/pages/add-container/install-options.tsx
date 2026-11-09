import { RESTART_POLICIES } from "../../../../src/shared/constants.js";
import { type InstallDraft, type InstallSpec } from "../../../../src/shared/install.js";
import { TEXT } from "../../constants.js";
import { bytes } from "../../format.js";

const text = TEXT.addContainer;

const DOMAIN_MEMORY = "autoheal.install.domain";

export function rememberedDomain() {
  try {
    return localStorage.getItem(DOMAIN_MEMORY) ?? "";
  } catch {
    return "";
  }
}

export function rememberDomain(domain: string) {
  try {
    localStorage.setItem(DOMAIN_MEMORY, domain);
  } catch {
    // ponytail: only a convenience; asked again next time.
  }
}

export const PUBLISH = "publish a port";

export const lastPart = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

// "docker/compose/docker-compose.postgres.yml" is its "postgres" version.
export const versionName = (file: string) =>
  lastPart(file)
    .replace(/\.ya?ml$/i, "")
    .replace(/^(docker-)?compose\.?/i, "") || lastPart(file);

// The proxy the chosen networks lead to, and how many are on a network, as each click changes them.
export const proxyOf = (draft: InstallDraft, networks: readonly string[]) =>
  draft.proxies?.find((proxy) => networks.includes(proxy.network))?.kind ?? null;

export const countOn = (draft: InstallDraft, network: string) => draft.networkCounts?.[network] ?? null;

export function toggleNetwork(spec: InstallSpec, name: string): InstallSpec {
  const on = spec.networks.includes(name);
  return { ...spec, networks: on ? spec.networks.filter((each) => each !== name) : [...spec.networks, name] };
}

export function togglePublish(spec: InstallSpec): InstallSpec {
  if (spec.port === null) return spec;
  return { ...spec, port: { ...spec.port, published: spec.port.published === null ? spec.port.target : null } };
}

const freeNote = (available: number | null) => (available === null ? undefined : text.free(bytes(available)));

export function folderOptions(draft: InstallDraft) {
  const { slug } = draft.spec;
  const usual =
    draft.composeFolder === null
      ? []
      : [
          {
            value: `${draft.composeFolder}/${slug}`,
            label: `${draft.composeFolder}/${slug}`,
            note: draft.habits.folderProjects === null ? undefined : text.appsThere(draft.habits.folderProjects),
          },
        ];
  const disks = draft.places
    .filter((place) => place.path !== draft.composeFolder)
    .map((place) => ({
      value: `${place.path}/${slug}`,
      label: `${place.path}/${slug}`,
      note: freeNote(place.availableBytes),
    }));
  return [...usual, ...disks];
}

export function dataOptions(draft: InstallDraft, target: string) {
  const { slug, mounts } = draft.spec;
  const folderName = target.split("/").filter(Boolean).at(-1) ?? "data";
  const original = mounts.find((mount) => mount.target === target)?.source;
  const beside = original?.startsWith("./") ? original : `./${folderName}`;
  return [
    { value: beside, label: text.withTheApp },
    ...draft.places.map((place) => ({
      value: `${place.path}/${slug}/${folderName}`,
      label: `${place.path}/${slug}/${folderName}`,
      note: freeNote(place.availableBytes),
    })),
  ];
}

export function userOptions(draft: InstallDraft) {
  const usual =
    draft.userHabit ?? (draft.identity.kind === "ids" ? { value: draft.identity.user, uses: 0, of: 0 } : null);
  return usual === null
    ? []
    : [{ value: usual.value, label: usual.value, note: usual.uses > 0 ? text.likeOthers(usual.uses) : undefined }];
}

export function restartOptions(draft: InstallDraft) {
  const habit = draft.restartHabit;
  return RESTART_POLICIES.map((policy) => ({
    value: policy,
    label: text.restarts[policy],
    note: habit?.value === policy ? text.likeOthers(habit.uses) : undefined,
  }));
}

export function identityRow({ identity }: InstallDraft) {
  if (identity.kind === "ids") {
    return {
      value: identity.user,
      why: identity.uses === null ? text.idsUsual : text.likeOthers(identity.uses),
      warn: false,
    };
  }
  if (identity.kind === "image") return { value: text.imageUser(identity.user), why: text.imageChoice, warn: false };
  return { value: text.root, why: text.imageChoice, warn: true };
}

export const withIds = (spec: InstallSpec, user: string): InstallSpec => {
  const [id = "", group = ""] = user.split(":");
  return {
    ...spec,
    owner: user,
    environment: spec.environment.map((entry) => {
      if (entry.name === "PUID") return { ...entry, value: id };
      return entry.name === "PGID" ? { ...entry, value: group } : entry;
    }),
  };
};

export function withDomain(spec: InstallSpec, variable: string, domain: string): InstallSpec {
  const others = spec.environment.filter((entry) => entry.name !== variable);
  return {
    ...spec,
    environment: domain === "" ? others : [...others, { name: variable, value: `https://${domain}` }],
  };
}

export function lanAddressOf(spec: InstallSpec, address: string | null) {
  if (spec.port?.published == null) return null;
  return address === null ? text.onPort(spec.port.published) : `${address}:${spec.port.published}`;
}
