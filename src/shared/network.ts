import { z } from "zod";

// What Autoheal reads from a router, and what it makes of it. It only ever reads: see unifi-adapter.ts.
export const ROUTER_KIND = { unifi: "unifi" } as const;
export const ROUTER_CAPABILITY = {
  clients: "clients",
  devices: "devices",
  internet: "internet",
  events: "events",
  exposure: "exposure",
} as const;
export type RouterCapability = (typeof ROUTER_CAPABILITY)[keyof typeof ROUTER_CAPABILITY];

export const NETWORK_LIMITS = {
  nameCharacters: 64,
  pollMilliseconds: 60_000,
  exposureEveryPolls: 10,
  // A device gone for this many readings has dropped: one missed reading is nothing.
  dropAfterReadings: 2,
  dropsToTell: 5,
  dropDayMilliseconds: 24 * 60 * 60 * 1000,
  // Often offline otherwise: a phone leaving the house is not a fault.
  alwaysOnShare: 0.9,
  unusualTimes: 5,
  unusualBytes: 5_000_000_000,
  // Nothing is unusual until a device has this much history.
  learningDays: 7,
  usualWeeks: 4,
  outageTellMilliseconds: 5 * 60_000,
  speedTestsADay: 4,
  fairBusyShare: 0.1,
  evidenceMilliseconds: 5 * 60_000,
  usageDays: 90,
  eventDays: 90,
  sampleDays: 90,
  speedTestDays: 365,
  flowDays: 14,
  exposureKept: 50,
  reportsKept: 52,
  reportEveryMilliseconds: 7 * 24 * 60 * 60 * 1000,
  logLinesASecond: 200,
  logSenderLookupMilliseconds: 3_000,
  // How long the addresses of a router known by name stay good without a new answer.
  logSendersKeptMilliseconds: 5 * 60_000,
  logLineCharacters: 4_096,
  listed: 500,
  flowsListed: 200,
} as const;

export const NETWORK_EVENT = {
  joined: "joined",
  dropped: "dropped",
  returned: "returned",
  outage: "outage",
  outageEnded: "outage_ended",
  exposureChanged: "exposure_changed",
  flowNew: "flow_new",
  linkSlower: "link_slower",
  incidentLinked: "incident_linked",
  routerEvent: "router_event",
} as const;

// How a minute of internet went, read from the router and from Autoheal's own check together.
export const INTERNET_STATE = {
  up: "up",
  onSecondLine: "on_second_line",
  lineDown: "line_down",
  nothingGetsOut: "nothing_gets_out",
  routerDown: "router_down",
  dashboardOnly: "dashboard_only",
} as const;
export type InternetState = (typeof INTERNET_STATE)[keyof typeof INTERNET_STATE];

/** A public address's own check, in the control plane: it says what the router cannot while it is down. */
export const INTERNET_PROBES = ["https://1.1.1.1/cdn-cgi/trace", "https://www.google.com/generate_204"] as const;
export const INTERNET_PROBE_TIMEOUT_MILLISECONDS = 5_000;
// While the router says the line is up and the last look got out; any sign of trouble looks again each minute.
export const INTERNET_PROBE_EVERY_MILLISECONDS = 5 * 60_000;
export const SPEED_SOURCE = { router: "router", thisMachine: "this_machine" } as const;
export type SpeedSource = (typeof SPEED_SOURCE)[keyof typeof SPEED_SOURCE];
export const SPEED_TEST_URL = "https://speed.cloudflare.com";
export const SPEED_TEST_LIMITS = {
  workers: 4,
  directionMilliseconds: 10_000,
  warmUpMilliseconds: 2_000,
  downloadBytes: 25_000_000,
  uploadBytes: 2_000_000,
  routerPollMilliseconds: 5_000,
  // About two and a half minutes, then it measures from this machine instead.
  routerPolls: 30,
} as const;
export const ROUTER_DEVICE_KIND = { router: "router", switch: "switch", accessPoint: "access_point" } as const;
export type RouterDeviceKind = (typeof ROUTER_DEVICE_KIND)[keyof typeof ROUTER_DEVICE_KIND];

export const routerSettingsBodySchema = z.object({
  kind: z.enum([ROUTER_KIND.unifi]),
  url: z.url({ protocol: /^https$/ }).max(512),
  username: z.string().trim().min(1).max(128),
  // Left out to keep the stored one, which only an unchanged address keeps.
  password: z.string().min(1).max(512).optional(),
  // The certificate a person looked at and approved for this address, in full: the login goes to this one alone.
  trustedCertificate: z
    .string()
    .regex(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/)
    .optional(),
});
export type RouterSettingsBody = z.infer<typeof routerSettingsBodySchema>;

export const routerCertificateBodySchema = routerSettingsBodySchema.pick({ url: true });

/** What a router's address shows, read with nothing sent to it: for a person to compare and approve. */
export interface RouterCertificateView {
  url: string;
  fingerprint: string;
}

export const routerContractBodySchema = z.object({
  downMbps: z.number().positive().max(1_000_000),
  upMbps: z.number().positive().max(1_000_000),
});
export type RouterContract = z.infer<typeof routerContractBodySchema>;

export const networkDeviceBodySchema = z.object({
  givenName: z.string().trim().max(NETWORK_LIMITS.nameCharacters).nullable().optional(),
  known: z.boolean().optional(),
  muted: z.boolean().optional(),
});
export const networkAskBodySchema = z.object({ mac: z.string().regex(/^[0-9a-f:]{17}$/) });

export interface RouterSettingsView {
  configured: boolean;
  kind: string | null;
  url: string | null;
  username: string | null;
  // The first part of the remembered certificate's SHA-256, to tell it by.
  certificate: string | null;
  contract: RouterContract | null;
  logPort: number | null;
  ollamaServerId: string | null;
}

export interface RouterProbeView {
  name: string | null;
  version: string | null;
  // Each capability, and what it found or why it could not.
  capabilities: { capability: RouterCapability; works: boolean; detail: string }[];
}

export interface NetworkDeviceView {
  mac: string;
  name: string;
  network: string | null;
  ip: string | null;
  wired: boolean;
  uplink: string | null;
  uplinkPort: number | null;
  signal: number | null;
  online: boolean;
  firstSeen: number;
  lastSeen: number;
  known: boolean;
  muted: boolean;
  privateAddress: boolean;
  periodBytes: number;
  usualBytes: number | null;
  unusual: boolean;
  drops: number;
  oftenDrops: boolean;
  linkMbps: number | null;
  bestLinkMbps: number | null;
}

export interface NetworkDeviceDetailView {
  device: NetworkDeviceView;
  dropTimes: number[];
  talks: { other: string; port: number; lines: number; blocked: boolean }[];
  run: NetworkRun;
}

export interface NetworkRun {
  status: "idle" | "running" | "done" | "failed";
  text: string | null;
  error: string | null;
  server: string | null;
}

export interface NetworkOutageView {
  from: number;
  to: number | null;
  state: string;
}

export interface SpeedTestView {
  at: number;
  downMbps: number;
  upMbps: number;
  ping: number | null;
  fair: boolean;
  source: SpeedSource;
}

export interface NetworkSpeedRunView {
  status: "idle" | "running" | "failed";
  error: string | null;
}

export interface NetworkOverviewView {
  connected: boolean;
  problem: string | null;
  watchedSince: number | null;
  internet: { upPercent: number | null; outages: number; downMinutes: number };
  contract: { contract: RouterContract | null; fair: number; downMet: number; upMet: number };
  newDevices: number;
  oftenDropping: string[];
  unusual: string[];
  exposureWaiting: boolean;
  updates: string[];
  top: { name: string; bytes: number; unusual: boolean }[];
  toLookAt: number;
  learning: boolean;
}

export interface NetworkInternetView {
  outages: NetworkOutageView[];
  tests: SpeedTestView[];
  contract: RouterContract | null;
  lines: { wan: string; up: boolean; latency: number | null }[];
  publicAddress: string | null;
  speedTestRefused: boolean;
  run: NetworkSpeedRunView;
}

export const CHECK_RESULT = { passed: "passed", failed: "failed", notTested: "not_tested" } as const;
export type CheckResult = (typeof CHECK_RESULT)[keyof typeof CHECK_RESULT];

export interface NetworkFirewallView {
  rules: { name: string; detail: string }[];
  forwards: { name: string; detail: string; isNew: boolean }[];
  blocked7Days: number | null;
  crossing: { source: string; destination: string; port: number; lines: number; blocked: boolean }[];
  checks: { key: string; result: CheckResult }[];
  logLastAt: number | null;
  // Who sent lines lately that were not read, while none arrive from the router.
  logRefusedSender: string | null;
  // Lines not read, as they came from an address that is not the router's, counted since the watch last started (a
  // restore starts it again): the last one's sender and time, for an hour after it.
  logIgnored: { sender: string; at: number; lines: number } | null;
  logNameUnresolved: boolean;
  exposureReadable: boolean;
}

export interface NetworkMapView {
  infrastructure: { id: string; name: string; kind: RouterDeviceKind; uplink: string | null }[];
  devices: {
    id: string;
    name: string;
    network: string | null;
    ip: string | null;
    wired: boolean;
    uplink: string | null;
    uplinkPort: number | null;
    signal: number | null;
    // In GHz, for a device on Wi-Fi.
    band: string | null;
    online: boolean;
  }[];
  talks: { from: string; to: string; lines: number; blocked: boolean; firstTime: boolean }[];
  flowsAvailable: boolean;
}

export interface NetworkReportView {
  at: number;
  summary: string;
  points: string[];
  figures: string[];
  server: string | null;
}

export const isPrivateAddress = (mac: string) => (Number.parseInt(mac.slice(0, 2), 16) & 2) !== 0;

// Words for tasks and evidence. Device names come from anyone on the Wi-Fi: see cleanName.
export const NETWORK_TEXT = {
  newDevice: (name: string, network: string | null) => `New device on ${network ?? "your network"}: ${name}`,
  newDeviceDetails: (ip: string | null) =>
    `It joined with address ${ip ?? "unknown"}. Say you know it on the Network page.`,
  privateDevices: (count: number, network: string | null) =>
    `${count} ${count === 1 ? "device" : "devices"} with a private address joined ${network ?? "your network"} today`,
  privateDetails: "Phones often change their address, so these can be ones you know. This clears after a day.",
  oftenDrops: (name: string, drops: number) => `${name} dropped ${drops} times in a day`,
  oftenDropsDetails: "See when on the Network page. Mute it there if this is expected.",
  unusual: (name: string, used: string, usual: string) => `${name} used ${used} in a day, and usually uses ${usual}`,
  unusualDetails: "Check what it was doing. Mute it there if this is expected.",
  linkSlower: (name: string, now: number, best: number) => `${name}'s link fell to ${now} Mb, from ${best} Mb`,
  linkSlowerDetails: "A cable or port is the usual cause.",
  internetDown: (state: string) => `The internet is down: ${state}`,
  internetDownDetails: "Autoheal's own check and the router agree on this. It clears when the line is back.",
  firmware: (name: string, version: string) => `${name} has an update${version === "" ? "" : `: ${version}`}`,
  firmwareDetails: "Apply it in UniFi. Autoheal only reads from the router.",
  exposure: "The router's rules or port forwards changed",
  exposureDetails: "See what changed on the Network page, under Firewall, and confirm it if you made it.",
  routerProblem: (problem: string) => `Autoheal cannot read the router: ${problem}`,
  routerProblemDetails: "Check the connection in Settings > Connections.",
  logsStopped: "The router's log export stopped arriving",
  logsStoppedDetails: "Autoheal has no firewall evidence until it comes back.",
  crossing: (source: string, destination: string) =>
    `${source} reached ${destination} for the first time, across networks`,
  crossingDetails:
    "Seen in the router's log lines, which anything on your network can send in its name. It clears after a day. Check it is expected.",
  evidence: (lines: readonly string[]) => `Network around that time:\n${lines.join("\n")}`,
  evidenceDropped: (name: string, at: string) => `${at}: ${name} dropped off the network.`,
  evidenceReturned: (name: string, at: string) => `${at}: ${name} came back.`,
  evidenceLink: (name: string, at: string, detail: string) => `${at}: ${name}'s link changed: ${detail}.`,
  evidenceOutage: (at: string, state: string) => `${at}: internet outage: ${state}.`,
  speedNotSaid: "not said",
  loginRefused: "the router refused the login",
  certificateChanged: "the router's certificate changed",
  routerTooSlow: "The router took too long to answer.",
  routerAnswerTooLarge: "The router's answer was larger than Autoheal reads, so it was let go.",
  routerReadStopped: "Autoheal stopped waiting for the router's answer.",
  routerAnswered: (status: number, path: string) => `The router answered ${status} for ${path}`,
  reportFailed: (reason: string) =>
    `Ollama could not write this week's words (${reason}). The figures are still right.`,
  reportTitle: "This week on your network",
} as const;

export const INTERNET_STATE_WORDS: Record<InternetState, string> = {
  up: "up",
  on_second_line: "moved to the second line",
  line_down: "the provider's line is down",
  nothing_gets_out: "the router says up, but nothing gets out",
  router_down: "the router is down, or this machine's link is",
  dashboard_only: "the dashboard cannot reach the router, but the internet is fine",
};

/** A device's name as it may be shown or sent anywhere: anyone on the Wi-Fi can call theirs anything. */
export const cleanName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, NETWORK_LIMITS.nameCharacters);
