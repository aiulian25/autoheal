import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TEXT } from "../constants.js";
import {
  host,
  packageView,
  job,
  json,
  client,
  show,
  resetHostPage,
  IMAGES,
  PACKAGES,
  checkable,
} from "../test-support/host-page.js";

afterEach(resetHostPage);

it("re-enables Check images after its accepted job finishes and submits another check without unmounting", async () => {
  const { records, posts, refresh } = show();
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: IMAGES });
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_updates"]));
  await waitFor(() => expect(button.disabled).toBe(true));
  records.set("j1", job("j1", "check_updates", "succeeded"));
  await refresh();
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_updates", "check_updates"]));
});

it("holds the package check back while another package job runs, and leaves the image check free", async () => {
  const running = job("upgrade", "upgrade_packages", "delivered");
  const { posts } = show({ ...checkable, running, recent: [running] });
  const packages = await screen.findByRole<HTMLButtonElement>("button", { name: PACKAGES });
  await waitFor(() => expect(packages.disabled).toBe(true));
  fireEvent.click(packages);
  expect(posts).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: IMAGES }));
  await waitFor(() => expect(posts).toEqual(["check_updates"]));
});

it.each(["succeeded", "failed", "expired"] as const)(
  "checks images and packages apart, each button following its own job until it is %s",
  async (status) => {
    const { records, posts, refresh } = show(checkable);
    const images = await screen.findByRole<HTMLButtonElement>("button", { name: IMAGES });
    const packages = await screen.findByRole<HTMLButtonElement>("button", { name: PACKAGES });
    fireEvent.click(packages);
    await waitFor(() => expect(posts).toEqual(["check_packages"]));
    expect(await screen.findByText("Package check: Queued")).toBeTruthy();
    expect(screen.queryByText(/^Image check/)).toBeNull();
    expect(images.disabled).toBe(false);
    fireEvent.click(images);
    await waitFor(() => expect(posts).toEqual(["check_packages", "check_updates"]));
    records.set("j1", job("j1", "check_packages", "delivered"));
    records.set("j2", job("j2", "check_updates", "succeeded"));
    await refresh();
    expect(await screen.findByText("Image check: Completed")).toBeTruthy();
    expect(await screen.findByText("Package check: Under way")).toBeTruthy();
    await waitFor(() => expect(images.disabled).toBe(false));
    expect(packages.disabled).toBe(true);
    records.set("j1", job("j1", "check_packages", status));
    await refresh();
    await waitFor(() => expect(packages.disabled).toBe(false));
  },
);

it("keeps a status-read failure separate from asking again and recovers by refreshing the same job", async () => {
  const { records, posts, fetch } = show();
  const base = fetch.getMockImplementation()!;
  let unavailable = true;
  fetch.mockImplementation((url, init) =>
    String(url).startsWith("/api/jobs/") && unavailable
      ? Promise.resolve(json({ error: "internal_error" }, 503))
      : base(url, init),
  );
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: IMAGES });
  fireEvent.click(button);
  expect(
    await screen.findByText("Check status is unavailable. Refresh status before requesting another check."),
  ).toBeTruthy();
  expect(button.disabled).toBe(true);
  unavailable = false;
  records.set("j1", job("j1", "check_updates", "succeeded"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh check status" }));
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(posts).toEqual(["check_updates"]);
});

it("allows asking again when the first request was refused, with no job accepted", async () => {
  const { posts, fetch } = show();
  const base = fetch.getMockImplementation()!;
  let refused = true;
  fetch.mockImplementation((url, init) =>
    init?.method === "POST" && refused ? Promise.resolve(json({ error: "internal_error" }, 503)) : base(url, init),
  );
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: IMAGES });
  fireEvent.click(button);
  await screen.findByRole("alert");
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(posts).toEqual([]);
  refused = false;
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_updates"]));
});

it("observes completion through fallback polling without an SSE event", async () => {
  const { records, posts } = show();
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: IMAGES });
  fireEvent.click(button);
  await screen.findByText("Image check: Queued");
  records.set("j1", job("j1", "check_updates", "succeeded"));
  await waitFor(() => expect(button.disabled).toBe(false), { timeout: 4000 });
  expect(posts).toEqual(["check_updates"]);
});

it.each([
  { ...checkable, facts: { ...checkable.facts!, setting: "off" as const } },
  { ...checkable, facts: { ...checkable.facts!, unsupported: "no_systemd" as const } },
])("offers no package check when the host does not permit checking its packages", async (view) => {
  show(view);
  await screen.findByRole("button", { name: IMAGES });
  await waitFor(() => expect(client.getQueryData(["host-packages", host.id])).toEqual(view));
  expect(screen.queryByRole("button", { name: PACKAGES })).toBeNull();
});

it("checks only the packages of a host without Docker: it has no images to check", async () => {
  const { posts } = show(checkable, undefined, { ...host, kind: "ssh", docker: false });
  // Offered once its packages are known to be checkable; it has no images to check.
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: PACKAGES });
  expect(screen.queryByRole("button", { name: IMAGES })).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual(["check_packages"]));
  expect(await screen.findByText("Package check: Queued")).toBeTruthy();
  expect(screen.queryByText(/^Image check/)).toBeNull();
  // Its updates are its packages': no container images, and no image rollout across hosts.
  expect(screen.queryByRole("heading", { name: TEXT.containerImages.title })).toBeNull();
  expect(screen.queryByText("Staged cross-host rollout")).toBeNull();
  expect(screen.getByRole("heading", { name: TEXT.hostPackages.title })).toBeTruthy();
});

it("offers a terminal where the host's runner can open one, and says why it cannot elsewhere", async () => {
  const terminalButton = async () => screen.findByRole<HTMLButtonElement>("button", { name: TEXT.hostTerminal.button });
  show(packageView, undefined, { ...host, hostTerminal: true });
  expect((await terminalButton()).disabled).toBe(false);
  cleanup();
  const reasons = [
    [{ hostTerminal: false }, TEXT.hostTerminal.unavailable.off(host.label)],
    [{}, TEXT.hostTerminal.unavailable.runner(host.label)],
    [{ hostTerminal: true, state: "silent" as const }, TEXT.hostTerminal.unavailable.silent(host.label)],
  ] as const;
  for (const [shown, why] of reasons) {
    show(packageView, undefined, { ...host, ...shown });
    const button = await terminalButton();
    expect([button.disabled, button.title]).toEqual([true, why]);
    cleanup();
  }
});
