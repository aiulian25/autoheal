import { randomUUID } from "node:crypto";
import { channelFingerprint, type DeliveryService } from "./delivery-service.js";
import type { DeliveryContext } from "../../shared/notification-deliveries.js";
import type { GotifySettings, NtfySettings, WebhookSettings } from "../../config/shared-settings.js";
import {
  BEARER_PREFIX,
  DISCORD_TITLE_LIMIT,
  SLACK_ESCAPES,
  SLACK_MESSAGE,
  WEBHOOK_FORMAT,
  VERDICT_ESCALATED,
  BRAND_ASSETS,
  GOTIFY_CLICK_EXTRA,
  GOTIFY_MESSAGE_PATH,
  GOTIFY_PRIORITY,
  GOTIFY_TOKEN_HEADER,
  INCIDENT_NOTICE_PRIORITY,
  INTEGRATION_KIND,
  JSON_CONTENT_TYPE,
  NOTIFY_CHANNELS,
  NOTIFY_FROM_PRIORITY,
  NOTIFY_MESSAGE_LIMIT,
  NOTIFY_RESOLVED_PRIORITY,
  NOTIFY_TEXT,
  NOTIFY_TIMEOUT_MILLISECONDS,
  NTFY_PRIORITY,
  NTFY_RESOLVED_TAG,
  NTFY_TAGS,
  NTFY_VIEW_ACTION,
  TASK_LINK,
  TASK_PRIORITIES,
  TASK_PRIORITY,
  type NotificationKind,
  type TaskPriority,
  type WebhookFormat,
  HTTP_HEADERS,
  INCIDENT_LINK,
} from "../../shared/constants.js";
import type { NotificationDeliveryView } from "../../shared/api.js";
import { describeError } from "../../shared/errors.js";
import { sha256Hex } from "../../shared/hash.js";
import { incidentMessage } from "../../shared/incident-message.js";
import { log } from "../../shared/log.js";
import type { IncidentNotice } from "../../shared/protocol.js";
import { joinUrl } from "../../shared/urls.js";

export interface NotifiedTask {
  hostId?: string | null;
  updatedAt?: number;
  id: string;
  number: number;
  title: string;
  description: string;
  priority: TaskPriority;
}

export interface NotificationChannels {
  gotify: GotifySettings | null;
  ntfy: NtfySettings | null;
  webhook: WebhookSettings | null;
}
type ChannelConfig = NonNullable<NotificationChannels[NotificationKind]>;

interface Message {
  title: string;
  body: string;
  priority: TaskPriority;
  // Opened by a tap, and by ntfy's button.
  link: string;
  action: string;
  tag: string;
}

interface DeliveryRecord {
  fingerprint: string;
  attempt: number;
  health: NotificationDeliveryView;
}
const unknownDelivery = (): NotificationDeliveryView => ({
  status: "unknown",
  lastAttemptAt: null,
  lastSuccessAt: null,
  failureCode: null,
});
// One of the channels, for a test or a queued attempt; the others left out.
const only = (channels: NotificationChannels, kind: NotificationKind): NotificationChannels => ({
  gotify: kind === INTEGRATION_KIND.gotify ? channels.gotify : null,
  ntfy: kind === INTEGRATION_KIND.ntfy ? channels.ntfy : null,
  webhook: kind === INTEGRATION_KIND.webhook ? channels.webhook : null,
});

const bearer = (token: string | null): Record<string, string> =>
  token === null ? {} : { [HTTP_HEADERS.authorization]: `${BEARER_PREFIX}${token}` };

const slackText = (words: string) =>
  SLACK_ESCAPES.reduce((escaped, [character, entity]) => escaped.replaceAll(character, entity), words);

// What each receiver takes: plain fields for any of them, an embed for Discord, and a line with its link for Slack.
const WEBHOOK_BODIES: Record<WebhookFormat, (message: Message, text: string) => unknown> = {
  [WEBHOOK_FORMAT.json]: (message, text) => ({
    title: message.title,
    message: text,
    priority: message.priority,
    link: message.link,
  }),
  [WEBHOOK_FORMAT.discord]: (message, text) => ({
    // An alert's words come from containers and people: none of them may ping anyone.
    allowed_mentions: { parse: [] },
    embeds: [{ title: message.title.slice(0, DISCORD_TITLE_LIMIT), description: text, url: message.link }],
  }),
  [WEBHOOK_FORMAT.slack]: (message, text) => ({
    text: SLACK_MESSAGE(message.link, slackText(message.title), slackText(text)),
  }),
};

const atLeast = (priority: TaskPriority, floor: TaskPriority) =>
  TASK_PRIORITIES.indexOf(priority) <= TASK_PRIORITIES.indexOf(floor);

/**
 * Background passes go on when an alert cannot be queued: it is logged here, and the inbox counts the ones a full
 * queue refused. A runner's own notice is refused instead, so the runner can tell people through its own Gotify.
 */
export const logAlertNotQueued = (error: unknown) => log(NOTIFY_TEXT.notQueued(describeError(error)));

/**
 * Pushes to Gotify, ntfy and a webhook: tasks from medium priority up, and every incident a runner handled. A
 * tap opens the task or incident. Titles and a few lines only, never logs. The channels are read at
 * each provider attempt. Routine alerts persist before sending; provider failures remain retryable.
 * A full durable queue rejects visibly instead of silently dropping intent. Explicit channel tests
 * remain immediate and are never retried automatically.
 */
export class Notifier {
  private readonly records = new Map<NotificationKind, DeliveryRecord>();
  constructor(
    private readonly channels: () => NotificationChannels,
    private readonly publicBaseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly outbox?: DeliveryService,
  ) {
    outbox?.useSender(async (kind, message) => {
      const channels = this.channels();
      const config = channels[kind];
      if (config === null) return "not_configured";
      const [problem = null] = await this.sendDirect(only(channels, kind), message);
      return problem === null ? null : (this.recordFor(kind, config).health.failureCode ?? "unreachable");
    });
  }

  /** Reads observations only. Querying health never sends a test or retains credentials in metadata. */
  delivery(kind: NotificationKind): NotificationDeliveryView {
    const config = this.channels()[kind];
    if (config === null) {
      this.reset(kind);
      return unknownDelivery();
    }
    const memory = this.recordFor(kind, config).health;
    const durable = this.outbox?.health(kind);
    return durable?.lastAttemptAt !== null &&
      durable?.lastAttemptAt !== undefined &&
      durable.lastAttemptAt > (memory.lastAttemptAt ?? -1)
      ? durable
      : { ...memory };
  }

  reset(kind?: NotificationKind) {
    if (kind === undefined) this.records.clear();
    else this.records.delete(kind);
  }

  private recordFor(kind: NotificationKind, config: ChannelConfig): DeliveryRecord {
    const key = channelFingerprint(config);
    let record = this.records.get(kind);
    if (record?.fingerprint !== key) {
      record = { fingerprint: key, attempt: 0, health: unknownDelivery() };
      this.records.set(kind, record);
    }
    return record;
  }

  private completed(
    kind: NotificationKind,
    record: DeliveryRecord,
    attempt: number,
    failure: NotificationDeliveryView["failureCode"],
  ) {
    if (this.records.get(kind) !== record) return;
    if (failure === null) record.health.lastSuccessAt = this.clock();
    // Older concurrent requests may contribute acceptance evidence, but cannot replace the latest result.
    if (record.attempt !== attempt) return;
    record.health.status = failure === null ? "healthy" : "degraded";
    record.health.failureCode = failure;
  }

  /** The weekly network report: to whichever channels are set up, not tied to a task. */
  async networkReport(title: string, body: string) {
    await this.send(this.channels(), {
      title,
      body,
      priority: TASK_PRIORITY.low,
      link: `${this.publicBaseUrl}/network`,
      action: title,
      tag: NTFY_TAGS[TASK_PRIORITY.low],
    });
  }

  async taskOpened(task: NotifiedTask, reopened: boolean) {
    if (!atLeast(task.priority, NOTIFY_FROM_PRIORITY)) {
      return;
    }
    const title = reopened
      ? NOTIFY_TEXT.reopened(task.number, task.title)
      : NOTIFY_TEXT.opened(task.number, task.title);
    await this.send(
      this.channels(),
      {
        title,
        body: task.description,
        priority: task.priority,
        link: TASK_LINK(this.publicBaseUrl, task.id),
        action: NOTIFY_TEXT.openTask,
        tag: NTFY_TAGS[task.priority],
      },
      {
        key: `task:${task.id}:${task.updatedAt ?? sha256Hex(JSON.stringify([task.title, task.description]))}:${reopened ? "reopened" : "opened"}`,
        kind: reopened ? "task_reopened" : "task_opened",
        resourceKind: "task",
        resourceId: task.id,
        hostId: task.hostId,
      },
    );
  }

  /** Only what was worth waking someone for is worth saying it is over: by itself, or how Autoheal ended it. */
  async taskResolved(task: NotifiedTask, body: string = NOTIFY_TEXT.resolvedBody) {
    if (!atLeast(task.priority, TASK_PRIORITY.high)) {
      return;
    }
    await this.send(
      this.channels(),
      {
        title: NOTIFY_TEXT.resolved(task.number, task.title),
        body,
        priority: NOTIFY_RESOLVED_PRIORITY,
        link: TASK_LINK(this.publicBaseUrl, task.id),
        action: NOTIFY_TEXT.openTask,
        tag: NTFY_RESOLVED_TAG,
      },
      {
        key: `task:${task.id}:${task.updatedAt ?? sha256Hex(body)}:resolved`,
        kind: "task_resolved",
        resourceKind: "task",
        resourceId: task.id,
        hostId: task.hostId,
      },
    );
  }

  /** A runner handled an incident: worded as the runner would, on every channel set up here. */
  async incidentHandled(
    hostLabel: string,
    notice: IncidentNotice,
    context: { hostId?: string; notificationKey?: string } = {},
  ) {
    const message = incidentMessage(hostLabel, notice, this.publicBaseUrl);
    const priority = INCIDENT_NOTICE_PRIORITY[notice.verdict];
    await this.send(
      this.channels(),
      {
        title: message.title,
        body: message.body,
        priority,
        link: message.link ?? this.publicBaseUrl,
        action: NOTIFY_TEXT.openIncident,
        tag: NTFY_TAGS[priority],
      },
      {
        key:
          context.notificationKey ??
          (notice.incidentId
            ? `incident:${notice.incidentId}:${notice.verdict}:${sha256Hex(notice.outcome)}`
            : randomUUID()),
        resolved: notice.verdict !== VERDICT_ESCALATED,
        kind: "incident_handled",
        resourceKind: notice.incidentId ? "incident" : "system",
        resourceId: notice.incidentId,
        hostId: context.hostId,
      },
    );
  }

  /** An escalation woke someone, so its settling by itself is said too, quietly: nothing is left to decide. */
  async incidentCleared(
    hostLabel: string,
    incident: { id: string; containerName: string; hostId?: string },
    outcome: string,
  ) {
    await this.send(
      this.channels(),
      {
        title: NOTIFY_TEXT.cleared(hostLabel, incident.containerName),
        body: outcome,
        priority: NOTIFY_RESOLVED_PRIORITY,
        link: INCIDENT_LINK(this.publicBaseUrl, incident.id),
        action: NOTIFY_TEXT.openIncident,
        tag: NTFY_RESOLVED_TAG,
      },
      {
        key: `incident:${incident.id}:cleared`,
        kind: "incident_cleared",
        resourceKind: "incident",
        resourceId: incident.id,
        hostId: incident.hostId,
      },
    );
  }

  /** "Send a test" in Settings: what went wrong, or null when the channel took the message. */
  async test(kind: NotificationKind): Promise<string | null> {
    const [problem = null] = await this.send(only(this.channels(), kind), {
      title: NOTIFY_TEXT.testTitle,
      body: NOTIFY_TEXT.testBody,
      priority: NOTIFY_FROM_PRIORITY,
      link: this.publicBaseUrl,
      action: NOTIFY_TEXT.openTask,
      tag: NTFY_TAGS[NOTIFY_FROM_PRIORITY],
    });
    return problem;
  }

  private send(
    channels: NotificationChannels,
    message: Message,
    context?: DeliveryContext,
  ): Promise<(string | null)[]> {
    if (this.outbox && context) {
      this.outbox.enqueue(context, message);
      return Promise.resolve([]);
    }
    return this.sendDirect(channels, message);
  }
  private sendDirect({ gotify, ntfy, webhook }: NotificationChannels, message: Message): Promise<(string | null)[]> {
    const text = message.body.slice(0, NOTIFY_MESSAGE_LIMIT);
    const deliveries: Promise<string | null>[] = [];
    if (gotify !== null) {
      deliveries.push(
        this.post(
          INTEGRATION_KIND.gotify,
          gotify,
          joinUrl(gotify.url, GOTIFY_MESSAGE_PATH),
          { [GOTIFY_TOKEN_HEADER]: gotify.token },
          {
            title: message.title,
            message: text,
            priority: GOTIFY_PRIORITY[message.priority],
            extras: { [GOTIFY_CLICK_EXTRA]: { click: { url: message.link } } },
          },
        ),
      );
    }
    if (ntfy !== null) {
      deliveries.push(
        this.post(INTEGRATION_KIND.ntfy, ntfy, ntfy.url, bearer(ntfy.token), {
          topic: ntfy.topic,
          title: message.title,
          message: text,
          priority: NTFY_PRIORITY[message.priority],
          tags: [message.tag],
          // The logo on the notification, which ntfy's app fetches from the dashboard.
          icon: joinUrl(this.publicBaseUrl, BRAND_ASSETS.icon),
          click: message.link,
          actions: [{ action: NTFY_VIEW_ACTION, label: message.action, url: message.link }],
        }),
      );
    }
    if (webhook !== null) {
      deliveries.push(
        this.post(
          INTEGRATION_KIND.webhook,
          webhook,
          webhook.url,
          bearer(webhook.token),
          WEBHOOK_BODIES[webhook.format](message, text),
        ),
      );
    }
    return Promise.all(deliveries);
  }

  private async post(
    kind: NotificationKind,
    config: ChannelConfig,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ) {
    const record = this.recordFor(kind, config);
    const attempt = ++record.attempt;
    record.health = { ...record.health, status: "unknown", lastAttemptAt: this.clock(), failureCode: null };
    const signal = AbortSignal.timeout(NOTIFY_TIMEOUT_MILLISECONDS);
    try {
      const response = await this.fetchImplementation(url, {
        method: "POST",
        headers: { [HTTP_HEADERS.contentType]: JSON_CONTENT_TYPE, ...headers },
        body: JSON.stringify(body),
        signal,
      });
      // Neither response bodies nor exceptions belong in health metadata or diagnostic output.
      void response.body?.cancel().catch(() => undefined);
      this.completed(kind, record, attempt, response.ok ? null : "refused");
      if (response.ok) return null;
      const problem = NOTIFY_TEXT.refused(response.status);
      log(NOTIFY_TEXT.failed(NOTIFY_CHANNELS[kind], problem));
      return problem;
    } catch (error) {
      const timedOut =
        signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
      this.completed(kind, record, attempt, timedOut ? "timeout" : "unreachable");
      const problem = timedOut ? NOTIFY_TEXT.timeout : NOTIFY_TEXT.unreachable;
      log(NOTIFY_TEXT.failed(NOTIFY_CHANNELS[kind], problem));
      return problem;
    }
  }
}
