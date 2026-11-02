import { describe, expect, it } from "vitest";
import { answerHostProfile, profileOf } from "./host-profile.js";
import type { ContainerDetails } from "./incident-report.js";

const container = (
  name: string,
  {
    image = "example/app:1",
    env = [] as string[],
    project = null as string | null,
    folder = null as string | null,
    networks = [] as string[],
    binds = [] as string[],
    policy = "unless-stopped",
    labels = {} as Record<string, string>,
  } = {},
) =>
  ({
    Name: `/${name}`,
    State: { Running: true },
    Config: {
      Image: image,
      Env: env,
      Labels: {
        ...(project === null ? {} : { "com.docker.compose.project": project }),
        ...(folder === null ? {} : { "com.docker.compose.project.working_dir": folder }),
        ...labels,
      },
    },
    HostConfig: { RestartPolicy: { Name: policy } },
    NetworkSettings: { Networks: Object.fromEntries(networks.map((network) => [network, {}])) },
    Mounts: binds.map((source) => ({ Type: "bind", Source: source, Destination: "/data" })),
  }) as unknown as ContainerDetails;

const apps = [
  container("wiki", {
    image: "ghcr.io/requarks/wiki:2",
    env: ["PUID=1000", "PGID=1000", "TZ=Europe/Lisbon", "DB_PASS=do-not-read-me"],
    project: "wiki",
    folder: "/home/me/docker/wiki",
    networks: ["npm", "wiki_default"],
    binds: ["/home/me/docker/wiki/data", "/mnt/fast/wiki", "/var/run/docker.sock"],
  }),
  container("wiki-db", {
    image: "postgres:16",
    env: ["POSTGRES_PASSWORD=do-not-read-me"],
    project: "wiki",
    folder: "/home/me/docker/wiki",
    networks: ["wiki_default"],
  }),
  container("feed", {
    env: ["PUID=1000", "PGID=1000", "TZ=Europe/Lisbon", "API_TOKEN=do-not-read-me"],
    project: "feed",
    folder: "/home/me/docker/feed",
    networks: ["npm"],
    binds: ["/mnt/fast/feed/data"],
  }),
  container("odd", { env: ["PUID=33", "PGID=33", "TZ=UTC"], project: "odd", folder: "/srv/odd", policy: "always" }),
  container("proxy", {
    image: "jc21/nginx-proxy-manager:2.16.0",
    project: "proxy",
    folder: "/home/me/docker/proxy",
    networks: ["npm"],
  }),
  container("shared-db", { image: "docker.io/library/mariadb:11", project: "data", folder: "/home/me/docker/data" }),
  container("autoheal-helper-1", { env: ["PUID=7", "PGID=7"], labels: { "com.autoheal.helper": "true" } }),
];

describe("how a host is set up", () => {
  const profile = profileOf(apps);

  it("takes what most containers do, and says how many, leaving Autoheal's own helpers out", () => {
    expect(profile.containers).toBe(6);
    expect(profile.user).toEqual({ value: "1000:1000", uses: 2, of: 3 });
    expect(profile.timeZone).toEqual({ value: "Europe/Lisbon", uses: 2, of: 3 });
    expect(profile.restartPolicy).toEqual({ value: "unless-stopped", uses: 5, of: 6 });
  });

  it("never carries a value beyond its IDs and time zone", () => {
    expect(JSON.stringify(profile)).not.toContain("do-not-read-me");
  });

  it("finds the folder Compose projects live in, each project once", () => {
    expect(profile.composeFolder).toEqual({ path: "/home/me/docker", projects: 4, of: 5 });
  });

  it("tells data beside its Compose file from data elsewhere, and leaves system paths out", () => {
    expect(profile.mountsBesideCompose).toBe(1);
    expect(profile.places).toEqual([{ path: "/mnt/fast", mounts: 2, availableBytes: null }]);
  });

  it("lists only networks two or more apps share", () => {
    expect(profile.networks).toEqual([{ name: "npm", containers: 3 }]);
  });

  it("recognises a proxy by its image's own name, with the network it shares", () => {
    expect(profile.proxies).toEqual([{ kind: "Nginx Proxy Manager", container: "proxy", network: "npm" }]);
  });

  it("tells a database an app keeps for itself from one standing alone, whatever the registry", () => {
    expect(profile.databases).toEqual({ common: "mariadb:11", ownToAnApp: 1, standingAlone: 1 });
  });

  it("does not take an app with a database's name in its tag for a database", () => {
    const app = container("feed", { image: "athou/commafeed:latest-postgresql" });
    expect(profileOf([app]).databases).toEqual({ common: null, ownToAnApp: 0, standingAlone: 0 });
  });

  it("has nothing to say of a host with no containers", () => {
    expect(profileOf([])).toMatchObject({ containers: 0, user: null, timeZone: null, composeFolder: null, places: [] });
  });
});

describe("hosts laid out differently", () => {
  const nas = (folder: string, data: string) => [
    container("app", {
      env: ["PUID=1026", "PGID=100", "TZ=Europe/Lisbon"],
      project: "app",
      folder: `${folder}/app`,
      binds: [`${folder}/app/config`, `${data}/media`, `${data}/backups`],
    }),
    container("other", { project: "other", folder: `${folder}/other`, binds: [`${folder}/other/config`] }),
  ];

  it.each([
    ["Synology", "/volume1/docker", "/volume1/media", "/volume1/media"],
    ["QNAP", "/share/Container", "/share/Multimedia", "/share/Multimedia"],
    ["Unraid", "/mnt/user/appdata", "/mnt/user/media", "/mnt/user"],
    ["TrueNAS", "/mnt/tank/apps", "/mnt/tank/data", "/mnt/tank"],
  ])("finds a %s's app folders and data", (_nas, folder, data, place) => {
    const profile = profileOf(nas(folder, data));
    expect(profile.composeFolder).toEqual({ path: folder, projects: 2, of: 2 });
    expect(profile.mountsBesideCompose).toBe(2);
    expect(profile.places).toEqual([{ path: place, mounts: 2, availableBytes: null }]);
    expect(profile.user).toEqual({ value: "1026:100", uses: 1, of: 1 });
  });

  it("copes with what plain docker run leaves: no Compose labels, no IDs, no time zone", () => {
    const profile = profileOf([container("one", { binds: ["/opt/one"] }), container("two", { networks: ["bridge"] })]);
    expect(profile).toMatchObject({ composeFolder: null, user: null, timeZone: null, mountsBesideCompose: 0 });
    expect(profile.places).toEqual([{ path: "/opt/one", mounts: 1, availableBytes: null }]);
    expect(profile.networks).toEqual([]);
  });

  it("takes temporary mounts for no one's data", () => {
    expect(profileOf([container("one", { binds: ["/tmp/test-1", "/tmp"] })]).places).toEqual([]);
  });

  it("names the network most apps share for a proxy on several", () => {
    const proxy = container("npm", {
      image: "jc21/nginx-proxy-manager:2",
      project: "proxy",
      networks: ["aaa-tunnel", "npm"],
    });
    const others = ["a", "b", "c"].map((name) => container(name, { project: name, networks: ["npm"] }));
    const tunnel = container("t", { project: "t", networks: ["aaa-tunnel"] });
    expect(profileOf([proxy, tunnel, ...others]).proxies[0]?.network).toBe("npm");
  });

  it("leaves out an ID that is not a number, rather than show a variable it could not read", () => {
    expect(profileOf([container("one", { env: ["PUID=\${UID}", "PGID=1000"] })]).user).toBeNull();
  });
});

describe("a runner's answer", () => {
  const docker = {
    containerSummaries: async () => apps.map((app) => ({ Id: app.Name })) as never,
    inspect: async (id: string) => apps.find((app) => app.Name === id) ?? null,
  };

  it("adds the space on each data folder's disk, looked for under the host's root", async () => {
    const asked: string[] = [];
    const answer = await answerHostProfile({
      docker,
      files: {
        filesystem: async (path) => {
          asked.push(path);
          return { device: "1", totalBytes: 2, usedBytes: 1, availableBytes: 1024 };
        },
      },
      hostRoot: "/host/root",
      containerAccess: true,
    });
    expect(asked).toEqual(["/host/root/mnt/fast"]);
    expect(answer.profile?.places[0]?.availableBytes).toBe(1024);
  });

  it("says no where the host's .env keeps people out, and looks at nothing", async () => {
    const answer = await answerHostProfile({
      docker: {
        containerSummaries: async () => {
          throw new Error("looked");
        },
        inspect: async () => null,
      },
      files: { filesystem: async () => null },
      hostRoot: "/",
      containerAccess: false,
    });
    expect(answer.profile).toBeNull();
    expect(answer.error).toBeTruthy();
  });

  it("says why when Docker cannot answer", async () => {
    const answer = await answerHostProfile({
      docker: {
        containerSummaries: async () => {
          throw new Error("Docker is down");
        },
        inspect: async () => null,
      },
      files: { filesystem: async () => null },
      hostRoot: "/",
      containerAccess: true,
    });
    expect(answer).toEqual({ error: "Docker is down", profile: null });
  });
});
