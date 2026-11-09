import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TEXT } from "../constants.js";
import { packageView, show, resetHostPage } from "../test-support/host-page.js";

afterEach(resetHostPage);

it("derives the host's active tab from a same-page router navigation", async () => {
  const { router } = show();
  const nav = await screen.findByRole("navigation", { name: TEXT.hosts.tabs.label });
  await act(() => router.navigate("#updates"));
  expect(
    within(nav)
      .getByRole("link", { name: /^Updates/ })
      .getAttribute("aria-current"),
  ).toBe("true");
});

it("underlines the section scrolled to, until a tab jumps somewhere else", async () => {
  const { router } = show();
  const nav = await screen.findByRole("navigation", { name: TEXT.hosts.tabs.label });
  const current = () => nav.querySelector('[aria-current="true"]')?.textContent;
  const placed = (["updates", "dependencies", "control"] as const).map((section, index) =>
    vi
      .spyOn(document.getElementById(section)!, "getBoundingClientRect")
      .mockReturnValue({ top: index * window.innerHeight } as DOMRect),
  );

  fireEvent.scroll(window);
  expect(current()).toMatch(/^Updates/);

  await act(() => router.navigate("#dependencies"));
  await waitFor(() => expect(current()).toMatch(/^Dependencies/));
  placed.forEach((spy) => spy.mockRestore());
});

it("keeps host tab highlighting on the browser URL through native clicks, Back/Forward and another same-page link", async () => {
  show(packageView, "#containers");
  const nav = await screen.findByRole("navigation", { name: TEXT.hosts.tabs.label });
  const selected = (name: string) => {
    expect(
      within(nav)
        .getByRole("link", { name: new RegExp(`^${name}`) })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(nav.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  };
  selected(TEXT.hosts.tabs.containers);
  const updates = within(nav).getByRole("link", { name: TEXT.hosts.tabs.updates });
  expect(updates.getAttribute("href")).toBe("#updates");
  fireEvent.click(updates);
  await waitFor(() => {
    expect(window.location.hash).toBe("#updates");
    selected(TEXT.hosts.tabs.updates);
  });
  await act(async () => window.history.back());
  await waitFor(() => {
    expect(window.location.hash).toBe("#containers");
    selected(TEXT.hosts.tabs.containers);
  });
  await act(async () => window.history.forward());
  await waitFor(() => {
    expect(window.location.hash).toBe("#updates");
    selected(TEXT.hosts.tabs.updates);
  });
  fireEvent.click(screen.getByRole("link", { name: "Other link to host control" }));
  await waitFor(() => selected(TEXT.hosts.tabs.control));
  await act(async () => {
    window.location.hash = "not-a-section";
  });
  await waitFor(() => selected(TEXT.hosts.tabs.overview));
  await act(async () => {
    window.location.hash = "";
  });
  await waitFor(() => selected(TEXT.hosts.tabs.overview));
});

it("leads back to the container list from the page's Containers tab", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: `${TEXT.hostNetworks.chip} 0` }));
  expect(screen.getByRole("heading", { name: new RegExp(`^${TEXT.hostNetworks.title}`) })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: new RegExp(`^${TEXT.hosts.tabs.containers}`) }));
  expect(await screen.findByRole("heading", { name: new RegExp(`^${TEXT.hostContainers.title}`) })).toBeTruthy();
});

it("scrolls to the section a link from another page names, once the host is drawn", async () => {
  const scrolled: string[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push(this.id);
  });
  show(undefined, "#updates");
  await waitFor(() => expect(scrolled).toContain("updates"));
});
