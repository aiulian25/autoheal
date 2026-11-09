import type { RouterDeviceKind, RouterProbeView } from "../../shared/network.js";

export interface RouterClient {
  mac: string;
  name: string;
  network: string | null;
  ip: string | null;
  wired: boolean;
  // The switch or access point it is on, by its MAC address.
  uplinkMac: string | null;
  uplinkPort: number | null;
  signal: number | null;
  // In GHz; null on a cable or where it does not say.
  band: string | null;
  received: number;
  sent: number;
}

export interface RouterDevice {
  mac: string;
  name: string;
  kind: RouterDeviceKind;
  model: string | null;
  version: string | null;
  upgradeTo: string | null;
  uplinkMac: string | null;
  ports: { index: number; speedMbps: number; up: boolean }[];
}

export interface InternetHealth {
  lines: { wan: string; up: boolean; latency: number | null }[];
  publicAddress: string | null;
  // Bits a second on the line now, each way together; null when it does not say.
  busyMbps: number | null;
  lastTest: { at: number; downMbps: number; upMbps: number; ping: number | null } | null;
}

export interface ExposureSnapshot {
  rules: { name: string; detail: string }[];
  forwards: { name: string; detail: string }[];
}

/** What any router must say, in plain facts rather than its own shapes. A new kind is one more of these. */
export interface RouterAdapter {
  // Every read tried once, and what the router calls itself and the version it runs, where it says.
  capabilities(): Promise<RouterProbeView>;
  clients(): Promise<RouterClient[]>;
  devices(): Promise<RouterDevice[]>;
  internet(): Promise<InternetHealth>;
  // Null where this router, or this user, does not say.
  exposure(): Promise<ExposureSnapshot | null>;
  // False where this user may not.
  startSpeedTest(): Promise<boolean>;
}

export class RouterLoginRefused extends Error {}
export class RouterCertificateChanged extends Error {}
