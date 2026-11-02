import { describe, expect, it } from "vitest";
import type { ContainerView } from "../../shared/api.js";
import { oneServer } from "../ollama/ollama-pool.js";
import { UpdateAssessor, sameSeries } from "./update-assessor.js";

const container = (image: string, overrides: Partial<ContainerView> = {}): ContainerView => ({
  hostId: "h1",
  hostLabel: "Alder",
  hostState: "online",
  name: "app",
  containerId: "0123456789ab",
  image,
  state: "running",
  health: "healthy",
  startedAt: 1,
  finishedAt: null,
  exitCode: null,
  oomKilled: false,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  composeProject: null,
  composeService: null,
  link: null,
  version: null,
  ports: null,
  hostNetwork: false,
  update: { status: "available", checkedAt: 1, policy: "auto", remote: null, reason: null },
  usage: null,
  protected: false,
  byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: null },
  handsOff: null,
  problem: null,
  ...overrides,
});

function assessorAnswering(answer: () => string) {
  const asked: string[] = [];
  const assessor = new UpdateAssessor(
    oneServer(
      {
        chat: async (_system: string, user: string) => {
          asked.push(user);
          return { content: answer(), thinking: "" };
        },
        contextTokens: 16_384,
        model: "model",
        modelDigest: async () => null,
      },
      { enqueue: (_priority, job) => job(new AbortController().signal) },
    ),
  );
  return { assessor, asked };
}

const kind =
  (value: string, reason = "It is an app.") =>
  () =>
    JSON.stringify({ kind: value, reason });

describe("UpdateAssessor", () => {
  it.each([
    ["a database, whatever its tag", "postgres:16", "database", "hold"],
    [
      "an app that keeps data, on a tag that names no version",
      "ghcr.io/immich-app/immich-server:release",
      "keeps_data",
      "hold",
    ],
    ["an app that keeps data, on a version tag", "ghcr.io/paperless-ngx/paperless-ngx:2.13", "keeps_data", "update"],
    ["a tool that keeps nothing, even on latest", "traefik/whoami:latest", "stateless", "update"],
  ])("decides by rule for %s", async (_case, image, appKind, decision) => {
    const { assessor } = assessorAnswering(kind(appKind));
    expect((await assessor.assess(container(image), [])).decision).toBe(decision);
  });

  it("names the moving tag when it holds, after what Ollama says the app is", async () => {
    const { assessor } = assessorAnswering(kind("keeps_data", "Immich keeps the family's photos."));
    expect(await assessor.assess(container("ghcr.io/immich-app/immich-server:release"), [])).toEqual({
      decision: "hold",
      reason:
        'Immich keeps the family\'s photos. Its tag "release" names no version, so the newer image could be a big jump for its data.',
    });
  });

  describe("with the versions its images name", () => {
    const immich = (from: string, to: string) =>
      container("ghcr.io/immich-app/immich-server:release", {
        version: from,
        update: {
          status: "available",
          checkedAt: 1,
          policy: "auto",
          remote: { version: to, revision: null, source: null, createdAt: null },
          reason: null,
        },
      });
    const assessed = (from: string, to: string, appKind = "keeps_data") =>
      assessorAnswering(kind(appKind, "Immich keeps the family's photos.")).assessor.assess(immich(from, to), []);

    it("updates an app that keeps data within its release series, and holds it when a new one starts", async () => {
      expect(await assessed("v1.120.1", "v1.120.2")).toEqual({
        decision: "update",
        reason: "Immich keeps the family's photos. v1.120.1 → v1.120.2 stays in the same release series.",
      });
      expect(await assessed("v1.120.2", "v2.0.0")).toEqual({
        decision: "hold",
        reason:
          "Immich keeps the family's photos. v1.120.2 → v2.0.0 starts a new release series, which may change its data.",
      });
      expect((await assessed("0.9.1", "0.10.0")).decision).toBe("hold");
    });

    it("still holds a database, and keeps to the tag's rule when the versions say nothing", async () => {
      expect((await assessed("16.4", "16.5", "database")).decision).toBe("hold");
      // Calendar versions, and a base image's label left on both sides.
      expect((await assessed("2024.10.1", "2024.10.2")).reason).toContain('Its tag "release" names no version');
      expect((await assessed("24.04", "24.04")).decision).toBe("hold");
    });

    it("updates a rebuild of the same version when the image's labels are its own, not when a version is all", async () => {
      const rebuilt = (labels: { source: string | null; revision: string | null }) =>
        assessorAnswering(kind("keeps_data", "Radicale keeps calendars.")).assessor.assess(
          container("tomsquest/docker-radicale:latest", {
            version: "3.8.3",
            update: {
              status: "available",
              checkedAt: 1,
              policy: "auto",
              remote: { version: "3.8.3", createdAt: null, ...labels },
              reason: null,
            },
          }),
          [],
        );
      expect(await rebuilt({ source: "https://github.com/tomsquest/docker-radicale", revision: null })).toEqual({
        decision: "update",
        reason: "Radicale keeps calendars. The newer image is 3.8.3 again, a rebuild of the same release.",
      });
      expect((await rebuilt({ source: null, revision: "4b3c2a1" })).decision).toBe("update");
      // A version alone may be the base image's, as Ubuntu's 24.04 on Ollama.
      expect((await rebuilt({ source: null, revision: null })).decision).toBe("hold");
    });

    it("tells Ollama both versions", async () => {
      const { assessor, asked } = assessorAnswering(kind("keeps_data"));
      await assessor.assess(immich("v1.120.1", "v1.120.2"), []);
      expect(JSON.parse(asked[0]!)).toMatchObject({ runningVersion: "v1.120.1", newVersion: "v1.120.2" });
    });
  });

  it.each([
    ["1.120.1", "1.120.2", true],
    ["v4.0.11.2680-ls262", "4.1.0.2700-ls270", true],
    ["0.9.1", "0.9.2", true],
    ["1.9", "2.0", false],
    ["0.9.1", "0.10.0", false],
    ["2024.10.1", "2024.11.0", null],
    ["latest", "1.0", null],
  ])("reads %s → %s as one release series: %s", (running, next, expected) => {
    expect(sameSeries(running, next)).toBe(expected);
  });

  it("holds a container that is in trouble right now without asking Ollama", async () => {
    const { assessor, asked } = assessorAnswering(kind("stateless"));
    const restarting = container("traefik/whoami:latest", { state: "restarting", problem: "restarting" });
    expect(await assessor.assess(restarting, [])).toEqual({
      decision: "hold",
      reason: "It is restarting right now; a person should look before it changes.",
    });
    expect(asked).toEqual([]);
  });

  it("tells Ollama names and images only, with the rest of the compose project", async () => {
    const { assessor, asked } = assessorAnswering(kind("keeps_data"));
    const database = container("postgres:16", { name: "db" });
    await assessor.assess(container("ghcr.io/paperless-ngx/paperless-ngx:2.13", { composeProject: "paperless" }), [
      database,
    ]);
    expect(JSON.parse(asked[0]!)).toEqual({
      container: "app",
      image: "ghcr.io/paperless-ngx/paperless-ngx:2.13",
      runningVersion: null,
      newVersion: null,
      composeProject: "paperless",
      otherServicesInProject: [{ name: "db", image: "postgres:16" }],
    });
  });

  it("has no decision when Ollama cannot be asked or answers something else", async () => {
    const unusable = assessorAnswering(kind("probably fine")).assessor;
    expect(await unusable.assess(container("traefik/whoami:latest"), [])).toEqual({
      decision: null,
      reason: "an answer that was not a kind of app",
    });
    const down = assessorAnswering(() => {
      throw new Error("connect ECONNREFUSED");
    }).assessor;
    expect(await down.assess(container("traefik/whoami:latest"), [])).toEqual({
      decision: null,
      reason: "connect ECONNREFUSED",
    });
  });
});
