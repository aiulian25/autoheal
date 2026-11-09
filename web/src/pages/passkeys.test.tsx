import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type OwnAccountView,
  type PasskeyStatusView,
  type PasskeyView,
  type SessionView,
} from "../../../src/shared/api.js";
import { HTTP_STATUS } from "../../../src/shared/constants.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { AccountPage } from "./account-page.js";
import { LoginPage } from "./auth-pages.js";

// The browser's own prompts, as a phone or a password manager would answer them.
const browser = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: browser.startRegistration,
  startAuthentication: browser.startAuthentication,
}));

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const account: OwnAccountView = {
  username: "admin",
  role: "admin",
  authenticatorName: "admin@autoheal.example.org",
  recoveryCodesLeft: 10,
  sessions: [],
};
const PHONE: PasskeyView = {
  id: "8c2f3c1e-5b7a-4d36-9e0f-1a2b3c4d5e6f",
  name: "Google Password Manager",
  createdAt: Date.now() - 86_400_000,
  lastUsedAt: null,
  synced: true,
  otherAddress: null,
};
const CREATION_OPTIONS = { challenge: "creation-challenge", rp: { id: "autoheal.example.org" } };
const REQUEST_OPTIONS = { challenge: "request-challenge", rpId: "autoheal.example.org" };
const MADE = { id: "credential", type: "public-key" };
const ANSWERED = { id: "credential", type: "public-key", response: { signature: "signed" } };

function serve(status: PasskeyStatusView, passkeys: PasskeyView[]) {
  const answers: Record<string, unknown> = {
    [`GET ${API_ROUTES.session}`]: session,
    [`GET ${API_ROUTES.account}`]: account,
    [`GET ${API_ROUTES.passkeyStatus}`]: status,
    [`GET ${API_ROUTES.accountPasskeys}`]: passkeys,
    [`POST ${API_ROUTES.accountPasskeyOptions}`]: CREATION_OPTIONS,
    [`POST ${API_ROUTES.accountPasskeys}`]: PHONE,
    [`POST ${API_ROUTES.passkeySignInOptions}`]: REQUEST_OPTIONS,
    [`POST ${API_ROUTES.passkeySignIn}`]: session,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      return new Response(null, { status: HTTP_STATUS.noContent });
    }
    const answer = method === "PATCH" ? { ...PHONE, name: "Work phone" } : answers[`${method} ${url}`];
    return new Response(JSON.stringify(answer ?? {}), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(path: string, signedIn: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, signedIn ? session : null);
  const router = createMemoryRouter(
    [
      { path: PATHS.account, element: <AccountPage /> },
      { path: PATHS.login, element: <LoginPage /> },
      { path: PATHS.home, element: <p>What needs you</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const sentTo = (fetch: ReturnType<typeof serve>, method: string, url: string) =>
  fetch.mock.calls
    .filter(([calledUrl, init]) => calledUrl === url && init?.method === method)
    .map(([, init]) => (init?.body === undefined ? null : JSON.parse(String(init.body))));

describe("passkeys", () => {
  beforeEach(() => {
    browser.startRegistration.mockReset();
    browser.startAuthentication.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("adds one after a current code: the browser's prompt, and it names itself", async () => {
    browser.startRegistration.mockResolvedValue(MADE);
    const fetch = serve({ usable: true, offered: false }, []);
    renderAt(PATHS.account, true);

    expect(await screen.findByText("No passkeys yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    fireEvent.change(screen.getByLabelText(/current code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/^Added Google Password Manager\./)).toBeTruthy();
    expect(sentTo(fetch, "POST", API_ROUTES.accountPasskeyOptions)).toEqual([{ code: "123456" }]);
    expect(browser.startRegistration).toHaveBeenCalledWith({ optionsJSON: CREATION_OPTIONS });
    const [added] = sentTo(fetch, "POST", API_ROUTES.accountPasskeys);
    expect(added).toMatchObject({ response: MADE });
    expect(typeof added.name).toBe("string");
  });

  it("says why the browser stopped, and when this device has one here already", async () => {
    browser.startRegistration.mockRejectedValueOnce(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    browser.startRegistration.mockRejectedValueOnce(
      Object.assign(new Error("previously registered"), { code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" }),
    );
    serve({ usable: true, offered: false }, []);
    renderAt(PATHS.account, true);

    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    fireEvent.change(screen.getByLabelText(/current code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/The browser stopped without a passkey/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("This device already has a passkey for this dashboard.")).toBeTruthy();
  });

  it("lists each with its manager's name, and renames or removes it in place", async () => {
    const fetch = serve({ usable: true, offered: true }, [PHONE]);
    renderAt(PATHS.account, true);
    const passkey = apiPath(API_ROUTES.accountPasskey, { passkeyId: PHONE.id });

    expect(await screen.findByText("Google Password Manager")).toBeTruthy();
    const section = within(screen.getByRole("region", { name: "Passkeys" }));
    expect(section.getByText("synced")).toBeTruthy();
    expect(section.getByText(/not used yet/)).toBeTruthy();
    fireEvent.click(section.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for Google Password Manager"), {
      target: { value: "Work phone" },
    });
    fireEvent.click(section.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sentTo(fetch, "PATCH", passkey)).toEqual([{ name: "Work phone" }]));

    fireEvent.click(section.getByRole("button", { name: "Remove" }));
    expect(sentTo(fetch, "DELETE", passkey)).toEqual([]);
    fireEvent.click(section.getByRole("button", { name: TEXT.yes }));
    await waitFor(() => expect(sentTo(fetch, "DELETE", passkey)).toEqual([null]));
  });

  it("explains that an IP address can have none, and offers no way to add one there", async () => {
    serve({ usable: false, offered: false }, []);
    renderAt(PATHS.account, true);

    expect(await screen.findByText(/browsers don't allow them at an IP address/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });

  it("signs in with a passkey alone from the sign-in page, once someone has one", async () => {
    browser.startAuthentication.mockResolvedValue(ANSWERED);
    const fetch = serve({ usable: true, offered: true }, []);
    renderAt(PATHS.login, false);

    fireEvent.click(await screen.findByRole("button", { name: "Passkey" }));

    expect(await screen.findByText("What needs you")).toBeTruthy();
    expect(browser.startAuthentication).toHaveBeenCalledWith({ optionsJSON: REQUEST_OPTIONS });
    expect(sentTo(fetch, "POST", API_ROUTES.passkeySignIn)).toEqual([{ response: ANSWERED }]);
  });

  it("offers no passkey on the sign-in page while nobody has one", async () => {
    serve({ usable: true, offered: false }, []);
    renderAt(PATHS.login, false);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Or continue with")).toBeNull());
    expect(screen.queryByRole("button", { name: "Passkey" })).toBeNull();
  });
});
