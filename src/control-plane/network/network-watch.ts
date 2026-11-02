import { createSocket, type Socket } from "node:dgram";
import { sizeText } from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import {
  CHECK_RESULT,
  INTERNET_PROBES,
  INTERNET_PROBE_TIMEOUT_MILLISECONDS,
  INTERNET_STATE_WORDS,
  SPEED_SOURCE,
  NETWORK_EVENT,
  NETWORK_LIMITS,
  NETWORK_TEXT,
  cleanName,
  isPrivateAddress,
  type InternetState,
  type NetworkDeviceDetailView,
  type NetworkDeviceView,
  type NetworkFirewallView,
  type NetworkInternetView,
  type NetworkMapView,
  type NetworkOverviewView,
} from "../../shared/network.js";
import type { InternetHealth, RouterAdapter, RouterClient, RouterDevice } from "./router-adapter.js";
import { RouterLogSenders, type ResolveRouter } from "./router-log-senders.js";
import { RouterCertificateChanged, RouterLoginRefused } from "./router-adapter.js";
import { type DeviceRow, NetworkStore } from "./network-store.js";
import {
  WEEK_MILLISECONDS,
  addedSince,
  countsForContract,
  flowInLine,
  internetStateOf,
  isDown,
  isFairTest,
  isUnusual,
  usualOf,
} from "./network-rules.js";
import type { RouterSettingsService } from "./router-settings-service.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MONTH_DAYS = 30;
const LOG_QUIET_MILLISECONDS = HOUR;
const LOCAL_ADDRESS = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe80:)/i;
const OUTSIDE = "outside";
const SECOND = 1_000;
const CHECK_KEY = { rules: "rules", logs: "logs", separation: "separation", outside: "outside" } as const;

export const NETWORK_PERIODS = { day: DAY, week: 7 * DAY, month: MONTH_DAYS * DAY } as const;
export type NetworkPeriod = keyof typeof NETWORK_PERIODS;

export interface NetworkFinding {
  key: string;
  title: string;
  description: string;
  id: string;
  label: string;
  urgent: boolean;
}

export interface NetworkWatchDependencies {
  store: NetworkStore;
  settings: Pick<RouterSettingsService, "adapter" | "contract" | "routerHost" | "view">;
  clock: () => number;
  // Autoheal's own check of the internet, which still answers while the router is down.
  ownCheck?: () => Promise<boolean>;
  logPort?: number | null;
  resolveRouter?: ResolveRouter;
}

async function ownCheck(): Promise<boolean> {
  const answers = await Promise.all(
    INTERNET_PROBES.map((url) =>
      fetch(url, { method: "HEAD", signal: AbortSignal.timeout(INTERNET_PROBE_TIMEOUT_MILLISECONDS) }).then(
        () => true,
        () => false,
      ),
    ),
  );
  return answers.some(Boolean);
}

const nameOf = (row: DeviceRow) => cleanName(row.given_name ?? row.name) || row.mac;
const BUSY_READINGS = 3;

/** Reads the router each minute, and turns differences between readings into what happened. It never writes to it. */
export class NetworkWatch {
  private lastCounters = new Map<string, { received: number; sent: number }>();
  private missing = new Map<string, number>();
  private polls = 0;
  private problem: string | null = null;
  private reachable = false;
  private lastDevices: RouterDevice[] = [];
  private lastBands = new Map<string, string | null>();
  private recentBusy: number[] = [];
  private lastInternet: InternetHealth | null = null;
  private exposureReadable = false;
  private speedTestRefused = false;
  private lastSpeedTestAsked = 0;
  private logLastAt: number | null = null;
  private logWindow = { second: 0, lines: 0 };
  private logRefused: { sender: string; at: number } | null = null;
  private receiver: Socket | null = null;
  private readonly logSenders: RouterLogSenders;

  constructor(private readonly dependencies: NetworkWatchDependencies) {
    this.logSenders = new RouterLogSenders(
      () => dependencies.settings.routerHost(),
      dependencies.clock,
      dependencies.resolveRouter,
    );
  }

  private get store() {
    return this.dependencies.store;
  }

  private now() {
    return this.dependencies.clock();
  }

  reset() {
    this.lastCounters.clear();
    this.missing.clear();
    this.problem = null;
    this.reachable = false;
    this.lastDevices = [];
    this.lastInternet = null;
    this.lastBands.clear();
    this.recentBusy = [];
    this.speedTestRefused = false;
    this.logRefused = null;
  }

  async tick() {
    const adapter = this.dependencies.settings.adapter();
    if (adapter === null) {
      this.reachable = false;
      this.problem = null;
      return;
    }
    const at = this.now();
    this.polls += 1;
    const [works] = await Promise.all([
      (this.dependencies.ownCheck ?? ownCheck)().catch(() => false),
      this.dependencies.logPort == null ? undefined : this.logSenders.refresh(),
    ]);
    try {
      const [clients, devices, internet] = await Promise.all([
        adapter.clients(),
        adapter.devices(),
        adapter.internet(),
      ]);
      this.reachable = true;
      this.problem = null;
      this.lastDevices = devices;
      this.lastInternet = internet;
      this.lastBands = new Map(clients.map(({ mac, band }) => [mac, band]));
      if (internet.busyMbps !== null) this.recentBusy = [...this.recentBusy, internet.busyMbps].slice(-BUSY_READINGS);
      this.record(clients, devices, at);
      this.recordInternet(internet.lines, internet.lines[0]?.latency ?? null, true, works, at);
      await this.recordSpeed(adapter, internet, at);
      if (this.polls % NETWORK_LIMITS.exposureEveryPolls === 1) await this.recordExposure(adapter, at);
    } catch (error) {
      // No reading is no news of any device: an unreachable router makes nothing look dropped.
      this.reachable = false;
      this.problem = this.problemIn(error);
      this.recordInternet([], null, false, works, at);
    }
    this.store.sweep(at);
  }

  private problemIn(error: unknown): string {
    if (error instanceof RouterLoginRefused) return NETWORK_TEXT.loginRefused;
    if (error instanceof RouterCertificateChanged) return NETWORK_TEXT.certificateChanged;
    return describeError(error);
  }

  private linkOf(client: RouterClient, devices: readonly RouterDevice[]): number | null {
    if (!client.wired || client.uplinkPort === null) return null;
    const uplink = devices.find(({ mac }) => mac === client.uplinkMac);
    return uplink?.ports.find(({ index }) => index === client.uplinkPort)?.speedMbps || null;
  }

  private record(clients: readonly RouterClient[], devices: readonly RouterDevice[], at: number) {
    const { store } = this;
    // Everything on the first reading is what is already there: it is not a flood of news.
    const firstConnection = !store.hasAnyDevice();
    const seen = new Set(clients.map(({ mac }) => mac));
    for (const client of clients) {
      const before = store.device(client.mac);
      const uplink = devices.find(({ mac }) => mac === client.uplinkMac)?.name ?? null;
      const link = this.linkOf(client, devices);
      if (before !== undefined && before.online === 0) store.addEvent(NETWORK_EVENT.returned, client.mac, at);
      if (before === undefined && !firstConnection)
        store.addEvent(NETWORK_EVENT.joined, client.mac, at, client.network ?? "");
      if (before?.link_mbps != null && link !== null && link !== before.link_mbps) {
        store.addEvent(NETWORK_EVENT.linkSlower, client.mac, at, `${before.link_mbps} to ${link} Mb`);
      }
      store.saveClient(client, uplink, link, at, firstConnection);
      const counters = this.lastCounters.get(client.mac);
      store.addUsage(
        client.mac,
        at,
        addedSince(counters?.received, client.received),
        addedSince(counters?.sent, client.sent),
      );
      this.lastCounters.set(client.mac, { received: client.received, sent: client.sent });
      this.missing.delete(client.mac);
    }
    for (const row of store.devices()) {
      if (row.online === 0 || seen.has(row.mac)) continue;
      const misses = (this.missing.get(row.mac) ?? 0) + 1;
      this.missing.set(row.mac, misses);
      if (misses < NETWORK_LIMITS.dropAfterReadings) continue;
      store.setOffline(row.mac);
      store.addEvent(NETWORK_EVENT.dropped, row.mac, at);
      this.lastCounters.delete(row.mac);
      this.missing.delete(row.mac);
    }
  }

  private recordInternet(
    lines: readonly { wan: string; up: boolean }[],
    latency: number | null,
    routerAnswers: boolean,
    works: boolean,
    at: number,
  ) {
    const state: InternetState = internetStateOf(routerAnswers, lines, works);
    this.store.addSample(at, !isDown(state), latency, state);
  }

  /** The quietest of the last few readings: the line right after a test still shows that test's own traffic. */
  quietBusyMbps(): number | null {
    return this.recentBusy.length === 0 ? null : Math.min(...this.recentBusy);
  }

  private async recordSpeed(adapter: RouterAdapter, internet: InternetHealth, at: number) {
    const contract = this.dependencies.settings.contract();
    const last = internet.lastTest;
    if (last !== null && last.at > this.store.lastSpeedTestAt()) {
      const busy = this.quietBusyMbps();
      this.store.addSpeedTest(last, busy, isFairTest(busy, contract?.downMbps ?? null), SPEED_SOURCE.router);
    }
    if (contract === null || this.speedTestRefused) return;
    const due =
      at - Math.max(this.lastSpeedTestAsked, this.store.lastSpeedTestAt()) >= DAY / NETWORK_LIMITS.speedTestsADay;
    // A busy line would only give an unfair test: it waits for a quiet minute.
    if (!due || !isFairTest(internet.busyMbps, contract.downMbps)) return;
    this.lastSpeedTestAsked = at;
    const allowed = await adapter.startSpeedTest().catch(() => false);
    if (!allowed) this.speedTestRefused = true;
  }

  private async recordExposure(adapter: RouterAdapter, at: number) {
    const snapshot = await adapter.exposure().catch(() => null);
    this.exposureReadable = snapshot !== null;
    if (snapshot === null) return;
    const latest = this.store.latestExposure();
    if (latest?.hash === NetworkStore.exposureHash(snapshot)) return;
    // The first look is what is already there.
    this.store.addExposure(at, snapshot, latest === null);
    if (latest !== null) this.store.addEvent(NETWORK_EVENT.exposureChanged, null, at);
  }

  // --- the router's log export -------------------------------------------------------------------------

  /** Listens only if asked to, and only to the router's own addresses. */
  startLogReceiver() {
    const { logPort } = this.dependencies;
    if (logPort == null || this.receiver !== null) return;
    const socket = createSocket("udp4");
    socket.on("message", (message, sender) => this.logLine(String(message), sender.address));
    socket.on("error", () => socket.close());
    socket.bind(logPort);
    this.receiver = socket;
    void this.logSenders.refresh();
  }

  stopLogReceiver() {
    this.receiver?.close();
    this.receiver = null;
  }

  /** One line from the network: refused unless from the router, capped in length and in rate, and only ever counted. */
  logLine(line: string, sender: string) {
    const at = this.now();
    if (!this.logSenders.allows(sender)) {
      this.logRefused = { sender, at };
      return;
    }
    const second = Math.floor(at / SECOND);
    if (this.logWindow.second !== second) this.logWindow = { second, lines: 0 };
    this.logWindow.lines += 1;
    if (this.logWindow.lines > NETWORK_LIMITS.logLinesASecond) return;
    this.logLastAt = at;
    const flow = flowInLine(line.slice(0, NETWORK_LIMITS.logLineCharacters));
    if (flow === null) return;
    // Scans from outside would fill the table one address at a time, so they count as one.
    const source = LOCAL_ADDRESS.test(flow.source) ? flow.source : OUTSIDE;
    const destination = LOCAL_ADDRESS.test(flow.destination) ? flow.destination : OUTSIDE;
    if (!flow.blocked) this.noteFirstCrossing(source, destination, at);
    this.store.addFlow(at, source, destination, flow.port, flow.blocked);
  }

  private noteFirstCrossing(source: string, destination: string, at: number) {
    if (source === OUTSIDE || destination === OUTSIDE || this.store.flowSeenBefore(source, destination)) return;
    const rows = this.store.devices();
    const from = rows.find(({ ip }) => ip === source);
    const to = rows.find(({ ip }) => ip === destination);
    if (from === undefined || to === undefined || from.network === to.network) return;
    this.store.addEvent(NETWORK_EVENT.flowNew, from.mac, at, `${nameOf(from)}|${nameOf(to)}`);
  }

  // --- views -------------------------------------------------------------------------------------------

  private earlierWeeks(span: number, at: number) {
    return Array.from({ length: NETWORK_LIMITS.usualWeeks }, (_, index) => {
      const end = at - (index + 1) * WEEK_MILLISECONDS;
      return this.store.usageBetween(end - span, end);
    });
  }

  private viewOf(
    row: DeviceRow,
    at: number,
    usage: Map<string, number>,
    drops: Map<string, number>,
    earlierWeeks: readonly Map<string, number>[],
  ): NetworkDeviceView {
    const bytes = usage.get(row.mac) ?? 0;
    const usual = usualOf(
      earlierWeeks.map((week) => week.get(row.mac)),
      row.first_seen,
      at,
    );
    const dropCount = drops.get(row.mac) ?? 0;
    const alwaysThere =
      row.wired === 1 || this.store.presentShare(row.mac, row.first_seen, at) >= NETWORK_LIMITS.alwaysOnShare;
    return {
      mac: row.mac,
      name: nameOf(row),
      network: row.network,
      ip: row.ip,
      wired: row.wired === 1,
      uplink: row.uplink,
      uplinkPort: row.uplink_port,
      signal: row.signal,
      online: row.online === 1,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      known: row.known === 1,
      muted: row.muted === 1,
      privateAddress: isPrivateAddress(row.mac),
      periodBytes: bytes,
      usualBytes: usual,
      unusual: isUnusual(bytes, usual),
      drops: dropCount,
      oftenDrops: alwaysThere && dropCount >= NETWORK_LIMITS.dropsToTell,
      linkMbps: row.link_mbps,
      bestLinkMbps: row.best_link_mbps,
    };
  }

  devices(period: NetworkPeriod = "day"): NetworkDeviceView[] {
    const at = this.now();
    const span = NETWORK_PERIODS[period];
    const usage = this.store.usageBetween(at - span, at + HOUR);
    const drops = this.store.countsSince(NETWORK_EVENT.dropped, at - span);
    const earlierWeeks = this.earlierWeeks(span, at);
    return this.store
      .devices()
      .map((row) => this.viewOf(row, at, usage, drops, earlierWeeks))
      .toSorted((one, other) => other.periodBytes - one.periodBytes)
      .slice(0, NETWORK_LIMITS.listed);
  }

  deviceDetail(mac: string): Omit<NetworkDeviceDetailView, "run"> | null {
    const row = this.store.device(mac);
    if (row === undefined) return null;
    const at = this.now();
    const span = NETWORK_PERIODS.week;
    const usage = this.store.usageBetween(at - span, at + HOUR);
    const drops = this.store.countsSince(NETWORK_EVENT.dropped, at - span);
    const dropTimes = this.store
      .eventsSince(NETWORK_EVENT.dropped, at - span)
      .filter((event) => event.mac === mac)
      .map((event) => event.at);
    const talks = this.store
      .flows(at - span)
      .filter(({ source, destination }) => source === row.ip || destination === row.ip)
      .map(({ source, destination, port, blocked, lines }) => ({
        other: this.labelOf(source === row.ip ? destination : source),
        port,
        lines,
        blocked: blocked === 1,
      }));
    return { device: this.viewOf(row, at, usage, drops, this.earlierWeeks(span, at)), dropTimes, talks };
  }

  private labelOf(address: string) {
    const row = this.store.devices().find(({ ip }) => ip === address);
    return row === undefined ? address : nameOf(row);
  }

  overview(): NetworkOverviewView {
    const at = this.now();
    const month = at - MONTH_DAYS * DAY;
    const devices = this.devices();
    const contract = this.dependencies.settings.contract();
    const tests = this.store.speedTests(month).filter(countsForContract);
    const { percent, downMinutes } = this.store.uptime(month);
    const watchedSince = this.store.watchedSince();
    return {
      connected: this.reachable,
      problem: this.problem,
      watchedSince,
      internet: { upPercent: percent, outages: this.store.outages(month).length, downMinutes },
      contract: {
        contract,
        fair: tests.length,
        downMet: contract === null ? 0 : tests.filter(({ downMbps }) => downMbps >= contract.downMbps).length,
        upMet: contract === null ? 0 : tests.filter(({ upMbps }) => upMbps >= contract.upMbps).length,
      },
      newDevices: devices.filter(({ known }) => !known).length,
      oftenDropping: devices.filter(({ oftenDrops, muted }) => oftenDrops && !muted).map(({ name }) => name),
      unusual: devices.filter(({ unusual, muted }) => unusual && !muted).map(({ name }) => name),
      exposureWaiting: this.exposureWaiting(),
      updates: this.lastDevices.filter(({ upgradeTo }) => upgradeTo !== null).map(({ name }) => cleanName(name)),
      top: devices.slice(0, 5).map(({ name, periodBytes, unusual }) => ({ name, bytes: periodBytes, unusual })),
      toLookAt: this.findings().length,
      learning: watchedSince === null || at - watchedSince < NETWORK_LIMITS.learningDays * DAY,
    };
  }

  private exposureWaiting() {
    const latest = this.store.latestExposure();
    return latest !== null && !latest.confirmed;
  }

  internet(): Omit<NetworkInternetView, "run"> {
    const at = this.now();
    return {
      outages: this.store.outages(at - MONTH_DAYS * DAY),
      tests: this.store.speedTests(at - MONTH_DAYS * DAY),
      contract: this.dependencies.settings.contract(),
      lines: this.lastInternet?.lines ?? [],
      publicAddress: this.lastInternet?.publicAddress ?? null,
      speedTestRefused: this.speedTestRefused,
    };
  }

  /** A plain file of what was measured, to show a provider. */
  internetReport(): string {
    const { outages, tests, contract } = this.internet();
    const date = (at: number) => new Date(at).toISOString();
    return [
      `Contract, Mb down and up: ${contract === null ? "not set" : `${contract.downMbps}, ${contract.upMbps}`}`,
      "",
      "Speed tests: time, down Mb, up Mb, ping ms, measured by, counted (not counted when the line was already busy, or from this machine)",
      ...tests.map((test) =>
        [
          date(test.at),
          test.downMbps,
          test.upMbps,
          test.ping ?? "",
          test.source,
          countsForContract(test) ? "yes" : "no",
        ].join(","),
      ),
      "",
      "Outages: from, to, what",
      ...outages.map(({ from, to, state }) =>
        [date(from), to === null ? "still" : date(to), INTERNET_STATE_WORDS[state as InternetState] ?? state].join(","),
      ),
      "",
      "A speed test measures to a test server, not to what the provider promises.",
      "",
    ].join("\n");
  }

  firewall(): NetworkFirewallView {
    const at = this.now();
    const latest = this.store.latestExposure();
    const confirmed = this.store.confirmedExposure();
    const knownForwards = new Set((confirmed?.forwards ?? []).map(({ name, detail }) => `${name}|${detail}`));
    const flows = this.store.flows(at - NETWORK_PERIODS.week);
    const logging = this.dependencies.logPort != null;
    const logsFresh = this.logLastAt !== null && at - this.logLastAt < LOG_QUIET_MILLISECONDS;
    const rulesResult = () => {
      if (latest === null) return CHECK_RESULT.notTested;
      return latest.confirmed ? CHECK_RESULT.passed : CHECK_RESULT.failed;
    };
    const logsResult = () => {
      if (!logging) return CHECK_RESULT.notTested;
      return logsFresh ? CHECK_RESULT.passed : CHECK_RESULT.failed;
    };
    return {
      rules: latest?.body.rules ?? [],
      forwards: (latest?.body.forwards ?? []).map(({ name, detail }) => ({
        name,
        detail,
        isNew: !latest?.confirmed && !knownForwards.has(`${name}|${detail}`),
      })),
      blocked7Days: logging ? this.store.blockedSince(at - NETWORK_PERIODS.week) : null,
      crossing: flows
        .filter(({ source, destination }) => source !== OUTSIDE && destination !== OUTSIDE)
        .map(({ source, destination, port, lines, blocked }) => ({
          source: this.labelOf(source),
          destination: this.labelOf(destination),
          port,
          lines,
          blocked: blocked === 1,
        })),
      checks: [
        { key: CHECK_KEY.rules, result: rulesResult() },
        { key: CHECK_KEY.logs, result: logsResult() },
        { key: CHECK_KEY.separation, result: CHECK_RESULT.notTested },
        { key: CHECK_KEY.outside, result: CHECK_RESULT.notTested },
      ],
      logLastAt: this.logLastAt,
      logRefusedSender:
        !logsFresh && this.logRefused !== null && at - this.logRefused.at < LOG_QUIET_MILLISECONDS
          ? this.logRefused.sender
          : null,
      logNameUnresolved: this.logSenders.unresolved,
      exposureReadable: this.exposureReadable || latest !== null,
    };
  }

  confirmExposure() {
    this.store.confirmLatestExposure();
  }

  map(): NetworkMapView {
    const at = this.now();
    const rows = this.store.devices();
    const firstTimes = new Set(this.store.eventsSince(NETWORK_EVENT.flowNew, at - DAY).map(({ detail }) => detail));
    const byIp = new Map(rows.flatMap((row) => (row.ip === null ? [] : [[row.ip, row] as const])));
    const idOf = (address: string) => byIp.get(address)?.mac ?? address;
    const flows = this.store.flows(at - NETWORK_PERIODS.week);
    const merged = new Map<string, NetworkMapView["talks"][number]>();
    for (const { source, destination, lines, blocked } of flows) {
      const from = idOf(source);
      const to = idOf(destination);
      const key = JSON.stringify([from, to, blocked]);
      const fromName = byIp.get(source);
      const toName = byIp.get(destination);
      const firstTime =
        fromName !== undefined && toName !== undefined && firstTimes.has(`${nameOf(fromName)}|${nameOf(toName)}`);
      const before = merged.get(key);
      merged.set(key, { from, to, lines: (before?.lines ?? 0) + lines, blocked: blocked === 1, firstTime });
    }
    return {
      infrastructure: this.lastDevices.map(({ mac, name, kind, uplinkMac }) => {
        const uplink = this.lastDevices.find((device) => device.mac === uplinkMac);
        return { id: mac, name: cleanName(name), kind, uplink: uplink === undefined ? null : cleanName(uplink.name) };
      }),
      devices: rows.map((row) => ({
        id: row.mac,
        name: nameOf(row),
        network: row.network,
        ip: row.ip,
        wired: row.wired === 1,
        uplink: row.uplink === null ? null : cleanName(row.uplink),
        uplinkPort: row.uplink_port,
        signal: row.signal,
        band: this.lastBands.get(row.mac) ?? null,
        online: row.online === 1,
      })),
      talks: [...merged.values()],
      flowsAvailable: this.logLastAt !== null,
    };
  }

  // --- findings, and what they tell others ----------------------------------------------------------------

  /** Whether this run could tell if a network task's problem is still there. */
  get judging() {
    return this.reachable || this.dependencies.settings.adapter() === null;
  }

  findings(): NetworkFinding[] {
    const at = this.now();
    const found: NetworkFinding[] = [];
    if (this.problem !== null) {
      found.push({
        key: "router-problem",
        title: NETWORK_TEXT.routerProblem(this.problem),
        description: NETWORK_TEXT.routerProblemDetails,
        id: "router",
        label: "Router",
        urgent: false,
      });
    }
    const devices = this.devices();
    const privateByNetwork = new Map<string, NetworkDeviceView[]>();
    for (const device of devices) {
      const isNew = !device.known;
      const joinedToday = at - device.firstSeen < DAY;
      if (isNew && device.privateAddress && joinedToday) {
        privateByNetwork.set(device.network ?? "", [...(privateByNetwork.get(device.network ?? "") ?? []), device]);
      }
      if (isNew && !device.privateAddress) {
        found.push({
          key: `new:${device.mac}`,
          title: NETWORK_TEXT.newDevice(device.name, device.network),
          description: NETWORK_TEXT.newDeviceDetails(device.ip),
          id: device.mac,
          label: device.name,
          urgent: false,
        });
      }
      if (device.muted) continue;
      if (device.oftenDrops) {
        found.push({
          key: `drops:${device.mac}`,
          title: NETWORK_TEXT.oftenDrops(device.name, device.drops),
          description: NETWORK_TEXT.oftenDropsDetails,
          id: device.mac,
          label: device.name,
          urgent: false,
        });
      }
      if (device.unusual) {
        found.push({
          key: `unusual:${device.mac}`,
          title: NETWORK_TEXT.unusual(device.name, sizeText(device.periodBytes), sizeText(device.usualBytes ?? 0)),
          description: NETWORK_TEXT.unusualDetails,
          id: device.mac,
          label: device.name,
          urgent: false,
        });
      }
      const { linkMbps, bestLinkMbps, online } = device;
      if (online && linkMbps !== null && bestLinkMbps !== null && linkMbps < bestLinkMbps) {
        found.push({
          key: `link:${device.mac}`,
          title: NETWORK_TEXT.linkSlower(device.name, linkMbps, bestLinkMbps),
          description: NETWORK_TEXT.linkSlowerDetails,
          id: device.mac,
          label: device.name,
          urgent: false,
        });
      }
    }
    for (const [network, group] of privateByNetwork) {
      found.push({
        key: `private:${network}`,
        title: NETWORK_TEXT.privateDevices(group.length, network === "" ? null : network),
        description: NETWORK_TEXT.privateDetails,
        id: `private:${network}`,
        label: network,
        urgent: false,
      });
    }
    for (const { mac, name, upgradeTo } of this.lastDevices) {
      if (upgradeTo === null) continue;
      found.push({
        key: `firmware:${mac}`,
        title: NETWORK_TEXT.firmware(cleanName(name), upgradeTo),
        description: NETWORK_TEXT.firmwareDetails,
        id: mac,
        label: cleanName(name),
        urgent: false,
      });
    }
    if (this.exposureWaiting()) {
      found.push({
        key: "exposure",
        title: NETWORK_TEXT.exposure,
        description: NETWORK_TEXT.exposureDetails,
        id: "exposure",
        label: "Firewall",
        urgent: true,
      });
    }
    const current = this.store.outages(at - DAY)[0];
    if (current !== undefined && current.to === null && at - current.from >= NETWORK_LIMITS.outageTellMilliseconds) {
      found.push({
        key: "internet",
        title: NETWORK_TEXT.internetDown(INTERNET_STATE_WORDS[current.state as InternetState] ?? current.state),
        description: NETWORK_TEXT.internetDownDetails,
        id: "internet",
        label: "Internet",
        urgent: true,
      });
    }
    if (this.dependencies.logPort != null && this.logLastAt !== null && at - this.logLastAt > LOG_QUIET_MILLISECONDS) {
      found.push({
        key: "logs",
        title: NETWORK_TEXT.logsStopped,
        description: NETWORK_TEXT.logsStoppedDetails,
        id: "logs",
        label: "Firewall",
        urgent: false,
      });
    }
    for (const { mac, detail } of this.store.eventsSince(NETWORK_EVENT.flowNew, at - DAY)) {
      const [from = "", to = ""] = detail.split("|");
      found.push({
        key: `crossing:${mac}:${to}`,
        title: NETWORK_TEXT.crossing(from, to),
        description: NETWORK_TEXT.crossingDetails,
        id: mac ?? "crossing",
        label: from,
        urgent: false,
      });
    }
    return found;
  }

  /**
   * What the network did just before a container failed, from the record alone, whichever model reads it. Measured
   * facts; a host is found by its address. Null when nothing happened near it.
   */
  evidenceFor(hostAddress: string | null, containerName: string, at: number): string | null {
    const from = at - NETWORK_LIMITS.evidenceMilliseconds;
    const device = hostAddress === null ? undefined : this.store.devices().find(({ ip }) => ip === hostAddress);
    const time = (when: number) => new Date(when).toISOString();
    const lines: string[] = [];
    for (const event of this.store.eventsBetween(from, at)) {
      if (device === undefined || event.mac !== device.mac) continue;
      if (event.kind === NETWORK_EVENT.dropped)
        lines.push(NETWORK_TEXT.evidenceDropped(nameOf(device), time(event.at)));
      if (event.kind === NETWORK_EVENT.returned)
        lines.push(NETWORK_TEXT.evidenceReturned(nameOf(device), time(event.at)));
      if (event.kind === NETWORK_EVENT.linkSlower) {
        lines.push(NETWORK_TEXT.evidenceLink(nameOf(device), time(event.at), event.detail));
      }
    }
    for (const outage of this.store.outages(from)) {
      lines.push(
        NETWORK_TEXT.evidenceOutage(
          time(outage.from),
          INTERNET_STATE_WORDS[outage.state as InternetState] ?? outage.state,
        ),
      );
    }
    if (lines.length === 0) return null;
    this.store.addEvent(NETWORK_EVENT.incidentLinked, device?.mac ?? null, at, `${containerName}|${lines[0]}`);
    return NETWORK_TEXT.evidence(lines);
  }
}
