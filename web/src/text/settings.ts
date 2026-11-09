import { API_ROUTES, type DataKind, type WidgetView } from "../../../src/shared/api.js";
import {
  type AnyKeyScope,
  BRAND_ASSETS,
  ENV_TRUSTED_PROXY_ADDRESSES,
  type IntegrationKind,
  MILLISECONDS_PER_DAY,
  type SecretSource,
  WIDGET_KEY_HEADER,
  type WebhookFormat,
  type WidgetKeyScope,
} from "../../../src/shared/constants.js";
import { DELIVERY_EVENT_LIMIT, DELIVERY_RETENTION_MILLISECONDS } from "../../../src/shared/notification-deliveries.js";
import { SETTINGS_SECTIONS } from "./basics.js";

// The end of an address, so a path can be added to it without a double slash.
const TRAILING_SLASHES = /\/+$/;

const URL_SCHEME_END = /:$/;

// What Homepage's widget shows, by the field of Autoheal's widget answer it reads.
const WIDGET_MAPPINGS: [keyof WidgetView, string][] = [
  ["hostsOnline", "Hosts up"],
  ["containerProblems", "Problems"],
  ["openTasks", "Tasks"],
  ["updatesAvailable", "Updates"],
];

/** Settings: connections, notifications, Ollama, keys and who may do what. */
export const SETTINGS_TEXT = {
  operatorGrants: {
    title: "Scoped operator access",
    explanation: (username: string) =>
      `Give ${username} specific container actions. Viewing access stays unchanged. Global settings, users, backups ` +
      "and host package actions remain administrator-only.",
    actions: {
      lifecycle: "Start, stop, restart and recreate",
      update: "Update and roll back",
      logs: "Read container logs",
      terminal: "Open a container terminal",
      files: "Browse and edit container files",
      settings: "Edit container settings",
      read: "View inventory (already available to viewers)",
    },
    scopes: { host: "All containers on the host", container: "One container", stack: "One Compose stack" },
    scoped: (scope: string, resource: string) => `${scope}: ${resource}`,
    none: "No delegated actions.",
    remove: "Remove grant",
    add: "Add delegated actions",
    host: "Host",
    chooseHost: "Choose a host",
    scope: "Scope",
    stackName: "Exact Compose project name",
    containerName: "Exact container name",
    addToReview: "Add to review",
    savingEnds:
      "Saving ends this person’s current sessions and closes their container connections. They must sign in again. " +
      "An action affecting dependent containers requires access to every affected member.",
    save: "Save access changes",
    discard: "Discard changes",
    discardAndReload: "Discard changes and reload",
    saved: "Access saved. The person must sign in again.",
  },
  notificationInbox: {
    title: "Notification deliveries",
    explanation:
      "Server accepted means Gotify or ntfy accepted the request; it does not confirm device receipt. Acknowledging " +
      "records human review and stops queued retries and escalation. Message bodies and credentials are excluded " +
      "from this inbox.",
    pending: (count: number) => `${count} channel deliveries pending.`,
    overflow: (count: number) => `${count} alerts could not be enqueued because capacity was reached. Last occurrence:`,
    overflowAfter: ". Review affected tasks and incidents.",
    none: "No captured notification deliveries.",
    open: (kind: string) => `Open ${kind}`,
    acknowledge: "Acknowledge",
    acknowledgedBy: (name: string) => `Acknowledged by ${name}`,
    noChannel:
      "No channel selected or configured when this alert was captured. Configure a channel and routing in Settings " +
      "first.",
    queue: "Queue using current routing",
    columns: {
      channel: "Channel",
      state: "State",
      attempts: "Attempts",
      lastAttempt: "Last attempt",
      accepted: "Server accepted",
      nextAttempt: "Next attempt",
      recovery: "Recovery",
    },
    escalation: "escalation",
    attempts: (made: number, limit: number) => `${made} / ${limit}`,
    retry: "Retry with current channel settings",
    history:
      `History retains up to ${DELIVERY_RETENTION_MILLISECONDS / MILLISECONDS_PER_DAY} days and ` +
      `${DELIVERY_EVENT_LIMIT.toLocaleString("en")} alerts. Interrupted provider requests may produce duplicate ` +
      "device pushes; each logical alert remains one inbox event.",
  },
  notificationRouting: {
    title: "Notification routing and quiet hours",
    explanation:
      "The first matching rule selects the primary channels. Without a match, configured channels receive alerts as " +
      "before. Rules apply to new alerts; queued alerts retain their captured rule. Quiet hours use UTC. Urgent " +
      "override permits urgent alerts during quiet hours. Escalation sends once to the selected channel after the " +
      "first permitted send slot if nobody acknowledges.",
    rules: "Routing rules",
    rule: (number: number) => `Rule ${number}`,
    host: "Host",
    allHosts: "All hosts",
    severity: "Severity",
    primaryChannels: "Primary channels (none suppresses primary sends)",
    quietHours: "Quiet hours (UTC)",
    quietFrom: "Quiet from",
    quietUntil: "Quiet until",
    urgentOverride: "Urgent alerts override quiet hours",
    escalateOnce: "Escalate once if unacknowledged",
    escalateAfter: "Escalate after minutes",
    escalationChannels: "Escalation channels",
    moveUp: "Move up",
    remove: "Remove rule",
    add: "Add routing rule",
    save: "Save routing",
    invalid:
      "Choose at least one severity, different quiet start/end times and an escalation channel when escalation is " +
      "enabled.",
    saved: "Notification routing saved.",
  },
  ollama: {
    title: "Ollama",
    reachable: "answering",
    unreachable: "not answering",
    missing: (model: string) => `${model} missing`,
  },
  settings: {
    configured: "Configured",
    notConfigured: "Not configured",
    madeBy: {
      certificate: { autoheal: "Made by Autoheal, renewed by itself", operator: "Your own, from the .env" },
      passphrase: {
        autoheal: "Made by Autoheal",
        operator: "From the .env",
      },
    } satisfies Record<string, Record<SecretSource, string>>,
    passphraseAgain:
      "Lost the backup passphrase? This prints it again, on this machine, in the folder of its compose file:",
    passphraseCommand: "docker compose run --rm control-plane backup-passphrase",
  },
  settingsPage: {
    invalidSettings: (names: string) =>
      `Saved settings for ${names} could not be read. Environment values or defaults are in use. Save the affected settings again, or restore them from a verified configuration backup.`,
    settingNames: {
      "integration.gotify": "Gotify",
      "integration.jarvis": "Jarvis",
      "integration.jarvis_aliases": "Jarvis names",
      "integration.ntfy": "ntfy",
      "integration.home_assistant": "Home Assistant",
      "integration.webhook": "Webhook",
      "integration.ollama": "Ollama",
      "integration.ollama_review_server": "Ollama server for the Home Assistant review",
      "integration.ollama_default_name": "Name of the default Ollama server",
      "integration.ollama_router_server": "Ollama server for the network",
      "integration.router": "Router",
      "integration.container_backup": "Container backups",
      "integration.router_contract": "Contract speeds",
      "runners.address": "the runner address",
      "backups.passphrase_shown_at": "the backup passphrase notice",
      host_updates: "host updates",
      "network.trusted_proxies": "trusted proxies",
    },
    title: "Settings",
    nav: {
      label: "Settings sections",
      connections: "Connections",
      notifications: "Notifications",
      schedules: "Schedules",
      backups: "Backups",
      people: "People and keys",
      system: "System",
      account: "Your account",
    } satisfies Record<keyof typeof SETTINGS_SECTIONS | "label", string>,
    sections: {
      connections: { title: "Connections", lede: "What Autoheal thinks with, and what else it watches." },
      notifications: { title: "Notifications", lede: "Where Autoheal tells you about tasks and incidents." },
      schedules: { title: "Schedules", lede: "When Autoheal does the slow, routine work." },
      backups: {
        title: "Backups",
        lede: "The database, copied daily, encrypted with age and checked after every run.",
      },
      people: { title: "People and keys", lede: "Who can sign in, and keys for other apps." },
      system: {
        title: "System",
        lede: "Read from the control plane's .env, except trusted proxies, which can be set here too. Secrets are never shown.",
      },
    },
    ollama: {
      model: "Model",
      address: "Address",
      context: "Context",
      contextTokens: (tokens: string) => `${tokens} tokens`,
      loadedNow: "Loaded now",
      noModel: "no model",
      available: (count: number) => `${count} available`,
      plainHttp: "Plain http. Anyone on the way can read the redacted reports and answer in Ollama's place. Use https.",
      itSays: "It says",
      thinks: "thinks before it answers",
      answersStraight: "answers without thinking first",
      cannotAnswer: "cannot answer questions",
      readsUpTo: (tokens: string) => `reads up to ${tokens} tokens`,
      fromEnvironment: "From the .env. Changing it here overrides it, without a restart.",
      fromDashboard: "Chosen here; the .env's is the fallback.",
      change: "Change",
      useEnvironment: "Use the .env's",
      useEnvironmentConfirm: "Go back to the Ollama the .env sets?",
      modelHint: "Every model that Ollama server has. Pick one.",
      modelsTitle: "Models on this Ollama",
      addServer: "Add another Ollama",
      cancelAdd: "Cancel",
      serverName: "Name",
      serverNamePlaceholder: "The machine it runs on, such as Delta3640",
      defaultNamePlaceholder: "Default",
      defaultNameHint: "What it is called here, such as the machine it runs on. Blank is Default.",
      nameLabel: "Name",
      unnamedDefault: "Default",
      defaultServerCapital: "The default server",
      addressPlaceholder: "http://192.168.10.178:11434",
      removeServer: "Remove",
      removeServerConfirm: (name: string, hosts: readonly string[]) =>
        hosts.length === 0 ? `Remove ${name}?` : `Remove ${name}? ${hosts.join(", ")} will go back to the default.`,
      usingDefaultForNow: (server: string) => `Not answering. Its hosts are using ${server} for now.`,
      watches: "Watches",
      watchesNote: (defaultServer: string) =>
        `A ticked host's redacted logs go to this machine. If it is off, they go to ${defaultServer}. A runner deciding alone must be able to reach this address too.`,
      defaultWatches: (server: string, hosts: readonly string[]) =>
        hosts.length === 0 ? `${server} watches no host now.` : `${server} watches: ${hosts.join(", ")}.`,
      homeAssistant: "Home Assistant",
      router: "Router",
      defaultServer: "the default server",
      hostUses: (server: string) => `Ollama: ${server}`,
      hostFallingBack: (server: string) => `(not answering, so ${server} for now)`,
      inUse: "in use",
      inMemory: "in memory",
      noModels: "That Ollama did not list any models. Check its address, or type a model's name.",
      modelsLabel: "Models",
      contextLabel: "Context window (tokens)",
      contextHint: "How much of a report it reads at once; within what the model reads.",
      save: "Save",
      checking: "Asking that Ollama…",
    },
    homeAssistant: {
      explanation: "Autoheal reads it, never changes it, and turns unavailable devices and integrations into tasks.",
      addressPlaceholder: "http://homeassistant.local:8123",
      token: "Long-lived token",
      tokenHint: "From a Home Assistant user without admin rights: Profile, then Security",
      connect: "Connect",
      change: "Change",
    },
    channels: {
      notSetUp: "Not set up",
      setUp: (name: string) => `Set up ${name}`,
      change: "Change",
      cancel: "Cancel",
    },
    // Settings → Backups: what the database holds, and how long it keeps each kind of record.
    data: {
      title: "Data",
      explanation: "Each day Autoheal removes finished records older than their window. The audit log is kept whole.",
      size: (size: string) => `The database holds ${size}`,
      cleaned: "cleaned up",
      removed: (count: string) => `${count} removed`,
      notCleaned: "not cleaned up since the dashboard started",
      window: (days: number) => `${days} days`,
      keptWhole: "kept whole",
      kinds: {
        runnerResults: "Runner receipts",
        updateRuns: "Update runs",
        jobs: "Jobs",
        replayRuns: "Replays",
        tasks: "Tasks",
        incidents: "Incidents",
        applicationBackupArtifacts: "Application backups",
        applicationBackupRuns: "Application backup runs",
        rebootPlans: "Reboot plans",
        auditEvents: "Audit log",
      } satisfies Record<DataKind, string>,
    },
    window: {
      title: "Host package window",
      explanation:
        "Every night, in each host's own time zone. Only hosts whose .env allows package updates take part. Reboots always stay yours.",
      from: "From",
      to: "To",
      securityFixes: "Install security fixes on their own, unless a rule holds them",
    },
    always: {
      title: "Always running",
      problemChecks: "Problem checks",
      imageChecks: "Image update checks",
      liveStats: "Live stats kept",
      databaseBackup: "Database backup",
      everySeconds: (seconds: number) => `every ${seconds} seconds`,
      everyHours: (hours: number) => `every ${hours} hours`,
      minutes: (minutes: number) => `${minutes} minutes`,
      daily: "daily",
    },
    backup: {
      last: (when: string) => `Last backup ${when}`,
      verified: "verified",
      notVerified: "not checked",
      none: "No backup yet",
      passphrase: { autoheal: "Passphrase made by Autoheal", operator: "Passphrase from the .env" } satisfies Record<
        SecretSource,
        string
      >,
      onThisMachine: "kept on this machine only",
      copiedOffbox: "copied off this machine too",
      seeAll: "See all backups",
      noOffbox: "No off-box copy yet. If this machine's disk dies, the backups go with it.",
      addOffbox: "Add an off-box copy",
      // Around the setting, which shows in the code font.
      offboxHowBefore:
        "Mount a folder from another machine (a NAS share, say) into the control plane's container, and name it in its .env as ",
      offboxSetting: "OFFBOX_BACKUP_DIRECTORY",
      offboxHowAfter: ". From the next backup on, each one is copied there too, still encrypted.",
    },
    people: {
      count: (count: number) => `${count} ${count === 1 ? "person" : "people"}`,
      roles: (count: number, role: string) => (count === 1 ? role : `${count} ${role}s`),
      manage: "Manage people",
    },
    keys: {
      title: "Widget and metrics keys",
      explanation:
        "A key lets Homepage show Autoheal's counts (hosts online, problems, open tasks, updates), or Prometheus " +
        "read its metrics: one of them, never both. Numbers only, labelled at most by host and mount, never by " +
        "container.",
      lastUsed: (ago: string) => `last used ${ago}`,
      neverUsed: "never used",
      newName: "New key name",
      reads: "Reads",
      scopes: { widget: "Homepage widget", metrics: "Metrics, for Prometheus" } satisfies Record<
        WidgetKeyScope,
        string
      >,
      shortScopes: { widget: "Homepage", metrics: "Metrics", jarvis: "Jarvis" } satisfies Record<AnyKeyScope, string>,
      create: "Create key",
    },
    proxies: {
      title: "Trusted proxies",
      explanation:
        "A reverse proxy passes on whom each request is for. Autoheal takes that word only from the proxies listed here, and records the address it gives in sessions, the audit log and the sign-in limits.",
      direct: (peer: string) => `Your browser reached Autoheal directly, from ${peer}.`,
      notTrusted: (peer: string, client: string) =>
        `Your request came through ${peer}, which says it is for ${client}. Autoheal does not take its word, so everyone who comes that way counts as ${peer}.`,
      trusted: (peer: string, client: string) =>
        `Your request came through ${peer}, a trusted proxy, so Autoheal counts it as from ${client}.`,
      trust: (peer: string) => `Trust ${peer}`,
      remove: "Remove",
      newAddress: "Add an address or a range",
      placeholder: "10.0.0.1 or 10.0.0.0/24",
      add: "Add",
      fromEnvironment: `The .env names these in ${ENV_TRUSTED_PROXY_ADDRESSES}, so they can only be changed there.`,
    },
    systemFacts: {
      version: "Version",
      address: "Dashboard address",
      certificate: "TLS certificate",
      proxies: "Trusted proxies",
      passphrase: "Backup passphrase",
      offbox: "Off-box backup copy",
    },
    selfUpdate: {
      title: "Updating Autoheal",
      explanation: (reference: string) =>
        `Runs ${reference} in place of this container, pulled first where it comes from a registry. The old container is kept for 10 minutes, and comes back by itself if the new one does not hold.`,
      runs: (image: string, since: string | null) =>
        since === null ? `Running image ${image}.` : `Running image ${image}, started ${since}.`,
      update: "Update Autoheal",
      last: "Last update",
    },
  },
  services: {
    names: { gotify: "Gotify", ntfy: "ntfy", webhook: "Webhook", homeAssistant: "Home Assistant" } satisfies Record<
      IntegrationKind,
      string
    >,
    fromEnvironment: "Set in the .env, so it is fixed here.",
    address: "Address",
    topic: "Topic",
    token: "Token",
    tokenOptional: "Access token (optional)",
    tokenKept: "set; leave empty to keep it",
    tokenHints: {
      gotify: "An application token from Gotify (Apps > Create application).",
      ntfy: "Only for a protected topic. Anyone who knows an open topic's name can read it.",
      webhook: "Sent as a bearer token, for a receiver that asks for one. Discord and Slack need none.",
      homeAssistant:
        "A long-lived token of a Home Assistant user without admin rights (Profile > Security), used read-only.",
    } satisfies Record<IntegrationKind, string>,
    tokenSet: "token set",
    save: "Save",
    remove: "Remove",
    removeConfirm: (name: string) => `Stop using ${name}?`,
    test: "Send a test",
    deliveryHealth: {
      configured: "Configured; untested",
      pending: "Configured; awaiting attempt result",
      accepted: (when: string) => `Last accepted by server ${when}`,
      failed: (when: string) => `Last attempt failed ${when}`,
      notObserved: "not observed",
      history: (attempt: string, success: string) =>
        `Last attempt: ${attempt}. Last accepted by server: ${success}. Server acceptance does not confirm device receipt.`,
      failures: {
        refused: "The server refused the attempt.",
        timeout: "The attempt timed out.",
        unreachable: "The notification server could not be reached.",
      },
    },
    plainHttp: (name: string) => `${name} is reached over plain http: anyone on the way can read what goes to it.`,
    // A webhook: where alerts go, in the shape its receiver takes.
    webhook: {
      addressHint:
        "Discord's and Slack's webhook addresses hold their key, so the address is kept sealed and shown only up to " +
        "its host. Paste it again to change anything.",
      format: "Format",
      formats: {
        json: "JSON (title, message, priority, link)",
        discord: "Discord",
        slack: "Slack, Mattermost or Rocket.Chat",
      } satisfies Record<WebhookFormat, string>,
      shortFormats: { json: "JSON", discord: "Discord", slack: "Slack" } satisfies Record<WebhookFormat, string>,
    },
    notConnected: (error: string | null) => `Not connected${error === null ? "." : `: ${error}`}`,
  },
  widgetKeys: {
    created: (name: string) => `Key for ${name}. Copy it now: it is shown only once.`,
    snippetIntro: "In Homepage's services.yaml (Homepage must trust your private CA, through NODE_EXTRA_CA_CERTS):",
    snippet: (baseUrl: string, secret: string) =>
      [
        "- Autoheal:",
        `    href: ${baseUrl}`,
        `    icon: ${baseUrl.replace(TRAILING_SLASHES, "")}${BRAND_ASSETS.icon}`,
        "    widget:",
        "      type: customapi",
        `      url: ${baseUrl.replace(TRAILING_SLASHES, "")}${API_ROUTES.widget}`,
        "      headers:",
        `        ${WIDGET_KEY_HEADER}: ${secret}`,
        "      mappings:",
        ...WIDGET_MAPPINGS.flatMap(([field, label]) => [`        - field: ${field}`, `          label: ${label}`]),
      ].join("\n"),
    metricsIntro: (baseUrl: string) =>
      `Prometheus reads ${baseUrl.replace(TRAILING_SLASHES, "")}${API_ROUTES.metrics} with this key as its bearer ` +
      "token. In prometheus.yml (Prometheus must trust your private CA when the dashboard has its own certificate):",
    metricsSnippet: (baseUrl: string, secret: string) => {
      const address = new URL(baseUrl);
      return [
        "scrape_configs:",
        "  - job_name: autoheal",
        `    scheme: ${address.protocol.replace(URL_SCHEME_END, "")}`,
        `    metrics_path: ${address.pathname.replace(TRAILING_SLASHES, "")}${API_ROUTES.metrics}`,
        "    authorization:",
        `      credentials: ${secret}`,
        "    static_configs:",
        `      - targets: ["${address.host}"]`,
      ].join("\n");
    },
    revoke: "Revoke",
    revokeConfirm: (name: string) => `Revoke the key ${name}? What reads with it stops getting Autoheal's numbers.`,
  },
} as const;
