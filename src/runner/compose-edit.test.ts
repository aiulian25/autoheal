import { describe, expect, it } from "vitest";
import type { ContainerSettings } from "../shared/protocol.js";
import { composeAgrees, editedCompose, isEmptyChange, settingsChange, type SettingsChange } from "./compose-edit.js";

const FOLDER = "/srv/wiki";
const ENV = `${FOLDER}/.env`;
const NO_CHANGE: SettingsChange = {
  environment: { set: [], removed: [] },
  labels: { set: [], removed: [] },
  ports: { added: [], removed: [] },
  mounts: { added: [], removed: [] },
  restart: null,
};
const FILE = `# my wiki
services:
  wiki:
    image: wiki:2 # pinned on purpose
    restart: unless-stopped
    env_file: stack.env
    environment:
      # the port it listens on
      - PORT=3000
      - DB_PASS=\${DB_PASS}
      - URL=https://\${DOMAIN}/wiki
      - PASSED
    labels:
      app.kind: "wiki"
    ports:
      - "8080:80"
      - \${ADMIN_PORT}:81
      - target: 443
        published: 8443
    volumes:
      - ./data:/data
      - wiki_cache:/cache:ro
  db:
    image: postgres:16
    environment:
      PORT: 5432

volumes:
  wiki_cache:
`;

const edit = (change: Partial<SettingsChange>, text = FILE, envs: [string, string | null][] = []) =>
  editedCompose({
    text,
    service: "wiki",
    project: "wiki",
    environmentPath: ENV,
    folder: FOLDER,
    envTexts: new Map(envs),
    change: { ...NO_CHANGE, ...change },
  });
const edited = (...args: Parameters<typeof edit>) => {
  const result = edit(...args);
  if (result.problem !== null) throw new Error(result.problem);
  return result;
};

describe("editing a Compose file", () => {
  it("changes a value where it stands, and nothing else", () => {
    const { text } = edited({ environment: { set: [{ name: "PORT", value: "4000" }], removed: [] } });
    expect(text).toBe(FILE.replace("- PORT=3000", "- PORT=4000"));
  });

  it("leaves another service's value of the same name", () => {
    const { text } = edited({ environment: { set: [{ name: "PORT", value: "4000" }], removed: [] } });
    expect(text).toContain("PORT: 5432");
  });

  it("changes a variable's value in the .env, leaving the file's reference", () => {
    const result = edited({ environment: { set: [{ name: "DB_PASS", value: "new one" }], removed: [] } }, FILE, [
      [ENV, "# keep\nDB_PASS=old\nOTHER=1\n"],
    ]);
    expect(result.text).toBe(FILE);
    expect(result.envTexts.get(ENV)).toBe("# keep\nDB_PASS='new one'\nOTHER=1\n");
  });

  it("gives a value the file leaves to the shell a place in the .env", () => {
    const result = edited({ environment: { set: [{ name: "PASSED", value: "yes" }], removed: [] } }, FILE, [
      [ENV, null],
    ]);
    expect(result.envTexts.get(ENV)).toBe("PASSED=yes\n");
  });

  it("refuses a variable inside a longer value rather than write the whole thing out", () => {
    const result = edit({ environment: { set: [{ name: "URL", value: "https://x/wiki" }], removed: [] } });
    expect(result.problem).toContain("URL");
  });

  it("changes a value that comes from the service's own settings file there", () => {
    const stack = `${FOLDER}/stack.env`;
    const result = edited({ environment: { set: [{ name: "FROM_FILE", value: "2" }], removed: [] } }, FILE, [
      [stack, "FROM_FILE=1\n"],
    ]);
    expect(result.text).toBe(FILE);
    expect(result.envTexts.get(stack)).toBe("FROM_FILE=2\n");
  });

  it("adds a new setting, a password going to the .env", () => {
    const result = edited(
      {
        environment: {
          set: [
            { name: "LANGUAGE", value: "en" },
            { name: "API_TOKEN", value: "abc" },
          ],
          removed: [],
        },
      },
      FILE,
      [[ENV, "A=1\n"]],
    );
    expect(result.text).toContain(`      - LANGUAGE=en\n      - "API_TOKEN=\${API_TOKEN}"\n`);
    expect(result.text).not.toContain("abc");
    expect(result.envTexts.get(ENV)).toBe("A=1\nAPI_TOKEN=abc\n");
  });

  it("writes a dollar so that Compose reads a dollar", () => {
    const { text } = edited({ environment: { set: [{ name: "PORT", value: "a$b" }], removed: [] } });
    expect(text).toContain('- "PORT=a$$b"');
  });

  it("removes a value, keeping the comment above the next", () => {
    const file = "services:\n  wiki:\n    environment:\n      - A=1\n      # about B\n      - B=2\n";
    const { text } = edited({ environment: { set: [], removed: ["A"] } }, file);
    expect(text).toBe("services:\n  wiki:\n    environment:\n      # about B\n      - B=2\n");
  });

  it("takes the key away with its last item", () => {
    const file = "services:\n  wiki:\n    image: a\n    environment:\n      - A=1\n    restart: always\n";
    const { text } = edited({ environment: { set: [], removed: ["A"] } }, file);
    expect(text).toBe("services:\n  wiki:\n    image: a\n    restart: always\n");
  });

  it("gives a service the key it does not have yet", () => {
    const file = "services:\n  wiki:\n    image: a\n\nnetworks: {}\n";
    const { text } = edited({ environment: { set: [{ name: "A", value: "1" }], removed: [] } }, file);
    expect(text).toBe("services:\n  wiki:\n    image: a\n    environment:\n      - A=1\n\nnetworks: {}\n");
  });

  it("keeps a map a map", () => {
    const { text } = edited({ labels: { set: [{ name: "app.kind", value: "docs" }], removed: [] } });
    expect(text).toContain('app.kind: "docs"');
  });

  it("changes a published port in place, one given by a variable too", () => {
    const { text } = edited({
      ports: {
        removed: [
          { target: 80, protocol: "tcp", published: 8080, address: "" },
          { target: 81, protocol: "tcp", published: 9000, address: "" },
        ],
        added: [
          { target: 80, protocol: "tcp", published: 8081, address: "127.0.0.1" },
          { target: 81, protocol: "tcp", published: 9001, address: "" },
        ],
      },
    });
    expect(text).toContain('      - "127.0.0.1:8081:80/tcp"\n      - "9001:81/tcp"\n      - target: 443');
  });

  it("refuses a port written in the long form", () => {
    const result = edit({
      ports: { removed: [{ target: 443, protocol: "tcp", published: 8443, address: "" }], added: [] },
    });
    expect(result.problem).toContain("8443");
  });

  it("keeps a mount's source as the file wrote it when only read-only changes", () => {
    const bind = (readOnly: boolean) => ({
      kind: "bind" as const,
      source: "/srv/wiki/data",
      target: "/data",
      readOnly,
    });
    const { text } = edited({ mounts: { removed: [bind(false)], added: [bind(true)] } });
    expect(text).toContain('- "./data:/data:ro"');
  });

  it("calls a project's volume by its short name, and declares one from outside", () => {
    const volume = (source: string, target: string) => ({ kind: "volume" as const, source, target, readOnly: false });
    const { text } = edited({
      mounts: { removed: [], added: [volume("wiki_cache", "/more"), volume("shared", "/shared")] },
    });
    expect(text).toContain('- "wiki_cache:/more"');
    expect(text).toContain('- "shared:/shared"');
    expect(text).toContain('volumes:\n  wiki_cache:\n  "shared":\n    external: true\n');
  });

  it("quotes a restart policy YAML would read as false", () => {
    const { text } = edited({ restart: { policy: "no", retries: 0 } });
    expect(text).toContain('    restart: "no"\n');
    expect(text).not.toContain("unless-stopped");
  });

  it("refuses what it cannot read rather than guess", () => {
    const inline = "services:\n  wiki:\n    environment: {A: 1}\n";
    expect(edit({ environment: { set: [{ name: "A", value: "2" }], removed: [] } }, inline).problem).toContain(
      "environment",
    );
    expect(edit({ restart: { policy: "always", retries: 0 } }, "services: {wiki: {image: a}}\n").problem).toContain(
      "wiki",
    );
  });
});

describe("what changed", () => {
  const settings: ContainerSettings = {
    environment: [{ name: "A", value: "1" }],
    labels: [{ name: "com.docker.compose.service", value: "wiki" }],
    ports: [],
    mounts: [],
    restart: { policy: "always", retries: 0 },
  };

  it("is nothing when nothing changed, or only Compose's own labels", () => {
    const labels = [{ name: "com.docker.compose.service", value: "other" }];
    expect(isEmptyChange(settingsChange(settings, settings))).toBe(true);
    expect(isEmptyChange(settingsChange(settings, { ...settings, labels }))).toBe(true);
  });

  it("names what was set and what went", () => {
    const change = settingsChange(settings, { ...settings, environment: [{ name: "B", value: "2" }] });
    expect(change.environment).toEqual({ set: [{ name: "B", value: "2" }], removed: ["A"] });
  });
});

describe("whether Compose agrees", () => {
  const change: SettingsChange = {
    ...NO_CHANGE,
    environment: { set: [{ name: "A", value: "a$b" }], removed: ["GONE"] },
    ports: {
      added: [{ target: 80, protocol: "tcp", published: 8081, address: "" }],
      removed: [{ target: 80, protocol: "tcp", published: 8080, address: "" }],
    },
    restart: { policy: "on-failure", retries: 3 },
  };
  const right = {
    environment: { A: "a$$b" },
    ports: [{ target: 80, published: "8081", protocol: "tcp" }],
    restart: "on-failure:3",
  };

  it("does when the service reads as asked", () => {
    expect(composeAgrees(right, change)).toBe(true);
  });

  it("does not when anything reads otherwise, or the service is not there", () => {
    expect(composeAgrees({ ...right, environment: { A: "other" } }, change)).toBe(false);
    expect(composeAgrees({ ...right, environment: { A: "a$$b", GONE: "1" } }, change)).toBe(false);
    expect(composeAgrees({ ...right, ports: [] }, change)).toBe(false);
    expect(composeAgrees({ ...right, restart: "always" }, change)).toBe(false);
    expect(composeAgrees(undefined, change)).toBe(false);
  });
});
