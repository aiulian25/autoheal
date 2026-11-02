import { COMPOSE_IMPORT } from "../shared/constants.js";
import { SECRET_NAME, isDeniedSource, type ComposeDocument, type ComposeService } from "../shared/install.js";

// What `docker compose config --format json` gives for someone else's file. Only what is read below is ever copied
// into what gets installed: anything else in their file simply does not exist for us, so it cannot reach a host.
interface ConfigVolume {
  type?: string;
  source?: string;
  target?: string;
}
interface ConfigService {
  image?: string;
  build?: unknown;
  profiles?: unknown[];
  command?: unknown;
  entrypoint?: unknown;
  environment?: Record<string, string | null>;
  env_file?: { path?: string }[];
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: Record<string, unknown>;
  user?: string;
  tmpfs?: unknown;
  volumes?: ConfigVolume[];
  ports?: { target?: number; published?: string | number }[];
  network_mode?: string;
  privileged?: boolean;
  cap_add?: unknown[];
  devices?: unknown[];
  pid?: string;
}
export interface ComposeConfig {
  services?: Record<string, ConfigService>;
}

export interface ImportedCompose {
  document: ComposeDocument;
  mainImage: string;
  port: number | null;
  mounts: { source: string; target: string; service: string }[];
  environment: { name: string; value: string }[];
  secrets: string[];
  // Passwords kept as its file sets them, as its app may rely on that without saying so.
  kept: string[];
  leftOut: string[];
  containers: string[];
  // The setting that holds the app's own address, when its file only gives an example of one.
  addressVariable: string | null;
}

const DATABASE_IMAGE = /(^|\/)(postgres|postgis|pgvector|mariadb|mysql|mongo|redis|valkey)(:|$)/;
const lastFolder = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "data";
const textList = (value: unknown): string[] | string | undefined => {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map(String) : undefined;
};

function leftOutOf(service: ConfigService): string[] {
  const words = COMPOSE_IMPORT.leftOut;
  return [
    ...(service.privileged === true ? [words.privileged] : []),
    ...(service.network_mode === "host" ? [words.hostNetwork] : []),
    ...(service.pid === "host" ? [words.hostProcesses] : []),
    ...((service.cap_add?.length ?? 0) > 0 ? [words.capabilities] : []),
    ...((service.devices?.length ?? 0) > 0 ? [words.devices] : []),
    ...(service.volumes ?? []).flatMap((volume) => {
      if (volume.source?.includes(COMPOSE_IMPORT.socket)) return [words.socket];
      return volume.source !== undefined && isDeniedSource(volume.source) ? [words.hostFolder(volume.source)] : [];
    }),
  ];
}

// Each stays beside the Compose file, whatever it was: a named volume, or a folder a stranger named on this host.
function mountsOf(name: string, service: ConfigService): ImportedCompose["mounts"] {
  return (service.volumes ?? []).flatMap((volume) => {
    const { source, target, type } = volume;
    if (target === undefined || (type !== "bind" && type !== "volume")) return [];
    if (source === undefined || source.includes(COMPOSE_IMPORT.socket) || isDeniedSource(source)) return [];
    if (source.startsWith("/")) return [{ source: `./${lastFolder(source)}`, target, service: name }];
    return [{ source: type === "bind" ? source.replace(/^(\.\/)?/, "./") : `./${source}`, target, service: name }];
  });
}

const parseEnvFile = (text: string) =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const at = line.indexOf("=");
      if (line.trim().startsWith("#") || at <= 0) return [];
      return [
        [
          line.slice(0, at).trim(),
          line
            .slice(at + 1)
            .trim()
            .replace(/^["']|["']$/g, ""),
        ],
      ];
    }),
  );

// The app itself: what publishes a port and nothing depends on, as an interface in front of its own API, else what
// publishes a port, else what nothing else depends on, and never a database if it can be helped.
function pickMain(services: Record<string, ConfigService>): string {
  const names = Object.keys(services);
  const needed = new Set(names.flatMap((name) => Object.keys(services[name]?.depends_on ?? {})));
  const isApp = (name: string) => !DATABASE_IMAGE.test(services[name]?.image ?? "");
  const serving = (name: string) => (services[name]?.ports?.length ?? 0) > 0;
  const candidates = [
    names.find((name) => serving(name) && !needed.has(name) && isApp(name)),
    names.find((name) => serving(name) && isApp(name)),
    names.find((name) => !needed.has(name) && isApp(name)),
    names.find(isApp),
  ];
  return candidates.find((name) => name !== undefined) ?? names[0]!;
}

/**
 * A stranger's Compose file, as ours: only known fields, data beside the file, secrets made fresh where that is safe.
 * A password several containers share becomes one generated value in all of them, and so does a placeholder, and one
 * also written into a URL. One standing alone stays as it is: the app may assume that default without saying so, and
 * changing it breaks the login.
 */
export function importCompose(
  config: ComposeConfig,
  envFiles: Record<string, string>,
  habits: { timeZone: string | null; ids: { user: string; group: string } | null },
  composeText = "",
): ImportedCompose | { problem: string } {
  const all = config.services ?? {};
  const services = Object.fromEntries(
    Object.entries(all).filter(([, service]) => (service.profiles?.length ?? 0) === 0),
  );
  const names = Object.keys(services);
  if (names.length === 0) return { problem: COMPOSE_IMPORT.noServices };
  const building = names.find((name) => services[name]?.image === undefined);
  if (building !== undefined) return { problem: COMPOSE_IMPORT.builds(building) };
  const unset = names.find((name) => services[name]?.image?.includes("$"));
  if (unset !== undefined) return { problem: COMPOSE_IMPORT.imageFromSetting(unset) };

  // Left blank: anything an app can start without, and what its own file makes optional with `${NAME:-}`.
  const staysBlank = (key: string) => !COMPOSE_IMPORT.neededWhenBlank.test(key) || composeText.includes(`\${${key}:-}`);
  // What its file sets a setting from, so that settings fed by one variable go on sharing one value.
  const variableOf = (key: string) =>
    /^\w+$/.test(key)
      ? (new RegExp(`\\b${key}\\b["']?\\s*[:=]\\s*["']?\\$\\{(\\w+)`).exec(composeText)?.[1] ?? key)
      : key;

  const environments = new Map<string, Record<string, string>>(
    names.map((name) => {
      const service = services[name]!;
      const fromFiles = Object.assign(
        {},
        ...(service.env_file ?? []).map((file) => parseEnvFile(envFiles[file.path ?? ""] ?? "")),
      ) as Record<string, string>;
      const usedFromFiles = Object.entries(fromFiles).filter(([key, value]) => value !== "" || !staysBlank(key));
      const given = Object.fromEntries(
        Object.entries(service.environment ?? {}).map(([key, value]) => [key, value ?? ""]),
      );
      return [name, { ...Object.fromEntries(usedFromFiles), ...given }];
    }),
  );

  const secretsIn = (environment: Record<string, string>) =>
    Object.entries(environment).filter(([key, value]) => SECRET_NAME.test(key) && !(value === "" && staysBlank(key)));
  const secretEntries = [...environments.values()].flatMap(secretsIn);
  const containersHolding = (literal: string) =>
    [...environments.values()].filter((environment) => secretsIn(environment).some(([, value]) => value === literal))
      .length;
  const uses = new Map<string, number>();
  for (const [, value] of secretEntries) uses.set(value, (uses.get(value) ?? 0) + 1);
  const isPlaceholder = (value: string) => COMPOSE_IMPORT.placeholder.test(value);
  const urlPasswordOf = (literal: string) => `:${literal}@`;
  const isReplaceableInUrl = (literal: string) => literal.length >= COMPOSE_IMPORT.shortestLiteral;
  const isInUrl = (literal: string) =>
    isReplaceableInUrl(literal) &&
    [...environments.values()].some((environment) =>
      Object.values(environment).some((value) => value.includes(urlPasswordOf(literal))),
    );
  const generated = new Map<string, string>();
  // ponytail: a placeholder within one container is its own secret; across containers all that share it become one.
  const own = new Map<string, string>();
  const kept = new Set<string>();
  for (const [key, value] of secretEntries) {
    if (value.includes("${")) continue;
    if (value === "") own.set(key, variableOf(key));
    else if (isPlaceholder(value) && containersHolding(value) === 1) own.set(key, key);
    else if (isPlaceholder(value) || (uses.get(value) ?? 0) > 1 || isInUrl(value)) {
      if (!generated.has(value)) generated.set(value, key);
    } else kept.add(key);
  }
  // A shared password is replaced as a whole secret or as the password in a URL: the same word elsewhere, such as a
  // user or a folder called postgres, is not the password.
  const replaceSecrets = (key: string, value: string) => {
    const whole = SECRET_NAME.test(key) ? generated.get(value) : undefined;
    if (whole !== undefined) return `\${${whole}}`;
    let result = value;
    for (const [literal, variable] of generated) {
      if (isReplaceableInUrl(literal)) result = result.replaceAll(urlPasswordOf(literal), `:\${${variable}}@`);
    }
    return result;
  };

  const main = pickMain(services);
  const target = services[main]?.ports?.[0]?.target ?? null;
  const isItsOwnAddress = (value: string) =>
    COMPOSE_IMPORT.placeholderAddress.test(value) || COMPOSE_IMPORT.localAddress.exec(value)?.[1] === String(target);
  const [addressVariable, exampleAddress] = Object.entries(environments.get(main) ?? {}).find(
    ([key, value]) => !SECRET_NAME.test(key) && isItsOwnAddress(value),
  ) ?? [null, null];
  const addressOrigin =
    exampleAddress === null ? null : (COMPOSE_IMPORT.addressOrigin.exec(exampleAddress)?.[0] ?? null);
  const isAtAddress = (value: string) =>
    addressOrigin !== null && (value === addressOrigin || value.startsWith(`${addressOrigin}/`));
  // A URL its file builds from a password nothing gave yet has none in it now: it gets that password back.
  const urlPassword = COMPOSE_IMPORT.passwordInUrl.exec(composeText)?.[1];
  const missingUrlPassword = (value: string) =>
    urlPassword !== undefined && COMPOSE_IMPORT.emptyPasswordInUrl.test(value);
  const urlPasswordMissing = [...environments.values()].some((environment) =>
    Object.values(environment).some(missingUrlPassword),
  );
  const document: ComposeDocument = { main, services: {} };
  for (const name of names) {
    const service = services[name]!;
    const environment = Object.fromEntries(
      Object.entries(environments.get(name) ?? {}).map(([key, value]) => {
        if (own.has(key)) return [key, `\${${own.get(key)}}`];
        if (isAtAddress(value)) return [key, `\${${addressVariable}}${value.slice(addressOrigin!.length)}`];
        if (missingUrlPassword(value)) {
          return [key, value.replace(COMPOSE_IMPORT.emptyPasswordInUrl, (_, start) => `${start}:\${${urlPassword}}@`)];
        }
        if (key === COMPOSE_IMPORT.timeZone && habits.timeZone !== null) return [key, habits.timeZone];
        if (key === COMPOSE_IMPORT.userVariable && habits.ids !== null) return [key, habits.ids.user];
        if (key === COMPOSE_IMPORT.groupVariable && habits.ids !== null) return [key, habits.ids.group];
        return [key, replaceSecrets(key, value)];
      }),
    );
    const command = textList(service.command);
    const entrypoint = textList(service.entrypoint);
    const tmpfs = textList(service.tmpfs);
    const entry: ComposeService = {
      image: service.image!,
      environment,
      depends_on: Object.fromEntries(
        Object.entries(service.depends_on ?? {})
          .filter(([other]) => services[other] !== undefined)
          .map(([other, { condition }]) => [other, { condition: condition ?? "service_started" }]),
      ),
      ...(command === undefined ? {} : { command }),
      ...(entrypoint === undefined ? {} : { entrypoint }),
      ...(tmpfs === undefined ? {} : { tmpfs }),
      ...(service.user === undefined ? {} : { user: service.user }),
      ...(service.healthcheck === undefined ? {} : { healthcheck: service.healthcheck }),
    };
    document.services[name] = entry;
  }
  if (habits.timeZone !== null) {
    const mainEnvironment = document.services[main]!.environment;
    mainEnvironment[COMPOSE_IMPORT.timeZone] ??= habits.timeZone;
  }
  return {
    document,
    mainImage: services[main]!.image!,
    port: target,
    mounts: names.flatMap((name) => mountsOf(name, services[name]!)),
    environment: [],
    secrets: [...new Set([...generated.values(), ...own.values(), ...(urlPasswordMissing ? [urlPassword!] : [])])],
    kept: [...kept],
    leftOut: [...new Set(names.flatMap((name) => leftOutOf(services[name]!)))],
    containers: names,
    addressVariable,
  };
}
