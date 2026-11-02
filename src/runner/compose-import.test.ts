import { describe, expect, it } from "vitest";
import { importCompose, type ComposeConfig, type ImportedCompose } from "./compose-import.js";
import { composeOf, type InstallSpec } from "../shared/install.js";

// What Compose itself makes of Paperless's docker-compose.postgres.yml, read from the real thing.
const paperless: ComposeConfig = {
  services: {
    broker: {
      image: "docker.io/valkey/valkey:9-alpine",
      volumes: [{ source: "redisdata", target: "/data", type: "volume" }],
    },
    db: {
      image: "docker.io/library/postgres:18",
      environment: { POSTGRES_DB: "paperless", POSTGRES_USER: "paperless", POSTGRES_PASSWORD: "paperless" },
      volumes: [{ source: "pgdata", target: "/var/lib/postgresql", type: "volume" }],
    },
    webserver: {
      image: "ghcr.io/paperless-ngx/paperless-ngx:latest",
      depends_on: { broker: { condition: "service_started" }, db: { condition: "service_started" } },
      env_file: [{ path: "docker-compose.env" }],
      environment: { PAPERLESS_REDIS: "redis://broker:6379", PAPERLESS_DBHOST: "db" },
      ports: [{ target: 8000, published: "8000" }],
      volumes: [
        { source: "data", target: "/usr/src/paperless/data", type: "volume" },
        { source: "./export", target: "/usr/src/paperless/export", type: "bind" },
      ],
    },
  },
};
const habits = { timeZone: "Europe/Lisbon", ids: { user: "1000", group: "1000" } };
const imported = (config: ComposeConfig, env: Record<string, string> = {}) => {
  const result = importCompose(config, env, habits);
  if ("problem" in result) throw new Error(result.problem);
  return result;
};

describe("Paperless's own Compose file", () => {
  const app = imported(paperless, { "docker-compose.env": "# a comment\nPAPERLESS_SECRET_KEY=change-me\n" });

  it("finds the app among its parts, the port it serves on, and every image", () => {
    expect(app.document.main).toBe("webserver");
    expect(app.mainImage).toBe("ghcr.io/paperless-ngx/paperless-ngx:latest");
    expect(app.port).toBe(8000);
    expect(app.containers).toEqual(["broker", "db", "webserver"]);
  });

  it("makes a placeholder fresh, keeps a lone default its app relies on, and says so", () => {
    expect(app.secrets).toEqual(["PAPERLESS_SECRET_KEY"]);
    const web = app.document.services.webserver!.environment;
    expect(web.PAPERLESS_SECRET_KEY).toBe("${PAPERLESS_SECRET_KEY}");
    expect(app.document.services.db!.environment.POSTGRES_PASSWORD).toBe("paperless");
    expect(app.kept).toEqual(["POSTGRES_PASSWORD"]);
    expect(JSON.stringify(app.document)).not.toContain("change-me");
  });

  it("keeps all its data beside the Compose file, each with its own container", () => {
    expect(app.mounts).toEqual([
      { source: "./redisdata", target: "/data", service: "broker" },
      { source: "./pgdata", target: "/var/lib/postgresql", service: "db" },
      { source: "./data", target: "/usr/src/paperless/data", service: "webserver" },
      { source: "./export", target: "/usr/src/paperless/export", service: "webserver" },
    ]);
  });

  it("adds the host's time zone to the app", () => {
    expect(app.document.services.webserver!.environment.TZ).toBe("Europe/Lisbon");
  });
});

describe("what is written for it", () => {
  const app = imported(paperless, { "docker-compose.env": "PAPERLESS_SECRET_KEY=change-me" });
  const spec: InstallSpec = {
    name: "paperless-ngx",
    slug: "paperless-ngx",
    image: app.mainImage,
    folder: "/home/me/docker/paperless-ngx",
    restartPolicy: "unless-stopped",
    owner: null,
    networks: ["npm"],
    port: { target: 8000, published: 8888 },
    mounts: app.mounts,
    environment: [],
    secrets: [{ name: "PAPERLESS_SECRET_KEY", characters: 32 }],
    database: null,
    document: app.document,
  };
  const compose = composeOf(spec);

  it("names its containers after the app, labels them all, and takes the app's choices", () => {
    expect(compose).toContain('container_name: "paperless-ngx"');
    expect(compose).toContain('container_name: "paperless-ngx-db"');
    expect(compose).toContain('container_name: "paperless-ngx-broker"');
    expect(compose.match(/com\.autoheal\.installed/g)).toHaveLength(3);
    expect(compose.match(/restart: unless-stopped/g)).toHaveLength(3);
    expect(compose).toContain('"8888:8000"');
    expect(compose).toContain('- "npm"');
    expect(compose).toContain('- "default"');
    expect(compose).toContain('"./pgdata:/var/lib/postgresql"');
    expect(compose).toContain('PAPERLESS_SECRET_KEY: "${PAPERLESS_SECRET_KEY}"');
  });

  it("publishes only the app, and only when asked", () => {
    expect(compose.match(/ports:/g)).toHaveLength(1);
    expect(composeOf({ ...spec, port: { target: 8000, published: null } })).not.toContain("ports:");
  });
});

describe("a stranger's file", () => {
  it("gets nothing dangerous through, and says what it left out", () => {
    const app = imported({
      services: {
        web: {
          image: "a/b:1",
          privileged: true,
          network_mode: "host",
          pid: "host",
          cap_add: ["SYS_ADMIN"],
          devices: ["/dev/sda"],
          ports: [{ target: 80, published: "80" }],
          volumes: [
            { source: "/var/run/docker.sock", target: "/var/run/docker.sock", type: "bind" },
            { source: "/etc", target: "/hostetc", type: "bind" },
            { source: "/mnt/photos", target: "/photos", type: "bind" },
          ],
          labels: { "traefik.enable": "true" },
          security_opt: ["seccomp=unconfined"],
          sysctls: { a: 1 },
        } as never,
      },
    });
    expect(app.leftOut).toEqual(
      expect.arrayContaining([
        "privileged mode",
        "the host's own network",
        "the host's processes",
        "extra capabilities",
        "the host's devices",
        "full control of Docker (its socket)",
        "the host's own /etc",
      ]),
    );
    expect(app.mounts).toEqual([{ source: "./photos", target: "/photos", service: "web" }]);
    const written = JSON.stringify(app.document);
    for (const word of [
      "privileged",
      "SYS_ADMIN",
      "docker.sock",
      "seccomp",
      "traefik",
      "sysctls",
      "/etc",
      "network_mode",
    ]) {
      expect(written).not.toContain(word);
    }
  });

  it("gives one generated password to every container sharing it, in a URL too", () => {
    const app = imported({
      services: {
        web: {
          image: "a/b:1",
          environment: { DB_PASSWORD: "hunter22", DATABASE_URL: "postgres://u:hunter22@db/app" },
        },
        db: { image: "postgres:17", environment: { POSTGRES_PASSWORD: "hunter22" } },
      },
    });
    expect(app.secrets).toEqual(["DB_PASSWORD"]);
    expect(app.kept).toEqual([]);
    expect(app.document.services.db!.environment.POSTGRES_PASSWORD).toBe("${DB_PASSWORD}");
    expect(app.document.services.web!.environment.DATABASE_URL).toBe("postgres://u:${DB_PASSWORD}@db/app");
    expect(JSON.stringify(app.document)).not.toContain("hunter22");
  });

  it("leaves a value that already refers to a variable alone", () => {
    const app = imported({ services: { web: { image: "a/b:1", environment: { API_KEY: "${API_KEY}" } } } });
    expect(app.secrets).toEqual([]);
    expect(app.document.services.web!.environment.API_KEY).toBe("${API_KEY}");
  });

  it("does not take a user or a folder for the password that happens to read the same", () => {
    const app = imported({
      services: {
        web: {
          image: "a/b:1",
          environment: { DB_PASSWORD: "postgres", DB_USERNAME: "postgres", DATA_FOLDER: "./postgres" },
        },
        db: { image: "postgres:17", environment: { POSTGRES_PASSWORD: "postgres", POSTGRES_USER: "postgres" } },
      },
    });
    expect(app.document.services.db!.environment).toEqual({
      POSTGRES_PASSWORD: "${DB_PASSWORD}",
      POSTGRES_USER: "postgres",
    });
    expect(app.document.services.web!.environment).toMatchObject({
      DB_PASSWORD: "${DB_PASSWORD}",
      DB_USERNAME: "postgres",
      DATA_FOLDER: "./postgres",
    });
  });

  it("gives two secrets one container holds a value each, though they share a placeholder", () => {
    const app = imported({
      services: { web: { image: "a/b:1", environment: { JWT_SECRET: "change-this", SETUP_TOKEN: "change-this" } } },
    });
    expect(app.secrets).toEqual(["JWT_SECRET", "SETUP_TOKEN"]);
    expect(app.document.services.web!.environment).toMatchObject({
      JWT_SECRET: "${JWT_SECRET}",
      SETUP_TOKEN: "${SETUP_TOKEN}",
    });
  });

  it("makes a change-this placeholder fresh, and leaves blank what its file makes optional", () => {
    const text = "WORKER_TOKEN: ${WORKER_TOKEN:-}\nSOME_TOKEN_FILE: ${SOME_TOKEN_FILE:-}";
    const config: ComposeConfig = {
      services: {
        web: {
          image: "a/b:1",
          environment: { JWT_SECRET: "change-this-long-secret", WORKER_TOKEN: "", OTHER_SECRET_FILE: "" },
        },
      },
    };
    const result = importCompose(config, {}, habits, text);
    if ("problem" in result) throw new Error(result.problem);
    expect(result.secrets).toEqual(["JWT_SECRET"]);
    expect(result.document.services.web!.environment).toEqual({
      JWT_SECRET: "${JWT_SECRET}",
      WORKER_TOKEN: "",
      OTHER_SECRET_FILE: "",
      TZ: "Europe/Lisbon",
    });
  });

  it("has one setting for an address its file only gives an example of", () => {
    const app = imported({
      services: {
        web: {
          image: "a/b:1",
          environment: {
            APP_URL: "https://app.example.com",
            CLIENT_URL: "https://app.example.com",
            WEBHOOK: "https://real.host/hook",
          },
        },
      },
    });
    expect(app.addressVariable).toBe("APP_URL");
    expect(app.document.services.web!.environment).toMatchObject({
      APP_URL: "${APP_URL}",
      CLIENT_URL: "${APP_URL}",
      WEBHOOK: "https://real.host/hook",
    });
  });

  describe("a settings file listing every option, most left blank", () => {
    const text = "DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/postgres";
    const sample = [
      "NEXTAUTH_URL=http://localhost:3000/api/v1/auth",
      "NEXTAUTH_SECRET=",
      "POSTGRES_PASSWORD=",
      "MEILI_MASTER_KEY=",
      "OPENAI_API_KEY=",
      "GITHUB_SECRET=",
      "PROXY_BYPASS=",
      "NEXT_PUBLIC_CREDENTIALS_ENABLED=",
      "ALLOW_PRIVATE_NETWORK_ACCESS=",
      "PAGINATION_TAKE_COUNT=50",
    ].join("\n");
    const result = importCompose(
      {
        services: {
          app: {
            image: "a/b:1",
            env_file: [{ path: ".env" }],
            environment: { DATABASE_URL: "postgresql://postgres:@postgres:5432/postgres" },
            ports: [{ target: 3000 }],
          },
          postgres: { image: "postgres:16-alpine", env_file: [{ path: ".env" }] },
        },
      },
      { ".env": sample },
      habits,
      text,
    );
    if ("problem" in result) throw new Error(result.problem);
    const app = result.document.services.app!.environment;

    it("makes only what it cannot start without", () => {
      expect(result.secrets.sort()).toEqual(["MEILI_MASTER_KEY", "NEXTAUTH_SECRET", "POSTGRES_PASSWORD"]);
      expect(Object.keys(app)).not.toEqual(expect.arrayContaining(["OPENAI_API_KEY"]));
      for (const name of ["GITHUB_SECRET", "PROXY_BYPASS", "NEXT_PUBLIC_CREDENTIALS_ENABLED"]) {
        expect(app).not.toHaveProperty(name);
      }
      expect(app.PAGINATION_TAKE_COUNT).toBe("50");
    });

    it("gives the database and the URL that reaches it the same password", () => {
      expect(app.DATABASE_URL).toBe("postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/postgres");
      expect(result.document.services.postgres!.environment.POSTGRES_PASSWORD).toBe("${POSTGRES_PASSWORD}");
    });

    it("takes the app's own localhost for its address, keeping the path after it", () => {
      expect(result.addressVariable).toBe("NEXTAUTH_URL");
      expect(app.NEXTAUTH_URL).toBe("${NEXTAUTH_URL}/api/v1/auth");
    });
  });

  it("follows a blank password to the variable its file fills it from", () => {
    const text = "POSTGRES_PASSWORD: ${DB_PASSWORD}\nDB_URL: postgres://u:${DB_PASSWORD}@db/app";
    const result = importCompose(
      {
        services: {
          web: { image: "a/b:1", environment: { DB_URL: "postgres://u:@db/app" } },
          db: { image: "postgres:17", environment: { POSTGRES_PASSWORD: "" } },
        },
      },
      {},
      habits,
      text,
    );
    if ("problem" in result) throw new Error(result.problem);
    expect(result.secrets).toEqual(["DB_PASSWORD"]);
    expect(result.document.services.db!.environment.POSTGRES_PASSWORD).toBe("${DB_PASSWORD}");
    expect(result.document.services.web!.environment.DB_URL).toBe("postgres://u:${DB_PASSWORD}@db/app");
  });

  it("does not take another service's localhost for the app's address", () => {
    const app = imported({
      services: {
        web: { image: "a/b:1", ports: [{ target: 3000 }], environment: { OLLAMA_URL: "http://localhost:11434" } },
      },
    });
    expect(app.addressVariable).toBeNull();
    expect(app.document.services.web!.environment.OLLAMA_URL).toBe("http://localhost:11434");
  });

  it("will not install an image nothing names", () => {
    const result = importCompose({ services: { web: { image: "${APP_IMAGE?required}" } } }, {}, habits);
    expect(result).toEqual({ problem: expect.stringContaining("web") });
  });

  it("uses the host's IDs where a file sets them", () => {
    const app = imported({ services: { web: { image: "a/b:1", environment: { PUID: "0", PGID: "0" } } } });
    expect(app.document.services.web!.environment).toMatchObject({ PUID: "1000", PGID: "1000" });
  });

  it("picks the app, not its database, even when only the database publishes a port", () => {
    const app: ImportedCompose = imported({
      services: {
        db: { image: "postgres:17", ports: [{ target: 5432 }] },
        web: { image: "a/b:1" },
      },
    });
    expect(app.document.main).toBe("web");
  });

  it("takes what nothing else depends on for the app, when none publishes a port", () => {
    const app = imported({
      services: {
        helper: { image: "a/helper:1" },
        web: { image: "a/web:1", depends_on: { helper: { condition: "service_started" } } },
      },
    });
    expect(app.document.main).toBe("web");
  });

  describe("WyrmRSS: an interface in front of its own API, with its database password in a URL", () => {
    const wyrm = imported({
      services: {
        "wyrm-db": {
          image: "postgres:18",
          environment: { POSTGRES_USER: "wyrm", POSTGRES_PASSWORD: "wyrm", POSTGRES_DB: "wyrm" },
        },
        "wyrm-server": {
          image: "ghcr.io/kryoseu/wyrm-server:latest",
          environment: { WYRM_DATABASE_CONNECTION: "postgres://wyrm:wyrm@wyrm-db/wyrm" },
          ports: [{ target: 3001, published: "3001" }],
          depends_on: { "wyrm-db": { condition: "service_healthy" } },
        },
        "wyrm-ui": {
          image: "ghcr.io/kryoseu/wyrm-ui:latest",
          environment: { WYRM_BACKEND_URL: "http://wyrm-server:3001" },
          ports: [{ target: 3000, published: "3000" }],
          depends_on: { "wyrm-server": { condition: "service_healthy" } },
        },
      },
    });

    it("opens the interface, not the API it depends on", () => {
      expect(wyrm.document.main).toBe("wyrm-ui");
      expect(wyrm.port).toBe(3000);
    });

    it("generates the password in both places and leaves the user and database names", () => {
      expect(wyrm.secrets).toEqual(["POSTGRES_PASSWORD"]);
      expect(wyrm.kept).toEqual([]);
      expect(wyrm.document.services["wyrm-db"]!.environment).toEqual({
        POSTGRES_USER: "wyrm",
        POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}",
        POSTGRES_DB: "wyrm",
      });
      expect(wyrm.document.services["wyrm-server"]!.environment.WYRM_DATABASE_CONNECTION).toBe(
        "postgres://wyrm:${POSTGRES_PASSWORD}@wyrm-db/wyrm",
      );
    });
  });

  it("will not install what it would have to build, or an empty file", () => {
    expect(importCompose({ services: { web: { build: { context: "." } } } }, {}, habits)).toMatchObject({
      problem: expect.stringContaining("built from source"),
    });
    expect(importCompose({ services: {} }, {}, habits)).toMatchObject({
      problem: expect.stringContaining("no containers"),
    });
  });

  it("leaves out optional parts a file only starts when asked", () => {
    const app = imported({
      services: { web: { image: "a/b:1" }, tools: { image: "a/tools:1", profiles: ["debug"] } },
    });
    expect(app.containers).toEqual(["web"]);
  });
});
