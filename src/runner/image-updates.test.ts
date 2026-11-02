import { describe, expect, it } from "vitest";
import type { ContainerSummary, ImageDetails } from "./docker-client.js";
import { ImageUpdateChecker } from "./image-updates.js";
import type { ContainerDetails } from "./incident-report.js";
import type { ImageReference } from "./registry-client.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const imageId = (character: string) => `sha256:${character.repeat(63)}0`;

const labelled = (version: string) => ({
  version,
  revision: null,
  source: "https://github.com/example/app",
  createdAt: Date.UTC(2026, 9, 24),
});

const summary = (name: string, image: string, id: string): ContainerSummary => ({
  Id: name,
  Names: [`/${name}`],
  Image: image,
  ImageID: id,
  State: "running",
  Status: "Up",
});

describe("ImageUpdateChecker", () => {
  const images = new Map<string, ImageDetails>([
    [imageId("a"), { Id: imageId("a"), RepoDigests: [`nginx@${digest("1")}`] }],
    [imageId("b"), { Id: imageId("b"), RepoDigests: [`ghcr.io/example/app@${digest("2")}`] }],
    // Built on the host: no registry knows it.
    [imageId("c"), { Id: imageId("c"), RepoTags: ["my-build:dev"], RepoDigests: [] }],
    // Pulled, then its tag moved on to a newer image (docker compose pull without up): no names left.
    [imageId("g"), { Id: imageId("g"), RepoTags: [], RepoDigests: [] }],
    [imageId("d"), { Id: imageId("d"), RepoDigests: [`registry.lan/private@${digest("4")}`] }],
    // The containerd image store gives an image built here a digest too, under its own name.
    [imageId("f"), { Id: imageId("f"), RepoDigests: [`redis@${imageId("f")}`] }],
  ]);
  // The containerd image store forgets an image once its tag moves on: "moved" runs one of those.
  const created: Record<string, string> = { moved: "ghcr.io/example/moved:1", pulled: "ghcr.io/example/pulled:1" };
  let summaries: ContainerSummary[] = [];
  let registryDown = false;
  const asked: string[] = [];
  const labelsRead: string[] = [];
  // What each tag points to now, and every image each repository ever published.
  const tags: Record<string, string> = {
    "library/nginx": digest("1"),
    "example/app": digest("9"),
    "library/redis": digest("7"),
    "example/moved": digest("8"),
    "example/pulled": digest("6"),
    private: digest("4"),
  };
  const published: Record<string, string[]> = {
    "example/app": [digest("2"), digest("9")],
    "example/moved": [imageId("e"), digest("8")],
    "example/pulled": [imageId("g"), digest("6")],
  };
  const checker = new ImageUpdateChecker(
    {
      containerSummaries: async () => summaries,
      inspect: async (name) =>
        created[name] === undefined
          ? null
          : ({ Name: `/${name}`, State: {}, Config: { Image: created[name]! } } satisfies ContainerDetails),
      inspectImage: async (reference) => images.get(reference) ?? null,
    },
    {
      digest: async (reference: ImageReference) => {
        asked.push(`${reference.registry}/${reference.repository}:${reference.tag}`);
        if (registryDown || reference.repository === "private") {
          throw new Error("unauthorized");
        }
        if (!reference.tag.startsWith("sha256:")) {
          return tags[reference.repository]!;
        }
        if (!(published[reference.repository] ?? []).includes(reference.tag)) {
          throw new Error("the registry answered HTTP 404");
        }
        return reference.tag;
      },
      labels: async (reference: ImageReference, remoteDigest: string) => {
        labelsRead.push(`${reference.repository}@${remoteDigest}`);
        return labelled("2.1.0");
      },
    },
    () => 1_000,
  );

  it("compares each image's recorded digests with what its tag points to now, once per image", async () => {
    summaries = [
      summary("web", "nginx", imageId("a")),
      summary("web-2", "nginx", imageId("a")),
      summary("app", "ghcr.io/example/app:2", imageId("b")),
      summary("local", "my-build:dev", imageId("c")),
      summary("pinned", `nginx@${digest("1")}`, imageId("a")),
      summary("private", "registry.lan/private:1", imageId("d")),
    ];
    expect(await checker.checkAll()).toEqual({ images: 3, available: 1, unknown: 1 });
    expect(asked).toEqual([
      "registry-1.docker.io/library/nginx:latest",
      "ghcr.io/example/app:2",
      "registry.lan/private:1",
      // A newer digest behind the tag, and the registry knows the one running: an update.
      `ghcr.io/example/app:${digest("2")}`,
    ]);
    expect(checker.resultFor(imageId("a"), "nginx")).toEqual({
      status: "current",
      checkedAt: 1_000,
      remoteDigest: digest("1"),
      remote: null,
      reason: null,
    });
    // Only the newer image's labels are read.
    expect(checker.resultFor(imageId("b"), "ghcr.io/example/app:2")).toEqual({
      status: "available",
      checkedAt: 1_000,
      remoteDigest: digest("9"),
      remote: labelled("2.1.0"),
      reason: null,
    });
    expect(labelsRead).toEqual([`example/app@${digest("9")}`]);
    expect(checker.resultFor(imageId("c"), "my-build:dev")).toBeNull();
    expect(checker.resultFor(imageId("d"), "registry.lan/private:1")).toMatchObject({
      status: "unknown",
      reason: "unauthorized",
    });
  });

  it("reads a newer image's labels once, and keeps the last answer and why while a registry is down", async () => {
    summaries = [summary("app", "ghcr.io/example/app:2", imageId("b"))];
    await checker.checkAll();
    expect(labelsRead).toHaveLength(1);
    registryDown = true;
    await checker.checkAll();
    expect(checker.resultFor(imageId("b"), "ghcr.io/example/app:2")).toMatchObject({
      status: "available",
      remote: labelled("2.1.0"),
      reason: "unauthorized",
    });
    expect(checker.resultFor(imageId("a"), "nginx")).toBeNull();
  });

  it("never offers a public image in place of one built here under the same name, and says why", async () => {
    registryDown = false;
    summaries = [summary("cache", "redis", imageId("f"))];
    await checker.checkAll();
    expect(checker.resultFor(imageId("f"), "redis")).toMatchObject({
      status: "unknown",
      reason: "the registry does not know the image it runs: built here, or pulled from elsewhere",
    });
  });

  it("follows a container whose tag moved on to a newer image, by the name it was created with", async () => {
    summaries = [summary("moved", imageId("e"), imageId("e"))];
    await checker.checkAll();
    expect(checker.resultFor(imageId("e"), "ghcr.io/example/moved:1")).toEqual({
      status: "available",
      checkedAt: 1_000,
      remoteDigest: digest("8"),
      remote: labelled("2.1.0"),
      reason: null,
    });
  });

  it("follows a container whose image was pulled again under its tag, and skips one labelled off", async () => {
    summaries = [
      summary("pulled", imageId("g"), imageId("g")),
      { ...summary("pinned-on-purpose", "nginx", imageId("a")), Labels: { "autoheal.update": "off" } },
    ];
    asked.length = 0;
    await checker.checkAll();
    expect(checker.resultFor(imageId("g"), "ghcr.io/example/pulled:1")?.status).toBe("available");
    expect(asked.some((reference) => reference.includes("nginx"))).toBe(false);
  });

  it("runs one check at a time: a second request while one runs shares it", async () => {
    registryDown = false;
    summaries = [summary("app", "ghcr.io/example/app:2", imageId("b"))];
    asked.length = 0;
    const [first, second] = await Promise.all([checker.checkAll(), checker.checkAll()]);
    expect(second).toEqual(first);
    expect(asked.filter((reference) => reference === "ghcr.io/example/app:2")).toHaveLength(1);
  });

  it("reads at most three new images' labels from Docker Hub in one check, and the rest at the next", async () => {
    const names = ["one", "two", "three", "four"];
    const newDigests: Record<string, string> = {
      one: digest("5"),
      two: digest("6"),
      three: digest("7"),
      four: digest("8"),
    };
    const read: string[] = [];
    const hub = new ImageUpdateChecker(
      {
        containerSummaries: async () =>
          names.map((name, index) => summary(name, `example/${name}`, imageId(`${index}`))),
        inspect: async () => null,
        inspectImage: async (reference) => ({ Id: reference, RepoDigests: [`example/any@${digest("1")}`] }),
      },
      {
        digest: async (reference: ImageReference) =>
          reference.tag.startsWith("sha256:") ? reference.tag : newDigests[reference.repository.split("/")[1]!]!,
        labels: async (reference: ImageReference) => {
          read.push(reference.repository);
          return labelled("1.0.1");
        },
      },
      () => 1_000,
    );
    await hub.checkAll();
    expect(read).toHaveLength(3);
    expect(
      names.filter((_name, index) => hub.resultFor(imageId(`${index}`), `example/${_name}`)?.remote === null),
    ).toHaveLength(1);
    await hub.checkAll();
    expect(read).toHaveLength(4);
    expect(names.every((_name, index) => hub.resultFor(imageId(`${index}`), `example/${_name}`)?.remote !== null)).toBe(
      true,
    );
  });
});

it.each([false, true])("keeps different tracked tags on one image independent (reverse=%s)", async (reverse) => {
  const id = imageId("a");
  const containers = [
    summary("stable", "ghcr.io/example/app:stable", id),
    summary("canary", "ghcr.io/example/app:canary", id),
  ];
  if (reverse) containers.reverse();
  const checker = new ImageUpdateChecker(
    {
      containerSummaries: async () => containers,
      inspect: async () => null,
      inspectImage: async () => ({ Id: id, RepoDigests: [`ghcr.io/example/app@${digest("1")}`] }),
    },
    {
      digest: async (reference) => (reference.tag === "canary" ? digest("2") : digest("1")),
      labels: async () => labelled("new"),
    },
  );
  await checker.checkAll();
  expect(checker.resultFor(id, "ghcr.io/example/app:stable")?.status).toBe("current");
  expect(checker.resultFor(id, "ghcr.io/example/app:canary")?.status).toBe("available");
});

it("deduplicates reference aliases and image inspection while isolating repository failures and late results", async () => {
  const id = imageId("a");
  let containers = [
    summary("one", "nginx", id),
    summary("alias", "docker.io/library/nginx:latest", id),
    summary("private", "private.example/app:latest", id),
  ];
  let inspected = 0;
  const asked: string[] = [];
  const checker = new ImageUpdateChecker(
    {
      containerSummaries: async () => containers,
      inspect: async () => null,
      inspectImage: async () => {
        inspected++;
        return { Id: id, RepoDigests: [`nginx@${digest("1")}`] };
      },
    },
    {
      digest: async (reference) => {
        asked.push(`${reference.registry}/${reference.repository}:${reference.tag}`);
        if (reference.registry === "private.example") throw new Error("refused");
        return digest("1");
      },
      labels: async () => labelled("new"),
    },
  );
  expect(await checker.checkAll()).toEqual({ images: 2, available: 0, unknown: 1 });
  expect(inspected).toBe(1);
  expect(asked).toHaveLength(2);
  expect(checker.resultFor(id, "index.docker.io/library/nginx:latest")?.status).toBe("current");
  expect(checker.resultFor(id, "private.example/app:latest")).toMatchObject({ status: "unknown", reason: "refused" });
  expect(checker.resultFor(id, `nginx@${digest("1")}`)).toBeNull();
  expect(checker.resultFor(id, id)).toBeNull();
  containers = [containers[2]!];
  await checker.checkAll();
  expect(checker.resultFor(id, "nginx")).toBeNull();
});

it("shares concurrent label reads for two tags resolving to one repository digest", async () => {
  const id = imageId("b");
  let reads = 0;
  const checker = new ImageUpdateChecker(
    {
      containerSummaries: async () => [
        summary("one", "ghcr.io/example/app:one", id),
        summary("two", "ghcr.io/example/app:two", id),
      ],
      inspect: async () => null,
      inspectImage: async () => ({ Id: id, RepoDigests: [`ghcr.io/example/app@${digest("1")}`] }),
    },
    {
      digest: async (reference) => (reference.tag.startsWith("sha256:") ? reference.tag : digest("2")),
      labels: async () => {
        reads++;
        return labelled("new");
      },
    },
  );
  expect((await checker.checkAll()).available).toBe(2);
  expect(reads).toBe(1);
  await checker.checkAll();
  expect(reads).toBe(1);
});

describe("a tag whose digest moved with nothing new for this machine", () => {
  const id = imageId("a");
  const reference = "redis:latest";
  const checkerWith = (configDigest: string | undefined) =>
    new ImageUpdateChecker(
      {
        containerSummaries: async () => [summary("cache", reference, id)],
        inspect: async () => null,
        inspectImage: async () => ({ Id: id, RepoDigests: [`redis@${digest("1")}`] }),
      },
      {
        digest: async ({ tag }) => (tag === "latest" ? digest("2") : tag),
        labels: async () => ({ ...labelled("8.2"), configDigest }),
      },
    );

  it("is no update when this platform's image is the one it runs", async () => {
    const checker = checkerWith(id);
    expect((await checker.checkAll()).available).toBe(0);
    expect(checker.resultFor(id, reference)).toMatchObject({ status: "current", remote: null });
  });

  it("is one when this platform's image differs, and what it reports carries no digest of the registry's", async () => {
    const checker = checkerWith(imageId("b"));
    await checker.checkAll();
    const result = checker.resultFor(id, reference);
    expect(result?.status).toBe("available");
    expect(result?.remote).not.toHaveProperty("configDigest");
  });

  it("stays one while the registry has not said what its image is, until a pull finds the same image", async () => {
    const checker = checkerWith(undefined);
    await checker.checkAll();
    expect(checker.resultFor(id, reference)?.status).toBe("available");
    checker.confirmCurrent(imageId("c"), reference);
    expect(checker.resultFor(id, reference)?.status).toBe("available");
    checker.confirmCurrent(id, reference);
    expect(checker.resultFor(id, reference)).toMatchObject({ status: "current", remote: null, reason: null });
  });
});
