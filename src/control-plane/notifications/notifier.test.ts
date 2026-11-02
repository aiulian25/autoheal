import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskPriority, WebhookFormat } from "../../shared/constants.js";
import { Notifier, type NotificationChannels } from "./notifier.js";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const CHANNELS: NotificationChannels = {
  gotify: { url: "https://gotify.home.lan", token: "gotify-app-token" },
  ntfy: { url: "https://ntfy.home.lan", topic: "autoheal", token: "ntfy-access-token" },
  webhook: null,
};

function notifierWith(failing = false, channels: () => NotificationChannels = () => CHANNELS) {
  const sent: Sent[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    if (failing) {
      throw new Error("connect ECONNREFUSED");
    }
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const notifier = new Notifier(channels, "https://autoheal.home.lan/", fakeFetch);
  return { notifier, sent };
}

const task = (priority: TaskPriority) => ({
  id: "4b4e2a7a-0000-4000-8000-000000000001",
  number: 12,
  title: "tika crashed on Alder",
  description: "apache/tika:3 is exited (exit 1).",
  priority,
});

describe("Notifier", () => {
  it("pushes a new task to Gotify and ntfy, and a tap opens the task", async () => {
    const { notifier, sent } = notifierWith();
    await notifier.taskOpened(task("high"), false);
    const link = "https://autoheal.home.lan/tasks/4b4e2a7a-0000-4000-8000-000000000001";
    expect(sent).toEqual([
      {
        url: "https://gotify.home.lan/message",
        headers: expect.objectContaining({ "x-gotify-key": "gotify-app-token" }),
        body: {
          title: "#12 tika crashed on Alder",
          message: "apache/tika:3 is exited (exit 1).",
          priority: 8,
          extras: { "client::notification": { click: { url: link } } },
        },
      },
      {
        url: "https://ntfy.home.lan",
        headers: expect.objectContaining({ authorization: "Bearer ntfy-access-token" }),
        body: {
          topic: "autoheal",
          title: "#12 tika crashed on Alder",
          message: "apache/tika:3 is exited (exit 1).",
          priority: 4,
          tags: ["warning"],
          icon: "https://autoheal.home.lan/brand/autoheal-192.png",
          click: link,
          actions: [{ action: "view", label: "Open task", url: link }],
        },
      },
    ]);
  });

  it("lists low tasks without pushing them, and says calmly that a task is over only when it was worth waking for", async () => {
    const { notifier, sent } = notifierWith();
    await notifier.taskOpened(task("low"), false);
    await notifier.taskResolved(task("medium"));
    expect(sent).toEqual([]);
    await notifier.taskOpened(task("medium"), true);
    await notifier.taskResolved(task("urgent"));
    expect(sent.map(({ body }) => [body.title, body.priority, body.tags])).toEqual([
      ["#12 again: tika crashed on Alder", 5, undefined],
      ["#12 again: tika crashed on Alder", 3, ["wrench"]],
      ["#12 resolved: tika crashed on Alder", 5, undefined],
      ["#12 resolved: tika crashed on Alder", 3, ["white_check_mark"]],
    ]);
    expect(sent.at(-1)?.body.message).toBe("The problem cleared on its own; the task is closed.");
  });

  it("says how Autoheal ended a task it closed itself", async () => {
    const { notifier, sent } = notifierWith();
    await notifier.taskResolved(task("high"), "Removed the unused images: / is now 71% full.");
    expect(sent.map(({ body }) => body.message)).toEqual([
      "Removed the unused images: / is now 71% full.",
      "Removed the unused images: / is now 71% full.",
    ]);
  });

  it("never throws when a channel is down", async () => {
    const { notifier } = notifierWith(true);
    await expect(notifier.taskOpened(task("urgent"), false)).resolves.toBeUndefined();
  });

  it("tells everyone about an incident a runner handled, loudly only when it needs someone", async () => {
    const { notifier, sent } = notifierWith();
    const notice = {
      containerName: "tika",
      verdict: "needs you" as const,
      outcome: "Needs you, nothing was changed.",
      diagnosis: "It keeps failing on a missing setting.",
      stateSummary: "status=exited exit_code=1",
      incidentId: "6f1c9a1e-0000-4000-8000-000000000000",
    };
    await notifier.incidentHandled("Alder", notice);
    await notifier.incidentHandled("Alder", { ...notice, verdict: "restarted", incidentId: null });
    const link = "https://autoheal.home.lan/incidents/6f1c9a1e-0000-4000-8000-000000000000";
    expect(sent.map(({ body }) => [body.title, body.priority, body.click ?? body.extras])).toEqual([
      ["Autoheal Alder: tika needs you", 8, { "client::notification": { click: { url: link } } }],
      ["Autoheal Alder: tika needs you", 4, link],
      [
        "Autoheal Alder: tika restarted",
        5,
        { "client::notification": { click: { url: "https://autoheal.home.lan/" } } },
      ],
      ["Autoheal Alder: tika restarted", 3, "https://autoheal.home.lan/"],
    ]);
    expect(sent[0]!.body.message).toContain(link);
  });

  it("shapes a webhook's message for any receiver, for Discord and for Slack, with its token only when it has one", async () => {
    const link = "https://autoheal.home.lan/tasks/4b4e2a7a-0000-4000-8000-000000000001";
    const hook =
      (format: WebhookFormat, token: string | null = null) =>
      () => ({
        gotify: null,
        ntfy: null,
        webhook: { url: "https://hooks.home.lan/autoheal", token, format },
      });
    const json = notifierWith(false, hook("json", "receiver-token"));
    await json.notifier.taskOpened(task("high"), false);
    expect(json.sent).toEqual([
      {
        url: "https://hooks.home.lan/autoheal",
        headers: expect.objectContaining({ authorization: "Bearer receiver-token" }),
        body: {
          title: "#12 tika crashed on Alder",
          message: "apache/tika:3 is exited (exit 1).",
          priority: "high",
          link,
        },
      },
    ]);

    // A long title is cut to what Discord takes, and nothing in it may ping anyone.
    const discord = notifierWith(false, hook("discord"));
    await discord.notifier.taskOpened({ ...task("high"), title: `@everyone ${"x".repeat(300)}` }, false);
    const [toDiscord] = discord.sent;
    expect(toDiscord!.headers).not.toHaveProperty("authorization");
    expect(toDiscord!.body).toEqual({
      allowed_mentions: { parse: [] },
      embeds: [
        { title: `#12 @everyone ${"x".repeat(242)}`, description: "apache/tika:3 is exited (exit 1).", url: link },
      ],
    });

    const slack = notifierWith(false, hook("slack"));
    await slack.notifier.taskOpened({ ...task("high"), title: "a <b>", description: "exit 1 & <restart>" }, false);
    expect(slack.sent[0]!.body).toEqual({ text: `*<${link}|#12 a &lt;b&gt;>*\nexit 1 &amp; &lt;restart&gt;` });
  });

  it("reads the channels at each send, and a test says what went wrong, on one channel only", async () => {
    let channels: NotificationChannels = { gotify: null, ntfy: null, webhook: null };
    const { notifier, sent } = notifierWith(false, () => channels);
    await notifier.taskOpened(task("urgent"), false);
    expect(sent).toEqual([]);

    channels = CHANNELS;
    await expect(notifier.test("ntfy")).resolves.toBeNull();
    expect(sent.map(({ url, body }) => [url, body.title])).toEqual([["https://ntfy.home.lan", "Autoheal test"]]);
    await expect(notifierWith(true).notifier.test("gotify")).resolves.toBe(
      "The notification server could not be reached.",
    );
  });
});

afterEach(() => vi.restoreAllMocks());
describe("bounded notification delivery observations", () => {
  it("starts unknown, never tests while reading health, and records refusal, timeout and later acceptance", async () => {
    let now = 100;
    let result: "refused" | "timeout" | "accepted" = "refused";
    const privateText = "SyntheticPrivateToken https://secret.test/?token=private";
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    const request = vi.fn<typeof fetch>(async () => {
      if (result === "timeout") throw new DOMException(privateText, "TimeoutError");
      return new Response(privateText, { status: result === "refused" ? 401 : 200 });
    });
    const notifier = new Notifier(
      () => CHANNELS,
      "https://autoheal.test",
      request,
      () => now,
    );
    expect(notifier.delivery("gotify")).toEqual({
      status: "unknown",
      lastAttemptAt: null,
      lastSuccessAt: null,
      failureCode: null,
    });
    expect(request).not.toHaveBeenCalled();
    expect(await notifier.test("gotify")).toBe("it answered HTTP 401");
    expect(notifier.delivery("gotify")).toEqual({
      status: "degraded",
      lastAttemptAt: 100,
      lastSuccessAt: null,
      failureCode: "refused",
    });
    now = 200;
    result = "timeout";
    expect(await notifier.test("gotify")).toBe("The notification request timed out.");
    expect(notifier.delivery("gotify")).toMatchObject({
      status: "degraded",
      lastAttemptAt: 200,
      failureCode: "timeout",
    });
    now = 300;
    result = "accepted";
    expect(await notifier.test("gotify")).toBeNull();
    expect(notifier.delivery("gotify")).toEqual({
      status: "healthy",
      lastAttemptAt: 300,
      lastSuccessAt: 300,
      failureCode: null,
    });
    now = 400;
    result = "refused";
    await notifier.test("gotify");
    expect(notifier.delivery("gotify")).toEqual({
      status: "degraded",
      lastAttemptAt: 400,
      lastSuccessAt: 300,
      failureCode: "refused",
    });
    expect(notifier.delivery("ntfy").status).toBe("unknown");
    expect(JSON.stringify([printed.mock.calls, notifier.delivery("gotify")])).not.toContain(privateText);
    expect(JSON.stringify(notifier.delivery("gotify"))).not.toContain("gotify-app-token");
  });

  it("redacts error messages, causes and non-Error throws", async () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const failure of [new Error("private-token", { cause: new Error("private-token") }), "private-token"]) {
      const notifier = new Notifier(
        () => CHANNELS,
        "https://autoheal.test",
        async () => {
          throw failure;
        },
      );
      expect(await notifier.test("ntfy")).toBe("The notification server could not be reached.");
      expect(notifier.delivery("ntfy")).toMatchObject({ status: "degraded", failureCode: "unreachable" });
    }
    expect(JSON.stringify(printed.mock.calls)).not.toContain("private-token");
  });

  it("drops observations for changed credentials, endpoints and topics without retaining historical configurations", async () => {
    let channels = CHANNELS;
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const notifier = new Notifier(() => channels, "https://autoheal.test", request);
    await notifier.test("gotify");
    await notifier.test("ntfy");
    channels = { ...channels, gotify: { ...channels.gotify!, token: "new-private-token" } };
    expect(notifier.delivery("gotify").status).toBe("unknown");
    expect(notifier.delivery("ntfy").status).toBe("healthy");
    await notifier.test("gotify");
    channels = {
      ...channels,
      gotify: { ...channels.gotify!, url: "https://other.test" },
      ntfy: { ...channels.ntfy!, topic: "other" },
    };
    expect(notifier.delivery("gotify").status).toBe("unknown");
    expect(notifier.delivery("ntfy").status).toBe("unknown");
    // A webhook's format is part of its setup.
    channels = { ...channels, webhook: { url: "https://hooks.test", token: null, format: "json" } };
    await notifier.test("webhook");
    expect(notifier.delivery("webhook").status).toBe("healthy");
    channels = { ...channels, webhook: { ...channels.webhook!, format: "slack" } };
    expect(notifier.delivery("webhook").status).toBe("unknown");
    channels = { gotify: null, ntfy: null, webhook: null };
    expect(notifier.delivery("gotify").status).toBe("unknown");
    notifier.reset();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not let an older success replace a newer failure, or a reset configuration inherit a pending result", async () => {
    let now = 1;
    const releases: ((response: Response) => void)[] = [];
    const notifier = new Notifier(
      () => CHANNELS,
      "https://autoheal.test",
      () => new Promise((resolve) => releases.push(resolve)),
      () => now,
    );
    const first = notifier.test("gotify");
    now = 2;
    const second = notifier.test("gotify");
    releases[1]!(new Response(null, { status: 403 }));
    await second;
    now = 3;
    releases[0]!(new Response(null, { status: 200 }));
    await first;
    expect(notifier.delivery("gotify")).toEqual({
      status: "degraded",
      lastAttemptAt: 2,
      lastSuccessAt: 3,
      failureCode: "refused",
    });
    const old = notifier.test("gotify");
    notifier.reset("gotify");
    expect(notifier.delivery("gotify").status).toBe("unknown");
    releases[2]!(new Response(null, { status: 200 }));
    await old;
    expect(notifier.delivery("gotify")).toEqual({
      status: "unknown",
      lastAttemptAt: null,
      lastSuccessAt: null,
      failureCode: null,
    });
    now = 4;
    const older = notifier.test("gotify");
    now = 5;
    const newer = notifier.test("gotify");
    releases[4]!(new Response(null, { status: 200 }));
    await newer;
    releases[3]!(new Response(null, { status: 401 }));
    await older;
    expect(notifier.delivery("gotify")).toEqual({
      status: "healthy",
      lastAttemptAt: 5,
      lastSuccessAt: 5,
      failureCode: null,
    });
  });
});
