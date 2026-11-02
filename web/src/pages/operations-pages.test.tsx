import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, type SessionView } from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY } from "../constants.js";
import { IncidentsPage } from "./operations-pages.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};

function renderActivity(search: string) {
  const fetch = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify(url === API_ROUTES.session ? session : []), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: PATHS.incidents, element: <IncidentsPage /> }], {
    initialEntries: [`${PATHS.incidents}${search}`],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { fetch, router };
}

const asked = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url]) => String(url));

describe("the incidents on Activity", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows one container's incidents when a link asks, keeps them when the status changes, and leads back to all", async () => {
    const { fetch, router } = renderActivity("?hostId=h1&containerName=paperless");
    expect(await screen.findByText("Only the incidents of paperless.")).toBeTruthy();
    await waitFor(() => expect(asked(fetch)).toContain(`${API_ROUTES.incidents}?hostId=h1&containerName=paperless`));

    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "resolved" } });
    expect(router.state.location.search).toBe("?hostId=h1&containerName=paperless&status=resolved");
    await waitFor(() =>
      expect(asked(fetch)).toContain(`${API_ROUTES.incidents}?status=resolved&hostId=h1&containerName=paperless`),
    );

    fireEvent.click(screen.getByRole("link", { name: "Show all" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByText("Only the incidents of paperless.")).toBeNull();
  });
});
