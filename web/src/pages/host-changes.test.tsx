import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostChangeView } from "../../../src/shared/api.js";
import { HOST_CHANGES_ANCHOR } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";
import { HostChanges } from "./host-changes.js";

const changes: HostChangeView[] = [
  { id: 2, at: Date.now() - 60_000, kind: "rebooted", containerName: null, details: {} },
  {
    id: 3,
    at: Date.now() - 60_000,
    kind: "recreated",
    containerName: "paperless-db",
    details: { imageBefore: "postgres:16", imageAfter: "postgres:17" },
  },
  {
    id: 1,
    at: Date.now() - 3_600_000,
    kind: "stopped",
    containerName: "tika",
    details: { exitCode: 137, oomKilled: true },
  },
];

function show(answer: HostChangeView[], path = "/hosts/h1") {
  const fetch = vi.fn(
    async (_url: string) => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/hosts/:hostId", element: <HostChanges hostId="h1" /> }], {
    initialEntries: [path],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { fetch, queryClient, router };
}

const nextTick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("what changed on a host", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // jsdom has none: a test that watches scrolling puts one in.
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("lists each change in words, the host's own as the host, in the order the journal gives", async () => {
    const { fetch } = show(changes);
    const card = (await screen.findByRole("region", { name: "What changed" })) as HTMLElement;
    const items = await within(card).findAllByRole("listitem");
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual(["Host", "paperless-db", "tika"]);
    expect(items[0]?.textContent).toContain("the host rebooted");
    expect(items[1]?.textContent).toContain("recreated (postgres:16 → postgres:17)");
    expect(items[2]?.textContent).toContain("stopped: out of memory");
    expect(fetch).toHaveBeenCalledWith(apiPath(API_ROUTES.hostChanges, { hostId: "h1" }), expect.anything());
  });

  it("shows the five latest changes, and folds the earlier ones away under them", async () => {
    const many: HostChangeView[] = Array.from({ length: 8 }, (_each, index) => ({
      id: 100 - index,
      at: Date.now() - index * 60_000,
      kind: "started",
      containerName: `app-${index}`,
      details: {},
    }));
    show(many);
    const card = await screen.findByRole("region", { name: TEXT.hostChanges.title });
    await within(card).findByText("app-0");
    const fold = within(card).getByText(TEXT.hostChanges.earlier(3)).closest("details")!;
    expect(fold.open).toBe(false);
    const shown = within(card)
      .getAllByRole("listitem")
      .filter((item) => !fold.contains(item))
      .map((item) => item.querySelector("strong")!.textContent);
    expect(shown).toEqual(["app-0", "app-1", "app-2", "app-3", "app-4"]);
    expect(
      within(fold)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("strong")!.textContent),
    ).toEqual(["app-5", "app-6", "app-7"]);
  });

  it("says when nothing changed", async () => {
    show([]);
    expect(await screen.findByText("Nothing changed in the last two weeks.")).toBeTruthy();
  });

  it("comes into view when a link leads to it, once the page has its data, and again only on the next link", async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    const { queryClient, router } = show(changes, `/hosts/h1#${HOST_CHANGES_ANCHOR}`);
    // Another part of the page still waiting for its answer, which would move the card down when it came.
    let answerTheRest = () => {};
    void queryClient.fetchQuery({
      queryKey: ["the rest of the page"],
      queryFn: () => new Promise<null>((resolve) => (answerTheRest = () => resolve(null))),
    });
    const card = (await screen.findByRole("region", { name: "What changed" })) as HTMLElement;
    await within(card).findAllByRole("listitem");
    await nextTick();
    expect(scrolled).not.toHaveBeenCalled();

    answerTheRest();
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(scrolled.mock.contexts[0]).toBe(card);

    // The page refreshing leaves it where the person has scrolled it.
    void queryClient.refetchQueries({ queryKey: ["the rest of the page"] });
    await nextTick();
    answerTheRest();
    await nextTick();
    expect(scrolled).toHaveBeenCalledTimes(1);

    await act(() => router.navigate(`/hosts/h1#${HOST_CHANGES_ANCHOR}`));
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));

    // The page's own changes to its address replace it: they are no link to follow.
    await act(() => router.navigate(`/hosts/h1?container=tika#${HOST_CHANGES_ANCHOR}`, { replace: true }));
    await nextTick();
    expect(scrolled).toHaveBeenCalledTimes(2);
  });

  it("stays where the page draws it when the address does not name it", async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    show(changes);
    await within((await screen.findByRole("region", { name: "What changed" })) as HTMLElement).findAllByRole(
      "listitem",
    );
    await nextTick();
    expect(scrolled).not.toHaveBeenCalled();
  });
});
