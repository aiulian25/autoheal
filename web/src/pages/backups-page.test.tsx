import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type BackupView,
  type RestorePreviewView,
  type SessionView,
} from "../../../src/shared/api.js";
import { ERROR_TEXT, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { BackupsPage } from "./backups-page.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "test",
  secondFactorDone: true,
};
const backup: BackupView = {
  fileName: "test.sqlite.age",
  createdAt: 1,
  createdBy: "admin",
  origin: "manual",
  schemaVersion: 1,
  appVersion: "2",
  sha256: "a".repeat(64),
  sizeBytes: 100,
  integrityCheck: "ok",
  offboxCopied: false,
};
const previewOf = (owner: Pick<RestorePreviewView, "owner" | "ownerChanges">): RestorePreviewView => ({
  restoreId: "00000000-0000-4000-8000-000000000001",
  source: "stored",
  fileName: backup.fileName,
  schemaVersion: 1,
  expiresAt: Date.now() + 60000,
  dataAsOf: 1,
  counts: { hosts: 0, incidents: 0, runbooks: 0 },
  hostsRestored: [],
  ...owner,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The backups page, its restore asked for: the preview comes back, and its confirmation answers as `confirmed` says.
async function previewing(preview: RestorePreviewView, confirmed: () => Promise<Response> = async () => json({})) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === API_ROUTES.session) return json(session);
      if (path === API_ROUTES.backups) return json([backup]);
      if (path === apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName })) return json(preview);
      const confirming = path === apiPath(API_ROUTES.restoreConfirm, { restoreId: preview.restoreId });
      if (init?.method === "POST" && confirming) return confirmed();
      return json([]);
    }),
  );
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: "/", element: <BackupsPage /> }]);
  render(
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: TEXT.backups.restore }));
  await screen.findByRole("button", { name: TEXT.backups.confirm });
}

it("shows restore maintenance and preserves retry feedback when draining fails", async () => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previewing(previewOf({ owner: "admin", ownerChanges: false }), async () => {
    await paused;
    return json({ error: "restore_drain_busy" }, 503);
  });
  // The one who signs in now still does after: nothing to say.
  expect(screen.queryByText(TEXT.backups.owner("admin"))).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: TEXT.backups.confirm }));
  expect(await screen.findByText(TEXT.backups.restoring)).toBeTruthy();
  expect((screen.getByRole("button", { name: TEXT.backups.confirm }) as HTMLButtonElement).disabled).toBe(true);
  release();
  expect(await screen.findByText(ERROR_TEXT.restore_drain_busy)).toBeTruthy();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: TEXT.backups.confirm }) as HTMLButtonElement).disabled).toBe(false),
  );
});

it("says before a restore who alone would sign in after it, when that is someone else", async () => {
  await previewing(previewOf({ owner: "cedar", ownerChanges: true }));
  expect(screen.getByText(TEXT.backups.owner("cedar"))).toBeTruthy();
});
