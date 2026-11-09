import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { API_ROUTES, apiPath, type ContainerView } from "../../../src/shared/api.js";
import { HOST_SECTIONS } from "../../../src/shared/constants.js";
import {
  CARD_PAGES,
  CARD_STORAGE_KEY_PREFIX,
  DEPENDENCY_MAP_TEXT,
  HOST_CARDS,
  RUNNER_UPDATE_COMMAND,
  TEXT,
} from "../constants.js";
import { timeOfDay } from "../format.js";
import { hostPackagesQuery, localHostQuery } from "../queries.js";
import {
  host,
  hostHealthWithout,
  packageView,
  client,
  AUTOHEAL_VERSION,
  MADE_JOIN_CODE,
  answers,
  show,
  resetHostPage,
  checkable,
} from "../test-support/host-page.js";

afterEach(resetHostPage);

it("says in its title that the host's runner holds its automatic recovery, and why", async () => {
  show(packageView, undefined, { ...host, recoveryHold: { reason: "state_full", until: null } });
  const title = await screen.findByRole("heading", { level: 1, name: host.label });
  const held = within(title.parentElement!).getByText(TEXT.hosts.recoveryHeld);
  expect(held.className).toBe("badge danger");
  expect(held.title).toBe(TEXT.hosts.recoveryHeldWhy.state_full);
});

it("offers to switch a runner host to SSH, but not the machine Autoheal runs on", async () => {
  show();
  fireEvent.click(await screen.findByText(TEXT.ssh.add.switchTitle));
  expect(await screen.findByText(TEXT.ssh.add.switchExplanation)).toBeTruthy();
  cleanup();

  answers.localHostId = host.id;
  show();
  await waitFor(() => expect(client.getQueryState(localHostQuery.queryKey)?.status).toBe("success"));
  expect(screen.queryByText(TEXT.ssh.add.switchTitle)).toBeNull();
});

it("makes a new join code for a runner that joined, but not for this machine's runner nor one never seen", async () => {
  const { fetch } = show();
  fireEvent.click(await screen.findByRole("button", { name: TEXT.hosts.joinCode.make }));
  expect(await screen.findByText(MADE_JOIN_CODE.rejoinCommand)).toBeTruthy();
  const until = timeOfDay(MADE_JOIN_CODE.joinCodeExpiresAt);
  expect(screen.getByText(TEXT.hosts.joinCode.paste(host.label, until))).toBeTruthy();
  const asked = fetch.mock.calls.filter(
    ([url, init]) => String(url) === apiPath(API_ROUTES.hostJoinCode, { hostId: host.id }) && init?.method === "POST",
  );
  expect(asked.map(([, init]) => JSON.parse(String(init!.body)))).toEqual([{}]);
  cleanup();

  answers.localHostId = host.id;
  show();
  await waitFor(() => expect(client.getQueryState(localHostQuery.queryKey)?.status).toBe("success"));
  expect(screen.queryByText(TEXT.hosts.joinCode.title)).toBeNull();
  cleanup();

  answers.localHostId = "h0";
  show(packageView, undefined, { ...host, state: "never_seen", lastHeartbeatAt: null });
  await screen.findByRole("heading", { level: 1, name: host.label });
  expect(screen.queryByText(TEXT.hosts.joinCode.title)).toBeNull();
});

it("leaves out operating system updates on a host whose runner reads only its containers", async () => {
  show(checkable, undefined, { ...host, health: hostHealthWithout });
  // Its containers' images still are; its packages, read for the rest of the page, are not shown.
  await screen.findByRole("heading", { name: TEXT.containerImages.heading });
  await waitFor(() => expect(client.getQueryState(hostPackagesQuery(host.id).queryKey)?.status).toBe("success"));
  expect(document.getElementById("host-packages-title")).toBeNull();
});

it("tells how to bring a runner on another version level with Autoheal", async () => {
  show(packageView, undefined, { ...host, runnerVersion: "1.9.0" });
  expect(await screen.findByText(TEXT.ssh.runnerBehind("1.9.0", AUTOHEAL_VERSION))).toBeTruthy();
  expect(screen.getByText(RUNNER_UPDATE_COMMAND)).toBeTruthy();
});

it("lists a newer version than a container's tag apart, as the person's to take, not one to tick", async () => {
  const container = (name: string, image: string, newerTag: string, policy: "ask" | "off" = "ask"): ContainerView => ({
    hostId: host.id,
    hostLabel: host.label,
    hostState: "online",
    name,
    containerId: "0123456789ab",
    image,
    state: "running",
    health: "healthy",
    startedAt: 1,
    finishedAt: null,
    exitCode: null,
    oomKilled: false,
    restartCount: 0,
    restartPolicy: "unless-stopped",
    composeProject: null,
    composeService: null,
    link: null,
    version: null,
    source: null,
    ports: null,
    hostNetwork: false,
    update: { status: "current", checkedAt: 1, policy, remote: null, reason: null, newerTag },
    usage: null,
    byItself: { restart: "ask", update: "ask", restartLock: null, updateLock: null },
    protected: false,
    handsOff: null,
    problem: null,
  });
  answers.hostContainers = [
    container("paperless", "ghcr.io/paperless-ngx/paperless-ngx:2.13", "2.14"),
    container("redis", "redis:7.2", "7.4", "off"),
  ];
  show();

  expect(await screen.findByRole("heading", { name: TEXT.containerImages.newerTitle })).toBeTruthy();
  expect(screen.getByText(TEXT.updates.versions("2.13", "2.14"))).toBeTruthy();
  expect(screen.queryByText(TEXT.updates.versions("7.2", "7.4"))).toBeNull();
  expect(screen.queryByText(TEXT.containerImages.allCurrent)).toBeNull();
  expect(screen.queryByRole("checkbox", { name: TEXT.containerImages.selectOne("paperless") })).toBeNull();
});

it("shows three newer tag versions to begin with, and the rest on a click", async () => {
  const container = (name: string): ContainerView => ({
    hostId: host.id,
    hostLabel: host.label,
    hostState: "online",
    name,
    containerId: "0123456789ab",
    image: `example/${name}:1.0`,
    state: "running",
    health: "healthy",
    startedAt: 1,
    finishedAt: null,
    exitCode: null,
    oomKilled: false,
    restartCount: 0,
    restartPolicy: "unless-stopped",
    composeProject: null,
    composeService: null,
    link: null,
    version: null,
    source: null,
    ports: null,
    hostNetwork: false,
    update: { status: "current", checkedAt: 1, policy: "ask", remote: null, reason: null, newerTag: "1.1" },
    usage: null,
    byItself: { restart: "ask", update: "ask", restartLock: null, updateLock: null },
    protected: false,
    handsOff: null,
    problem: null,
  });
  answers.hostContainers = ["alpha", "bravo", "charlie", "delta", "echo"].map(container);
  show();

  expect(await screen.findByRole("heading", { name: "Newer TAG versions" })).toBeTruthy();
  expect(screen.getAllByText(TEXT.updates.versions("1.0", "1.1"))).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: TEXT.containerImages.newerShowAll(5) }));
  expect(screen.getAllByText(TEXT.updates.versions("1.0", "1.1"))).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: TEXT.containerImages.newerShowFewer }));
  expect(screen.getAllByText(TEXT.updates.versions("1.0", "1.1"))).toHaveLength(3);
});

it("shows a host without Docker its system and packages alone, and all of its containers' sections once it has Docker", async () => {
  const tabNames = () =>
    within(screen.getByRole("navigation", { name: TEXT.hosts.tabs.label }))
      .getAllByRole("link")
      .map((link) => link.textContent);
  show(checkable, undefined, { ...host, kind: "ssh", docker: false });
  await screen.findByRole("heading", { name: TEXT.hostPackages.title });
  expect(tabNames()).toEqual([TEXT.hosts.tabs.overview, TEXT.hosts.tabs.updates]);
  for (const section of ["containers", "dependencies", "control"]) {
    expect(document.getElementById(section)).toBeNull();
  }
  cleanup();

  // Docker installed since: the host reports it, and they are all back.
  show(checkable, undefined, { ...host, kind: "ssh", docker: true });
  await screen.findByRole("heading", { name: TEXT.hostPackages.title });
  expect(tabNames()).toEqual([
    TEXT.hosts.tabs.overview,
    expect.stringMatching(new RegExp(`^${TEXT.hosts.tabs.containers}`)),
    TEXT.hosts.tabs.updates,
    TEXT.hosts.tabs.dependencies,
    TEXT.hosts.tabs.control,
  ]);
  expect(document.getElementById("containers")).not.toBeNull();
});

it("puts the stats history right under the dials, folded away until opened", async () => {
  show();
  const fold = (await screen.findByText(TEXT.metrics.statsHistory)).closest("details")!;
  expect(fold.open).toBe(false);
  expect(fold.closest(`#${HOST_SECTIONS.overview}`)).not.toBeNull();
  // The dials come first; nothing stands between them and the fold.
  expect(fold.previousElementSibling?.className).toContain("section stack");
  expect(screen.queryByText(TEXT.metrics.history)).toBeNull();
});

it("puts a host's old images in its containers' section, right after the container list", async () => {
  show();
  const images = await screen.findByRole("region", { name: TEXT.hostImages.title });
  const containers = images.closest(`#${HOST_SECTIONS.containers}`)!;
  expect(containers).not.toBeNull();
  expect(images.previousElementSibling).toBe(containers.querySelector(".host-containers"));
});

it("hides a section's one card for this browser, its tab with it, and shows it again from the line", async () => {
  show();
  const tabs = await screen.findByRole("navigation", { name: TEXT.hosts.tabs.label });
  expect(within(tabs).getByRole("link", { name: TEXT.hosts.tabs.dependencies })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.start }));
  // Alone in its section, it has nothing to come before.
  expect(screen.queryByRole("button", { name: TEXT.arrange.pinCard(DEPENDENCY_MAP_TEXT.title) })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.hideCard(DEPENDENCY_MAP_TEXT.title) }));
  expect(document.getElementById(HOST_SECTIONS.dependencies)).toBeNull();
  expect(within(tabs).queryByRole("link", { name: TEXT.hosts.tabs.dependencies })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.show(DEPENDENCY_MAP_TEXT.title) }));
  expect(document.getElementById(HOST_SECTIONS.dependencies)).not.toBeNull();
  expect(within(tabs).getByRole("link", { name: TEXT.hosts.tabs.dependencies })).toBeTruthy();
});

it("puts a pinned overview card first after a reload, with the rest in their order after it", async () => {
  const reporting = { ...host, health: hostHealthWithout };
  show(packageView, undefined, reporting);
  await screen.findByText(TEXT.hostSystem.title);
  fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.start }));
  fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.pinCard(TEXT.hostSystem.title) }));
  fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.done }));

  cleanup();
  show(packageView, undefined, reporting);
  await screen.findByText(TEXT.hostSystem.title);
  const [first, second, third] = document.getElementById(HOST_SECTIONS.overview)!.children;
  expect(first!.className).toContain("host-system");
  expect(second!.className).toContain("section stack");
  expect(third!.className).toContain("stats-history");
});

it("shows a hidden card a link leads to, and the system card while the host's clock pauses its recovery", async () => {
  const hidden = [HOST_CARDS.updates, HOST_CARDS.system, HOST_CARDS.control];
  window.localStorage.setItem(`${CARD_STORAGE_KEY_PREFIX}${CARD_PAGES.host}`, JSON.stringify({ pinned: [], hidden }));
  show(packageView, `#${HOST_SECTIONS.updates}`, { ...host, health: hostHealthWithout, clockSkewSeconds: -754 });
  expect(await screen.findByText(TEXT.hostSystem.title)).toBeTruthy();
  expect(document.getElementById(HOST_SECTIONS.updates)).not.toBeNull();
  expect(document.getElementById(HOST_SECTIONS.control)).toBeNull();
  // The line lists what stays out of sight.
  expect(screen.getByRole("button", { name: TEXT.arrange.show(TEXT.hostControl.title(host.label)) })).toBeTruthy();
  expect(screen.queryByRole("button", { name: TEXT.arrange.show(TEXT.hostSystem.title) })).toBeNull();
  // Arranging says why a hidden one shows.
  fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.start }));
  const bar = screen.getByRole("group", { name: TEXT.arrange.controls(TEXT.hostSystem.title) });
  expect(within(bar).getByText(TEXT.arrange.pressing, { exact: false })).toBeTruthy();
  expect(within(bar).getByRole("button", { name: TEXT.arrange.show(TEXT.hostSystem.title) })).toBeTruthy();
});
