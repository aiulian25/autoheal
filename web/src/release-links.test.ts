import { describe, expect, it } from "vitest";
import { releaseNotesLink } from "./release-links.js";

describe("a version's release notes", () => {
  it.each([
    [
      "https://github.com/paperless-ngx/paperless-ngx",
      "2.13.5",
      "https://github.com/paperless-ngx/paperless-ngx/releases?q=2.13.5",
    ],
    // A "v" before the numbers, or a variant after them, still finds the release by its numbers.
    ["https://github.com/immich-app/immich", "v1.120.2", "https://github.com/immich-app/immich/releases?q=1.120.2"],
    ["https://github.com/example/database.git/", "16.5-alpine", "https://github.com/example/database/releases?q=16.5"],
    // A source deep in its repository is its repository's, and a plain-http one is linked on https.
    [
      "http://github.com/linuxserver/docker-jellyfin/tree/master",
      "10.10.3-ls45",
      "https://github.com/linuxserver/docker-jellyfin/releases?q=10.10.3",
    ],
    ["https://codeberg.org/forgejo/forgejo", "9.0.2", "https://codeberg.org/forgejo/forgejo/releases?q=9.0.2"],
    // GitLab nests groups: the project is all of the path before "/-/", and its tags carry the release notes.
    [
      "https://gitlab.com/group/subgroup/project/-/tree/main",
      "2024.10.1",
      "https://gitlab.com/group/subgroup/project/-/tags?search=2024.10.1",
    ],
    ["https://gitlab.com/group/project.git", "v3.4", "https://gitlab.com/group/project/-/tags?search=3.4"],
  ])("from %s for %s: %s", (source, version, link) => {
    expect(releaseNotesLink(source, version)).toBe(link);
  });

  it("lists every release for a version without numbers to find it by", () => {
    expect(releaseNotesLink("https://github.com/example/app", "latest")).toBe(
      "https://github.com/example/app/releases",
    );
    expect(releaseNotesLink("https://github.com/example/app", null)).toBe("https://github.com/example/app/releases");
    expect(releaseNotesLink("https://gitlab.com/group/app", "16")).toBe("https://gitlab.com/group/app/-/releases");
  });

  it("builds the link from the host and the project alone: no credentials, port or query the label carried", () => {
    const link = releaseNotesLink("https://reader:s3cret@github.com:8443/example/app?tab=readme#top", "1.2.3+build");
    expect(link).toBe("https://github.com/example/app/releases?q=1.2.3");
  });

  it.each([
    ["a host whose release pages are not known", "https://git.example.org/example/app"],
    ["a host that only looks like a known one", "https://github.com.example.org/example/app"],
    ["another host ending the same way", "https://evilgithub.com/example/app"],
    ["a known host's other name", "https://www.github.com/example/app"],
    ["an owner without a project", "https://github.com/example"],
    ["a GitLab group without a project", "https://gitlab.com/group/-/tree/main"],
    ["no address at all", "not a link"],
  ])("makes none for %s", (_why, source) => {
    expect(releaseNotesLink(source, "1.2.3")).toBeNull();
  });

  it("makes none where an image names no source", () => {
    expect(releaseNotesLink(null, "1.2.3")).toBeNull();
  });
});
