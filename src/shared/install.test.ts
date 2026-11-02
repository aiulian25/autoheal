import { describe, expect, it } from "vitest";
import type { HostProfile } from "./protocol.js";
import {
  withAddress,
  INSTALL_RECIPES,
  composeOf,
  draftOf,
  envLine,
  installSpecSchema,
  isDeniedSource,
  looksLikeImage,
  recipesMatching,
  slugOf,
  type ImageFacts,
  type InstallSpec,
} from "./install.js";

const profile: HostProfile = {
  containers: 36,
  user: { value: "1000:1000", uses: 9, of: 9 },
  timeZone: { value: "Europe/Lisbon", uses: 10, of: 10 },
  restartPolicy: { value: "unless-stopped", uses: 31, of: 36 },
  composeFolder: { path: "/home/me/docker", projects: 25, of: 25 },
  mountsBesideCompose: 41,
  places: [],
  networks: [{ name: "npm", containers: 17 }],
  proxies: [{ kind: "Nginx Proxy Manager", container: "npm", network: "npm" }],
  databases: { common: "postgres:16", ownToAnApp: 2, standingAlone: 0 },
};
const empty: HostProfile = {
  ...profile,
  containers: 0,
  user: null,
  timeZone: null,
  restartPolicy: null,
  composeFolder: null,
  networks: [],
  proxies: [],
};
const facts = (overrides: Partial<ImageFacts> = {}): ImageFacts => ({
  ports: [3000],
  volumes: ["/data"],
  environment: [],
  user: "",
  ...overrides,
});
const mealie = INSTALL_RECIPES.find((recipe) => recipe.id === "mealie")!;

describe("a new app's first proposal", () => {
  it("sets an unknown image up as the host's other apps are", () => {
    const { spec, habits, proxy } = draftOf("ghcr.io/somedev/Cool_App:latest", facts(), profile);
    expect(spec).toMatchObject({
      slug: "cool-app",
      name: "cool-app",
      folder: "/home/me/docker/cool-app",
      restartPolicy: "unless-stopped",
      networks: ["npm"],
      port: { target: 3000, published: null },
      mounts: [{ source: "./data", target: "/data" }],
      database: null,
    });
    expect(habits).toEqual({ folderProjects: 25, networkContainers: 17 });
    expect(proxy?.kind).toBe("Nginx Proxy Manager");
    expect(() => installSpecSchema.parse(spec)).not.toThrow();
  });

  it("only claims IDs on an image that reads them, and says who it really runs as", () => {
    expect(draftOf("a/b", facts(), profile).identity).toEqual({ kind: "root" });
    expect(draftOf("a/b", facts({ user: "node" }), profile).identity).toEqual({ kind: "image", user: "node" });
    const reads = draftOf("a/b", facts({ environment: [{ name: "PUID", value: "" }] }), profile);
    expect(reads.identity).toEqual({ kind: "ids", user: "1000:1000", uses: 9, of: 9 });
    expect(reads.spec.environment).toEqual(
      expect.arrayContaining([
        { name: "PUID", value: "1000" },
        { name: "PGID", value: "1000" },
      ]),
    );
    expect(draftOf("lscr.io/linuxserver/sonarr:latest", facts(), profile).identity.kind).toBe("ids");
    expect(draftOf("a/b", facts(), profile).spec.environment.map((entry) => entry.name)).not.toContain("PUID");
  });

  it("gives data folders to the user an image names by number, and to none it cannot name", () => {
    expect(draftOf("a/b", facts({ user: "1001" }), profile).spec.owner).toBe("1001:1001");
    expect(draftOf("a/b", facts({ user: "1001:50" }), profile).spec.owner).toBe("1001:50");
    expect(draftOf("a/b", facts({ user: "node" }), profile).spec.owner).toBeNull();
  });

  it("generates what an image leaves empty and calls a secret, and nothing it gives a value", () => {
    const { spec } = draftOf(
      "a/b",
      facts({
        environment: [
          { name: "ADMIN_PASSWORD", value: "" },
          { name: "API_KEY", value: "" },
          { name: "NODE_VERSION", value: "24" },
          { name: "KEYBOARD", value: "" },
          { name: "SECRET_KEY", value: "already" },
        ],
      }),
      profile,
    );
    expect(spec.secrets.map((secret) => secret.name)).toEqual(["ADMIN_PASSWORD", "API_KEY"]);
  });

  it("goes through the proxy most apps use, not whichever is listed first", () => {
    const several: HostProfile = {
      ...profile,
      networks: [
        { name: "npm", containers: 11 },
        { name: "newt", containers: 6 },
        { name: "cloudflare", containers: 2 },
      ],
      proxies: [
        { kind: "Cloudflare Tunnel", container: "cloudflared-tunnel", network: "cloudflare" },
        { kind: "Pangolin (Newt)", container: "newt", network: "npm" },
        { kind: "Nginx Proxy Manager", container: "npm", network: "npm" },
      ],
    };
    const draft = draftOf("a/b", facts(), several);
    expect(draft.spec.networks).toEqual(["npm"]);
    expect(draft.proxy?.kind).toBe("Pangolin (Newt)");
    expect(draft.networkCounts).toEqual({ npm: 11, newt: 6, cloudflare: 2 });
    expect(draft.proxies).toContainEqual({ kind: "Cloudflare Tunnel", network: "cloudflare" });
  });

  it("publishes a port on a host with no proxy to go through", () => {
    expect(draftOf("a/b", facts(), empty).spec).toMatchObject({
      folder: "/opt/apps/b",
      networks: [],
      port: { target: 3000, published: 3000 },
    });
  });

  it("needs no port or network for an app that serves nothing", () => {
    expect(draftOf("a/b", facts({ ports: [] }), profile).spec).toMatchObject({ networks: [], port: null });
  });

  it("wires a recipe and its own database to one generated password", () => {
    const { spec, baseUrlVariable } = draftOf(mealie.image, facts({ ports: [], volumes: [] }), profile, mealie);
    expect(spec).toMatchObject({
      name: "Mealie",
      slug: "mealie",
      port: { target: 9000, published: null },
      mounts: [{ source: "./data", target: "/app/data" }],
      database: { image: "postgres:17" },
      secrets: [{ name: "POSTGRES_PASSWORD", characters: 32 }],
    });
    expect(baseUrlVariable).toBe("BASE_URL");
    const compose = composeOf(spec);
    expect(compose).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}");
    expect(compose).toContain('container_name: "Mealie-DB"');
    expect(compose).toContain("condition: service_healthy");
  });

  it("does not mount a recipe's data twice when its image declares it too", () => {
    const { spec } = draftOf(mealie.image, facts({ volumes: ["/app/data"] }), profile, mealie);
    expect(spec.mounts).toEqual([{ source: "./data", target: "/app/data" }]);
  });
});

describe("a proposal read from a project's page", () => {
  const hints = {
    image: "0xfurai/peekaping:latest",
    ports: [8383],
    volumes: ["/app/data"],
    environment: [
      { name: "DB_NAME", value: "/app/data/peekaping.db" },
      { name: "ADMIN_PASSWORD", value: "changeme" },
    ],
    leftOut: ["privileged mode", "privileged mode"],
  };
  const draft = draftOf(hints.image, facts({ ports: [], volumes: [] }), profile, undefined, {
    address: "https://github.com/0xfurai/peekaping",
    hints,
  });

  it("takes its port, data and settings, set up as the host's other apps are", () => {
    expect(draft.spec).toMatchObject({
      name: "peekaping",
      folder: "/home/me/docker/peekaping",
      networks: ["npm"],
      port: { target: 8383, published: null },
      mounts: [{ source: "./data", target: "/app/data" }],
    });
    expect(draft.spec.environment).toContainEqual({ name: "DB_NAME", value: "/app/data/peekaping.db" });
    expect(draft.project?.settings).toEqual(["DB_NAME"]);
  });

  it("never keeps an example password: it is made fresh, with its value nowhere", () => {
    expect(draft.spec.secrets.map((secret) => secret.name)).toEqual(["ADMIN_PASSWORD"]);
    expect(JSON.stringify(draft)).not.toContain("changeme");
  });

  it("says once what it left out", () => {
    expect(draft.project?.leftOut).toEqual(["privileged mode"]);
  });
});

describe("the address an app is told", () => {
  const spec = {
    slug: "books",
    environment: [],
    port: { target: 3000, published: 3100 },
  } as unknown as InstallSpec;
  const told = (from: InstallSpec, address: string | null) => withAddress(from, "APP_URL", address).environment;

  it("is where it answers on the LAN, else its name", () => {
    expect(told(spec, "192.168.10.178")).toEqual([{ name: "APP_URL", value: "http://192.168.10.178:3100" }]);
    expect(told({ ...spec, port: { target: 3000, published: null } }, "192.168.10.178")).toEqual([
      { name: "APP_URL", value: "http://books:3000" },
    ]);
  });

  it("leaves a chosen domain alone, and an app with no such setting", () => {
    const chosen = { ...spec, environment: [{ name: "APP_URL", value: "https://books.home" }] };
    expect(told(chosen, "192.168.10.178")).toEqual(chosen.environment);
    expect(withAddress(spec, null, "192.168.10.178")).toBe(spec);
  });
});

describe("the Compose file", () => {
  const { spec } = draftOf(mealie.image, facts(), profile, mealie);

  it("holds no secret or ID, those being in the .env", () => {
    const compose = composeOf({ ...spec, environment: [{ name: "PUID", value: "1000" }] });
    expect(compose).not.toContain("1000");
    expect(compose).toContain("env_file: .env");
  });

  it("keeps a database on the app's private network when the app also joins a shared one", () => {
    const compose = composeOf(spec);
    expect(compose).toContain('- "npm"');
    expect(compose).toContain('- "default"');
    expect(compose).toContain("external: true");
    expect(compose).toContain("com.autoheal.installed");
  });

  it("joins every network ticked, and can publish a port as well", () => {
    const compose = composeOf({ ...spec, networks: ["npm", "newt"], port: { target: 9000, published: 9925 } });
    expect(compose).toContain('- "npm"');
    expect(compose).toContain('- "newt"');
    expect(compose).toContain('  "newt":\n    external: true');
    expect(compose).toContain('  "npm":\n    external: true');
    expect(compose).toContain('"9925:9000"');
  });

  it("publishes only when asked", () => {
    expect(composeOf(spec)).not.toContain("ports:");
    expect(composeOf({ ...spec, networks: [], port: { target: 9000, published: 9925 } })).toContain('"9925:9000"');
  });
});

describe("what is accepted", () => {
  const { spec } = draftOf("a/b", facts(), profile);

  it.each([
    ["a name that could break out", { name: "a b;rm" }],
    ["a folder going up", { folder: "/home/me/../../etc" }],
    ["a relative folder", { folder: "docker/app" }],
    ["a value with a line break", { environment: [{ name: "A", value: "x\nEVIL=1" }] }],
    ["a value with a quote", { environment: [{ name: "A", value: "it's" }] }],
    ["a variable with a space", { environment: [{ name: "A B", value: "x" }] }],
    ["a mount going up", { mounts: [{ source: "./../../etc", target: "/x" }] }],
    ["an address for an image", { image: "https://github.com/a/b" }],
    ["an image with a space", { image: "a b" }],
    ["a short secret", { secrets: [{ name: "A", characters: 4 }] }],
  ])("refuses %s", (_what, change) => {
    expect(() => installSpecSchema.parse({ ...spec, ...change })).toThrow();
  });

  it("knows the host's own paths", () => {
    expect(isDeniedSource("/etc")).toBe(true);
    expect(isDeniedSource("/etc/passwd")).toBe(true);
    expect(isDeniedSource("/")).toBe(true);
    expect(isDeniedSource("/etcetera")).toBe(false);
    expect(isDeniedSource("/mnt/fast/app")).toBe(false);
    expect(isDeniedSource("./data")).toBe(false);
  });

  it("quotes a .env value only when it must", () => {
    expect(envLine({ name: "A", value: "plain" })).toBe("A=plain");
    expect(envLine({ name: "A", value: "two words" })).toBe("A='two words'");
    expect(envLine({ name: "A", value: "$HOME" })).toBe("A='$HOME'");
  });
});

describe("what a person types", () => {
  it("finds a recipe by name, and takes a path for an image", () => {
    expect(recipesMatching("meal").map((recipe) => recipe.id)).toEqual(["mealie"]);
    expect(recipesMatching("  ")).toEqual([]);
    expect(looksLikeImage("ghcr.io/someone/app:latest")).toBe(true);
    expect(looksLikeImage("nginx:1")).toBe(true);
    expect(looksLikeImage("https://github.com/someone/app")).toBe(false);
    expect(looksLikeImage("uptime kuma")).toBe(false);
  });

  it("names an app after its image", () => {
    expect(slugOf("ghcr.io/somedev/Cool_App:latest")).toBe("cool-app");
    expect(slugOf("nginx@sha256:abc")).toBe("nginx");
  });
});
