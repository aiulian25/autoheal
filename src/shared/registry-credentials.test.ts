import { describe, expect, it } from "vitest";
import {
  accessForImage,
  coversRepository,
  registryCredentialBodySchema,
  registryHostOf,
} from "./registry-credentials.js";

const access = (registry: string, repository: string | null) => ({ registry, repository });

describe("which credential covers an image", () => {
  it.each([
    ["owner/app", "owner/app", true],
    ["owner/app", "owner/app/part", true],
    ["owner/app", "owner/application", false],
    ["owner/app", "owner/other", false],
    ["owner", "owner/app", true],
    [null, "anything/at/all", true],
  ])("a credential for %s covers %s: %s", (scope, repository, covered) => {
    expect(coversRepository(scope, repository)).toBe(covered);
  });

  it("takes the credential scoped most closely to the image, not whichever comes first", () => {
    const wide = access("ghcr.io", null);
    const narrow = access("ghcr.io", "owner/app");
    expect(accessForImage([wide, narrow], { registry: "ghcr.io", repository: "owner/app" })).toBe(narrow);
    expect(accessForImage([narrow, wide], { registry: "ghcr.io", repository: "owner/app" })).toBe(narrow);
    expect(accessForImage([narrow, wide], { registry: "ghcr.io", repository: "someone/else" })).toBe(wide);
  });

  it("gives nothing for another registry, so a credential never leaves the one it is for", () => {
    const own = access("ghcr.io", null);
    expect(accessForImage([own], { registry: "registry.example.com", repository: "owner/app" })).toBeNull();
    expect(accessForImage([], { registry: "ghcr.io", repository: "owner/app" })).toBeNull();
  });

  it.each(["docker.io", "index.docker.io", "registry-1.docker.io", "DOCKER.IO"])(
    "reads %s as the one host Docker Hub answers to",
    (spelling) => {
      expect(registryHostOf(spelling)).toBe("registry-1.docker.io");
    },
  );

  it("matches an image on Docker Hub however the credential spells the registry", () => {
    const hub = access("docker.io", null);
    expect(accessForImage([hub], { registry: "registry-1.docker.io", repository: "library/nginx" })).toBe(hub);
  });
});

describe("what a credential may be set to", () => {
  const body = {
    registry: " GHCR.IO ",
    repository: "owner/app/",
    username: " owner ",
    password: "a-token",
    hostIds: [],
  };

  it("settles the registry and the repository, so one scope is not kept twice under two spellings", () => {
    expect(registryCredentialBodySchema.parse(body)).toEqual({
      registry: "ghcr.io",
      repository: "owner/app",
      username: "owner",
      password: "a-token",
      hostIds: [],
    });
  });

  it("takes a credential for a whole registry, with no repository named", () => {
    expect(registryCredentialBodySchema.parse({ ...body, repository: null }).repository).toBeNull();
    expect(registryCredentialBodySchema.parse({ ...body, repository: "" }).repository).toBeNull();
  });

  it.each(["Owner/App", "owner//app", "owner/app:2", "../etc/passwd", "owner/app?x=1"])(
    "refuses %s, which no registry would accept as a repository",
    (repository) => {
      expect(registryCredentialBodySchema.safeParse({ ...body, repository }).success).toBe(false);
    },
  );

  it("refuses an empty password or user name, and anything it was not asked for", () => {
    expect(registryCredentialBodySchema.safeParse({ ...body, password: "" }).success).toBe(false);
    expect(registryCredentialBodySchema.safeParse({ ...body, username: " " }).success).toBe(false);
    expect(registryCredentialBodySchema.safeParse({ ...body, serveraddress: "elsewhere" }).success).toBe(false);
  });
});
