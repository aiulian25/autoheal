import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../src/shared/api.js";
import {
  APPLICATION_BACKUP_FAILURE,
  type ApplicationBackupRun,
  type ApplicationBackupsView,
  type ApplicationBootEvidence,
  type BootDrillRecipe,
} from "../../../src/shared/application-backups.js";
import { TEXT } from "../constants.js";
import { ApplicationBackupPlans } from "./application-backup-plan.js";
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
const host = "c808b03c-4d00-4af2-ad9c-ee271e5ad4de",
  plan = "a2a88f1e-521c-4cab-b197-09029cc66f02",
  artifact = "7a839674-09e2-46de-b266-dbd0413ca29c",
  preview = "0519f0be-b1fd-4e75-a1cb-3061c3898d68",
  dropped = "5d1f0c3a-6b2e-4f8a-9c7d-2e4b6a8c0f13";
// How the writer review ends: the runner's report, unless the dashboard ended it first.
const reviewed: Pick<ApplicationBackupRun, "status" | "result" | "failure"> = {
  status: "succeeded",
  result: {
    id: preview,
    artifactId: artifact,
    ok: true,
    message: "Complete writer group",
    writers: ["app", "worker"],
    stopped: [],
    fingerprint: "a".repeat(64),
  },
  failure: null,
};
function show(
  review = reviewed,
  runs: ApplicationBackupRun[] = [],
  boot: { recipe?: BootDrillRecipe | null; imageId?: string | null; verifiedAt?: number | null } = {},
) {
  const value: ApplicationBackupsView = {
    available: true,
    sourceBytes: 33554432,
    payloadBytes: 35651584,
    plans: [
      {
        id: plan,
        hostId: host,
        revision: 1,
        definition: {
          version: 1,
          name: "Shared app",
          containerName: "app",
          consistency: "coordinated-clean-stop",
          exclusiveDockerWriters: true,
          sqlite: null,
          intervalHours: null,
          retain: 3,
          bootDrill: boot.recipe ?? null,
        },
        enabled: true,
        nextDueAt: null,
      },
    ],
    runs,
    artifacts: [
      {
        id: artifact,
        planId: plan,
        hostId: host,
        status: "ready",
        createdAt: Date.now(),
        payloadBytes: 200,
        verifiedAt: Date.now(),
        lastDrillAt: Date.now(),
        bootVerifiedAt: boot.verifiedAt ?? null,
        imageId: boot.imageId ?? null,
        retained: false,
      },
    ],
  };
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown = value;
    if (url === API_ROUTES.hosts) body = [];
    else if (url.endsWith("prepare-restore")) {
      body = { id: preview };
      value.runs.push({
        id: preview,
        planId: plan,
        hostId: host,
        operation: "preview",
        artifactId: artifact,
        createdAt: Date.now(),
        finishedAt: Date.now(),
        ...review,
      });
    } else if (options?.method === "POST") body = { id: "accepted" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ApplicationBackupPlans />
    </QueryClientProvider>,
  );
  return fetch;
}
it("requires a fresh writer review and explicit data replacement approval", async () => {
  const fetch = show();
  fireEvent.click(await screen.findByRole("button", { name: "Review live restore" }));
  await screen.findByText("worker");
  const restore = screen.getByRole("button", { name: "Restore reviewed application data" });
  expect(restore).toHaveProperty("disabled", true);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/restore"))).toBe(false);
  fireEvent.click(screen.getByLabelText(/I approve replacing/));
  fireEvent.click(restore);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("/restore"))).toBe(true));
  const request = fetch.mock.calls.find(([url]) => url.endsWith("/restore"))!;
  expect(JSON.parse(request[1]!.body as string)).toMatchObject({ artifactId: artifact, previewRunId: preview });
});
it("states the small-data and clean-stop contract without promising a native database dump", async () => {
  show();
  await screen.findByText("Shared app");
  expect(screen.getByText(/Initial limit: 32 MiB/)).toBeTruthy();
  expect(screen.getByText(/not a database-native dump/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run isolated restore drill" })).toBeTruthy();
});
it("says why the dashboard ended a run, in the run list and in a writer review", async () => {
  show({ status: "failed", result: null, failure: APPLICATION_BACKUP_FAILURE.expired }, [
    {
      id: dropped,
      planId: plan,
      hostId: host,
      operation: "capture",
      status: "failed",
      artifactId: artifact,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      result: null,
      failure: APPLICATION_BACKUP_FAILURE.planChanged,
    },
  ]);
  await screen.findByText(TEXT.applicationBackups.failure[APPLICATION_BACKUP_FAILURE.planChanged]);
  fireEvent.click(screen.getByRole("button", { name: "Review live restore" }));
  await screen.findByText(TEXT.applicationBackups.failure[APPLICATION_BACKUP_FAILURE.expired]);
  expect(screen.queryByText(/Waiting for the runner/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Restore reviewed application data" })).toBeNull();
});

describe("boot drills", () => {
  const RECIPE = { readySeconds: 30, environment: [] };
  const bootText = TEXT.applicationBackups.boot;
  const bootRun = (over: Partial<ApplicationBootEvidence>, ok: boolean): ApplicationBackupRun => ({
    id: "99999999-9999-4999-8999-999999999999",
    planId: plan,
    hostId: host,
    operation: "boot-drill",
    status: ok ? "succeeded" : "failed",
    artifactId: artifact,
    createdAt: Date.now(),
    finishedAt: Date.now(),
    failure: null,
    result: {
      id: "99999999-9999-4999-8999-999999999999",
      attempt: 0,
      artifactId: artifact,
      ok,
      message: ok ? "Started." : "Did not start.",
      writers: [],
      stopped: [],
      boot: { imageId: "sha256:one", readySeconds: 30, readiness: null, problem: null, logs: null, left: [], ...over },
    },
  });

  it("offers none for a plan that did not ask, or a backup that recorded no image", async () => {
    show();
    await screen.findByText("Shared app");
    expect(screen.queryByRole("button", { name: bootText.run })).toBeNull();
    expect(screen.queryByText(bootText.notVerified)).toBeNull();
    cleanup();
    show(reviewed, [], { recipe: RECIPE, imageId: null });
    await screen.findByText(bootText.notVerified);
    expect(screen.queryByRole("button", { name: bootText.run })).toBeNull();
  });

  it("asks first, then starts it, keeping the two kinds of verified apart", async () => {
    const fetch = show(reviewed, [], { recipe: RECIPE, imageId: "sha256:one" });
    expect(await screen.findByText(bootText.notVerified)).toBeTruthy();
    expect(screen.getByText(new RegExp(bootText.integrityVerified))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: bootText.run }));
    expect(screen.getByText(bootText.confirm)).toBeTruthy();
    expect(fetch.mock.calls.some(([, options]) => String(options?.body).includes("boot-drill"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: bootText.confirmRun }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, options]) => String(options?.body).includes('"operation":"boot-drill"'))).toBe(
        true,
      ),
    );
  });

  it("cancelling starts nothing", async () => {
    const fetch = show(reviewed, [], { recipe: RECIPE, imageId: "sha256:one" });
    fireEvent.click(await screen.findByRole("button", { name: bootText.run }));
    fireEvent.click(screen.getByRole("button", { name: bootText.cancel }));
    expect(screen.queryByText(bootText.confirm)).toBeNull();
    expect(fetch.mock.calls.some(([, options]) => String(options?.body).includes("boot-drill"))).toBe(false);
  });

  it("shows how it knows, and says so when only staying up is known", async () => {
    show(reviewed, [bootRun({ readiness: "stayed-running" }, true)], {
      recipe: RECIPE,
      imageId: "sha256:one",
    });
    expect(await screen.findByText(bootText.readiness["stayed-running"](30))).toBeTruthy();
    expect(screen.getByText(bootText.notVerified)).toBeTruthy();
  });

  it("shows the last lines of a failure, and whatever could not be removed", async () => {
    show(reviewed, [bootRun({ logs: "the database is corrupt", left: ["autoheal-helper-boot-drill-x"] }, false)], {
      recipe: RECIPE,
      imageId: "sha256:one",
    });
    expect(await screen.findByText("the database is corrupt")).toBeTruthy();
    expect(screen.getByText(bootText.left("autoheal-helper-boot-drill-x"))).toBeTruthy();
  });
});
