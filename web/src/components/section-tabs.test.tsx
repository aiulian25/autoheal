import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter, createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, expect, it } from "vitest";
import type { SessionView } from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { SettingsNav, type SettingsSection } from "./section-tabs.js";

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  window.history.replaceState(null, "", "/");
});
it("derives the settings active section from a same-page router navigation", async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const session: SessionView = {
    user: { id: "u", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
    csrfToken: "csrf",
    secondFactorDone: true,
  };
  client.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: PATHS.settings, element: <SettingsNav current={null} /> }], {
    initialEntries: [PATHS.settings],
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const nav = screen.getByRole("navigation", { name: TEXT.settingsPage.nav.label });
  await act(() => router.navigate("#notifications"));
  expect(
    within(nav).getByRole("link", { name: TEXT.settingsPage.nav.notifications }).getAttribute("aria-current"),
  ).toBe("true");
});

function show({
  hash = "#notifications",
  current = null,
  role = "admin",
}: { hash?: string; current?: SettingsSection | null; role?: "admin" | "viewer" } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const session: SessionView = {
    user: { id: "u", username: role, role, mustChangePassword: false, totpEnabled: true },
    csrfToken: "csrf",
    secondFactorDone: true,
  };
  client.setQueryData(SESSION_QUERY_KEY, session);
  window.history.replaceState(null, "", PATHS.settings + hash);
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <SettingsNav current={current} />
        <Link to="#system">Other link to settings system</Link>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole("navigation", { name: TEXT.settingsPage.nav.label });
}
const selected = (nav: HTMLElement, name: string) => {
  expect(within(nav).getByRole("link", { name }).getAttribute("aria-current")).toBe("true");
  expect(nav.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
};
it("keeps settings highlighting on the browser URL through native clicks, Back/Forward and another same-page link", async () => {
  const nav = show();
  const words = TEXT.settingsPage.nav;
  selected(nav, words.notifications);
  const schedules = within(nav).getByRole("link", { name: words.schedules });
  expect(schedules.getAttribute("href")).toBe("#schedules");
  fireEvent.click(schedules);
  await waitFor(() => {
    expect(window.location.hash).toBe("#schedules");
    selected(nav, words.schedules);
  });
  await act(async () => window.history.back());
  await waitFor(() => {
    expect(window.location.hash).toBe("#notifications");
    selected(nav, words.notifications);
  });
  await act(async () => window.history.forward());
  await waitFor(() => {
    expect(window.location.hash).toBe("#schedules");
    selected(nav, words.schedules);
  });
  fireEvent.click(screen.getByRole("link", { name: "Other link to settings system" }));
  await waitFor(() => selected(nav, words.system));
  await act(async () => {
    window.location.hash = "not-a-section";
  });
  await waitFor(() => selected(nav, words.connections));
  await act(async () => {
    window.location.hash = "";
  });
  await waitFor(() => selected(nav, words.connections));
});
it("keeps a settings subpage's explicit current section regardless of its hash", async () => {
  const nav = show({ hash: "#notifications", current: "people" });
  selected(nav, TEXT.settingsPage.nav.people);
  expect(within(nav).getByRole("link", { name: TEXT.settingsPage.nav.notifications }).getAttribute("href")).toBe(
    `${PATHS.settings}#notifications`,
  );
  expect(within(nav).getByRole("link", { name: TEXT.settingsPage.nav.account }).getAttribute("href")).toBe(
    PATHS.account,
  );
  await act(async () => {
    window.location.hash = "schedules";
  });
  await waitFor(() => expect(window.location.hash).toBe("#schedules"));
  selected(nav, TEXT.settingsPage.nav.people);
});
it("preserves viewer navigation filtering and the default section", async () => {
  const nav = show({ hash: "#unknown", role: "viewer" });
  const words = TEXT.settingsPage.nav;
  selected(nav, words.connections);
  expect(within(nav).queryByRole("link", { name: words.people })).toBeNull();
  expect(within(nav).queryByRole("link", { name: words.backups })).toBeNull();
  fireEvent.click(within(nav).getByRole("link", { name: words.notifications }));
  await waitFor(() => selected(nav, words.notifications));
});
