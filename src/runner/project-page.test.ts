import { describe, expect, it } from "vitest";
import { PROJECT_PAGE } from "../shared/constants.js";
import {
  PROJECT_FILE_TOO_LARGE,
  hintsInReadme,
  parseDockerRun,
  readProjectFile,
  readProjectPage,
  readProjectSettings,
} from "./project-page.js";

const page = (files: Record<string, string>) =>
  (async (url: string) => {
    const file = url.split("/HEAD/")[1] ?? "";
    return file in files ? new Response(files[file]) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;

const PEEKAPING_STYLE = `
# A project

\`\`\`bash
docker run -d --restart=always \\
  -p 8383:8383 \\
  -e DB_NAME=/app/data/peekaping.db \\
  -v $(pwd)/.data/sqlite:/app/data \\
  --name peekaping \\
  0xfurai/peekaping:latest
\`\`\`
`;

describe("reading a docker run line", () => {
  it("finds its image, port, data folder and settings, across continued lines", () => {
    expect(hintsInReadme(PEEKAPING_STYLE).hints).toEqual({
      image: "0xfurai/peekaping:latest",
      ports: [8383],
      volumes: ["/app/data"],
      environment: [{ name: "DB_NAME", value: "/app/data/peekaping.db" }],
      leftOut: [],
    });
  });

  it("does not take a host path from a README, only where the app keeps its data", () => {
    const hints = parseDockerRun("-v /etc/shadow:/data -v /:/rootfs:ro app/x:1");
    expect(hints?.volumes).toEqual(["/data", "/rootfs"]);
    expect(JSON.stringify(hints)).not.toContain("/etc/shadow");
  });

  it("leaves out what gives an app power over its host, and says so", () => {
    const hints = parseDockerRun(
      "--privileged --network=host --cap-add NET_ADMIN --device /dev/sda -v /var/run/docker.sock:/var/run/docker.sock app/x:1",
    );
    expect(hints?.leftOut).toEqual([
      "privileged mode",
      "the host's own network",
      "the NET_ADMIN capability",
      "a device of the host's",
      "full control of Docker (its socket)",
    ]);
    expect(hints?.volumes).toEqual([]);
  });

  it("leaves IDs and time zone to the host's own habits, and blanks a value it should not trust", () => {
    const hints = parseDockerRun('-e PUID=0 -e TZ=Mars -e URL=$(whoami) -e "TITLE=My app" app/x:1');
    expect(hints?.environment.map((entry) => entry.name)).not.toContain("PUID");
    expect(hints?.environment.map((entry) => entry.name)).not.toContain("TZ");
    expect(hints?.environment).toContainEqual({ name: "TITLE", value: "My app" });
    expect(hints?.environment.find((entry) => entry.name === "URL")?.value).toBe("");
  });

  it("finds no image where there is none, or none that reads as one", () => {
    expect(parseDockerRun("--rm -it")).toBeNull();
    expect(parseDockerRun("<your-image>")).toBeNull();
    expect(parseDockerRun("https://evil.example/x")).toBeNull();
  });
});

describe("reading a project's page", () => {
  it("takes a GitHub project's README first, whichever address form it was pasted in", async () => {
    for (const address of [
      "https://github.com/0xfurai/peekaping",
      "https://github.com/0xfurai/peekaping/",
      "https://github.com/0xfurai/peekaping.git",
      "https://github.com/0xfurai/peekaping/tree/main#readme",
    ]) {
      const found = await readProjectPage(address, page({ "README.md": PEEKAPING_STYLE }));
      expect(found).toMatchObject({ kind: "found", hints: { image: "0xfurai/peekaping:latest" } });
    }
  });

  it("asks only GitHub, and only about the owner and project in the address", async () => {
    const asked: string[] = [];
    await readProjectPage("https://github.com/someone/app", (async (url: string) => {
      asked.push(url);
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch);
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      expect(
        url.startsWith("https://raw.githubusercontent.com/someone/app/HEAD/") ||
          url.startsWith("https://api.github.com/repos/someone/app/git/trees/HEAD"),
        url,
      ).toBe(true);
    }
  });

  it("names an image a registry's page shows outright, reading nothing", async () => {
    const nothing = (async () => {
      throw new Error("read");
    }) as unknown as typeof fetch;
    for (const [address, image] of [
      ["https://hub.docker.com/r/someone/app", "someone/app:latest"],
      ["https://ghcr.io/someone/app", "ghcr.io/someone/app"],
      ["https://github.com/someone/repo/pkgs/container/app", "ghcr.io/someone/app:latest"],
    ] as const) {
      expect(await readProjectPage(address, nothing)).toMatchObject({ kind: "found", hints: { image } });
    }
  });

  it("falls back on a Compose file when the README has no command", async () => {
    const found = await readProjectPage(
      "https://github.com/someone/app",
      page({ "README.md": "# Just words", "compose.yaml": "services:\n  app:\n    image: someone/app:2\n" }),
    );
    expect(found).toMatchObject({ kind: "compose", file: "compose.yaml" });
  });

  it("reads a project's Compose files, simplest first, leaving out those not for installing", async () => {
    const tree = {
      tree: [
        "docker/compose/docker-compose.postgres.yml",
        "docker/compose/docker-compose.sqlite.yml",
        "docker/compose/docker-compose.ci-test.yml",
        ".devcontainer/docker-compose.devcontainer.sqlite-tika.yml",
        "docker/compose/docker-compose.env",
      ].map((path) => ({ path, type: "blob" })),
    };
    const fetcher = (async (url: string) => {
      if (url.includes("api.github.com")) return new Response(JSON.stringify(tree));
      if (url.endsWith("README.md")) return new Response("Deploy with `docker compose`.");
      return url.endsWith(".sqlite.yml") || url.endsWith(".postgres.yml")
        ? new Response(`services: {} # ${url}`)
        : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const found = await readProjectPage("https://github.com/paperless-ngx/paperless-ngx", fetcher);
    expect(found).toMatchObject({
      kind: "compose",
      files: ["docker/compose/docker-compose.sqlite.yml", "docker/compose/docker-compose.postgres.yml"],
      file: "docker/compose/docker-compose.sqlite.yml",
      folder: "docker/compose",
    });
    const chosen = await readProjectPage(
      "https://github.com/paperless-ngx/paperless-ngx",
      fetcher,
      "docker/compose/docker-compose.postgres.yml",
    );
    expect(chosen).toMatchObject({ kind: "compose", file: "docker/compose/docker-compose.postgres.yml" });
  });

  it("takes no other file in place of one a person chose that is gone, nor when the project cannot be listed", async () => {
    const chosen = "docker/compose/docker-compose.postgres.yml";
    const listed = ["docker/compose/docker-compose.sqlite.yml", chosen];
    let tree: string[] | null = listed;
    const fetcher = (async (url: string) => {
      if (url.includes("api.github.com")) {
        return tree === null
          ? new Response("", { status: 403 })
          : new Response(JSON.stringify({ tree: tree.map((path) => ({ path, type: "blob" })) }));
      }
      const file = url.split("/HEAD/")[1] ?? "";
      return tree?.includes(file) === true ? new Response(`services: {} # ${file}`) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const address = "https://github.com/paperless-ngx/paperless-ngx";
    expect(await readProjectPage(address, fetcher, chosen)).toMatchObject({ kind: "compose", file: chosen });

    tree = ["docker/compose/docker-compose.sqlite.yml"];
    expect(await readProjectPage(address, fetcher, chosen)).toEqual({ kind: "variantGone", file: chosen });
    tree = null;
    expect(await readProjectPage(address, fetcher, chosen)).toEqual({ kind: "variantGone", file: chosen });
  });

  it("finds a Compose file in a project of thousands of files", async () => {
    const tree = {
      tree: [
        ...Array.from({ length: 6000 }, (_, index) => ({
          path: `client/src/some/long/path/file-${index}.ts`,
          type: "blob",
        })),
        { path: "docker-compose.yml", type: "blob" },
      ],
    };
    const fetcher = (async (url: string) => {
      if (url.includes("api.github.com")) return new Response(JSON.stringify(tree));
      if (url.endsWith("README.md")) return new Response("Then `docker compose up -d`.");
      return url.endsWith("docker-compose.yml") ? new Response("services: {}") : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await readProjectPage("https://github.com/a/b", fetcher)).toMatchObject({
      kind: "compose",
      file: "docker-compose.yml",
    });
  });

  it("tries the usual names when GitHub's listing cannot be read", async () => {
    const fetcher = (async (url: string) => {
      if (url.includes("api.github.com")) return new Response("{ not json");
      return url.endsWith("/compose.yaml") ? new Response("services: {}") : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await readProjectPage("https://github.com/a/b", fetcher)).toMatchObject({
      kind: "compose",
      file: "compose.yaml",
    });
  });

  it("reads the example a project keeps for its settings, when it has no settings of its own", async () => {
    const fetcher = (async (url: string) =>
      url.endsWith("/docker/example.env")
        ? new Response("A=1")
        : new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await readProjectSettings({ owner: "a", name: "b", folder: "docker" }, fetcher)).toBe("A=1");
    expect(await readProjectSettings({ owner: "a", name: "b", folder: "" }, fetcher)).toBeNull();
  });

  it.each([
    [
      "the one image it names",
      "services:\n  app:\n    image: someone/app:2\n",
      {
        kind: "found",
        hints: { image: "someone/app:2", ports: [], volumes: [], environment: [], leftOut: [] },
      },
    ],
    [
      "a choice between the images it names",
      "services:\n  app:\n    image: someone/app:2\n  db:\n    image: postgres:16\n",
      { kind: "severalImages", images: ["someone/app:2", "postgres:16"] },
    ],
  ])("offers, from a README's Compose example and no Compose file, %s", async (_what, example, expected) => {
    const readme = `# App\n\nStart it with docker compose:\n\n\`\`\`yaml\n${example}\`\`\`\n`;
    expect(await readProjectPage("https://github.com/someone/app", page({ "README.md": readme }))).toEqual(expected);
  });

  it("still takes a project's own Compose file over the images its README names", async () => {
    const readme = "```yaml\nservices:\n  app:\n    image: someone/app:1\n```\n";
    const compose = "services:\n  app:\n    image: someone/app:2\n";
    const found = await readProjectPage(
      "https://github.com/someone/app",
      page({ "README.md": readme, "compose.yaml": compose }),
    );
    expect(found).toMatchObject({ kind: "compose", text: compose });
  });

  it("does not guess at an image when its README says Compose and no file can be found", async () => {
    const readme = "The easiest way to deploy is `docker compose`.";
    expect(await readProjectPage("https://github.com/a/b", page({ "README.md": readme }))).toEqual({
      kind: "composeOnly",
    });
  });

  it("reads a file beside its Compose file, never outside the project", async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return new Response("A=1");
    }) as unknown as typeof fetch;
    const source = { owner: "a", name: "b", folder: "docker/compose" };
    expect(await readProjectFile(source, "docker-compose.env", fetcher)).toBe("A=1");
    expect(asked).toEqual(["https://raw.githubusercontent.com/a/b/HEAD/docker/compose/docker-compose.env"]);
    expect(await readProjectFile(source, "../../../etc/passwd", fetcher)).toBeNull();
    expect(await readProjectFile(source, "/etc/passwd", fetcher)).toBeNull();
  });

  it("refuses a Compose file longer than it reads, rather than a start of it that reads as a smaller project", async () => {
    const first = "services:\n  app:\n    image: someone/app:2\n";
    const comment = `# ${"x".repeat(PROJECT_PAGE.readCharacters)}\n`;
    const second = "  database:\n    image: postgres:16\n";
    const found = await readProjectPage(
      "https://github.com/someone/app",
      page({ "README.md": "# Just words", "compose.yaml": `${first}${comment}${second}` }),
    );
    expect(found).toEqual({ kind: "composeTooLarge" });
  });

  it("reads a Compose file of exactly what it reads, whole", async () => {
    const first = "services:\n  app:\n    image: someone/app:2\n";
    const whole = `${first}${"#".repeat(PROJECT_PAGE.readCharacters - first.length)}`;
    const found = await readProjectPage("https://github.com/someone/app", page({ "compose.yaml": whole }));
    expect(found).toMatchObject({ kind: "compose", text: whole });
  });

  it("reads no more of a file than it keeps, however much its publisher sends", async () => {
    const piece = new TextEncoder().encode("x".repeat(64 * 1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 16 * 1024 * 1024) return controller.close();
        pulled += piece.length;
        controller.enqueue(piece);
      },
    });
    const fetcher = (async () => new Response(body)) as unknown as typeof fetch;

    const text = await readProjectFile({ owner: "a", name: "b", folder: "" }, "big.env", fetcher);

    expect(text).toBe(PROJECT_FILE_TOO_LARGE);
    expect(pulled).toBeLessThan(PROJECT_PAGE.readCharacters + 4 * piece.length);
  });

  it("tells each read to stop once the whole preview's time is up", async () => {
    const told: (AbortSignal | null | undefined)[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      told.push(init?.signal);
      return new Response("A=1");
    }) as unknown as typeof fetch;

    await readProjectFile({ owner: "a", name: "b", folder: "" }, "a.env", fetcher, AbortSignal.abort());

    expect(told[0]?.aborted).toBe(true);
  });

  it("offers a guess under the project's own name when nothing says, and knows no other site", async () => {
    expect(await readProjectPage("https://github.com/someone/app", page({}))).toEqual({
      kind: "guess",
      candidates: ["ghcr.io/someone/app:latest", "someone/app:latest"],
    });
    expect(await readProjectPage("https://example.com/app", page({}))).toEqual({ kind: "unknownSite" });
  });

  it("copes with a site that does not answer", async () => {
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect((await readProjectPage("https://github.com/someone/app", down)).kind).toBe("guess");
  });
});
