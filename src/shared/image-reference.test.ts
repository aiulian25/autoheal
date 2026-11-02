import { describe, expect, it } from "vitest";
import { imageRepository, imageTag, splitTag } from "./image-reference.js";

describe("image references", () => {
  it.each([
    ["ghcr.io/paperless-ngx/paperless-ngx:2.13", "ghcr.io/paperless-ngx/paperless-ngx"],
    ["redis", "redis"],
    ["redis@sha256:abc", "redis"],
    ["registry.lan:5000/team/app:1.2@sha256:abc", "registry.lan:5000/team/app"],
  ])("names the repository of %s: %s", (image, repository) => {
    expect(imageRepository(image)).toBe(repository);
  });

  it.each([
    ["ghcr.io/immich-app/immich-server:release", "release"],
    ["postgres:16", "16"],
    ["redis", "latest"],
    ["registry.lan:5000/team/app:1.2@sha256:abc", "1.2"],
  ])("reads the tag of %s: %s", (image, tag) => {
    expect(imageTag(image)).toBe(tag);
  });

  it("splits a tag off, but never a registry's port", () => {
    expect(splitTag("registry.lan:5000/team/app:1.2")).toEqual({ name: "registry.lan:5000/team/app", tag: "1.2" });
    expect(splitTag("registry.lan:5000/team/app")).toEqual({ name: "registry.lan:5000/team/app", tag: "latest" });
  });
});
