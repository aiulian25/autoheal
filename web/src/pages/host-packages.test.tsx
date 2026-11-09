import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, type HostPackagesView, type HostView, type JobView } from "../../../src/shared/api.js";
import { HOST_PACKAGE_COMMANDS } from "../../../src/shared/constants.js";
import type { PackageFacts } from "../../../src/shared/protocol.js";
import { TEXT } from "../constants.js";
import { HostPackages, RebootWarning } from "./host-packages.js";

const facts = (overrides: Partial<PackageFacts> = {}): PackageFacts => ({
  setting: "apply",
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: [],
  kernelWaiting: "6.8.0-90-generic",
  timeZone: "Europe/Lisbon",
  recentChanges: [
    {
      endedAt: Date.now() - 3_600_000,
      byUnattendedUpgrades: true,
      upgraded: [{ name: "curl", version: "8.5.0-2ubuntu10.6" }],
      upgradedCount: 1,
      installed: [],
      removed: [],
    },
  ],
  ...overrides,
});

const view = (overrides: Partial<HostPackagesView> = {}): HostPackagesView => ({
  hostId: "h1",
  rebootRequired: false,
  lifecycle: {
    release: "Ubuntu 24.04",
    status: "supported",
    securityUntil: "2029-05-31",
    extendedUntil: "2034-04-25",
    datesAsOf: "2026-10-22",
  },
  facts: facts(),
  checkedAt: Date.now(),
  refreshed: true,
  refreshProblem: null,
  needsRepair: false,
  packages: [
    {
      name: "openssl",
      installed: "3.0.13-1",
      candidate: "3.0.13-2",
      security: true,
      kind: "routine",
      held: false,
      summary: "Secure Sockets Layer toolkit - cryptographic utility",
      source: "noble-security",
    },
    {
      name: "docker-ce",
      installed: "5:28.5.0",
      candidate: "5:28.5.1",
      security: false,
      kind: "container_runtime",
      held: true,
      summary: "Docker: the open-source application container engine",
      source: "Docker CE",
    },
  ],
  keptBack: [],
  removable: [],
  automatic: ["openssl"],
  unattended: [],
  forPerson: ["docker-ce"],
  running: null,
  recent: [],
  window: { securityInWindow: true, windowStart: "03:00", windowEnd: "05:00" },
  ...overrides,
});

const job = (overrides: Partial<JobView> = {}): JobView => ({
  id: "j1",
  hostId: "h1",
  hostLabel: "Alder",
  containerName: "",
  action: "upgrade_packages",
  status: "pending",
  requestedBy: "admin",
  taskId: null,
  createdAt: Date.now(),
  completedAt: null,
  outcome: null,
  output: null,
  recoveryBackupId: null,
  packages: ["openssl"],
  progress: null,
  stack: null,
  ...overrides,
});

// What the API answers: the host's packages as `served.view` has them now, and a job for each request.
function serve(packages: HostPackagesView, hosts: readonly Partial<HostView>[] = []) {
  const served = { view: packages };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const read = url === API_ROUTES.hosts ? hosts : served.view;
    const body = init?.method === "POST" ? job(JSON.parse(String(init.body))) : read;
    if (init?.method === "POST") {
      served.view = { ...served.view, running: body as JobView, recent: [body as JobView, ...served.view.recent] };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, served };
}

function show(packages: HostPackagesView, admin = true, element?: ReactNode, hosts: readonly Partial<HostView>[] = []) {
  const answers = serve(packages, hosts);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      {element ?? <HostPackages hostId="h1" admin={admin} />}
    </QueryClientProvider>,
  );
  // The host's packages as they are now, as the page's next refresh would bring them.
  const refresh = async (changed: HostPackagesView) => {
    answers.served.view = changed;
    await act(() => queryClient.invalidateQueries());
  };
  return { ...answers, refresh, queryClient, ...rendered };
}

const posted = (fetch: ReturnType<typeof serve>["fetch"]) =>
  fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));

describe("a host's packages, as drawn, with the details a click away", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists each update with what it is, and opens its version, source and who installs it", async () => {
    show(view());

    expect(
      await screen.findByText(
        "Security fixes go in on their own in the nightly window, 03:00 to 05:00. The rest waits for you.",
      ),
    ).toBeTruthy();
    const openssl = screen.getByRole("button", { name: "openssl" }).closest("li")!;
    expect(openssl.textContent).toContain("Secure Sockets Layer toolkit - cryptographic utility");
    expect(within(openssl).getByText("security")).toBeTruthy();
    fireEvent.click(within(openssl).getByRole("button", { name: "openssl" }));
    expect(within(openssl).getByText("New version 3.0.13-2").className).toBe("new-version");
    expect(within(openssl).getByText("installed 3.0.13-1")).toBeTruthy();
    expect(within(openssl).getByText("Noble-security").className).toBe("security-source");
    expect(openssl.textContent).toContain("routine · Autoheal, tonight");

    const docker = screen.getByRole("button", { name: "docker-ce" }).closest("li")!;
    expect(docker.textContent).toContain("held for you");
    fireEvent.click(within(docker).getByRole("button", { name: "docker-ce" }));
    expect(docker.textContent).toContain("container runtime · you");
    expect(within(docker).getByText("Docker CE").className).toBe("muted");
  });

  it("tells an SSH host's admin to choose its setting on its own card, where a runner host's says its .env", async () => {
    const off = view({ facts: facts({ setting: "off" }) });
    show(off, true, undefined, [{ id: "h1", kind: "ssh" }]);
    expect(await screen.findByText(TEXT.hostPackages.allowedOverSsh.off)).toBeTruthy();
    cleanup();
    show(off, true, undefined, [{ id: "h1", kind: "runner" }]);
    expect(await screen.findByText(TEXT.hostPackages.allowed.off)).toBeTruthy();
  });

  it("says the window's line as drawn when everything listed goes in tonight", async () => {
    show(view({ packages: view().packages.slice(0, 1), forPerson: [] }));

    expect(
      await screen.findByText("Installed in the nightly window, 03:00 to 05:00. Security fixes go in on their own."),
    ).toBeTruthy();
  });

  it("sends its install button to the page's bar when it has one, off the card's foot", async () => {
    function InABar() {
      const [bar, setBar] = useState<HTMLElement | null>(null);
      return (
        <>
          <div ref={setBar} data-testid="bar" />
          <HostPackages hostId="h1" admin actionsIn={bar} />
        </>
      );
    }
    const { fetch } = show(view(), true, <InABar />);

    fireEvent.click(await screen.findByRole("button", { name: "Install now" }));

    const bar = screen.getByTestId("bar");
    expect(within(bar).getByRole("button", { name: "Install now" })).toBeTruthy();
    expect(within(bar).getByText("Host packages")).toBeTruthy();
    expect(within(bar).getByText(/\d+ ticked/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Install now" })).toHaveLength(1);
    await waitFor(() => expect(posted(fetch)).toHaveLength(1));
  });

  it("ticks every update to begin with, and installs exactly the ones still ticked", async () => {
    const { fetch } = show(view());

    expect(await screen.findByRole("button", { name: "Install now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select docker-ce" }));
    // Only what Autoheal would put in tonight is left: putting it in now is the other way.
    fireEvent.click(screen.getByRole("button", { name: "Install now instead" }));

    await waitFor(() => expect(posted(fetch)).toEqual([{ action: "upgrade_packages", packages: ["openssl"] }]));
  });

  it("disables every host package mutation immediately, through acceptance and the running job", async () => {
    const { fetch } = show(
      view({ needsRepair: true, rebootRequired: true, removable: [{ name: "old-library", installed: "1" }] }),
      true,
      <>
        <RebootWarning hostId="h1" hostLabel="Alder" admin />
        <HostPackages hostId="h1" admin />
      </>,
    );
    const respond = fetch.getMockImplementation()!;
    let accept!: () => void;
    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
    fetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST") await pending;
      return respond(url, init);
    });
    const install = await screen.findByRole<HTMLButtonElement>("button", { name: "Install now" });
    fireEvent.click(install);
    await waitFor(() => expect(install.disabled).toBe(true));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Reboot now" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Repair dpkg" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove unused (1)" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Select openssl" }).disabled).toBe(true);
    fireEvent.click(install);
    expect(posted(fetch)).toHaveLength(1);
    await act(async () => accept());
    await screen.findByText("Now updating openssl docker-ce ..");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Return to package list" }).disabled).toBe(true);
    expect(screen.getByText(/You can leave this page/)).toBeTruthy();
  });

  it("keeps an accepted update locked after navigating away before its response, then unlocks after the recheck", async () => {
    const { fetch, queryClient, rerender, refresh } = show(view());
    const respond = fetch.getMockImplementation()!;
    let accept!: () => void;
    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
    fetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST") await pending;
      return respond(url, init);
    });
    const page = (visible: boolean) => (
      <QueryClientProvider client={queryClient}>
        {visible ? <HostPackages hostId="h1" admin /> : <p>Another page</p>}
      </QueryClientProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Install now" }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(1));
    rerender(page(false));
    expect(fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.signal).toBeUndefined();
    rerender(page(true));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true),
    );
    rerender(page(false));
    await act(async () => accept());
    rerender(page(true));
    await screen.findByText("Now updating openssl docker-ce ..");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true);

    const finished = job({ status: "succeeded", completedAt: Date.now(), packages: ["openssl", "docker-ce"] });
    const checking = job({ id: "j2", action: "check_packages", packages: [] });
    await refresh(view({ running: checking, recent: [checking, finished] }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true);
    await refresh(view({ recent: [{ ...checking, status: "succeeded" }, finished] }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(false),
    );
    expect(posted(fetch)).toHaveLength(1);
  });

  it.each(["pending", "delivered"] as const)(
    "recovers a %s job from server state on a fresh page and unlocks after failure",
    async (status) => {
      const running = job({ status });
      const { refresh } = show(view({ running, recent: [running] }));
      await screen.findByText("Now updating openssl ..");
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true);
      await refresh(
        view({ recent: [{ ...running, status: "failed", outcome: "The package manager refused the update." }] }),
      );
      await waitFor(() =>
        expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(false),
      );
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Return to package list" }).disabled).toBe(false);
    },
  );

  it("observes an accepted job after its POST response is lost instead of offering another update", async () => {
    const { fetch } = show(view());
    const respond = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      const response = await respond(url, init);
      if (init?.method === "POST") throw new TypeError("Connection closed after acceptance");
      return response;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Install now" }));
    await screen.findByText("Now updating openssl docker-ce ..");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true);
    expect(posted(fetch)).toHaveLength(1);
  });

  it("keeps controls locked when both acceptance and status responses are lost, until fresh status confirms completion", async () => {
    const { fetch, queryClient, refresh, served } = show(view());
    const respond = fetch.getMockImplementation()!;
    let offline = false;
    fetch.mockImplementation(async (url, init) => {
      if (offline) throw new TypeError("Offline");
      const response = await respond(url, init);
      if (init?.method === "POST") {
        offline = true;
        throw new TypeError("Response lost");
      }
      return response;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Install now" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true);
    offline = false;
    await refresh(served.view);
    await screen.findByText("Now updating openssl docker-ce ..");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(true);
    await refresh(view({ recent: [job({ status: "succeeded" })] }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install now" }).disabled).toBe(false),
    );
    expect(posted(fetch)).toHaveLength(1);
  });

  it("shows the update as a terminal does: what it updates, the command, the output as it grows, how it ended", async () => {
    const { refresh } = show(view());

    fireEvent.click(await screen.findByRole("button", { name: "Install now" }));
    expect(await screen.findByText("Now updating openssl docker-ce ..")).toBeTruthy();
    const command = HOST_PACKAGE_COMMANDS.apt.upgrade(["openssl", "docker-ce"]).join(" ");
    expect(screen.getByText(`Installing package(s) with command ${command} ..`)).toBeTruthy();
    expect(screen.getByText("Waiting for the host's runner to start it…").className).toBe("log terminal");

    const started = job({
      status: "delivered",
      packages: ["openssl", "docker-ce"],
      output: "Unpacking openssl (3.0.13-2) ...",
    });
    await refresh(view({ running: started, recent: [started] }));
    expect((await screen.findByText("Unpacking openssl (3.0.13-2) ...")).tagName).toBe("PRE");

    const finished = {
      ...started,
      status: "succeeded" as const,
      completedAt: Date.now(),
      outcome: "Upgraded openssl, docker-ce.",
    };
    const recheck = job({
      id: "j2",
      action: "check_packages",
      requestedBy: "Autoheal",
      packages: [],
      createdAt: Date.now() + 1,
    });
    await refresh(view({ running: recheck, recent: [recheck, finished] }));
    expect(await screen.findByText(".. install complete Upgraded openssl, docker-ce.")).toBeTruthy();
    expect(screen.getByText("Re-fetching available packages ..")).toBeTruthy();

    await refresh(view({ packages: [], recent: [{ ...recheck, status: "succeeded" }, finished] }));
    expect(await screen.findByText("Re-fetching available packages .. done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to package list" }));
    expect(await screen.findByText("All installed packages are up to date.")).toBeTruthy();
  });

  it("follows an update Autoheal started, and says how one failed", async () => {
    const nightly = job({ status: "delivered", requestedBy: "Autoheal", output: "Unpacking openssl ..." });
    const { refresh } = show(view({ running: nightly, recent: [nightly] }));

    expect(await screen.findByText("Now updating openssl ..")).toBeTruthy();
    await refresh(
      view({
        recent: [
          {
            ...nightly,
            status: "failed",
            outcome: "It failed: E: Sub-process /usr/bin/dpkg returned an error code (1)",
          },
        ],
      }),
    );
    expect(await screen.findByText(/^\.\. It failed: E: Sub-process/)).toBeTruthy();
  });

  it("lets an admin tick and install where the host lists its updates, and offers nothing to a viewer", async () => {
    const { fetch } = show(view({ facts: facts({ setting: "check" }), automatic: [] }));
    expect(await screen.findByText(/Tick what to install and install it from here/)).toBeTruthy();
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Install now/ }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(1));
    expect(posted(fetch)[0]).toMatchObject({ action: "upgrade_packages" });
    cleanup();

    show(view(), false);
    expect(await screen.findByRole("button", { name: "openssl" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("offers to remove what nothing needs any more, naming it first", async () => {
    const { fetch } = show(view({ removable: [{ name: "linux-image-6.8.0-85-generic", installed: "6.8.0-85.85" }] }));

    expect(await screen.findByText(/No longer needed \(1\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove unused (1)" }));

    expect(screen.getByRole("group", { name: /linux-image-6\.8\.0-85-generic 6\.8\.0-85\.85/ })).toBeTruthy();
    expect(posted(fetch)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
    await waitFor(() => expect(posted(fetch)).toEqual([{ action: "autoremove_packages", packages: [] }]));
  });

  it("keeps this week's changes and the release's support behind a link, and warns when support is short or over", async () => {
    show(view());
    fireEvent.click(await screen.findByRole("button", { name: "What changed this week" }));
    expect(screen.getByText(/upgraded curl 8.5.0-2ubuntu10.6/)).toBeTruthy();
    expect(screen.getByText("2 package updates are available.")).toBeTruthy();
    expect(
      screen.getByText(/^Ubuntu 24\.04 gets security fixes until .*2029\. Support dates as of .*2026\.$/),
    ).toBeTruthy();
    cleanup();

    show(
      view({
        lifecycle: {
          release: "Proxmox VE 8",
          status: "unsupported",
          securityUntil: "2026-08-31",
          extendedUntil: null,
          datesAsOf: "2026-10-22",
        },
      }),
    );
    const warning = await screen.findByText(
      /^Proxmox VE 8 gets no security fixes any more: move to a newer release\. Support dates as of .*2026\.$/,
    );
    expect(warning.className).toBe("notice error");
  });

  it("speaks of dnf-automatic on a dnf host, and leaves out apt's history", async () => {
    show(
      view({
        facts: facts({ manager: "dnf", unattendedUpgrades: true, recentChanges: [] }),
        automatic: [],
        unattended: ["openssl"],
      }),
    );

    expect(await screen.findByText(/dnf-automatic installs updates here by itself/)).toBeTruthy();
    const openssl = screen.getByRole("button", { name: "openssl" }).closest("li")!;
    fireEvent.click(within(openssl).getByRole("button", { name: "openssl" }));
    expect(openssl.textContent).toContain("dnf-automatic");
    fireEvent.click(screen.getByRole("button", { name: "What changed this week" }));
    expect(screen.queryByText("What apt changed this week")).toBeNull();
  });

  it("says how to let Autoheal list the updates where the host's .env keeps its packages off", async () => {
    show(view({ facts: facts({ setting: "off" }), checkedAt: null, packages: [], automatic: [], forPerson: [] }));

    expect(await screen.findByText(/add HOST_PACKAGES=check to this host's .env/)).toBeTruthy();
    expect(screen.queryByText("Not checked yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
  });

  it("says when the host's first check is under way", async () => {
    const checking = job({ action: "check_packages", status: "delivered", requestedBy: "Autoheal", packages: [] });
    show(view({ checkedAt: null, packages: [], automatic: [], forPerson: [], running: checking, recent: [checking] }));

    expect(await screen.findByText("Checking this host's packages for the first time…")).toBeTruthy();
  });

  it("says why when the host's packages are out of reach", async () => {
    show(view({ facts: facts({ unsupported: "no_systemd" }), packages: [], automatic: [], forPerson: [] }));
    expect(
      await screen.findByText("This host was not booted by systemd, which runs Autoheal's package jobs."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
  });
});

describe("the reboot warning", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const warning = (admin: boolean) => <RebootWarning hostId="h1" hostLabel="Alder" admin={admin} />;

  it("says a reboot waits, and reboots once asked twice", async () => {
    const { fetch } = show(view({ facts: facts({ rebootPackages: ["libc6"] }) }), true, warning(true));

    expect(await screen.findByText(/^Warning! Recent package updates/)).toBeTruthy();
    expect(screen.getByText("It waits for libc6. Kernel 6.8.0-90-generic starts at the next boot.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reboot now" }));

    expect(screen.getByRole("group", { name: /Reboot Alder now\?/ })).toBeTruthy();
    expect(posted(fetch)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
    await waitFor(() => expect(posted(fetch)).toEqual([{ action: "reboot", packages: [] }]));
  });

  it("shows whenever the host says one is needed, hides when asked, and offers no reboot to a viewer", async () => {
    show(view({ rebootRequired: true, facts: facts({ kernelWaiting: null }) }), false, warning(false));

    expect(await screen.findByText(/^Warning! Recent package updates/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reboot now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide alert" }));
    expect(screen.queryByText(/^Warning!/)).toBeNull();
  });

  it("says what became of the reboot asked for since the last check, and forgets an older one", async () => {
    const checkedAt = Date.now() - 60_000;
    const refused = job({
      id: "reboot-now",
      action: "reboot",
      status: "failed",
      createdAt: checkedAt + 1,
      outcome: "Not rebooting: a Proxmox backup is running on this node.",
    });
    const older = job({
      id: "reboot-before",
      action: "reboot",
      status: "succeeded",
      createdAt: checkedAt - 1,
      outcome: "Rebooting the host now.",
    });
    show(view({ rebootRequired: true, checkedAt, recent: [refused, older] }), true, warning(true));
    expect(await screen.findByText("Not rebooting: a Proxmox backup is running on this node.")).toBeTruthy();
    cleanup();

    show(view({ rebootRequired: true, checkedAt, recent: [older] }), true, warning(true));
    expect(await screen.findByText(/^Warning! Recent package updates/)).toBeTruthy();
    expect(screen.queryByText("Rebooting the host now.")).toBeNull();
  });

  it("says nothing while no reboot waits", async () => {
    const { fetch } = show(view({ facts: facts({ kernelWaiting: null }) }), true, warning(true));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/^Warning!/)).toBeNull();
  });
});
