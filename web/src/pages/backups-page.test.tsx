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
it("shows restore maintenance and preserves retry feedback when draining fails", async () => {
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
  const preview: RestorePreviewView = {
    restoreId: "00000000-0000-4000-8000-000000000001",
    source: "stored",
    fileName: backup.fileName,
    schemaVersion: 1,
    expiresAt: Date.now() + 60000,
    dataAsOf: 1,
    counts: { users: 1, hosts: 0, incidents: 0, runbooks: 0 },
    usersReactivated: [],
    usersAdded: [],
    hostsRestored: [],
  };
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      let body: unknown = [];
      if (path === API_ROUTES.session) body = session;
      else if (path === API_ROUTES.backups) body = [backup];
      else if (path === apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName })) body = preview;
      else if (
        init?.method === "POST" &&
        path === apiPath(API_ROUTES.restoreConfirm, { restoreId: preview.restoreId })
      ) {
        await paused;
        return new Response(JSON.stringify({ error: "restore_drain_busy" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
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
  fireEvent.click(await screen.findByRole("button", { name: TEXT.backups.confirm }));
  expect(await screen.findByText(TEXT.backups.restoring)).toBeTruthy();
  expect((screen.getByRole("button", { name: TEXT.backups.confirm }) as HTMLButtonElement).disabled).toBe(true);
  release();
  expect(await screen.findByText(ERROR_TEXT.restore_drain_busy)).toBeTruthy();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: TEXT.backups.confirm }) as HTMLButtonElement).disabled).toBe(false),
  );
});
