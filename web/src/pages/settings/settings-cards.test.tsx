import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type SelfUpdateView } from "../../../../src/shared/api.js";
import { SELF_UPDATE_STATUS, SELF_UPDATE_TEXT } from "../../../../src/shared/constants.js";
import { PATHS, TEXT } from "../../constants.js";
import {
  integration,
  INTEGRATIONS,
  json,
  words,
  RUNNING_IMAGE,
  selfUpdate,
  serve,
  renderSettings,
  sent,
} from "../../test-support/settings-page.js";

describe("the settings page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("connects Home Assistant with its address and a token, which is never shown again", async () => {
    const fetch = serve("admin");
    renderSettings("admin");

    const card = (await screen.findByRole("heading", { name: "Home Assistant" })).closest("section")!;
    fireEvent.change(within(card).getByLabelText(/^Address/), { target: { value: "http://ha.local:8123" } });
    fireEvent.change(within(card).getByLabelText(/^Long-lived token/), { target: { value: "secret-token" } });
    fireEvent.click(within(card).getByRole("button", { name: "Connect" }));

    const path = apiPath(API_ROUTES.integration, { kind: "homeAssistant" });
    await waitFor(() =>
      expect(sent(fetch, "PUT", path)).toEqual([{ url: "http://ha.local:8123", token: "secret-token" }]),
    );
  });

  it("shows observed test acceptance and clears it when the channel configuration is saved again", async () => {
    const fetch = serve("admin");
    const base = fetch.getMockImplementation()!;
    let delivery = {
      status: "unknown" as "unknown" | "healthy",
      lastAttemptAt: null as number | null,
      lastSuccessAt: null as number | null,
      failureCode: null,
    };
    fetch.mockImplementation(async (url, init) => {
      if (url === apiPath(API_ROUTES.integrationTest, { kind: "gotify" }) && init?.method === "POST") {
        delivery = { status: "healthy", lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), failureCode: null };
        return json({ problem: null, delivery });
      }
      if (url === apiPath(API_ROUTES.integration, { kind: "gotify" }) && init?.method === "PUT") {
        delivery = { status: "unknown", lastAttemptAt: null, lastSuccessAt: null, failureCode: null };
        return json(null);
      }
      if (url === API_ROUTES.integrations)
        return json(INTEGRATIONS.map((row) => (row.kind === "gotify" ? { ...row, delivery } : row)));
      return base(url, init);
    });
    renderSettings("admin");
    const row = (await screen.findByText("Gotify")).closest("li")!;
    expect(within(row).getByText("Configured; untested")).toBeTruthy();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(within(row).getByRole("button", { name: "Send a test" }));
    expect(await within(row).findByText(/^Last accepted by server/)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(await within(row).findByText("Configured; untested")).toBeTruthy();
    expect(within(row).queryByText(/^Last accepted by server/)).toBeNull();
  });

  it("does not apply a delayed old test result after the channel has been edited", async () => {
    const fetch = serve("admin");
    const base = fetch.getMockImplementation()!;
    const unknown = { status: "unknown", lastAttemptAt: null, lastSuccessAt: null, failureCode: null };
    let finishTest!: (response: Response) => void;
    let finishRead!: (response: Response) => void;
    let holdReads = false;
    const rows = () => INTEGRATIONS.map((row) => (row.kind === "gotify" ? { ...row, delivery: unknown } : row));
    fetch.mockImplementation(async (url, init) => {
      if (url === apiPath(API_ROUTES.integrationTest, { kind: "gotify" }) && init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finishTest = resolve;
        });
      if (url === API_ROUTES.integrations)
        return holdReads
          ? new Promise<Response>((resolve) => {
              finishRead = resolve;
            })
          : json(rows());
      return base(url, init);
    });
    renderSettings("admin");
    const row = (await screen.findByText("Gotify")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Send a test" }));
    await waitFor(() => expect(finishTest).toBeDefined());
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(row).queryByRole("button", { name: "Save" })).toBeNull());
    holdReads = true;
    await act(async () =>
      finishTest(
        json({ problem: null, delivery: { status: "healthy", lastAttemptAt: 1, lastSuccessAt: 1, failureCode: null } }),
      ),
    );
    await waitFor(() => expect(finishRead).toBeDefined());
    expect(within(row).queryByText(/^Last accepted by server/)).toBeNull();
    expect(within(row).getByText("Configured; untested")).toBeTruthy();
    await act(async () => finishRead(json(rows())));
  });

  it("tests and removes a channel that is set up, and sets one up that is not", async () => {
    const fetch = serve("admin");
    renderSettings("admin");

    const gotify = (await screen.findByText("Gotify")).closest("li")!;
    expect(within(gotify).getByText("https://gotify.example · token set")).toBeTruthy();
    fireEvent.click(within(gotify).getByRole("button", { name: "Send a test" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        apiPath(API_ROUTES.integrationTest, { kind: "gotify" }),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    fireEvent.click(within(gotify).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(gotify).getByRole("button", { name: TEXT.yes }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        apiPath(API_ROUTES.integration, { kind: "gotify" }),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );

    const ntfy = screen.getByText("ntfy").closest("li")!;
    expect(within(ntfy).getByText("Not set up")).toBeTruthy();
    fireEvent.click(within(ntfy).getByRole("button", { name: "Set up ntfy" }));
    expect(within(ntfy).getByLabelText(/^Topic/)).toBeTruthy();
  });

  it("sets up a webhook with its format, and shows its address only up to its host", async () => {
    const webhook = integration({
      kind: "webhook",
      source: "dashboard",
      url: "https://discord.com/…",
      format: "discord",
    });
    const fetch = serve("admin", { [API_ROUTES.integrations]: [...INTEGRATIONS, webhook] });
    renderSettings("admin");

    const row = (await screen.findByText("Webhook")).closest("li")!;
    expect(within(row).getByText("https://discord.com/… · Discord")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    // The address never comes back: its host stands in for it, and it is pasted again.
    const address = within(row).getByLabelText(/^Address/) as HTMLInputElement;
    expect([address.value, address.placeholder]).toEqual(["", "https://discord.com/…"]);
    const format = within(row).getByLabelText("Format") as HTMLSelectElement;
    expect(format.value).toBe("discord");
    expect((within(row).getByLabelText(/^Access token/) as HTMLInputElement).required).toBe(false);
    fireEvent.change(address, { target: { value: "https://hooks.slack.com/services/T/B/key" } });
    fireEvent.change(format, { target: { value: "slack" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent(fetch, "PUT", apiPath(API_ROUTES.integration, { kind: "webhook" }))).toEqual([
        { url: "https://hooks.slack.com/services/T/B/key", format: "slack" },
      ]),
    );
  });

  it("saves the package window's choice as soon as it changes", async () => {
    const fetch = serve("admin");
    renderSettings("admin");

    const tick = await screen.findByRole("checkbox", { name: /Install security fixes on their own/ });
    expect((tick as HTMLInputElement).checked).toBe(true);
    fireEvent.click(tick);

    await waitFor(() =>
      expect(sent(fetch, "PUT", API_ROUTES.hostUpdateSettings)).toEqual([
        { securityInWindow: false, windowStart: "03:00", windowEnd: "05:00" },
      ]),
    );
  });

  it("keeps both times when one is changed right after the other", async () => {
    const fetch = serve("admin");
    // The server keeps what it is sent, as the real one does.
    const answer = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) =>
      init?.method === "PUT" ? json(JSON.parse(String(init.body))) : answer(url, init),
    );
    renderSettings("admin");

    const from = await screen.findByLabelText("From");
    const to = screen.getByLabelText("To");
    fireEvent.change(from, { target: { value: "01:00" } });
    fireEvent.blur(from);
    fireEvent.change(to, { target: { value: "02:00" } });
    fireEvent.blur(to);

    await waitFor(() =>
      expect(sent(fetch, "PUT", API_ROUTES.hostUpdateSettings)).toEqual([
        { securityInWindow: true, windowStart: "01:00", windowEnd: "05:00" },
        { securityInWindow: true, windowStart: "01:00", windowEnd: "02:00" },
      ]),
    );
  });

  it("says there is no off-box copy yet, and how to add one", async () => {
    serve("admin");
    renderSettings("admin");

    expect(await screen.findByText(/^No off-box copy yet\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add an off-box copy" }));
    expect(screen.getByText("OFFBOX_BACKUP_DIRECTORY")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all backups" }).getAttribute("href")).toBe(PATHS.backups);
  });

  it("lists who can sign in and the widget keys, and creates a key", async () => {
    const fetch = serve("admin", {
      [`POST ${API_ROUTES.widgetKeys}`]: {
        key: { id: "k2", name: "phone", scope: "widget", hint: "efgh" },
        secret: "the-secret",
      },
    });
    renderSettings("admin");

    expect((await screen.findByText("1 person")).closest("p")!.textContent).toBe("1 person · admin");
    const keys = screen.getByRole("heading", { name: "Widget and metrics keys" }).closest("section")!;
    expect(within(keys).getByText("homepage")).toBeTruthy();
    expect(within(keys).getByText("Homepage · never used")).toBeTruthy();
    fireEvent.change(within(keys).getByLabelText(/^New key name/), { target: { value: "phone" } });
    fireEvent.click(within(keys).getByRole("button", { name: "Create key" }));

    await waitFor(() =>
      expect(sent(fetch, "POST", API_ROUTES.widgetKeys)).toEqual([{ name: "phone", scope: "widget" }]),
    );
    expect(await within(keys).findByText("the-secret")).toBeTruthy();
    expect(within(keys).getByText(/services\.yaml/)).toBeTruthy();
  });

  it("creates a metrics key, and shows how Prometheus scrapes with it", async () => {
    const fetch = serve("admin", {
      [`POST ${API_ROUTES.widgetKeys}`]: {
        key: { id: "k3", name: "prometheus", scope: "metrics", hint: "wxyz" },
        secret: "ahw_metrics-secret",
      },
    });
    renderSettings("admin");

    const keys = (await screen.findByRole("heading", { name: "Widget and metrics keys" })).closest("section")!;
    fireEvent.change(within(keys).getByLabelText(/^New key name/), { target: { value: "prometheus" } });
    fireEvent.change(within(keys).getByLabelText("Reads"), { target: { value: "metrics" } });
    fireEvent.click(within(keys).getByRole("button", { name: "Create key" }));

    await waitFor(() =>
      expect(sent(fetch, "POST", API_ROUTES.widgetKeys)).toEqual([{ name: "prometheus", scope: "metrics" }]),
    );
    expect(await within(keys).findByText(/^Prometheus reads https:\/\/autoheal\.example\/api\/metrics/)).toBeTruthy();
    const config = within(keys).getByText(/scrape_configs:/).textContent!;
    expect(config).toContain("metrics_path: /api/metrics");
    expect(config).toContain("credentials: ahw_metrics-secret");
    expect(config).toContain('targets: ["autoheal.example"]');
    expect(config).not.toContain("x-api-key");
  });

  it("shows a viewer what is set up, and nothing to change or only admins may see", async () => {
    serve("viewer");
    renderSettings("viewer");

    expect(await screen.findByText("Gotify")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "People and keys" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Backups" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Trusted proxies" })).toBeNull();
    expect(screen.queryByRole("link", { name: "People and keys" })).toBeNull();
    expect(screen.getByRole("link", { name: "Your account" }).getAttribute("href")).toBe(PATHS.account);
  });

  it("lets an update that stopped partway be taken up, and keeps the button off while one really runs", async () => {
    const stopped = (status: "blocked" | "updating") => ({
      ...selfUpdate,
      last: {
        status,
        from: "a",
        to: "b",
        reference: selfUpdate.reference,
        startedAt: 1,
        finishedAt: null,
        message: "It stopped partway.",
      },
    });
    serve("admin", { [API_ROUTES.selfUpdate]: stopped("blocked") });
    renderSettings("admin");
    await screen.findByText(/It stopped partway/);
    expect((screen.getByRole("button", { name: words.update }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    serve("admin", { [API_ROUTES.selfUpdate]: stopped("updating") });
    renderSettings("admin");
    await screen.findByText(/It stopped partway/);
    expect((screen.getByRole("button", { name: words.update }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("updates Autoheal from its System card, and says how it goes", async () => {
    const fetch = serve("admin", {
      [`POST ${API_ROUTES.selfUpdate}`]: {
        ...selfUpdate,
        last: {
          status: SELF_UPDATE_STATUS.updating,
          from: RUNNING_IMAGE,
          to: `sha256:${"b".repeat(64)}`,
          reference: selfUpdate.reference,
          startedAt: Date.now(),
          finishedAt: null,
          message: SELF_UPDATE_TEXT.started,
        },
      } satisfies SelfUpdateView,
    });
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: words.title })).closest("section")!;
    expect(within(card).getByText(words.explanation(selfUpdate.reference))).toBeTruthy();
    // Started on that image 20 minutes ago, however it was updated.
    expect(within(card).getByText(words.runs("aaaaaaaaaaaa", "20 minutes ago"))).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: words.update }));
    await waitFor(() => expect(sent(fetch, "POST", API_ROUTES.selfUpdate)).toHaveLength(1));
    expect(await within(card).findByText(new RegExp(SELF_UPDATE_TEXT.started))).toBeTruthy();
    // Not twice while it goes on.
    expect(within(card).getByRole<HTMLButtonElement>("button", { name: words.update }).disabled).toBe(true);
  });

  it("says why Autoheal cannot update itself where it cannot, with nothing to press", async () => {
    serve("admin", {
      [API_ROUTES.selfUpdate]: { ...selfUpdate, unavailable: SELF_UPDATE_TEXT.noSocket, runningImage: null },
    });
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: words.title })).closest("section")!;
    expect(await within(card).findByText(SELF_UPDATE_TEXT.noSocket)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: words.update })).toBeNull();
  });
});
