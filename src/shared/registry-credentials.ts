import { z } from "zod";
import { IMAGE_REFERENCE, REGISTRY, REGISTRY_CREDENTIALS } from "./constants.js";

/** What a runner is given for a pull or a check: the plain credential, for one registry and the repositories under it. */
export interface RegistryAccess {
  registry: string;
  /** The repository, or the path every covered repository starts with; null for the whole registry. */
  repository: string | null;
  username: string;
  password: string;
}

/** What the dashboard shows: who may use which registry, and never the password. */
export interface RegistryCredentialView {
  id: string;
  registry: string;
  repository: string | null;
  username: string;
  /** The hosts allowed to use it; empty for every host, now and later. */
  hostIds: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** What an asked-for access test found; `problem` is already fit to show, with nothing secret in it. */
export interface RegistryCredentialTestView {
  reached: boolean;
  problem: string | null;
}

/** Docker Hub answers to one host name whatever a reference calls it, so a credential for it is stored under that one. */
export const registryHostOf = (registry: string) => {
  const host = registry.trim().toLowerCase();
  return REGISTRY.dockerHubNames.some((name) => name === host) ? REGISTRY.dockerHubHost : host;
};

/** "owner/app/" and "owner/app" name the same scope; the stored form has no trailing separator. */
const repositoryScopeOf = (repository: string | null) => {
  const path = (repository ?? "").trim().replace(/\/+$/, "");
  return path === "" ? null : path;
};

/** A repository scope as a person may give it: empty or absent is the whole registry. */
const repositoryScope = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .max(REGISTRY_CREDENTIALS.repositoryLength)
    .regex(REGISTRY_CREDENTIALS.repositoryPattern)
    .nullable()
    .default(null),
);

export const registryCredentialBodySchema = z
  .object({
    registry: z.string().trim().min(1).max(REGISTRY_CREDENTIALS.registryLength),
    repository: repositoryScope,
    username: z.string().trim().min(1).max(REGISTRY_CREDENTIALS.usernameLength),
    password: z.string().min(1).max(REGISTRY_CREDENTIALS.passwordLength),
    hostIds: z.array(z.uuid()).max(REGISTRY_CREDENTIALS.hostsLimit).default([]),
  })
  .strict()
  .transform((body) => ({
    ...body,
    registry: registryHostOf(body.registry),
    repository: repositoryScopeOf(body.repository),
  }));

export type RegistryCredentialBody = z.infer<typeof registryCredentialBodySchema>;

/** A repository to try the credential against, for a credential that covers a whole registry. */
export const registryCredentialTestBodySchema = z.object({ repository: repositoryScope }).strict();

/**
 * Whether a credential covers an image: the same registry, and the repository itself or one under it. A credential
 * for "owner/app" covers "owner/app" and "owner/app/part", never "owner/application".
 */
export function coversRepository(scope: string | null, repository: string): boolean {
  if (scope === null) {
    return true;
  }
  return repository === scope || repository.startsWith(`${scope}${IMAGE_REFERENCE.pathSeparator}`);
}

export const coversImage = (
  access: Pick<RegistryAccess, "registry" | "repository">,
  image: Pick<RegistryAccess, "registry"> & { repository: string },
) =>
  registryHostOf(access.registry) === registryHostOf(image.registry) &&
  coversRepository(access.repository, image.repository);

/**
 * The credential for an image, the most closely scoped first: a credential for one repository is used before one
 * for its whole registry. Null when none covers it, and the image is asked for anonymously as before.
 */
export function accessForImage<Access extends Pick<RegistryAccess, "registry" | "repository">>(
  available: readonly Access[],
  image: { registry: string; repository: string },
): Access | null {
  const covering = available.filter((access) => coversImage(access, image));
  const byScope = [...covering].sort(
    (first, second) => (second.repository ?? "").length - (first.repository ?? "").length,
  );
  return byScope[0] ?? null;
}
