// Every path and interval the dashboard uses, and its text, which text/ keeps by page.

import { COMMON_TEXT } from "./text/common.js";
import { ATTENTION_TEXT } from "./text/attention.js";
import { INCIDENTS_TEXT } from "./text/incidents.js";
import { HOSTS_TEXT } from "./text/hosts.js";
import { CONTAINERS_TEXT } from "./text/containers.js";
import { STACKS_TEXT } from "./text/stacks.js";
import { HOST_STORAGE_TEXT } from "./text/host-storage.js";
import { INSTALLS_TEXT } from "./text/installs.js";
import { CONNECT_TEXT } from "./text/connect.js";
import { NETWORK_TEXT } from "./text/network.js";
import { HOME_ASSISTANT_TEXT } from "./text/home-assistant.js";
import { SETTINGS_TEXT } from "./text/settings.js";
import { ACCOUNT_TEXT } from "./text/account.js";
import { ADMIN_TEXT } from "./text/admin.js";
import {
  BYTES_PER_GIBIBYTE,
  BYTES_PER_KIBIBYTE,
  CONTAINER_PROBLEMS,
  CONTAINER_STATE_DEAD,
  CONTAINER_STATE_PAUSED,
  CONTAINER_STATE_RESTARTING,
  CONTAINER_STATE_RUNNING,
  HEALTH_HEALTHY,
  HEALTH_STARTING,
  HEALTH_UNHEALTHY,
  HOST_STATE,
  HOST_STATUS_ACTIVE,
  INCIDENT_STATUS,
  INTEGRITY_OK,
  JOB_STATUS,
  HEARTBEAT_INTERVAL_MILLISECONDS,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_HOUR,
  MILLISECONDS_PER_DAY,
  REPLAY_FINISHED,
  REPLAY_RUNNING,
  SAFETY_PROBLEMS,
  TASK_LABEL,
  TASK_PRIORITY,
  TASK_STATUS,
  USER_STATUS_ACTIVE,
  USER_STATUS_DEACTIVATED,
  VERDICT_DRY_RUN,
  VERDICT_ESCALATED,
  VERDICT_FIXED,
  WATCHED_PROBLEMS,
  ZIGBEE_PROBLEMS,
} from "../../src/shared/constants.js";
import { MAINTENANCE_CLOCK_TOLERANCE_MILLISECONDS } from "../../src/shared/maintenance.js";
export { SECONDS_PER_MINUTE, SETTINGS_SECTIONS } from "./text/basics.js";
export { ERROR_TEXT } from "./text/errors.js";

// Where a project's release notes are, by the host its image's source names; a source anywhere else gets no release
// link. GitHub and Codeberg name a project by its owner and repository; GitLab nests groups, so a project there is all
// of the path before "/-/". Each finds a version by its numbers among its releases (GitLab among its tags, which carry
// their release notes), and lists them all for a version without numbers.
export const RELEASE_PAGES: ReadonlyMap<string, { projectParts: number | null; all: string; find: string }> = new Map([
  ["github.com", { projectParts: 2, all: "/releases", find: "/releases?q=" }],
  ["codeberg.org", { projectParts: 2, all: "/releases", find: "/releases?q=" }],
  ["gitlab.com", { projectParts: null, all: "/-/releases", find: "/-/tags?search=" }],
]);
export const RELEASE_LINK = { scheme: "https://", projectEnd: "/-/", gitSuffix: /\.git$/, fewestParts: 2 } as const;
// A version's numbers, wherever its tag puts them: v1.120.2, 16.5-alpine, 1.40.0-ls250.
export const VERSION_NUMBERS = /\d+(?:\.\d+)+/;
// A host's clock this close to the control plane's is in sync: its report takes a moment on the way. Past the minute a
// runner's clock may be off before its automatic recovery pauses, the line warns.
export const CLOCK_IN_SYNC_SECONDS = 2;
export const CLOCK_WARNING_SECONDS = MAINTENANCE_CLOCK_TOLERANCE_MILLISECONDS / MILLISECONDS_PER_SECOND;

export const PATHS = {
  // Attention: what needs a person now. The board with every open item is one link away.
  home: "/",
  board: "/board",
  approvals: "/approvals",
  tasks: "/tasks",
  task: "/tasks/:taskId",
  login: "/login",
  secondFactor: "/second-factor",
  changePassword: "/change-password",
  totpSetup: "/totp-setup",
  incidents: "/incidents",
  incident: "/incidents/:incidentId",
  hosts: "/hosts",
  host: "/hosts/:hostId",
  containers: "/containers",
  homeAssistant: "/home",
  network: "/network",
  runbooks: "/runbooks",
  runbook: "/runbooks/:runbookId",
  replays: "/replays",
  replay: "/replays/:replayId",
  account: "/account",
  settings: "/settings",
  users: "/users",
  backups: "/backups",
  audit: "/audit",
  prompt: "/prompts/:promptHash",
} as const;

// An SSH host's own card on its page: its key, its root password, its settings.
export const SSH_HOST_ANCHOR = "ssh";
// What a person runs on a host to let Autoheal in over SSH, each a block with its copy button.
const AUTHORIZED_KEYS = "~/.ssh/authorized_keys";
// Reboot and shut down, on a host's page: the buttons, their confirm, and the strip that follows the host.
export const POWER_TEXT = {
  reboot: "Reboot",
  shutdown: "Shut down",
  cancel: "Cancel",
  confirm: {
    reboot: (label: string, containers: number) =>
      `Reboot ${label} now? Its ${containers} containers stop and start again with it. Autoheal follows it back.`,
    shutdown: (label: string) => `Shut ${label} down? It stays off until someone powers it on.`,
    // The machine the dashboard itself runs on.
    dashboardToo: "The dashboard goes down with it, and is back when it is.",
    go: { reboot: "Reboot now", shutdown: "Shut down" },
  },
  title: {
    reboot: (label: string) => `Rebooting ${label}`,
    shutdown: (label: string) => `Shutting ${label} down`,
    ready: (label: string) => `${label} is back`,
    off: (label: string) => `${label} is off`,
    failed: (label: string) => `${label} did not go down`,
  },
  steps: {
    reboot: ["Asked", "Going down", "Offline", "Starting", "Ready"],
    shutdown: ["Asked", "Going down", "Off"],
  },
  seen: {
    asked: "On its way to the host…",
    goingDown: (seconds: number) => `Going down. Last heard from ${seconds} s ago.`,
    offline: (seconds: number) => `Offline. No answer for ${seconds} s: Autoheal keeps asking.`,
    starting: "Back on the network: its services are starting.",
    ready: (took: string, running: number, total: number) =>
      `Back in ${took}. ${running} of ${total} containers running.`,
    readyWithoutDocker: (took: string) => `Back in ${took}.`,
    off: (at: string, by: string) =>
      `Shut down at ${at} by ${by}. No alarm while it stays off: Autoheal sees it the moment it is powered on.`,
  },
  badge: {
    reboot: "rebooting",
    shutdown: "shutting down",
    offline: "offline",
    starting: "starting",
    off: "shut down",
  },
  away: {
    offline: (label: string) => `Waiting for ${label} to come back`,
    off: (label: string) => `${label} is shut down`,
  },
} as const;
// Why a host's dependency map is empty: what to do differs with how Autoheal reaches it.
// A host's What changed shows its latest changes; the rest are folded away under them.
export const HOST_CHANGES_SHOWN = 5;
// The dependency map's drawing, in its own units (the map is 960 × 520 of them): dot sizes, a hub's threshold (this
// many links, or this share of the host's containers, whichever is more), labels, bubbles and the running dots.
export const MAP_VIEW = {
  radius: 5,
  radiusPerLink: 2.2,
  hubLinks: 6,
  hubShare: 0.4,
  labelGap: 6,
  labelDrop: 4,
  labelCharacters: 28,
  bend: 16,
  bubblePadding: 34,
  bubbleRound: 26,
  bubbleLabelInset: 12,
  bubbleLabelDrop: 16,
  resourceWidth: 150,
  resourceHeight: 26,
  resourceRound: 8,
  dotRadius: 3,
  flowMilliseconds: 1400,
  flowStagger: 0.13,
  reducedMotion: "(prefers-reduced-motion: reduce)",
} as const;
// How many containers one review of an action covers, and how many of them are asked about at a time.
export const OPERATION_REVIEW = { containers: 16, atOnce: 4 } as const;
export const DEPENDENCY_MAP_TEXT = {
  title: "Dependencies and shared resources",
  edges: {
    network_namespace: "Shares network namespace",
    compose_association: "Same Compose project (association only)",
    shared_writable_data: "Shares writable data",
    declared_dependency: "Declared dependency (Compose depends_on or autoheal.depends-on)",
  },
  explanation:
    "Network namespace sharing and shared writable data can enlarge an operation’s scope. Compose membership is an " +
    "association, not a startup order. Declared dependencies come from the optional autoheal.depends-on label and " +
    "do not change execution policy.",
  stale: "This report is stale. A mutation requires a fresh runner review.",
  truncated:
    "This report is partial because a graph or byte limit was reached. Operation review uses the full coordinator " +
    "discovery.",
  unresolved: "Some referenced containers could not be resolved.",
  captured: "Captured",
  counts: (containers: number, links: number) => `${containers} containers · ${links} links`,
  linkList: "Accessible link list",
  noRelationships: "No supported relationships were reported.",
  reviewAtMost: (count: number) => `Review at most ${count} containers at once.`,
  noUsableReview: "No usable operation review was returned. Update the runner and refresh the review.",
  reviewTitle: (action: string) => `Review ${action} impact`,
  locked:
    "The runner inspected and locked the same resource set used for execution. Shared-data writers and namespace " +
    "providers can be locked even when they are not replaced. A changed set will refuse the job.",
  protected: "protected",
  resources: (count: number) => `${count} coordinator resources`,
  expires: "review expires",
  confirm: "Confirm reviewed operation",
  refresh: "Refresh review",
  cancel: "Cancel",
  mapLabel: "Dependency map: hover or focus a container to see what it is linked to; the complete link list follows",
  group: "Group by what is shared",
  groupHint: "Draw each shared folder or volume once, instead of a line for every pair of containers.",
  groupedNote:
    "Each shared folder or volume is drawn once. Folders are named by a fingerprint: their paths stay on the host.",
  folder: (fingerprint: string) => `Host folder · ${fingerprint}`,
  volume: (name: string) => `Volume ${name}`,
  partners: {
    shared_writable_data: (count: number) => `shares data with ${count}`,
    declared_dependency: (count: number) => `${count} declared ${count === 1 ? "dependency" : "dependencies"}`,
    compose_association: (count: number) => `same project as ${count}`,
    network_namespace: (count: number) => `shares its network with ${count}`,
  },
  alone: "no links: nothing else moves with it",
  hub: "A hub: its data folder holds the others', so stopping or updating it touches all of theirs.",
  noReportFromRunner: "No dependency report is available. Update and connect this host’s runner.",
  noDocker: "No Docker on this host, so no containers here depend on each other.",
  notYet: "No dependency report yet: it comes with this host’s next report.",
} as const;
// A runner container brought to the image its compose file names, in the folder holding that file.
export const RUNNER_UPDATE_COMMAND = "docker compose pull && docker compose up -d";
export const SSH_SETUP = {
  folder: "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
  authorize: (publicLine: string) => `echo '${publicLine}' >> ${AUTHORIZED_KEYS} && chmod 600 ${AUTHORIZED_KEYS}`,
  authorizeFrom: (address: string, publicLine: string) =>
    `echo 'from="${address}" ${publicLine}' >> ${AUTHORIZED_KEYS} && chmod 600 ${AUTHORIZED_KEYS}`,
  joinDocker: (user: string) => `sudo usermod -aG docker ${user}`,
  checkDocker: "docker ps",
  // Run where the runner's compose file is, once a host is switched to SSH.
  removeRunner: "docker compose down",
  compareHostKey: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub",
  privateKeyFile: (name: string) => `autoheal-${name.replace(/[^A-Za-z0-9._-]/g, "-")}`,
  privateKeyType: "application/x-pem-file",
} as const;
// An operating system's name up to its release, "Ubuntu 24.04" of "Ubuntu 24.04.5 LTS": what a host's card has room for.
export const SYSTEM_RELEASE = /^[^\d(]+\d+(?:\.\d+)?/;
// A dial's value longer than this is set smaller, to stay inside the arc, and one longer still smaller again.
// Measured in Geist at the dial's weight: "1.2 MB/s" fits at the drawn size, "35.3 kB/s" at the long one,
// and up to "1,023.9 MB/s" at the longer one.
export const DIAL_LONG_VALUE = 8;
export const DIAL_LONGER_VALUE = 9;
// The exit code in a report's state line, "status=exited exit_code=1 …".
export const EXIT_CODE_IN_STATE = /exit_code=(-?\d+)/;
// The newest log lines the incident page shows before "Read the whole report".
export const LOG_EXCERPT_LINES = 3;
// Every disk on the Attention page is past the task threshold; this full, it is about to stop taking writes.
export const DISK_FULL_DANGER_PERCENT = 98;
// All of it: a share's ceiling on a chart.
export const FULL_PERCENT = 100;
export const MILLISECONDS_PER_HOUR = MILLISECONDS_PER_MINUTE * MINUTES_PER_HOUR;
export const REFRESH_MILLISECONDS = 15_000;
// A reset reaches the runner with the answer to its next report, and the report after it shows it: until then it waits.
export const RESET_HEARD_MILLISECONDS = 2 * HEARTBEAT_INTERVAL_MILLISECONDS;
// The inventory follows runners' event-driven reports and Home Assistant's live states.
// Newer tag versions listed before "Show all": the rest wait for a click.
export const NEWER_VERSIONS_SHOWN = 3;
export const INVENTORY_REFRESH_MILLISECONDS = 5_000;
// A rehearsal's timeline as first offered, and its bounds: within a week, a clock moved by up to a day either way.
const SECONDS_PER_DAY = MILLISECONDS_PER_DAY / MILLISECONDS_PER_SECOND;
export const REHEARSAL_FORM = {
  startSeconds: [0, 61, 600, 1200, 3600],
  latestSeconds: 7 * SECONDS_PER_DAY,
  clockOffsetSeconds: SECONDS_PER_DAY,
  rows: 50,
  stepSeconds: 60,
} as const;
// An application backup plan as the form first offers it, and how the card follows its runs.
export const APPLICATION_BACKUP_FORM = {
  refreshMilliseconds: 3000,
  readySeconds: 30,
  retain: 3,
  runsShown: 20,
} as const;
// How long a new rollout watches each cohort unless changed, in minutes.
export const ROLLOUT_FORM = { observeMinutes: 5 } as const;
// What a new rule starts with when quiet hours or escalation are ticked: 22:00 to 07:00 UTC, after 15 minutes.
export const NOTIFICATION_ROUTING_DEFAULTS = {
  quietStartMinute: 22 * MINUTES_PER_HOUR,
  quietEndMinute: 7 * MINUTES_PER_HOUR,
  escalateAfterMinutes: 15,
} as const;
// A host's maintenance window: how long one can be asked for, what it starts at, and how much one click extends it.
export const MAINTENANCE_FORM = {
  durationMinutes: [15, 30, 60, 120, 240, 480, 1440],
  defaultMinutes: 60,
  extendMinutes: 30,
} as const;
// Tasks and incidents arrive by the live stream; this is only for a change the stream missed.
export const BOARD_SAFETY_REFRESH_MILLISECONDS = 60_000;
// A container's timeline shows its newest few at first, so the rows under its opened one stay in reach.
export const CONTAINER_TIMELINE_SHOWN = 10;
// Coalesce nearby runner inventory reports into one refresh per relevant query.
export const LIVE_INVENTORY_BATCH_MILLISECONDS = 250;
// Usage meters turn amber, then red, past these percentages.
export const METER_WARNING_PERCENT = 75;
export const METER_DANGER_PERCENT = 90;
export const SEARCH_PARAMETERS = {
  search: "search",
  problemsOnly: "problems",
  hostId: "host",
  container: "container",
  // The card whose details are open beside the board.
  open: "open",
} as const;
// Rates have no natural top, so their dials run on a log scale: 1 KiB/s at the start, 1 GiB/s at
// the end, 1 MiB/s halfway.
// A link's speed in megabits a second, as bytes: 8 bits to the byte.
export const BYTES_PER_MEGABIT = 125_000;
export const RATE_DIAL_SCALE = {
  lowestBytesPerSecond: BYTES_PER_KIBIBYTE,
  highestBytesPerSecond: BYTES_PER_GIBIBYTE,
} as const;
export const MEGAHERTZ_PER_GIGAHERTZ = 1000;
// The task list's own address settings: which quick filter, which view, which words.
export const TASK_SEARCH_PARAMETERS = { show: "show", view: "view", search: "search" } as const;
export const TASK_SHOW = {
  open: "open",
  mine: "mine",
  autoheal: "autoheal",
  updates: "updates",
  closed: "closed",
} as const;
// The board is the task list's default view; this asks for the table instead.
export const TASK_LIST_VIEW = "list";
export const ASSIGNEE_SEPARATOR = ":";
export const ASSIGNEE_KINDS = { user: "user", agent: "agent" } as const;
// What a row dragged onto the Ollama agent carries: the keys of what it hands over, as JSON.
export const AGENT_DRAG_TYPE = "application/x-autoheal-hand-over";
// A hand-over's key: its kind, then its ids (a task's, an incident's, or a host's and a package's name).
export const HAND_OVER_SEPARATOR = ":";
// While an action is on its way to a runner, its result is looked for this often.
export const JOB_REFRESH_MILLISECONDS = 2_000;
export const NEW_VERSION_CHECK_MILLISECONDS = 5 * 60 * 1000;
// Pages load when first opened, by names each build gives its files. Vite says so by this event when one cannot load;
// a tab then loads the new build, once a minute at most.
export const STALE_BUILD = {
  event: "vite:preloadError",
  storageKey: "autoheal-reloaded-for-new-build",
  reloadAtMostEveryMilliseconds: 60_000,
} as const;
// The host list, while a host is being rebooted or shut down.
export const POWER_REFRESH_MILLISECONDS = 2_000;
// Ticked containers' jobs are followed every second: each ends in seconds, and the rows follow at once.
export const BULK_REFRESH_MILLISECONDS = 1_000;
// What a host's row shows for a moment after its container changed between two reports.
export const MOTION = {
  appeared: "appeared",
  removed: "removed",
  started: "started",
  stopped: "stopped",
  restarted: "restarted",
  paused: "paused",
  updated: "updated",
  failed: "failed",
} as const;
export type Motion = (typeof MOTION)[keyof typeof MOTION];
// Long enough to be seen; the stylesheet's effects end within it.
export const MOTION_MILLISECONDS = 1_600;
// How long a finished update's or recreate's line stays to say how it went.
export const FINISHED_LINE_MILLISECONDS = 6_000;
// A job that went well before its container's report came: the row stays at work for the report this long at most.
export const AWAIT_REPORT_MILLISECONDS = 3_000;
// The quick filters over a host's containers.
export const CONTAINER_SHOW = {
  all: "all",
  running: "running",
  stopped: "stopped",
  problems: "problems",
  updates: "updates",
  working: "working",
} as const;
export type ContainerShow = (typeof CONTAINER_SHOW)[keyof typeof CONTAINER_SHOW];
export const CONTAINER_SHOWS = Object.values(CONTAINER_SHOW);
// A shell drawn in the browser: its font size in pixels, the lines it keeps to scroll back, and how long a
// change of its size settles before the shell is told.
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_SCROLLBACK_LINES = 5_000;
export const TERMINAL_RESIZE_MILLISECONDS = 150;
// What the browser draws a shell with: the page's own terminal colors and mono font.
export const TERMINAL_STYLE_TOKENS = {
  background: "--terminal-background",
  foreground: "--terminal-foreground",
  font: "--font-mono",
} as const;
// A port added in a container's settings starts as the usual web one, published on a free-looking host port.
export const NEW_PORT_DEFAULTS = { target: 80, published: 8080 } as const;
// How long "Saved" shows after a setting changed in place.
export const SAVED_NOTE_MILLISECONDS = 1_800;
// How long a successful clipboard copy is announced.
export const COPY_FEEDBACK_MILLISECONDS = 3_000;
// Where the host page's OS updates start, for links further up the page.
export const MEGABITS_PER_GIGABIT = 1000;
export const QUERY_TRUE = "true";
export const REPLAY_REFRESH_MILLISECONDS = 2_000;
export const RECENT_INCIDENTS = 10;
export const QR_PIXELS = 200;
// The blank border scanners need around the code, in modules.
export const QR_MARGIN_MODULES = 1;
// A failed query is asked once more, a second later. One refused for too many requests is asked again
// when the server says, up to RATE_LIMITED_RETRIES times.
export const QUERY_RETRIES = 1;
export const QUERY_RETRY_DELAY_MILLISECONDS = 1_000;
export const RATE_LIMITED_RETRIES = 3;
// What inside a clickable row acts on its own click: the row then stays out of it.
export const INTERACTIVE_ELEMENTS = "a, button, input, select, textarea, label";

export const SESSION_QUERY_KEY = ["session"] as const;
// The look pinned on the account page, in this browser only. public/theme.js applies it before the first
// paint, so it reads the same key and values (a test keeps them equal); "device" pins nothing.
export const THEME_STORAGE_KEY = "autoheal-theme";
export const THEMES = { device: "device", light: "light", dark: "dark" } as const;
export type Theme = (typeof THEMES)[keyof typeof THEMES];
// Whether this browser asks once before a stop or a removal, chosen on the account page. Kept only while on:
// off, as it is unless chosen here, both act on one click.
export const ASK_FIRST_STORAGE_KEY = "autoheal-ask-first";
export const ASK_FIRST_ON = "on";
// What a person pinned first or hid on a page, kept in this browser alone as the look is: one key for each page.
export const CARD_STORAGE_KEY_PREFIX = "autoheal-cards-";
export const CARD_PAGES = { attention: "attention", host: "host" } as const;
export type CardPage = (typeof CARD_PAGES)[keyof typeof CARD_PAGES];
// Each page's cards, by the id a choice about them is kept under; one that keeps its place among them, for that place.
export const ATTENTION_CARDS = {
  updates: "updates",
  onItNow: "on-it-now",
  healed: "healed",
  comingUp: "coming-up",
  howFar: "how-far",
} as const;
export const HOST_CARDS = {
  dials: "dials",
  history: "history",
  system: "system",
  ollama: "ollama",
  profile: "profile",
  probes: "probes",
  images: "images",
  updates: "updates",
  dependencies: "dependencies",
  control: "control",
  changes: "changes",
} as const;
// A session's browser and system, guessed from its user agent: the first pattern that matches names
// it. Edge and Opera say Chrome too, Chrome says Safari, and Android says Linux, so they come first.
export const USER_AGENT_BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
export const USER_AGENT_SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/Android/, "Android"],
  [/iPhone|iPad/, "iOS"],
  [/Windows/, "Windows"],
  [/Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

// Names that usually hold a secret: their values stay hidden until asked for, so they do not sit on a screen.
export const SECRET_NAME_PATTERN = /pass|secret|token|key|credential|auth|private|dsn|database_url|_url$/i;
export const CONTAINER_DETAILS_REFRESH_MILLISECONDS = 5_000;

// Every piece of text the dashboard shows, kept by page in text/: one object, so a page reads TEXT.page.line.
export const TEXT = {
  ...COMMON_TEXT,
  ...ATTENTION_TEXT,
  ...INCIDENTS_TEXT,
  ...HOSTS_TEXT,
  ...CONTAINERS_TEXT,
  ...STACKS_TEXT,
  ...HOST_STORAGE_TEXT,
  ...INSTALLS_TEXT,
  ...CONNECT_TEXT,
  ...NETWORK_TEXT,
  ...HOME_ASSISTANT_TEXT,
  ...SETTINGS_TEXT,
  ...ACCOUNT_TEXT,
  ...ADMIN_TEXT,
} as const;

export const tooManyAttemptsText = (seconds: number) => `Too many attempts. Try again in ${seconds} seconds.`;
// The code was right for a time this far from the server's: one of the two clocks is off.
export const clockDriftText = (offsetSeconds: number) =>
  `That code is right, but for a time ${Math.abs(offsetSeconds)} seconds ${offsetSeconds > 0 ? "ahead of" : "behind"} this server. Set your phone's time to automatic, or use a recovery code.`;

export type Tone = "good" | "warning" | "danger" | "neutral";

const TONED_VALUES: Record<Exclude<Tone, "neutral">, readonly string[]> = {
  good: [
    CONTAINER_STATE_RUNNING,
    HEALTH_HEALTHY,
    HOST_STATE.online,
    HOST_STATUS_ACTIVE,
    USER_STATUS_ACTIVE,
    INCIDENT_STATUS.resolved,
    VERDICT_FIXED,
    REPLAY_RUNNING,
    REPLAY_FINISHED,
    JOB_STATUS.succeeded,
    TASK_STATUS.done,
    INTEGRITY_OK,
    TEXT.safety.ok,
    TEXT.zigbee.online,
  ],
  warning: [
    HEALTH_STARTING,
    CONTAINER_STATE_PAUSED,
    ZIGBEE_PROBLEMS.lowBattery,
    ZIGBEE_PROBLEMS.weakLink,
    SAFETY_PROBLEMS.batteryLow,
    TEXT.hosts.rebootRequired,
    HOST_STATE.neverSeen,
    INCIDENT_STATUS.deciding,
    INCIDENT_STATUS.decided,
    INCIDENT_STATUS.awaitingApproval,
    INCIDENT_STATUS.approved,
    VERDICT_DRY_RUN,
    TASK_PRIORITY.high,
    TASK_LABEL.update,
    TASK_STATUS.blocked,
    JOB_STATUS.pending,
    JOB_STATUS.delivered,
  ],
  danger: [
    CONTAINER_STATE_RESTARTING,
    CONTAINER_STATE_DEAD,
    HEALTH_UNHEALTHY,
    ...Object.values(CONTAINER_PROBLEMS),
    ZIGBEE_PROBLEMS.unavailable,
    ...Object.values(WATCHED_PROBLEMS),
    SAFETY_PROBLEMS.alarm,
    SAFETY_PROBLEMS.unavailable,
    SAFETY_PROBLEMS.offline,
    SAFETY_PROBLEMS.fault,
    HOST_STATE.silent,
    VERDICT_ESCALATED,
    USER_STATUS_DEACTIVATED,
    TASK_PRIORITY.urgent,
    JOB_STATUS.failed,
    JOB_STATUS.expired,
  ],
};
/** The tone each known state, problem and verdict shows in; anything else is neutral. */
export const BADGE_TONES: ReadonlyMap<string, Tone> = new Map(
  Object.entries(TONED_VALUES).flatMap(([tone, values]) => values.map((value) => [value, tone as Tone] as const)),
);
