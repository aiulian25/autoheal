import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, type SessionView } from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { boardQuery, integrationsQuery, ollamaQuery, overviewQuery } from "../queries.js";
import { routes } from "../router.js";

// A QR code is a picture the browser draws; here it is only a placeholder.
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64," } }));
vi.mock("./attention-page.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attention-page.js")>()),
  AttentionPage: () => <p>The Attention page</p>,
}));

const text = TEXT.totpSetup;
// The page Done leads to loads the first time it is opened: while every file runs, that can take over a second.
const FIRST_PAGE_LOAD = { timeout: 5_000 };
const CODES = ["made-up-code-one", "made-up-code-two"];
const PASSPHRASE = "a made-up backup passphrase";
const sessionWith = (totpEnabled: boolean): SessionView => ({
  user: { id: "u", username: "admin", role: "admin", mustChangePassword: false, totpEnabled },
  csrfToken: "csrf",
  secondFactorDone: totpEnabled,
});

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

// The setup a first admin goes through, against a control plane whose session says what it holds right now.
async function confirmedSetup(server: { session: SessionView | null }) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      if (path === API_ROUTES.session) {
        return server.session === null ? new Response(null, { status: 401 }) : json(server.session);
      }
      if (path === API_ROUTES.totpSetup)
        return json({ secret: "MADEUPKEY", otpauthUri: "otpauth://totp/x?secret=MADEUPKEY" });
      if (path === API_ROUTES.totpConfirm) {
        server.session = sessionWith(true);
        return json({ recoveryCodes: CODES, backupPassphrase: PASSPHRASE });
      }
      return json([]);
    }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, sessionWith(false));
  client.setQueryData(boardQuery.queryKey, { needsYou: [] });
  client.setQueryData(ollamaQuery.queryKey, { reachable: true });
  client.setQueryData(overviewQuery.queryKey, { homeAssistant: null });
  client.setQueryData(integrationsQuery.queryKey, []);
  const router = createMemoryRouter(routes, { initialEntries: [PATHS.totpSetup] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: text.start }));
  fireEvent.change(await screen.findByLabelText(text.code), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: text.confirm }));
  expect(await screen.findByText(PASSPHRASE)).toBeTruthy();
  return router;
}

// The person leaves for their password manager and comes back: the dashboard reads its session again.
async function backFromElsewhere(expected: (session: SessionView | null | undefined) => void) {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await waitFor(() => expected(client.getQueryData<SessionView | null>(SESSION_QUERY_KEY)));
}

it("keeps the recovery codes and the backup passphrase until Done, though the session is read again meanwhile", async () => {
  const router = await confirmedSetup({ session: sessionWith(false) });

  await backFromElsewhere((session) => expect(session?.user.totpEnabled).toBe(true));
  expect(screen.getByText(PASSPHRASE)).toBeTruthy();
  expect(screen.getByText(CODES[0]!, { exact: false })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: text.done }));
  await waitFor(() => expect(router.state.location.pathname).toBe(PATHS.home));
  await waitFor(() => expect(screen.queryByText(PASSPHRASE)).toBeNull(), FIRST_PAGE_LOAD);
  // Saved: the setup page is no longer anyone's to see.
  await router.navigate(PATHS.totpSetup);
  await waitFor(() => expect(router.state.location.pathname).toBe(PATHS.home));
});

it("lets them go the moment the person is signed out", async () => {
  const server = { session: sessionWith(false) as SessionView | null };
  const router = await confirmedSetup(server);
  server.session = null;

  await backFromElsewhere((session) => expect(session).toBeNull());
  await waitFor(() => expect(router.state.location.pathname).toBe(PATHS.login));
  await waitFor(() => expect(screen.queryByText(PASSPHRASE)).toBeNull(), FIRST_PAGE_LOAD);
});
