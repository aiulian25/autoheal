import { describe, expect, it } from "vitest";
import { unusedImageSchema } from "../shared/protocol.js";
import type { ContainerSummary, ImageSummary } from "./docker-client.js";
import { unusedImagesReport } from "./unused-images.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const builtAt = (day: number) => Date.UTC(2026, 9, day) / 1000;

// The app in use, the image it ran before its update, one a newer pull took the name from, one built here.
const IMAGES: ImageSummary[] = [
  { Id: digest("a"), RepoTags: ["paperless:2"], Size: 500_000_000, Created: builtAt(20) },
  {
    Id: digest("b"),
    RepoTags: ["paperless:2-autoheal-previous"],
    RepoDigests: [`ghcr.io/paperless-ngx/paperless-ngx@${digest("e")}`],
    Size: 480_000_000,
    Created: builtAt(12),
  },
  {
    Id: digest("c"),
    RepoTags: ["<none>:<none>"],
    RepoDigests: [`ghcr.io/immich-app/immich-server@${digest("f")}`],
    Size: 1_200_000_000,
    Created: builtAt(18),
  },
  { Id: digest("d"), RepoTags: [], RepoDigests: ["<none>@<none>"], Size: 8_000_000, Created: builtAt(1) },
  { Id: "sha1:not-a-digest", RepoTags: ["odd:1"], Size: 1, Created: builtAt(21) },
];
const CONTAINERS: ContainerSummary[] = [
  { Id: "c1", Names: ["/paperless"], ImageID: digest("a"), State: "running", Status: "Up 2 hours" },
];

describe("the images no container uses", () => {
  it("are reported newest first, with where a nameless one came from, as the control plane accepts them", async () => {
    const report = await unusedImagesReport({ containerSummaries: async () => CONTAINERS, images: async () => IMAGES });

    expect(report).toEqual([
      {
        id: digest("c"),
        tags: [],
        repository: "ghcr.io/immich-app/immich-server",
        sizeBytes: 1_200_000_000,
        createdAt: Date.UTC(2026, 9, 18),
        keptByUpdate: false,
      },
      {
        id: digest("b"),
        tags: ["paperless:2-autoheal-previous"],
        repository: "ghcr.io/paperless-ngx/paperless-ngx",
        sizeBytes: 480_000_000,
        createdAt: Date.UTC(2026, 9, 12),
        keptByUpdate: true,
      },
      {
        id: digest("d"),
        tags: [],
        repository: null,
        sizeBytes: 8_000_000,
        createdAt: Date.UTC(2026, 9, 1),
        keptByUpdate: false,
      },
    ]);
    expect(unusedImageSchema.array().safeParse(report).success).toBe(true);
  });
});
