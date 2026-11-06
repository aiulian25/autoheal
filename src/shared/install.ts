import { z } from "zod";
import { DENIED_BIND_SOURCES, RESTART_POLICIES, RESTART_POLICY_UNLESS_STOPPED } from "./constants.js";
import { ownCheckSchema, ownRunSchema, type OwnCheckRun } from "./own-compose.js";
import type { HostProfile } from "./protocol.js";

// What a new container is, as the person last saw it. Generated secrets are only named here: their values are made
// on the host when it is installed, and never pass through the dashboard.
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const OWNER_PATTERN = /^\d{1,10}:\d{1,10}$/;
const IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$/;
// No line breaks, and no quote: a value goes in a .env, between single quotes when it needs them.
const VALUE_PATTERN = /^[^\n\r'\0]{0,1024}$/;
export const isValidImage = (image: string) => IMAGE_PATTERN.test(image) && !image.includes("//");
const SLUG_LIKE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const hasNoDots = (path: string) => !path.split("/").includes("..");
const absolutePath = z
  .string()
  .max(1024)
  .regex(/^\/[^\n\r\0]*$/)
  .refine(hasNoDots);
// Beside its Compose file, or anywhere the host lets one be mounted from.
const mountSource = z
  .string()
  .max(1024)
  .regex(/^(\.\/|\/)[^\n\r\0:]*$/)
  .refine(hasNoDots);

// An app of several containers, as far as it was read from a Compose file: known fields only, nothing else can get in.
const composeServiceSchema = z.object({
  image: z.string().regex(IMAGE_PATTERN).refine(isValidImage),
  // Each is written as a JSON string, so a value cannot break out of it; only a line break is refused.
  environment: z.record(z.string().regex(/^[A-Za-z_][\w.-]{0,127}$/), z.string().regex(/^[^\n\r\0]{0,4096}$/)),
  depends_on: z.record(z.string().regex(SLUG_LIKE), z.object({ condition: z.string().max(64) })),
  command: z.union([z.string().max(4096), z.array(z.string().max(4096)).max(128)]).optional(),
  entrypoint: z.union([z.string().max(4096), z.array(z.string().max(4096)).max(128)]).optional(),
  tmpfs: z.union([z.string().max(256), z.array(z.string().max(256)).max(16)]).optional(),
  user: z.string().max(64).optional(),
  healthcheck: z.record(z.string().max(64), z.unknown()).optional(),
});
export type ComposeService = z.infer<typeof composeServiceSchema>;
export const composeDocumentSchema = z.object({
  main: z.string().regex(SLUG_LIKE),
  services: z.record(z.string().regex(SLUG_LIKE), composeServiceSchema),
});
export type ComposeDocument = z.infer<typeof composeDocumentSchema>;

export const SECRET_CHARACTERS = { least: 16, most: 64, usual: 32 } as const;

export const installSpecSchema = z.object({
  name: z.string().regex(NAME_PATTERN),
  slug: z.string().regex(SLUG_PATTERN),
  image: z.string().regex(IMAGE_PATTERN).refine(isValidImage),
  folder: absolutePath,
  restartPolicy: z.enum(RESTART_POLICIES),
  // Who owns its data folders; null leaves them to whoever the host makes them as.
  owner: z.string().regex(OWNER_PATTERN).nullable(),
  // The networks other apps share that it joins, to be reached through: as many as a person ticks.
  networks: z.array(z.string().regex(NAME_PATTERN)).max(16),
  // What it serves on, and the port of the host's to publish it on; null publishes none.
  port: z
    .object({
      target: z.number().int().min(1).max(65535),
      published: z.number().int().min(1).max(65535).nullable(),
    })
    .nullable(),
  // A mount of an app of several containers says whose it is; the others are the app's own.
  mounts: z
    .array(z.object({ source: mountSource, target: absolutePath, service: z.string().max(63).optional() }))
    .max(64),
  // Everything goes in its .env, IDs included.
  environment: z
    .array(z.object({ name: z.string().regex(VARIABLE_PATTERN), value: z.string().regex(VALUE_PATTERN) }))
    .max(128),
  secrets: z
    .array(
      z.object({
        name: z.string().regex(VARIABLE_PATTERN),
        characters: z.number().int().min(SECRET_CHARACTERS.least).max(SECRET_CHARACTERS.most),
      }),
    )
    .max(32),
  // Its own database, beside it.
  database: z.object({ image: z.string().regex(IMAGE_PATTERN) }).nullable(),
  // Several containers together, read from a Compose file.
  document: composeDocumentSchema.nullable().optional(),
});
export type InstallSpec = z.infer<typeof installSpecSchema>;

export const INSTALL_LABEL = "com.autoheal.installed";
// How every Compose file Autoheal writes marks its services.
export const INSTALLED_LINE = `${INSTALL_LABEL}: "true"`;
export const COMPOSE_FILE = "docker-compose.yml";
export const ENV_FILE = ".env";
const DATABASE_SERVICE_SUFFIX = "-db";
const DATABASE_NAME_SUFFIX = "-DB";
const DATABASE_DATA = { source: "./db", target: "/var/lib/postgresql/data" };

export const databaseServiceOf = (spec: Pick<InstallSpec, "slug">) => `${spec.slug}${DATABASE_SERVICE_SUFFIX}`;
export const databaseNameOf = (spec: Pick<InstallSpec, "name">) => `${spec.name}${DATABASE_NAME_SUFFIX}`;
const documentImages = (document: ComposeDocument) => Object.values(document.services).map((service) => service.image);
export const imagesOf = (spec: InstallSpec) =>
  spec.document != null
    ? [...new Set(documentImages(spec.document))]
    : [spec.image, ...(spec.database === null ? [] : [spec.database.image])];
export const serviceContainerName = (spec: Pick<InstallSpec, "name" | "document">, service: string) =>
  service === spec.document?.main ? spec.name : `${spec.name}-${service}`;
export const containerNamesOf = (spec: InstallSpec) =>
  spec.document != null
    ? Object.keys(spec.document.services).map((service) => serviceContainerName(spec, service))
    : [spec.name, ...(spec.database === null ? [] : [databaseNameOf(spec)])];
export const mountSourcesOf = (spec: InstallSpec) => [
  ...spec.mounts.map((mount) => mount.source),
  ...(spec.database === null ? [] : [DATABASE_DATA.source]),
];

/** A path as the host reads it, so `//etc`, `/etc/.` or `/srv/../etc` is seen to be `/etc`. Runs in the browser too. */
function canonicalPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A path the host's system needs, which no new container may be given, however it is spelled. */
export function isDeniedSource(source: string): boolean {
  // A relative path is the app's own folder or under it.
  if (!source.startsWith("/")) return false;
  const denied: readonly string[] = DENIED_BIND_SOURCES;
  const path = canonicalPath(source);
  return denied.some((system) => (system === "/" ? path === "/" : path === system || path.startsWith(`${system}/`)));
}

// A JSON string is a valid YAML one, whatever it holds.
const quoted = (value: string) => JSON.stringify(value);

/** The Compose file: ordinary, and holding no secret or ID, those being in the .env beside it. */
function composeOfDocument(spec: InstallSpec, document: ComposeDocument): string {
  // Written from known fields only, each as JSON: JSON is valid YAML, and a value cannot break out of its quotes.
  const services = Object.entries(document.services).flatMap(([name, service]) => {
    const isMain = name === document.main;
    const mounts = spec.mounts.filter((mount) => (mount.service ?? document.main) === name);
    const flow = (key: string, value: unknown) => [`    ${key}: ${JSON.stringify(value)}`];
    const needs = Object.entries(service.depends_on);
    return [
      `  ${quoted(name)}:`,
      `    image: ${quoted(service.image)}`,
      `    container_name: ${quoted(serviceContainerName(spec, name))}`,
      `    restart: ${spec.restartPolicy}`,
      ...(isMain ? [`    env_file: ${ENV_FILE}`] : []),
      "    labels:",
      `      ${INSTALLED_LINE}`,
      ...(service.command === undefined ? [] : flow("command", service.command)),
      ...(service.entrypoint === undefined ? [] : flow("entrypoint", service.entrypoint)),
      ...(service.user === undefined ? [] : flow("user", service.user)),
      ...(service.tmpfs === undefined ? [] : flow("tmpfs", service.tmpfs)),
      ...(service.healthcheck === undefined ? [] : flow("healthcheck", service.healthcheck)),
      ...(Object.keys(service.environment).length === 0
        ? []
        : [
            "    environment:",
            ...Object.entries(service.environment).map(([key, value]) => `      ${key}: ${quoted(value)}`),
          ]),
      ...(needs.length === 0
        ? []
        : [
            "    depends_on:",
            ...needs.flatMap(([other, need]) => [`      ${quoted(other)}:`, `        condition: ${need.condition}`]),
          ]),
      ...(mounts.length === 0
        ? []
        : ["    volumes:", ...mounts.map((mount) => `      - ${quoted(`${mount.source}:${mount.target}`)}`)]),
      ...(isMain && spec.port?.published != null
        ? ["    ports:", `      - ${quoted(`${spec.port.published}:${spec.port.target}`)}`]
        : []),
      ...(isMain && spec.networks.length > 0
        ? ["    networks:", ...[...spec.networks, "default"].map((network) => `      - ${quoted(network)}`)]
        : []),
    ];
  });
  const networks =
    spec.networks.length === 0
      ? []
      : ["networks:", ...spec.networks.flatMap((network) => [`  ${quoted(network)}:`, "    external: true"])];
  return `${["services:", ...services, ...networks].join("\n")}\n`;
}

/** The address an app is told it answers at, when its file only gave an example and no domain was chosen for it. */
export function withAddress(spec: InstallSpec, variable: string | null, hostAddress: string | null): InstallSpec {
  const told = spec.environment.some((entry) => entry.name === variable);
  if (variable === null || told || spec.port === null) return spec;
  const onLan = spec.port.published !== null && hostAddress !== null;
  const value = onLan ? `http://${hostAddress}:${spec.port.published}` : `http://${spec.slug}:${spec.port.target}`;
  return { ...spec, environment: [...spec.environment, { name: variable, value }] };
}

export function composeOf(spec: InstallSpec): string {
  if (spec.document != null) return composeOfDocument(spec, spec.document);
  const service = spec.slug;
  const appNetworks = [...spec.networks, ...(spec.networks.length > 0 && spec.database !== null ? ["default"] : [])];
  const lines = [
    "services:",
    `  ${service}:`,
    `    image: ${quoted(spec.image)}`,
    `    container_name: ${quoted(spec.name)}`,
    `    restart: ${spec.restartPolicy}`,
    `    env_file: ${ENV_FILE}`,
    `    labels:`,
    `      ${INSTALLED_LINE}`,
    ...(spec.mounts.length === 0
      ? []
      : ["    volumes:", ...spec.mounts.map((m) => `      - ${quoted(`${m.source}:${m.target}`)}`)]),
    ...(spec.port?.published == null
      ? []
      : ["    ports:", `      - ${quoted(`${spec.port.published}:${spec.port.target}`)}`]),
    ...(appNetworks.length === 0
      ? []
      : ["    networks:", ...appNetworks.map((network) => `      - ${quoted(network)}`)]),
    ...(spec.database === null
      ? []
      : [
          "    depends_on:",
          `      ${databaseServiceOf(spec)}:`,
          "        condition: service_healthy",
          `  ${databaseServiceOf(spec)}:`,
          `    image: ${quoted(spec.database.image)}`,
          `    container_name: ${quoted(databaseNameOf(spec))}`,
          `    restart: ${spec.restartPolicy}`,
          "    labels:",
          `      ${INSTALLED_LINE}`,
          "    environment:",
          "      POSTGRES_USER: ${POSTGRES_USER}",
          "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}",
          "      POSTGRES_DB: ${POSTGRES_DB}",
          "      PGUSER: ${POSTGRES_USER}",
          "    volumes:",
          `      - ${quoted(`${DATABASE_DATA.source}:${DATABASE_DATA.target}`)}`,
          "    healthcheck:",
          '      test: ["CMD", "pg_isready"]',
          "      interval: 10s",
          "      timeout: 5s",
          "      retries: 10",
        ]),
    ...(spec.networks.length === 0
      ? []
      : ["networks:", ...spec.networks.flatMap((network) => [`  ${quoted(network)}:`, "    external: true"])]),
  ];
  return `${lines.join("\n")}\n`;
}

const NEEDS_QUOTES = /[\s#$"`\\]/;
/** One line of a .env: in single quotes where it needs them, which a value cannot hold. */
export const envLine = ({ name, value }: { name: string; value: string }) =>
  `${name}=${NEEDS_QUOTES.test(value) ? `'${value}'` : value}`;

// --- what fills a spec in ---------------------------------------------------------------------------------

/** What is known of an app ahead of its image. Each is checked against its own docs before it ships. */
export interface InstallRecipe {
  id: string;
  name: string;
  about: string;
  image: string;
  port: number;
  mounts: { source: string; target: string }[];
  // It honours PUID and PGID, whatever its image shows.
  usesIds?: boolean;
  environment?: { name: string; value: string }[];
  secrets?: string[];
  // Holds the address it answers at, once it has a name.
  baseUrlVariable?: string;
  database?: { image: string; environment: { name: string; value: string }[] };
}

export const INSTALL_RECIPES: readonly InstallRecipe[] = [
  {
    id: "uptime-kuma",
    name: "Uptime-Kuma",
    about: "Watches your sites and services",
    image: "louislam/uptime-kuma:2",
    port: 3001,
    mounts: [{ source: "./data", target: "/app/data" }],
  },
  {
    id: "mealie",
    name: "Mealie",
    about: "Recipes and meal plans",
    image: "ghcr.io/mealie-recipes/mealie:latest",
    port: 9000,
    mounts: [{ source: "./data", target: "/app/data" }],
    usesIds: true,
    baseUrlVariable: "BASE_URL",
    environment: [
      { name: "ALLOW_SIGNUP", value: "false" },
      { name: "DB_ENGINE", value: "postgres" },
      { name: "POSTGRES_PORT", value: "5432" },
    ],
    database: {
      image: "postgres:17",
      environment: [
        { name: "POSTGRES_USER", value: "mealie" },
        { name: "POSTGRES_DB", value: "mealie" },
        { name: "POSTGRES_SERVER", value: "mealie-db" },
      ],
    },
    secrets: ["POSTGRES_PASSWORD"],
  },
];

/** What an image says of itself, from its build. */
export interface ImageFacts {
  ports: number[];
  volumes: string[];
  environment: { name: string; value: string }[];
  // As built: empty means it runs as root unless it does something about that.
  user: string;
}

export const SECRET_NAME = /(^|_|db)pass|secret|token|(^|_)key($|_)|credentials?$|private_?key/i;
const IDS_IMAGE = /(^|\/)(lscr\.io\/linuxserver|linuxserver|hotio)\//;
const FALLBACK_FOLDER = "/opt/apps";
const USER_VARIABLE = "PUID";
const GROUP_VARIABLE = "PGID";
const TIME_ZONE_VARIABLE = "TZ";
const NUMERIC_USER = /^\d+(:\d+)?$/;
const lastFolder = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "data";

const PROJECT_ADDRESS = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const HUB_ADDRESS = /^https?:\/\/hub\.docker\.com\/r\/([\w.-]+\/[\w.-]+)(?:[/?#].*)?$/i;
const GHCR_PACKAGE = /^https?:\/\/github\.com\/([\w.-]+)\/[\w.-]+\/pkgs\/container\/([\w.-]+)(?:[/?#].*)?$/i;
const REGISTRY_ADDRESS = /^https?:\/\/((?:ghcr\.io|quay\.io|lscr\.io)\/[\w./-]+?(?::[\w.-]+)?)\/?$/i;

export const isAddress = (typed: string) => /^https?:\/\//i.test(typed.trim());

/** Where an address names its image outright: a registry's page rather than a project's. */
export function imageFromAddress(address: string): string | null {
  const package_ = GHCR_PACKAGE.exec(address);
  if (package_ !== null) return `ghcr.io/${package_[1]}/${package_[2]}:latest`;
  const hub = HUB_ADDRESS.exec(address);
  if (hub !== null) return `${hub[1]}:latest`;
  const registry = REGISTRY_ADDRESS.exec(address);
  return registry === null ? null : (registry[1] ?? null);
}

/** The GitHub project an address points at. */
export function projectOf(address: string): { owner: string; name: string } | null {
  const match = PROJECT_ADDRESS.exec(address.trim());
  return match === null ? null : { owner: match[1]!, name: match[2]! };
}

/** What a project's README says to run. Data only: each piece is checked, and none of it is ever run. */
export interface ProjectHints {
  image: string;
  ports: number[];
  volumes: string[];
  environment: { name: string; value: string }[];
  // What it asked for that a stranger's README does not get without a person saying so.
  leftOut: string[];
}

export type ProjectPage =
  | { kind: "found"; hints: ProjectHints }
  | { kind: "guess"; candidates: string[] }
  | { kind: "composeOnly" }
  | { kind: "compose"; text: string; files: string[]; file: string; folder: string; owner: string; name: string }
  | { kind: "severalImages"; images: string[] }
  | { kind: "unknownSite" };

/** "ghcr.io/somedev/Cool_App:latest" is the app cool-app. */
export function slugOf(image: string): string {
  const name = (image.split("@")[0] ?? "").split("/").at(-1)?.split(":")[0] ?? "";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "app" : slug;
}

// Who it runs as, truthfully: IDs only work on an image that reads them.
export type InstallIdentity =
  | { kind: "ids"; user: string; uses: number | null; of: number | null }
  | { kind: "image"; user: string }
  | { kind: "root" };

function identityOf(
  profile: HostProfile,
  facts: ImageFacts,
  image: string,
  recipe: InstallRecipe | undefined,
): InstallIdentity {
  const readsIds =
    recipe?.usesIds === true ||
    IDS_IMAGE.test(image) ||
    facts.environment.some((entry) => entry.name === USER_VARIABLE);
  if (readsIds) {
    const habit = profile.user;
    return habit === null
      ? { kind: "ids", user: "1000:1000", uses: null, of: null }
      : { kind: "ids", user: habit.value, uses: habit.uses, of: habit.of };
  }
  return facts.user === "" || facts.user === "root" || facts.user === "0"
    ? { kind: "root" }
    : { kind: "image", user: facts.user };
}

export interface InstallDraft {
  spec: InstallSpec;
  identity: InstallIdentity;
  // Facts for the screen: how many others do the same.
  habits: { folderProjects: number | null; networkContainers: number | null };
  // What it could join instead.
  networks: string[];
  // What can be offered to click on: where its other apps live, its disks, and what most of them do.
  composeFolder: string | null;
  places: { path: string; availableBytes: number | null }[];
  userHabit: { value: string; uses: number; of: number } | null;
  restartHabit: { value: string; uses: number; of: number } | null;
  // From runners on: how many are on each network, and which proxy each leads to, for when another is chosen.
  networkCounts?: Record<string, number>;
  proxies?: { kind: string; network: string }[];
  // Read from a project's page: where, the settings it named, and what it asked for that was left out.
  project: {
    address: string;
    settings: string[];
    leftOut: string[];
    // Read from a Compose file: the ones the project offers, which one this is, and passwords left as it sets them.
    files?: string[];
    file?: string | null;
    kept?: string[];
  } | null;
  baseUrlVariable: string | null;
  proxy: { kind: string; container: string } | null;
}

/** A complete proposal, from what the image says and what the host already does. */
export function draftOf(
  image: string,
  facts: ImageFacts,
  profile: HostProfile,
  recipe?: InstallRecipe,
  project?: { address: string; hints: ProjectHints },
): InstallDraft {
  const slug = recipe?.id ?? slugOf(image);
  const identity = identityOf(profile, facts, image, recipe);
  const hints = project?.hints;
  const port = recipe?.port ?? hints?.ports[0] ?? facts.ports[0] ?? null;
  // The proxy most apps go through: networks come busiest first, and a host may have several.
  const proxyOn = (name: string) => profile.proxies.find((candidate) => candidate.network === name);
  const busiest = profile.networks.find((candidate) => proxyOn(candidate.name) !== undefined);
  const proxy = busiest === undefined ? null : (proxyOn(busiest.name) ?? null);
  // Reached through the host's proxy where it has one, as its other apps are; else on a port of its own.
  const network = port === null ? null : (proxy?.network ?? null);
  const usablePlaces = profile.places.filter((place) => place.path.split("/").filter(Boolean).length > 1);
  const taken = new Set(recipe?.mounts.map((mount) => mount.target));
  const mounts = recipe?.mounts ?? [];
  const volumeMounts = [...new Set([...(hints?.volumes ?? []), ...facts.volumes])]
    .filter((target) => !taken.has(target))
    .map((target) => ({ source: `./${lastFolder(target)}`, target }));
  const imageSecrets = facts.environment
    .filter((entry) => entry.value === "" && SECRET_NAME.test(entry.name))
    .map((entry) => entry.name);
  // An example password in a README is no password: anything named like a secret is made fresh.
  const projectSecrets = (hints?.environment ?? [])
    .filter((entry) => SECRET_NAME.test(entry.name))
    .map((entry) => entry.name);
  const projectSettings = (hints?.environment ?? []).filter((entry) => !SECRET_NAME.test(entry.name));
  const secretNames = [...new Set([...(recipe?.secrets ?? []), ...imageSecrets, ...projectSecrets])];
  const ids =
    identity.kind === "ids"
      ? [
          { name: USER_VARIABLE, value: identity.user.split(":")[0] ?? "" },
          { name: GROUP_VARIABLE, value: identity.user.split(":")[1] ?? "" },
        ]
      : [];
  const timeZone = profile.timeZone === null ? [] : [{ name: TIME_ZONE_VARIABLE, value: profile.timeZone.value }];
  const owner =
    identity.kind === "ids"
      ? identity.user
      : identity.kind === "image" && NUMERIC_USER.test(identity.user)
        ? identity.user.includes(":")
          ? identity.user
          : `${identity.user}:${identity.user}`
        : null;
  return {
    spec: {
      name: recipe?.name ?? slug,
      slug,
      image: recipe?.image ?? image,
      folder: `${profile.composeFolder?.path ?? FALLBACK_FOLDER}/${slug}`,
      restartPolicy:
        (profile.restartPolicy?.value as InstallSpec["restartPolicy"] | undefined) ?? RESTART_POLICY_UNLESS_STOPPED,
      owner,
      networks: network === null ? [] : [network],
      port: port === null ? null : { target: port, published: network === null ? port : null },
      mounts: [...mounts, ...volumeMounts],
      environment: [
        ...ids,
        ...timeZone,
        ...(recipe?.environment ?? []),
        ...(recipe?.database?.environment ?? []),
        ...projectSettings,
      ],
      secrets: secretNames.map((name) => ({ name, characters: SECRET_CHARACTERS.usual })),
      database: recipe?.database === undefined ? null : { image: recipe.database.image },
    },
    identity,
    habits: {
      folderProjects: profile.composeFolder?.projects ?? null,
      networkContainers: profile.networks.find((candidate) => candidate.name === network)?.containers ?? null,
    },
    networks: profile.networks.map((candidate) => candidate.name),
    composeFolder: profile.composeFolder?.path ?? null,
    places: usablePlaces.map((place) => ({ path: place.path, availableBytes: place.availableBytes })),
    userHabit: profile.user,
    restartHabit: profile.restartPolicy,
    networkCounts: Object.fromEntries(profile.networks.map((candidate) => [candidate.name, candidate.containers])),
    proxies: profile.proxies.flatMap((candidate) =>
      candidate.network === null ? [] : [{ kind: candidate.kind, network: candidate.network }],
    ),
    project:
      project === undefined
        ? null
        : {
            address: project.address,
            settings: projectSettings.map((entry) => entry.name),
            leftOut: [...new Set(project.hints.leftOut)],
          },
    baseUrlVariable: recipe?.baseUrlVariable ?? null,
    proxy: proxy === null ? null : { kind: proxy.kind, container: proxy.container },
  };
}

/** Finds a recipe by what a person typed. */
export const recipesMatching = (typed: string) => {
  const wanted = typed.trim().toLowerCase();
  return wanted === ""
    ? []
    : INSTALL_RECIPES.filter((recipe) => recipe.id.includes(wanted) || recipe.name.toLowerCase().includes(wanted));
};

/** Something that looks like an image to pull, not words to search for. */
export const looksLikeImage = (typed: string) => /[/:]/.test(typed.trim()) && isValidImage(typed.trim());

// --- what a runner answers ----------------------------------------------------------------------------------

export const INSTALL_CHECK_KEYS = ["image", "compose", "folder", "name", "network", "port", "disk", "mounts"] as const;
export const installCheckSchema = z.object({
  key: z.enum(INSTALL_CHECK_KEYS),
  ok: z.boolean(),
  detail: z.string().max(512),
});
export type InstallCheck = z.infer<typeof installCheckSchema>;

const identitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ids"),
    user: z.string().max(32),
    uses: z.number().nullable(),
    of: z.number().nullable(),
  }),
  z.object({ kind: z.literal("image"), user: z.string().max(128) }),
  z.object({ kind: z.literal("root") }),
]);

export const installAnswerSchema = z.object({
  error: z.string().max(1024).nullable(),
  draft: z
    .object({
      spec: installSpecSchema,
      identity: identitySchema,
      habits: z.object({ folderProjects: z.number().nullable(), networkContainers: z.number().nullable() }),
      networks: z.array(z.string().max(256)).max(16),
      composeFolder: z.string().max(1024).nullable(),
      places: z.array(z.object({ path: z.string().max(1024), availableBytes: z.number().nullable() })).max(16),
      userHabit: z.object({ value: z.string().max(256), uses: z.number(), of: z.number() }).nullable(),
      restartHabit: z.object({ value: z.string().max(256), uses: z.number(), of: z.number() }).nullable(),
      networkCounts: z.record(z.string().max(256), z.number()).optional(),
      proxies: z
        .array(z.object({ kind: z.string().max(256), network: z.string().max(256) }))
        .max(16)
        .optional(),
      project: z
        .object({
          address: z.string().max(512),
          settings: z.array(z.string().max(128)).max(128),
          leftOut: z.array(z.string().max(128)).max(16),
          files: z.array(z.string().max(512)).max(16).optional(),
          file: z.string().max(512).nullable().optional(),
          kept: z.array(z.string().max(128)).max(64).optional(),
        })
        .nullable(),
      baseUrlVariable: z.string().max(128).nullable(),
      proxy: z.object({ kind: z.string().max(256), container: z.string().max(256) }).nullable(),
    })
    .nullable(),
  checks: z.array(installCheckSchema).max(16),
  own: ownCheckSchema.nullable().optional(),
});
export type InstallAnswer = z.infer<typeof installAnswerSchema>;

export const installComposeBodySchema = z.string().max(128 * 1024);

export const installDraftBodySchema = z.object({
  image: z.string().regex(IMAGE_PATTERN).refine(isValidImage).optional(),
  project: z
    .string()
    .max(512)
    .regex(/^https?:\/\/[^\s]+$/)
    .optional(),
  composeFile: z
    .string()
    .max(512)
    .regex(/^[\w./-]+$/)
    .refine(hasNoDots)
    .optional(),
  compose: installComposeBodySchema.optional(),
  recipe: z.string().regex(SLUG_PATTERN).optional(),
});

export type InstallRequest =
  | {
      id: string;
      kind: "draft";
      image: string | null;
      recipe: string | null;
      project?: string | null;
      composeFile?: string | null;
      compose?: string | null;
    }
  | { id: string; kind: "check"; spec: InstallSpec }
  | { id: string; kind: "ownCheck"; files: OwnCheckRun };

/** What an install job puts on its host: an app set up here, or a person's own files as they are. */
export const installDetailsSchema = z.union([ownRunSchema, installSpecSchema]);
export type InstallDetails = z.infer<typeof installDetailsSchema>;

export const isBlocking = (check: InstallCheck) => !check.ok;
