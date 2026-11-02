import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type OwnAccountView, type SessionView } from "../../../src/shared/api.js";
import { HTTP_STATUS } from "../../../src/shared/constants.js";
import {
  ASK_FIRST_ON,
  ASK_FIRST_STORAGE_KEY,
  PATHS,
  SESSION_QUERY_KEY,
  THEME_STORAGE_KEY,
  THEMES,
} from "../constants.js";
import { AccountPage } from "./account-page.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};

const THIS_SESSION = "a".repeat(16);
const PHONE_SESSION = "b".repeat(16);

const account: OwnAccountView = {
  username: "admin",
  role: "admin",
  authenticatorName: "admin@autoheal.lan:8443",
  recoveryCodesLeft: 7,
  sessions: [
    {
      id: THIS_SESSION,
      current: true,
      ip: "192.168.10.50",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      createdAt: Date.now() - 3_600_000,
      lastSeenAt: Date.now(),
    },
    {
      id: PHONE_SESSION,
      current: false,
      ip: "10.0.0.12",
      userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
      createdAt: Date.now() - 86_400_000,
      lastSeenAt: Date.now() - 7_200_000,
    },
  ],
};

function serve() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      return new Response(null, { status: HTTP_STATUS.noContent });
    }
    const body =
      url === API_ROUTES.session ? session : { ...account, username: init?.method === "PATCH" ? "alex" : "admin" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAccount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: PATHS.account, element: <AccountPage /> }], {
    initialEntries: [PATHS.account],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const sent = (fetch: ReturnType<typeof serve>, method: string) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method === method)
    .map(([url, init]) => [url, init?.body === undefined ? null : JSON.parse(String(init.body))]);

describe("your account", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists where you are signed in, and signs out one session or every other one", async () => {
    const fetch = serve();
    renderAccount();
    expect(await screen.findByText("This browser · Chrome on Linux")).toBeTruthy();
    expect(
      screen.getByText("Ending a session also closes its container shells and stops interactive work."),
    ).toBeTruthy();
    expect(screen.getByText("Recovery codes: 7 of 10 left.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out This browser · Chrome on Linux" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign out Firefox on Android" }));
    await waitFor(() =>
      expect(sent(fetch, "DELETE")).toEqual([[apiPath(API_ROUTES.accountSession, { sessionId: PHONE_SESSION }), null]]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere else" }));
    await waitFor(() => expect(sent(fetch, "DELETE").at(-1)).toEqual([API_ROUTES.accountOtherSessions, null]));
  });

  it("renames you only with your current password", async () => {
    const fetch = serve();
    renderAccount();
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "alex" } });
    // The name form comes first; the password form below asks for the current password too.
    const [renamePassword] = screen.getAllByLabelText("Current password");
    fireEvent.change(renamePassword!, { target: { value: "the old password" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(sent(fetch, "PATCH")).toEqual([
      [API_ROUTES.account, { username: "alex", currentPassword: "the old password" }],
    ]);
    expect(await screen.findByText("Signed in as alex (admin).")).toBeTruthy();
  });

  it("follows the device's look until another is chosen, then shows and keeps that one here", async () => {
    serve();
    renderAccount();
    const looks = await screen.findByRole("radiogroup", { name: "Appearance" });
    expect((within(looks).getByRole("radio", { name: /As this device is set/ }) as HTMLInputElement).checked).toBe(
      true,
    );

    fireEvent.click(within(looks).getByRole("radio", { name: "Dark" }));
    expect((within(looks).getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe(THEMES.dark);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(THEMES.dark);

    fireEvent.click(within(looks).getByRole("radio", { name: /As this device is set/ }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("asks before stop and remove only once chosen here, and keeps that choice in this browser", async () => {
    serve();
    renderAccount();
    const askFirst = async () =>
      within(await screen.findByRole("region", { name: "Container actions" })).getByRole("checkbox", {
        name: /Ask before stop and remove/,
      }) as HTMLInputElement;
    expect((await askFirst()).checked).toBe(false);
    expect(window.localStorage.getItem(ASK_FIRST_STORAGE_KEY)).toBeNull();

    fireEvent.click(await askFirst());
    expect((await askFirst()).checked).toBe(true);
    expect(window.localStorage.getItem(ASK_FIRST_STORAGE_KEY)).toBe(ASK_FIRST_ON);

    // The next visit in this browser finds it on; unticked, nothing is kept.
    cleanup();
    renderAccount();
    expect((await askFirst()).checked).toBe(true);
    fireEvent.click(await askFirst());
    expect((await askFirst()).checked).toBe(false);
    expect(window.localStorage.getItem(ASK_FIRST_STORAGE_KEY)).toBeNull();

    // Where storage is off nothing is kept, and the box says so.
    const refused = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage is off");
    });
    try {
      fireEvent.click(await askFirst());
      expect((await askFirst()).checked).toBe(false);
    } finally {
      refused.mockRestore();
    }
  });
});
