import type { HomeAssistantSettings } from "../../config/shared-settings.js";
import type { HomeAssistantSummaryView, HomeAssistantView } from "../../shared/api.js";
import {
  HOME_ASSISTANT_FIRST_RETRY_MILLISECONDS,
  HOME_ASSISTANT_LONGEST_RETRY_MILLISECONDS,
  HOME_ASSISTANT_MESSAGES,
  HOME_ASSISTANT_READ_COMMANDS,
  HOME_ASSISTANT_REGISTRY_EVENTS,
  HOME_ASSISTANT_REGISTRY_REFRESH_MILLISECONDS,
  HOME_ASSISTANT_REGISTRY_SETTLE_MILLISECONDS,
  HOME_ASSISTANT_RETRY_GROWTH,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import type { HomeFacts, HomeLogRecord } from "./home-review.js";
import { HomeAssistantTokenRefused, type HomeAssistantClient, type StateChange } from "./home-assistant-client.js";
import {
  countUnavailable,
  safetyDevices,
  summaryOf,
  systemOf,
  watchedDevices,
  zigbeeDevices,
  type AreaEntry,
  type DeviceEntry,
  type EntityEntry,
  type StateEntry,
} from "./home-assistant-views.js";

export interface HomeAssistantTiming {
  firstRetryMilliseconds: number;
  longestRetryMilliseconds: number;
  registryRefreshMilliseconds: number;
  registrySettleMilliseconds: number;
}

const DEFAULT_TIMING: HomeAssistantTiming = {
  firstRetryMilliseconds: HOME_ASSISTANT_FIRST_RETRY_MILLISECONDS,
  longestRetryMilliseconds: HOME_ASSISTANT_LONGEST_RETRY_MILLISECONDS,
  registryRefreshMilliseconds: HOME_ASSISTANT_REGISTRY_REFRESH_MILLISECONDS,
  registrySettleMilliseconds: HOME_ASSISTANT_REGISTRY_SETTLE_MILLISECONDS,
};

/**
 * A live copy of what Home Assistant knows: its registries, read again soon after HA says one changed (and every
 * few minutes regardless), and every entity's state, kept current by HA's own state-change events. It reconnects
 * on its own, backing off, except after a refused token: HA counts failed logins and may ban the address.
 */
export class HomeAssistantInventory {
  private areas = new Map<string, string>();
  private devices: DeviceEntry[] = [];
  private entities: EntityEntry[] = [];
  private states = new Map<string, StateEntry>();
  // Changes that arrive while the full state list loads; applied after it, or the list would undo them.
  private changesDuringLoad: StateChange[] | null = null;
  private connected = false;
  private version: string | null = null;
  private error: string | null = null;
  private connectedSince: number | null = null;
  private retryDelay: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  // A registry change was announced: they are read once the burst settles.
  private settleTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly client: HomeAssistantClient,
    private readonly timing: HomeAssistantTiming = DEFAULT_TIMING,
    private readonly clock: () => number = Date.now,
    // Each state as it is read at a connect and as it changes, for whoever reads Home Assistant's helpers.
    private readonly onState: (state: StateEntry) => void = () => {},
  ) {
    this.retryDelay = timing.firstRetryMilliseconds;
  }

  start() {
    void this.connect();
  }

  /** One attempt; on failure it schedules the next one itself. Resolves either way. */
  async connect() {
    this.stopped = false;
    try {
      const version = await this.client.connect((reason) => this.lost(reason));
      // Subscribe first, then load: a change between the two is never missed.
      this.changesDuringLoad = [];
      await this.client.subscribeStateChanges((change) => this.apply(change));
      await Promise.all(
        HOME_ASSISTANT_REGISTRY_EVENTS.map((event) => this.client.subscribe(event, () => this.registriesChanged())),
      );
      await this.load();
      const changes = this.changesDuringLoad;
      this.changesDuringLoad = null;
      changes.forEach((change) => this.apply(change));
      if (this.stopped) {
        this.client.close();
        return;
      }
      this.connected = true;
      this.version = version;
      this.error = null;
      this.connectedSince = this.clock();
      this.retryDelay = this.timing.firstRetryMilliseconds;
      this.refreshTimer = setInterval(() => void this.refreshRegistries(), this.timing.registryRefreshMilliseconds);
      log(HOME_ASSISTANT_MESSAGES.connected(version));
    } catch (error) {
      this.changesDuringLoad = null;
      this.client.close();
      this.connected = false;
      this.error = describeError(error);
      if (error instanceof HomeAssistantTokenRefused) {
        log(HOME_ASSISTANT_MESSAGES.tokenRefused);
        return;
      }
      log(HOME_ASSISTANT_MESSAGES.failed(this.error));
      this.retryLater();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer ?? undefined);
    clearTimeout(this.settleTimer ?? undefined);
    clearInterval(this.refreshTimer ?? undefined);
    this.client.close();
  }

  view(): HomeAssistantView {
    const snapshot = { areas: this.areas, devices: this.devices, entities: this.entities, states: this.states };
    return {
      status: {
        configured: true,
        connected: this.connected,
        version: this.version,
        error: this.error,
        connectedSince: this.connectedSince,
      },
      system: systemOf(snapshot),
      zigbee: zigbeeDevices(snapshot),
      safety: safetyDevices(snapshot),
      watched: watchedDevices(snapshot),
      entities: this.states.size,
      unavailableEntities: countUnavailable(this.states),
    };
  }

  isConnected() {
    return this.connected;
  }

  facts(): HomeFacts {
    return { areas: this.areas, devices: this.devices, entities: this.entities, states: this.states };
  }

  systemLog(): Promise<HomeLogRecord[] | null> {
    return this.connected
      ? this.client.command<HomeLogRecord[]>(HOME_ASSISTANT_READ_COMMANDS.systemLog)
      : Promise.resolve(null);
  }

  summary(): HomeAssistantSummaryView {
    const view = this.view();
    return {
      connected: this.connected,
      version: this.version,
      system: view.system,
      entities: view.entities,
      unavailableEntities: view.unavailableEntities,
      ...summaryOf(view.zigbee, view.safety, view.watched),
    };
  }

  private async load() {
    const [areas, devices, entities, states] = await Promise.all([
      this.client.command<AreaEntry[]>(HOME_ASSISTANT_READ_COMMANDS.areas),
      this.client.command<DeviceEntry[]>(HOME_ASSISTANT_READ_COMMANDS.devices),
      this.client.command<EntityEntry[]>(HOME_ASSISTANT_READ_COMMANDS.entities),
      this.client.command<StateEntry[]>(HOME_ASSISTANT_READ_COMMANDS.states),
    ]);
    this.useRegistries(areas, devices, entities);
    this.states = new Map(states.map((state) => [state.entity_id, state]));
    states.forEach((state) => this.passOn(state));
  }

  private async refreshRegistries() {
    try {
      const [areas, devices, entities] = await Promise.all([
        this.client.command<AreaEntry[]>(HOME_ASSISTANT_READ_COMMANDS.areas),
        this.client.command<DeviceEntry[]>(HOME_ASSISTANT_READ_COMMANDS.devices),
        this.client.command<EntityEntry[]>(HOME_ASSISTANT_READ_COMMANDS.entities),
      ]);
      this.useRegistries(areas, devices, entities);
    } catch (error) {
      // A dropped connection reports itself through `lost`; keep the last registries meanwhile.
      this.error = describeError(error);
    }
  }

  // Turning on several entities, or pairing a device, announces a change for each: one read covers them all.
  private registriesChanged() {
    clearTimeout(this.settleTimer ?? undefined);
    this.settleTimer = setTimeout(() => void this.refreshRegistries(), this.timing.registrySettleMilliseconds);
  }

  private useRegistries(areas: AreaEntry[], devices: DeviceEntry[], entities: EntityEntry[]) {
    this.areas = new Map(areas.map((area) => [area.area_id, area.name]));
    this.devices = devices;
    this.entities = entities;
  }

  private apply(change: StateChange) {
    if (this.changesDuringLoad !== null) {
      this.changesDuringLoad.push(change);
      return;
    }
    if (change.new_state === null) {
      this.states.delete(change.entity_id);
      return;
    }
    this.states.set(change.entity_id, change.new_state);
    this.passOn(change.new_state);
  }

  // What a listener does with a state never reaches the socket: thrown there, it would end the whole process.
  private passOn(state: StateEntry) {
    try {
      this.onState(state);
    } catch (error) {
      log(HOME_ASSISTANT_MESSAGES.notPassedOn(describeError(error)));
    }
  }

  private lost(reason: string) {
    if (this.stopped) {
      return;
    }
    this.connected = false;
    this.error = reason;
    clearInterval(this.refreshTimer ?? undefined);
    log(HOME_ASSISTANT_MESSAGES.lost(reason));
    this.retryLater();
  }

  private retryLater() {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = setTimeout(() => void this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * HOME_ASSISTANT_RETRY_GROWTH, this.timing.longestRetryMilliseconds);
  }
}

/**
 * Home Assistant as Settings (or the .env) has it now: one live inventory, or none. Changing it in
 * Settings stops the old connector and starts one for the new address.
 */
export class HomeAssistantConnection {
  connected(): boolean {
    return this.inventory?.isConnected() ?? false;
  }

  facts(): HomeFacts | null {
    return this.inventory?.facts() ?? null;
  }

  systemLog(): Promise<HomeLogRecord[] | null> {
    return this.inventory?.systemLog() ?? Promise.resolve(null);
  }

  private inventory: HomeAssistantInventory | null = null;
  private readonly stateListeners: ((state: StateEntry) => void)[] = [];

  constructor(
    private readonly makeInventory: (
      settings: HomeAssistantSettings,
      onState: (state: StateEntry) => void,
    ) => HomeAssistantInventory,
  ) {}

  /** Each state Home Assistant has, as it is read at every connect and as it changes, whichever inventory is live. */
  onState(listener: (state: StateEntry) => void) {
    this.stateListeners.push(listener);
  }

  /** Follows `settings` from now on; the application starts it, and Settings restart it. */
  use(settings: HomeAssistantSettings | null) {
    this.inventory?.stop();
    const passOn = (state: StateEntry) => this.stateListeners.forEach((listener) => listener(state));
    this.inventory = settings === null ? null : this.makeInventory(settings, passOn);
  }

  start() {
    this.inventory?.start();
  }

  /** One attempt, for tests: resolves either way. */
  async connect() {
    await this.inventory?.connect();
  }

  stop() {
    this.inventory?.stop();
  }

  view(): HomeAssistantView | null {
    return this.inventory?.view() ?? null;
  }

  summary(): HomeAssistantSummaryView | null {
    return this.inventory?.summary() ?? null;
  }
}
