import { createHash } from "node:crypto";
import { NETWORK_LIMITS, type NetworkOutageView, type SpeedSource, type SpeedTestView } from "../../shared/network.js";
import type { DatabaseHandle } from "../database/connection.js";
import type { ExposureSnapshot, RouterClient } from "./router-adapter.js";
import { isDown } from "./network-rules.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// A longer gap in the readings ends an outage: Autoheal was not watching, so it cannot say.
const SAMPLE_GAP_MILLISECONDS = 3 * 60_000;

export interface DeviceRow {
  mac: string;
  name: string;
  given_name: string | null;
  network: string | null;
  ip: string | null;
  wired: number;
  uplink: string | null;
  uplink_port: number | null;
  signal: number | null;
  link_mbps: number | null;
  best_link_mbps: number | null;
  first_seen: number;
  last_seen: number;
  online: number;
  known: number;
  muted: number;
}

export const hourOf = (at: number) => at - (at % HOUR);

/** The network's history, kept small: hourly totals, not readings, each table swept to its own limit. */
export class NetworkStore {
  constructor(private readonly handle: DatabaseHandle) {}

  private get sqlite() {
    return this.handle.sqlite;
  }

  devices(): DeviceRow[] {
    return this.sqlite.prepare("SELECT * FROM network_devices").all() as DeviceRow[];
  }

  device(mac: string): DeviceRow | undefined {
    return this.sqlite.prepare("SELECT * FROM network_devices WHERE mac = ?").get(mac) as DeviceRow | undefined;
  }

  hasAnyDevice(): boolean {
    return this.sqlite.prepare("SELECT 1 FROM network_devices LIMIT 1").get() !== undefined;
  }

  watchedSince(): number | null {
    const row = this.sqlite.prepare("SELECT MIN(first_seen) AS at FROM network_devices").get() as { at: number | null };
    return row.at;
  }

  /** Writes what the router says of a device now. Whether it is known is a person's, and stays. */
  saveClient(client: RouterClient, uplink: string | null, linkMbps: number | null, at: number, known: boolean) {
    this.sqlite
      .prepare(
        `INSERT INTO network_devices
           (mac, name, network, ip, wired, uplink, uplink_port, signal, link_mbps, best_link_mbps, first_seen, last_seen, online, known)
         VALUES (@mac, @name, @network, @ip, @wired, @uplink, @port, @signal, @link, @link, @at, @at, 1, @known)
         ON CONFLICT (mac) DO UPDATE SET name = @name, network = @network, ip = @ip, wired = @wired, uplink = @uplink,
           uplink_port = @port, signal = @signal, link_mbps = @link,
           best_link_mbps = MAX(COALESCE(best_link_mbps, 0), COALESCE(@link, 0)), last_seen = @at, online = 1`,
      )
      .run({
        mac: client.mac,
        name: client.name,
        network: client.network,
        ip: client.ip,
        wired: client.wired ? 1 : 0,
        uplink,
        port: client.uplinkPort,
        signal: client.signal,
        link: linkMbps,
        at,
        known: known ? 1 : 0,
      });
  }

  setOffline(mac: string) {
    this.sqlite.prepare("UPDATE network_devices SET online = 0 WHERE mac = ?").run(mac);
  }

  changeDevice(mac: string, change: { givenName?: string | null; known?: boolean; muted?: boolean }) {
    if (change.givenName !== undefined) {
      this.sqlite.prepare("UPDATE network_devices SET given_name = ? WHERE mac = ?").run(change.givenName || null, mac);
    }
    if (change.known !== undefined) {
      this.sqlite.prepare("UPDATE network_devices SET known = ? WHERE mac = ?").run(change.known ? 1 : 0, mac);
    }
    if (change.muted !== undefined) {
      this.sqlite.prepare("UPDATE network_devices SET muted = ? WHERE mac = ?").run(change.muted ? 1 : 0, mac);
    }
  }

  addUsage(mac: string, at: number, received: number, sent: number) {
    this.sqlite
      .prepare(
        `INSERT INTO network_usage_hours (mac, hour, received, sent) VALUES (?, ?, ?, ?)
         ON CONFLICT (mac, hour) DO UPDATE SET received = received + excluded.received, sent = sent + excluded.sent`,
      )
      .run(mac, hourOf(at), received, sent);
  }

  usageBetween(from: number, to: number): Map<string, number> {
    const rows = this.sqlite
      .prepare(
        "SELECT mac, SUM(received + sent) AS bytes FROM network_usage_hours WHERE hour >= ? AND hour < ? GROUP BY mac",
      )
      .all(hourOf(from), to) as { mac: string; bytes: number }[];
    return new Map(rows.map(({ mac, bytes }) => [mac, bytes]));
  }

  /** How much of its time since first seen, over a week, a device has been there. */
  presentShare(mac: string, firstSeen: number, at: number): number {
    const since = Math.max(firstSeen, at - 7 * DAY);
    const hours = Math.max(1, Math.ceil((at - since) / HOUR));
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS seen FROM network_usage_hours WHERE mac = ? AND hour >= ?")
      .get(mac, hourOf(since)) as { seen: number };
    return row.seen / hours;
  }

  addEvent(kind: string, mac: string | null, at: number, detail = "") {
    this.sqlite
      .prepare("INSERT INTO network_events (kind, mac, at, detail) VALUES (?, ?, ?, ?)")
      .run(kind, mac, at, detail);
  }

  eventsSince(kind: string, since: number): { mac: string | null; at: number; detail: string }[] {
    return this.sqlite
      .prepare("SELECT mac, at, detail FROM network_events WHERE kind = ? AND at >= ? ORDER BY at")
      .all(kind, since) as { mac: string | null; at: number; detail: string }[];
  }

  eventsBetween(from: number, to: number): { kind: string; mac: string | null; at: number; detail: string }[] {
    return this.sqlite
      .prepare("SELECT kind, mac, at, detail FROM network_events WHERE at >= ? AND at <= ? ORDER BY at")
      .all(from, to) as { kind: string; mac: string | null; at: number; detail: string }[];
  }

  countsSince(kind: string, since: number): Map<string, number> {
    const rows = this.sqlite
      .prepare(
        "SELECT mac, COUNT(*) AS times FROM network_events WHERE kind = ? AND at >= ? AND mac IS NOT NULL GROUP BY mac",
      )
      .all(kind, since) as { mac: string; times: number }[];
    return new Map(rows.map(({ mac, times }) => [mac, times]));
  }

  addSample(at: number, up: boolean, latency: number | null, state: string) {
    this.sqlite
      .prepare("INSERT OR REPLACE INTO internet_samples (at, wan, up, latency, state) VALUES (?, 'internet', ?, ?, ?)")
      .run(at, up ? 1 : 0, latency, state);
  }

  /** Up as a share of the minutes Autoheal watched. Time it was off is not counted either way. */
  uptime(since: number): { percent: number | null; downMinutes: number } {
    const rows = this.sqlite.prepare("SELECT state FROM internet_samples WHERE at >= ?").all(since) as {
      state: string;
    }[];
    if (rows.length === 0) return { percent: null, downMinutes: 0 };
    const down = rows.filter(({ state }) => isDown(state)).length;
    return { percent: ((rows.length - down) / rows.length) * 100, downMinutes: down };
  }

  outages(since: number): NetworkOutageView[] {
    const rows = this.sqlite.prepare("SELECT at, state FROM internet_samples WHERE at >= ? ORDER BY at").all(since) as {
      at: number;
      state: string;
    }[];
    const found: NetworkOutageView[] = [];
    let current: NetworkOutageView | null = null;
    let last = 0;
    for (const { at, state } of rows) {
      const gap = last !== 0 && at - last > SAMPLE_GAP_MILLISECONDS;
      if (current !== null && (!isDown(state) || gap)) {
        current.to = gap ? last : at;
        current = null;
      }
      if (current === null && isDown(state)) {
        current = { from: at, to: null, state };
        found.push(current);
      }
      last = at;
    }
    return found.toReversed();
  }

  addSpeedTest(
    test: { at: number; downMbps: number; upMbps: number; ping: number | null },
    busy: number | null,
    fair: boolean,
    source: SpeedSource,
  ) {
    this.sqlite
      .prepare(
        "INSERT OR IGNORE INTO speed_tests (at, down_mbps, up_mbps, ping, busy_mbps, fair, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(test.at, test.downMbps, test.upMbps, test.ping, busy, fair ? 1 : 0, source);
  }

  speedTests(since: number): SpeedTestView[] {
    const rows = this.sqlite
      .prepare("SELECT at, down_mbps, up_mbps, ping, fair, source FROM speed_tests WHERE at >= ? ORDER BY at")
      .all(since) as {
      at: number;
      down_mbps: number;
      up_mbps: number;
      ping: number | null;
      fair: number;
      source: SpeedSource;
    }[];
    return rows.map((row) => ({
      at: row.at,
      downMbps: row.down_mbps,
      upMbps: row.up_mbps,
      ping: row.ping,
      fair: row.fair === 1,
      source: row.source,
    }));
  }

  // The router's own: one this machine measured says nothing of what the router has yet to report.
  lastSpeedTestAt(): number {
    const row = this.sqlite.prepare("SELECT MAX(at) AS at FROM speed_tests WHERE source = 'router'").get() as {
      at: number | null;
    };
    return row.at ?? 0;
  }

  // Sorted, so a list in another order is not a change.
  static exposureHash(snapshot: ExposureSnapshot): string {
    const lines = [...snapshot.rules, ...snapshot.forwards].map((each) => `${each.name}|${each.detail}`).toSorted();
    return createHash("sha256").update(lines.join("\n")).digest("hex");
  }

  latestExposure(): { at: number; hash: string; body: ExposureSnapshot; confirmed: boolean } | null {
    const row = this.sqlite
      .prepare("SELECT at, hash, body_json AS body, confirmed FROM exposure_snapshots ORDER BY at DESC LIMIT 1")
      .get() as { at: number; hash: string; body: string; confirmed: number } | undefined;
    return row === undefined
      ? null
      : { at: row.at, hash: row.hash, body: JSON.parse(row.body) as ExposureSnapshot, confirmed: row.confirmed === 1 };
  }

  confirmedExposure(): ExposureSnapshot | null {
    const row = this.sqlite
      .prepare("SELECT body_json AS body FROM exposure_snapshots WHERE confirmed = 1 ORDER BY at DESC LIMIT 1")
      .get() as { body: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.body) as ExposureSnapshot);
  }

  addExposure(at: number, snapshot: ExposureSnapshot, confirmed: boolean) {
    this.sqlite
      .prepare("INSERT OR REPLACE INTO exposure_snapshots (at, hash, body_json, confirmed) VALUES (?, ?, ?, ?)")
      .run(at, NetworkStore.exposureHash(snapshot), JSON.stringify(snapshot), confirmed ? 1 : 0);
  }

  confirmLatestExposure() {
    this.sqlite
      .prepare("UPDATE exposure_snapshots SET confirmed = 1 WHERE at = (SELECT MAX(at) FROM exposure_snapshots)")
      .run();
  }

  addFlow(at: number, source: string, destination: string, port: number, blocked: boolean) {
    this.sqlite
      .prepare(
        `INSERT INTO network_flows (hour, source, destination, port, blocked, lines) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (hour, source, destination, port, blocked) DO UPDATE SET lines = lines + 1`,
      )
      .run(hourOf(at), source, destination, port, blocked ? 1 : 0);
  }

  flows(since: number): { source: string; destination: string; port: number; blocked: number; lines: number }[] {
    return this.sqlite
      .prepare(
        `SELECT source, destination, port, blocked, SUM(lines) AS lines FROM network_flows WHERE hour >= ?
         GROUP BY source, destination, port, blocked ORDER BY lines DESC LIMIT ?`,
      )
      .all(hourOf(since), NETWORK_LIMITS.flowsListed) as {
      source: string;
      destination: string;
      port: number;
      blocked: number;
      lines: number;
    }[];
  }

  blockedSince(since: number): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(SUM(lines), 0) AS total FROM network_flows WHERE hour >= ? AND blocked = 1")
      .get(hourOf(since)) as { total: number };
    return row.total;
  }

  flowSeenBefore(source: string, destination: string): boolean {
    return (
      this.sqlite
        .prepare("SELECT 1 FROM network_flows WHERE source = ? AND destination = ? AND blocked = 0 LIMIT 1")
        .get(source, destination) !== undefined
    );
  }

  addReport(at: number, body: object) {
    this.sqlite
      .prepare("INSERT OR REPLACE INTO network_reports (at, body_json) VALUES (?, ?)")
      .run(at, JSON.stringify(body));
  }

  reports(): { at: number; body: string }[] {
    return this.sqlite
      .prepare("SELECT at, body_json AS body FROM network_reports ORDER BY at DESC LIMIT ?")
      .all(NETWORK_LIMITS.reportsKept) as { at: number; body: string }[];
  }

  lastReportAt(): number {
    const row = this.sqlite.prepare("SELECT MAX(at) AS at FROM network_reports").get() as { at: number | null };
    return row.at ?? 0;
  }

  /** Each table to its limit. */
  sweep(at: number) {
    const { usageDays, eventDays, sampleDays, speedTestDays, flowDays, exposureKept, reportsKept } = NETWORK_LIMITS;
    const before = (days: number) => at - days * DAY;
    this.sqlite.prepare("DELETE FROM network_usage_hours WHERE hour < ?").run(before(usageDays));
    this.sqlite.prepare("DELETE FROM network_events WHERE at < ?").run(before(eventDays));
    this.sqlite.prepare("DELETE FROM internet_samples WHERE at < ?").run(before(sampleDays));
    this.sqlite.prepare("DELETE FROM speed_tests WHERE at < ?").run(before(speedTestDays));
    this.sqlite.prepare("DELETE FROM network_flows WHERE hour < ?").run(before(flowDays));
    this.sqlite
      .prepare(
        "DELETE FROM exposure_snapshots WHERE at NOT IN (SELECT at FROM exposure_snapshots ORDER BY at DESC LIMIT ?)",
      )
      .run(exposureKept);
    this.sqlite
      .prepare("DELETE FROM network_reports WHERE at NOT IN (SELECT at FROM network_reports ORDER BY at DESC LIMIT ?)")
      .run(reportsKept);
    this.sqlite.prepare("DELETE FROM network_devices WHERE last_seen < ?").run(before(speedTestDays));
  }
}
