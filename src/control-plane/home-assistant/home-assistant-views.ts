import type {
  HomeAssistantSummaryView,
  HomeAssistantSystemView,
  HomeAssistantUpdateView,
  SafetyDeviceView,
  WatchedDeviceView,
  WatchedProblemView,
  ZigbeeDeviceView,
} from "../../shared/api.js";
import {
  BOX_UPDATE_PLATFORMS,
  DATA_RATE_BYTES,
  DATA_SIZE_BYTES,
  PERCENT,
  DEVICE_CLASSES,
  ENTITY_DOMAIN_SEPARATOR,
  ENTITY_DOMAINS,
  ENTITY_STATES,
  LINK_QUALITY_TRANSLATION_KEY,
  LINK_QUALITY_UNIQUE_ID_SUFFIX,
  LOW_BATTERY_PERCENT,
  SAFETY_DEVICE_CLASSES,
  SAFETY_PROBLEMS,
  SUPERVISOR_PLATFORM,
  SUPERVISOR_UPDATES,
  SYSTEM_MONITOR_PLATFORM,
  SYSTEM_MONITOR_SENSORS,
  VIRTUAL_INTERFACE,
  WATCHED_INTEGRATIONS,
  WATCHED_PROBLEMS,
  WEAK_LINK_QUALITY,
  ZIGBEE_INTEGRATION,
  ZIGBEE_PROBLEMS,
  ZIGBEE_ROLES,
  type SafetyProblem,
  type WatchedProblem,
  type ZigbeeProblem,
  type ZigbeeRole,
} from "../../shared/constants.js";
import { webLinkOf } from "../../shared/urls.js";

// The parts of Home Assistant's registries and states Autoheal reads, as its WebSocket API sends them.

export interface AreaEntry {
  area_id: string;
  name: string;
}

export interface DeviceEntry {
  id: string;
  name: string | null;
  name_by_user: string | null;
  manufacturer: string | null;
  model: string | null;
  area_id: string | null;
  identifiers: [string, string][];
  via_device_id: string | null;
  disabled_by: string | null;
}

export interface EntityEntry {
  entity_id: string;
  device_id: string | null;
  platform: string;
  unique_id: string;
  disabled_by: string | null;
  translation_key: string | null;
}

export interface StateEntry {
  entity_id: string;
  state: string;
  attributes: {
    device_class?: string;
    friendly_name?: string;
    unit_of_measurement?: string;
    // An update entity's: what it updates, from which version to which, and where it says what changed.
    title?: string;
    installed_version?: string | null;
    latest_version?: string | null;
    release_url?: string | null;
  };
  last_updated: string;
  last_reported?: string;
}

interface HomeAssistantSnapshot {
  areas: ReadonlyMap<string, string>;
  devices: readonly DeviceEntry[];
  entities: readonly EntityEntry[];
  states: ReadonlyMap<string, StateEntry>;
}

interface DeviceWithStates {
  device: DeviceEntry;
  entities: EntityEntry[];
  states: StateEntry[];
}

const domainOf = (entityId: string) => entityId.slice(0, entityId.indexOf(ENTITY_DOMAIN_SEPARATOR));
const isPresent = <Value>(value: Value | null | undefined): value is Value => value !== null && value !== undefined;
const nameOf = (device: DeviceEntry) => device.name_by_user ?? device.name ?? device.id;
const isUnavailable = (state: StateEntry) => state.state === ENTITY_STATES.unavailable;
const isBinarySensor = (state: StateEntry, deviceClass: string) =>
  domainOf(state.entity_id) === ENTITY_DOMAINS.binarySensor && state.attributes.device_class === deviceClass;
const countOf = <Item>(items: readonly Item[], predicate: (item: Item) => boolean) => items.filter(predicate).length;
const byAreaThenName = (first: { area: string | null; name: string }, second: { area: string | null; name: string }) =>
  (first.area ?? "").localeCompare(second.area ?? "") || first.name.localeCompare(second.name);

function numberOf(state: StateEntry | undefined): number | null {
  const value = Number(state?.state);
  return state === undefined || !Number.isFinite(value) ? null : value;
}

// Null when no entity of the device reports a state: nothing says either way.
const availabilityOf = (states: readonly StateEntry[]) =>
  states.length === 0 ? null : states.some((state) => !isUnavailable(state));

function lastSeenOf(states: readonly StateEntry[]): number | null {
  const moments = states
    .map((state) => Date.parse(state.last_reported ?? state.last_updated))
    .filter((moment) => Number.isFinite(moment));
  return moments.length === 0 ? null : Math.max(...moments);
}

// True when any reporting sensor is on, false when all are off, null when none reports.
function anyOn(sensors: readonly StateEntry[]): boolean | null {
  const reporting = sensors.filter((sensor) => !isUnavailable(sensor));
  return reporting.length === 0 ? null : reporting.some((sensor) => sensor.state === ENTITY_STATES.on);
}

function devicesWithStates(snapshot: HomeAssistantSnapshot): DeviceWithStates[] {
  const entitiesByDevice = new Map<string, EntityEntry[]>();
  for (const entity of snapshot.entities) {
    if (entity.device_id === null || entity.disabled_by !== null) {
      continue;
    }
    const known = entitiesByDevice.get(entity.device_id);
    if (known === undefined) {
      entitiesByDevice.set(entity.device_id, [entity]);
      continue;
    }
    known.push(entity);
  }
  return snapshot.devices
    .filter((device) => device.disabled_by === null)
    .map((device) => {
      const entities = entitiesByDevice.get(device.id) ?? [];
      const states = entities.map((entity) => snapshot.states.get(entity.entity_id)).filter(isPresent);
      return { device, entities, states };
    });
}

const areaOf = (snapshot: HomeAssistantSnapshot, device: DeviceEntry) =>
  device.area_id === null ? null : (snapshot.areas.get(device.area_id) ?? null);

const isZigbee = (device: DeviceEntry) => device.identifiers.some(([domain]) => domain === ZIGBEE_INTEGRATION);

const isLinkQuality = (entity: EntityEntry) =>
  entity.translation_key === LINK_QUALITY_TRANSLATION_KEY || entity.unique_id.endsWith(LINK_QUALITY_UNIQUE_ID_SUFFIX);

const batteryOf = (states: readonly StateEntry[]) =>
  states.find(
    (state) =>
      domainOf(state.entity_id) === ENTITY_DOMAINS.sensor && state.attributes.device_class === DEVICE_CLASSES.battery,
  );

// Battery devices sleep and relay nothing; mains-powered ones route for the rest of the mesh.
function roleOf(device: DeviceEntry, coordinators: ReadonlySet<string>, battery: StateEntry | undefined): ZigbeeRole {
  if (coordinators.has(device.id)) {
    return ZIGBEE_ROLES.coordinator;
  }
  return battery === undefined ? ZIGBEE_ROLES.router : ZIGBEE_ROLES.endDevice;
}

type ZigbeeSignals = Pick<ZigbeeDeviceView, "available" | "batteryPercent" | "linkQuality">;

function zigbeeProblemsOf(device: ZigbeeSignals): ZigbeeProblem[] {
  const checks: [boolean, ZigbeeProblem][] = [
    [device.available === false, ZIGBEE_PROBLEMS.unavailable],
    [device.batteryPercent !== null && device.batteryPercent < LOW_BATTERY_PERCENT, ZIGBEE_PROBLEMS.lowBattery],
    [device.linkQuality !== null && device.linkQuality < WEAK_LINK_QUALITY, ZIGBEE_PROBLEMS.weakLink],
  ];
  return checks.filter(([present]) => present).map(([, problem]) => problem);
}

type SafetySignals = Pick<SafetyDeviceView, "alarm" | "available" | "online" | "batteryLow" | "fault">;

function safetyProblemsOf(device: SafetySignals): SafetyProblem[] {
  const checks: [boolean, SafetyProblem][] = [
    [device.alarm, SAFETY_PROBLEMS.alarm],
    [device.available === false, SAFETY_PROBLEMS.unavailable],
    [device.online === false, SAFETY_PROBLEMS.offline],
    [device.batteryLow === true, SAFETY_PROBLEMS.batteryLow],
    [device.fault === true, SAFETY_PROBLEMS.fault],
  ];
  return checks.filter(([present]) => present).map(([, problem]) => problem);
}

export function zigbeeDevices(snapshot: HomeAssistantSnapshot): ZigbeeDeviceView[] {
  const zigbee = devicesWithStates(snapshot).filter(({ device }) => isZigbee(device));
  const coordinators = new Set(zigbee.map(({ device }) => device.via_device_id).filter(isPresent));
  return zigbee
    .map(({ device, entities, states }) => {
      const battery = batteryOf(states);
      const linkQualityEntity = entities.find(isLinkQuality);
      const linkQualityState =
        linkQualityEntity === undefined ? undefined : snapshot.states.get(linkQualityEntity.entity_id);
      const signals = {
        available: availabilityOf(states),
        batteryPercent: numberOf(battery),
        linkQuality: numberOf(linkQualityState),
      };
      return {
        id: device.id,
        name: nameOf(device),
        area: areaOf(snapshot, device),
        manufacturer: device.manufacturer,
        model: device.model,
        role: roleOf(device, coordinators, battery),
        ...signals,
        lastSeen: lastSeenOf(states),
        problems: zigbeeProblemsOf(signals),
      };
    })
    .sort(byAreaThenName);
}

/** Smoke, gas, CO and heat alarms, with what their own sensors say about them. */
export function safetyDevices(snapshot: HomeAssistantSnapshot): SafetyDeviceView[] {
  return devicesWithStates(snapshot)
    .map(({ device, states }) => ({
      device,
      states,
      alarms: states.filter(
        (state) =>
          domainOf(state.entity_id) === ENTITY_DOMAINS.binarySensor &&
          SAFETY_DEVICE_CLASSES.has(state.attributes.device_class ?? ""),
      ),
    }))
    .filter(({ alarms }) => alarms.length > 0)
    .map(({ device, states, alarms }) => {
      const signals = {
        available: availabilityOf(states),
        alarm: alarms.some((alarm) => alarm.state === ENTITY_STATES.on),
        online: anyOn(states.filter((state) => isBinarySensor(state, DEVICE_CLASSES.connectivity))),
        batteryLow: anyOn(states.filter((state) => isBinarySensor(state, DEVICE_CLASSES.battery))),
        fault: anyOn(states.filter((state) => isBinarySensor(state, DEVICE_CLASSES.problem))),
      };
      return {
        id: device.id,
        name: nameOf(device),
        area: areaOf(snapshot, device),
        model: device.model,
        ...signals,
        problems: safetyProblemsOf(signals),
      };
    })
    .sort(byAreaThenName);
}

function problemOf(state: StateEntry): WatchedProblem | null {
  if (isUnavailable(state)) {
    return WATCHED_PROBLEMS.unavailable;
  }
  if (isBinarySensor(state, DEVICE_CLASSES.connectivity) && state.state === ENTITY_STATES.off) {
    return WATCHED_PROBLEMS.offline;
  }
  if (isBinarySensor(state, DEVICE_CLASSES.problem) && state.state === ENTITY_STATES.on) {
    return WATCHED_PROBLEMS.problem;
  }
  if (domainOf(state.entity_id) === ENTITY_DOMAINS.sensor && state.state === ENTITY_STATES.down) {
    return WATCHED_PROBLEMS.down;
  }
  return null;
}

function problemsOf(states: readonly StateEntry[]): WatchedProblemView[] {
  return states
    .map((state) => ({ entity: state.attributes.friendly_name ?? state.entity_id, problem: problemOf(state) }))
    .filter((entry): entry is WatchedProblemView => entry.problem !== null);
}

/** Devices of the systems Home Assistant already watches (UniFi, Pi-hole, NAS, uptime checks…). */
export function watchedDevices(snapshot: HomeAssistantSnapshot): WatchedDeviceView[] {
  return devicesWithStates(snapshot)
    .map((entry) => ({
      ...entry,
      watched: entry.entities.filter((entity) => WATCHED_INTEGRATIONS.has(entity.platform)),
    }))
    .filter(({ watched }) => watched.length > 0)
    .map(({ device, states, watched }) => {
      const available = availabilityOf(states);
      return {
        id: device.id,
        name: nameOf(device),
        integration: watched[0]!.platform,
        area: areaOf(snapshot, device),
        available,
        // A device that is entirely unavailable is one problem, not one per entity.
        problems: available === false ? [] : problemsOf(states),
        updatesAvailable: countOf(
          states,
          (state) => domainOf(state.entity_id) === ENTITY_DOMAINS.update && state.state === ENTITY_STATES.on,
        ),
      };
    })
    .sort(
      (first, second) => first.integration.localeCompare(second.integration) || first.name.localeCompare(second.name),
    );
}

const isWatchedProblem = (device: WatchedDeviceView) => device.available === false || device.problems.length > 0;

const momentOf = (text: string | undefined) => {
  const moment = Date.parse(text ?? "");
  return Number.isFinite(moment) ? moment : null;
};

// An integration's entity by the unique id it gave it, while it is on.
function stateOf(snapshot: HomeAssistantSnapshot, platform: string, uniqueId: string): StateEntry | undefined {
  const entity = snapshot.entities.find(
    (candidate) =>
      candidate.platform === platform && candidate.unique_id === uniqueId && candidate.disabled_by === null,
  );
  return entity === undefined ? undefined : snapshot.states.get(entity.entity_id);
}

function rateOf(state: StateEntry | undefined): number | null {
  const value = numberOf(state);
  const bytesPerUnit = DATA_RATE_BYTES[state?.attributes.unit_of_measurement ?? ""];
  return value === null || bytesPerUnit === undefined ? null : value * bytesPerUnit;
}

function bytesOf(state: StateEntry | undefined): number | null {
  const value = numberOf(state);
  const bytesPerUnit = DATA_SIZE_BYTES[state?.attributes.unit_of_measurement ?? ""];
  return value === null || bytesPerUnit === undefined ? null : value * bytesPerUnit;
}

// How much is used of how much: from the used and free sensors when both are on, else from the used one and the
// share it is of the whole.
function sizeOf(used: StateEntry | undefined, free: StateEntry | undefined, share: number | null) {
  const usedBytes = bytesOf(used);
  const freeBytes = bytesOf(free);
  if (usedBytes === null) {
    return null;
  }
  if (freeBytes !== null) {
    return { usedBytes, totalBytes: usedBytes + freeBytes };
  }
  return share === null || share <= 0 ? null : { usedBytes, totalBytes: (usedBytes * PERCENT) / share };
}

const throughputPrefixOf = (entity: EntityEntry) =>
  [SYSTEM_MONITOR_SENSORS.receive, SYSTEM_MONITOR_SENSORS.transmit].find((prefix) =>
    entity.unique_id.startsWith(prefix),
  );

const interfaceOf = (entity: EntityEntry) => entity.unique_id.slice(throughputPrefixOf(entity)?.length ?? 0);

// The box's own network cards, summed: Docker's and the Supervisor's bridges carry traffic that never leaves it.
function networkOf(snapshot: HomeAssistantSnapshot, monitor: readonly EntityEntry[]) {
  const cards = monitor.filter(
    (entity) => throughputPrefixOf(entity) !== undefined && !VIRTUAL_INTERFACE.test(interfaceOf(entity)),
  );
  const on = cards.filter((entity) => entity.disabled_by === null);
  if (on.length === 0) {
    return { network: null, networkOff: cards.length > 0 };
  }
  const sumOf = (prefix: string) =>
    on
      .filter((entity) => entity.unique_id.startsWith(prefix))
      .reduce((total, entity) => total + (rateOf(snapshot.states.get(entity.entity_id)) ?? 0), 0);
  const network = {
    name: interfaceOf(on[0]!),
    receiveBytesPerSecond: sumOf(SYSTEM_MONITOR_SENSORS.receive),
    transmitBytesPerSecond: sumOf(SYSTEM_MONITOR_SENSORS.transmit),
  };
  return { network, networkOff: false };
}

// Updates waiting for the box's own software: the Supervisor's first (Core, its system, its Apps), then what HACS
// added, each by name.
function boxUpdatesOf(snapshot: HomeAssistantSnapshot): HomeAssistantUpdateView[] {
  const platforms = new Map(snapshot.entities.map((entity) => [entity.entity_id, entity.platform]));
  const fromHacs = (state: StateEntry) => Number(platforms.get(state.entity_id) !== SUPERVISOR_PLATFORM);
  const titleOf = (state: StateEntry) => state.attributes.title ?? state.attributes.friendly_name ?? state.entity_id;
  return [...snapshot.states.values()]
    .filter(
      (state) =>
        domainOf(state.entity_id) === ENTITY_DOMAINS.update &&
        state.state === ENTITY_STATES.on &&
        BOX_UPDATE_PLATFORMS.has(platforms.get(state.entity_id) ?? ""),
    )
    .sort((first, second) => fromHacs(first) - fromHacs(second) || titleOf(first).localeCompare(titleOf(second)))
    .map((state) => ({
      title: titleOf(state),
      installed: state.attributes.installed_version ?? null,
      latest: state.attributes.latest_version ?? null,
      releaseUrl: webLinkOf(state.attributes.release_url),
    }));
}

/** Home Assistant's own box, from its System Monitor's sensors and its Supervisor's update entities. */
export function systemOf(snapshot: HomeAssistantSnapshot): HomeAssistantSystemView {
  const monitor = snapshot.entities.filter((entity) => entity.platform === SYSTEM_MONITOR_PLATFORM);
  const monitored = (uniqueId: string) => stateOf(snapshot, SYSTEM_MONITOR_PLATFORM, uniqueId);
  const loads = SYSTEM_MONITOR_SENSORS.load.map((uniqueId) => numberOf(monitored(uniqueId)));
  const reported = monitor
    .filter((entity) => entity.disabled_by === null)
    .map((entity) => snapshot.states.get(entity.entity_id))
    .map((state) => momentOf(state?.last_reported ?? state?.last_updated))
    .filter(isPresent);
  const supervisorVersion = (uniqueId: string) =>
    stateOf(snapshot, SUPERVISOR_PLATFORM, uniqueId)?.attributes.installed_version ?? null;
  const memoryPercent = numberOf(monitored(SYSTEM_MONITOR_SENSORS.memory));
  const diskPercent = numberOf(monitored(SYSTEM_MONITOR_SENSORS.disk));
  const { memoryUsed, memoryFree, diskUsed, diskFree } = SYSTEM_MONITOR_SENSORS;
  return {
    monitored: monitor.length > 0,
    cpuPercent: numberOf(monitored(SYSTEM_MONITOR_SENSORS.cpu)),
    temperatureCelsius: numberOf(monitored(SYSTEM_MONITOR_SENSORS.temperature)),
    loadAverage: loads.every(isPresent) ? (loads as [number, number, number]) : null,
    memoryPercent,
    diskPercent,
    memory: sizeOf(monitored(memoryUsed), monitored(memoryFree), memoryPercent),
    disk: sizeOf(monitored(diskUsed), monitored(diskFree), diskPercent),
    ...networkOf(snapshot, monitor),
    bootedAt: momentOf(monitored(SYSTEM_MONITOR_SENSORS.boot)?.state),
    reportedAt: reported.length === 0 ? null : Math.max(...reported),
    operatingSystem: supervisorVersion(SUPERVISOR_UPDATES.operatingSystem),
    supervisor: supervisorVersion(SUPERVISOR_UPDATES.supervisor),
    updates: boxUpdatesOf(snapshot),
  };
}

export function summaryOf(
  zigbee: readonly ZigbeeDeviceView[],
  safety: readonly SafetyDeviceView[],
  watched: readonly WatchedDeviceView[],
): Pick<HomeAssistantSummaryView, "zigbee" | "safety" | "watched"> {
  const devices = zigbee.filter((device) => device.role !== ZIGBEE_ROLES.coordinator);
  return {
    zigbee: {
      total: devices.length,
      unavailable: countOf(devices, (device) => device.problems.includes(ZIGBEE_PROBLEMS.unavailable)),
      lowBattery: countOf(devices, (device) => device.problems.includes(ZIGBEE_PROBLEMS.lowBattery)),
      weakLink: countOf(devices, (device) => device.problems.includes(ZIGBEE_PROBLEMS.weakLink)),
    },
    safety: { total: safety.length, problems: countOf(safety, (device) => device.problems.length > 0) },
    watched: { total: watched.length, problems: countOf(watched, isWatchedProblem) },
  };
}

export const countUnavailable = (states: ReadonlyMap<string, StateEntry>) =>
  countOf([...states.values()], (state) => isUnavailable(state));
