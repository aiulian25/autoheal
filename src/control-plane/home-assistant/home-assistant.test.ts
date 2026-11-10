import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHomeAssistant } from "../../../test/fakes/fake-home-assistant.js";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type HomeAssistantView, type OverviewView } from "../../shared/api.js";
import { HomeAssistantClient, type ReadCommand } from "./home-assistant-client.js";
import { HomeAssistantInventory } from "./home-assistant-inventory.js";

const QUICK_RETRIES = {
  firstRetryMilliseconds: 10,
  longestRetryMilliseconds: 20,
  registryRefreshMilliseconds: 60_000,
  registrySettleMilliseconds: 10,
};

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

/** A small house: a Zigbee mesh, a smoke alarm on MQTT, and devices of systems HA already watches. */
function furnish(home: FakeHomeAssistant) {
  home.areas.push({ area_id: "kitchen", name: "Kitchen" }, { area_id: "server_room", name: "Server Room" });
  const zigbee = (ieee: string): [string, string][] => [["zha", ieee]];
  home.addDevice({
    id: "coordinator",
    name: "Zigbee",
    model: "CC2652",
    identifiers: zigbee("00:00:5e:00:53:22:1f:b1"),
  });
  home.addDevice({
    id: "fridge-plug",
    name: "Kitchen Fridge Plug",
    model: "S60ZBTPG",
    area_id: "kitchen",
    identifiers: zigbee("00:00:5e:00:53:21:ff:ff"),
    via_device_id: "coordinator",
  });
  home.addEntity("fridge-plug", "zha", "switch.kitchen_fridge_plug", "on");
  // Renamed by its owner: found by its unique id, not its entity id.
  home.addEntity(
    "fridge-plug",
    "zha",
    "sensor.fridge_link",
    "78",
    {},
    { unique_id: "00:00:5e:00:53:21:ff:ff-1-0-lqi" },
  );
  home.addDevice({
    id: "kitchen-temp",
    name: "Kitchen Temp",
    name_by_user: "Kitchen Thermometer",
    model: "SNZB-02D",
    area_id: "kitchen",
    identifiers: zigbee("00:00:5e:00:53:23:00:6f"),
    via_device_id: "coordinator",
  });
  home.addEntity("kitchen-temp", "zha", "sensor.kitchen_temp_battery", "20.0", { device_class: "battery" });
  home.addEntity("kitchen-temp", "zha", "sensor.kitchen_temp_lqi", "35", {}, { translation_key: "lqi" });
  home.addEntity("kitchen-temp", "zha", "sensor.kitchen_temp_temperature", "21.4", { device_class: "temperature" });

  home.addDevice({
    id: "kitchen-co",
    name: "Kitchen CO",
    model: "XC01-M",
    area_id: "kitchen",
    identifiers: [["mqtt", "co"]],
  });
  home.addEntity("kitchen-co", "mqtt", "binary_sensor.kitchen_co", "off", { device_class: "carbon_monoxide" });
  home.addEntity("kitchen-co", "mqtt", "binary_sensor.kitchen_co_battery", "on", { device_class: "battery" });
  home.addEntity("kitchen-co", "mqtt", "binary_sensor.kitchen_co_fault", "off", { device_class: "problem" });
  home.addEntity("kitchen-co", "mqtt", "binary_sensor.kitchen_co_online", "on", { device_class: "connectivity" });

  home.addDevice({ id: "commafeed", name: "CommaFeed" });
  home.addEntity("commafeed", "uptime_kuma", "sensor.commafeed_status", "down", { friendly_name: "CommaFeed Status" });
  home.addDevice({ id: "mini", name: "Mini", area_id: "server_room" });
  home.addEntity("mini", "ping", "sensor.mini_cpu", "unavailable");
  home.addEntity("mini", "ping", "sensor.mini_memory", "unavailable");
  home.addDevice({ id: "ds224", name: "DS224" });
  home.addEntity("ds224", "synology_dsm", "update.ds923_dsm_update", "on");
  home.addEntity("ds224", "synology_dsm", "binary_sensor.ds923_security", "off", { device_class: "problem" });
  home.addDevice({ id: "lamp", name: "Desk lamp" });
  home.addEntity("lamp", "tplink", "light.desk_lamp", "off");
}

/** Home Assistant's own box, as the real one reports it on 24 October 2026: System Monitor and the Supervisor. */
function furnishBox(home: FakeHomeAssistant) {
  home.addDevice({ id: "monitor", name: "System Monitor" });
  const monitor = (uniqueId: string, entityId: string, state: string, attributes: Record<string, string> = {}) =>
    home.addEntity("monitor", "systemmonitor", entityId, state, attributes, { unique_id: uniqueId });
  // Renamed by its owner: found by its unique id.
  monitor("processor_use", "sensor.box_cpu", "3", { unit_of_measurement: "%" });
  monitor("memory_use_percent", "sensor.system_monitor_memory_usage", "20.6", { unit_of_measurement: "%" });
  monitor("disk_use_percent", "sensor.system_monitor_disk_usage", "5.0", { unit_of_measurement: "%" });
  monitor("disk_use_percent_config", "sensor.system_monitor_disk_usage_config", "9.0", { unit_of_measurement: "%" });
  monitor("processor_temperature", "sensor.system_monitor_processor_temperature", "46.0");
  monitor("load_1m", "sensor.system_monitor_load_1_min", "0.14");
  monitor("load_5m", "sensor.system_monitor_load_5_min", "0.22");
  monitor("load_15m", "sensor.system_monitor_load_15_min", "0.23");
  monitor("last_boot", "sensor.system_monitor_uptime", "2026-10-13T11:23:43+00:00");
  // As System Monitor ships them: there, but off.
  for (const direction of ["in", "out"]) {
    home.addDisabledEntity("monitor", "systemmonitor", `sensor.system_monitor_network_throughput_${direction}_enp2s0`, {
      unique_id: `throughput_network_${direction}_enp2s0`,
    });
  }
  home.addDisabledEntity("monitor", "systemmonitor", "sensor.system_monitor_memory_use", { unique_id: "memory_use" });
  home.addDisabledEntity("monitor", "systemmonitor", "sensor.system_monitor_disk_use", { unique_id: "disk_use" });
  home.addDevice({ id: "core", name: "Home Assistant Core", identifiers: [["hassio", "core"]] });
  const update = (id: string, platform: string, uniqueId: string, state: string, versions: Record<string, string>) =>
    home.addEntity(id, platform, `update.${uniqueId}`, state, versions, { unique_id: uniqueId });
  update("core", "hassio", "home_assistant_core_version_latest", "on", {
    title: "Home Assistant Core",
    installed_version: "2026.10.2",
    latest_version: "2026.10.3",
    release_url: "https://www.home-assistant.io/changelogs/core-2026.10/#2026103",
  });
  update("core", "hassio", "home_assistant_os_version_latest", "off", {
    title: "Home Assistant Operating System",
    installed_version: "18.3",
    latest_version: "18.3",
  });
  update("core", "hassio", "home_assistant_supervisor_version_latest", "off", {
    title: "Home Assistant Supervisor",
    installed_version: "2026.10.3",
    latest_version: "2026.10.3",
  });
  // Its release link is no web address: it is left out.
  update("core", "hacs", "button_card_update", "on", {
    title: "button-card",
    installed_version: "v4.1.2",
    latest_version: "v4.2.0",
    release_url: "javascript:alert(1)",
  });
  // A device's firmware is the device's, not the box's.
  update("fridge-plug", "zha", "fridge_plug_firmware", "on", { title: "Fridge plug firmware" });
}

describe("the Home Assistant inventory", () => {
  let home: FakeHomeAssistant;
  let inventory: HomeAssistantInventory;

  beforeEach(async () => {
    home = await FakeHomeAssistant.start();
    furnish(home);
    inventory = new HomeAssistantInventory(
      new HomeAssistantClient({ url: home.url(), token: home.token }),
      QUICK_RETRIES,
    );
    await inventory.connect();
  });

  afterEach(async () => {
    inventory.stop();
    await home.close();
  });

  it("maps the Zigbee mesh: coordinator, routers and battery devices, by area", () => {
    const { status, zigbee } = inventory.view();
    expect(status).toMatchObject({ configured: true, connected: true, version: "2026.10.2", error: null });
    expect(zigbee.map(({ name, area, role }) => [name, area, role])).toEqual([
      ["Zigbee", null, "coordinator"],
      ["Kitchen Fridge Plug", "Kitchen", "router"],
      ["Kitchen Thermometer", "Kitchen", "end_device"],
    ]);
    expect(zigbee[1]).toMatchObject({ available: true, batteryPercent: null, linkQuality: 78 });
    expect(zigbee[2]).toMatchObject({ available: true, batteryPercent: 20, linkQuality: 35, problems: ["weak_link"] });
    expect(zigbee[2]!.lastSeen).toBeGreaterThan(0);
    expect(zigbee[0]).toMatchObject({ available: null, lastSeen: null });
  });

  it("follows Home Assistant live: a device dropping off the mesh shows at once", async () => {
    home.setState("switch.kitchen_fridge_plug", "unavailable");
    home.setState("sensor.fridge_link", "unavailable");
    await eventually(() => inventory.view().zigbee[1]!.available === false);
    expect(inventory.summary().zigbee).toEqual({ total: 2, unavailable: 1, lowBattery: 0, weakLink: 1 });
  });

  it("keeps a change that arrives while the full state list loads, instead of the older list", async () => {
    home.whileAnsweringStates = () => {
      home.whileAnsweringStates = null;
      home.setState("switch.kitchen_fridge_plug", "unavailable");
      home.setState("sensor.fridge_link", "unavailable");
    };
    home.dropConnections();
    await eventually(() => inventory.view().status.connected && inventory.view().zigbee[1]!.available === false);
  });

  it("passes on each state as it is read at a connect and as it changes, whatever its listener does", async () => {
    const seen: string[] = [];
    home.setState("input_text.autoheal_answers", "autoheal heard a 1");
    const listening = new HomeAssistantInventory(
      new HomeAssistantClient({ url: home.url(), token: home.token }),
      QUICK_RETRIES,
      Date.now,
      (state) => {
        seen.push(`${state.entity_id}=${state.state}`);
        if (state.entity_id === "input_text.broken") throw new Error("a listener that fails");
      },
    );
    await listening.connect();
    expect(seen).toContain("input_text.autoheal_answers=autoheal heard a 1");
    home.setState("input_text.broken", "x");
    home.setState("input_text.autoheal_answers", "autoheal later a 2");
    await eventually(() => seen.includes("input_text.autoheal_answers=autoheal later a 2"));
    expect(listening.view().status.connected).toBe(true);
    listening.stop();
  });

  it("reads the safety devices' own alarm, battery, fault and online sensors", () => {
    expect(inventory.view().safety).toEqual([
      {
        id: "kitchen-co",
        name: "Kitchen CO",
        area: "Kitchen",
        model: "XC01-M",
        available: true,
        alarm: false,
        online: true,
        batteryLow: true,
        fault: false,
        problems: ["battery_low"],
      },
    ]);
  });

  it("shows what HA already watches, with each device's problems and pending updates", () => {
    const watched = inventory.view().watched;
    expect(watched.map(({ integration, name }) => `${integration}/${name}`)).toEqual([
      "ping/Mini",
      "synology_dsm/DS224",
      "uptime_kuma/CommaFeed",
    ]);
    expect(watched[0]).toMatchObject({ available: false, problems: [], area: "Server Room" });
    expect(watched[1]).toMatchObject({ available: true, problems: [], updatesAvailable: 1 });
    expect(watched[2]!.problems).toEqual([{ entity: "CommaFeed Status", problem: "down" }]);
  });

  it("reads its own box from System Monitor and the Supervisor, by unique ids, and knows which sensors are off", async () => {
    furnishBox(home);
    home.dropConnections();
    await eventually(() => inventory.view().status.connected && inventory.view().system.monitored);
    const { system, entities } = inventory.view();
    expect(system).toMatchObject({
      monitored: true,
      cpuPercent: 3,
      temperatureCelsius: 46,
      loadAverage: [0.14, 0.22, 0.23],
      memoryPercent: 20.6,
      diskPercent: 5,
      memory: null,
      disk: null,
      network: null,
      networkOff: true,
      bootedAt: Date.parse("2026-10-13T11:23:43Z"),
      operatingSystem: "18.3",
      supervisor: "2026.10.3",
      updates: [
        {
          title: "Home Assistant Core",
          installed: "2026.10.2",
          latest: "2026.10.3",
          releaseUrl: "https://www.home-assistant.io/changelogs/core-2026.10/#2026103",
        },
        { title: "button-card", installed: "v4.1.2", latest: "v4.2.0", releaseUrl: null },
      ],
    });
    expect(system.reportedAt).toBeGreaterThan(0);
    expect(entities).toBeGreaterThan(20);
  });

  it("hears at once when sensors are turned on in Home Assistant, and gives sizes as used of the whole", async () => {
    furnishBox(home);
    home.dropConnections();
    await eventually(() => inventory.view().status.connected && inventory.view().system.networkOff);

    // As the owner did on 24 October: the network throughput sensors, memory use and disk use turned on.
    home.enableEntity("sensor.system_monitor_network_throughput_in_enp2s0", "0.051", { unit_of_measurement: "MB/s" });
    home.enableEntity("sensor.system_monitor_network_throughput_out_enp2s0", "0.012", { unit_of_measurement: "MB/s" });
    home.enableEntity("sensor.system_monitor_memory_use", "3311.3", { unit_of_measurement: "MiB" });
    home.enableEntity("sensor.system_monitor_disk_use", "22.4", { unit_of_measurement: "GiB" });
    await eventually(() => inventory.view().system.network !== null);
    const { system } = inventory.view();
    expect(system.network).toEqual({ name: "enp2s0", receiveBytesPerSecond: 51_000, transmitBytesPerSecond: 12_000 });
    expect(system.networkOff).toBe(false);
    expect(system.memory!.usedBytes).toBe(3311.3 * 1024 ** 2);
    expect(system.memory!.totalBytes).toBeCloseTo((3311.3 * 1024 ** 2 * 100) / 20.6);
    expect(system.disk!.totalBytes).toBeCloseTo((22.4 * 1024 ** 3 * 100) / 5);
    // Without a reconnect: the registries were read again once Home Assistant said they changed.
    expect(home.received.filter((type) => type === "get_states")).toHaveLength(2);
  });

  it("adds up the box's own network cards in bytes a second, leaving its bridges out", async () => {
    furnishBox(home);
    home.addDevice({ id: "monitor-network", name: "System Monitor" });
    const rate = (direction: string, card: string, value: string, unit: string) =>
      home.addEntity(
        "monitor-network",
        "systemmonitor",
        `sensor.throughput_${direction}_${card}`,
        value,
        { unit_of_measurement: unit },
        { unique_id: `throughput_network_${direction}_${card}` },
      );
    rate("in", "eth0", "1.5", "MB/s");
    rate("out", "eth0", "800", "kbit/s");
    rate("in", "docker0", "9", "MB/s");
    rate("in", "hassio", "9", "MB/s");
    home.dropConnections();
    await eventually(() => inventory.view().system.network !== null);
    expect(inventory.view().system).toMatchObject({
      network: { name: "eth0", receiveBytesPerSecond: 1_500_000, transmitBytesPerSecond: 100_000 },
      networkOff: false,
    });
  });

  it("sums it up for the overview, its box with it", () => {
    expect(inventory.summary()).toEqual({
      connected: true,
      version: "2026.10.2",
      system: inventory.view().system,
      entities: inventory.view().entities,
      unavailableEntities: 2,
      zigbee: { total: 2, unavailable: 0, lowBattery: 0, weakLink: 1 },
      safety: { total: 1, problems: 1 },
      watched: { total: 3, problems: 2 },
    });
  });

  it("only ever reads: anything else is refused before it is sent", async () => {
    const client = new HomeAssistantClient({ url: home.url(), token: home.token });
    await client.connect(() => undefined);
    await expect(client.command("call_service" as ReadCommand)).rejects.toThrow(/only reads/);
    client.close();
    expect(new Set(home.received)).toEqual(
      new Set([
        "subscribe_events",
        "get_states",
        "config/area_registry/list",
        "config/device_registry/list",
        "config/entity_registry/list",
      ]),
    );
  });

  it("reconnects and reloads after the connection drops", async () => {
    home.dropConnections();
    await eventually(() => !inventory.view().status.connected);
    home.setState("sensor.kitchen_temp_battery", "15.0");
    await eventually(() => inventory.view().status.connected);
    expect(inventory.view().zigbee[2]!.batteryPercent).toBe(15);
    expect(home.authAttempts).toBe(2);
  });

  it("fails fast, and keeps trying, when the server's certificate is not trusted", async () => {
    const impostor = await FakeHomeAssistant.start(home.token, "untrusted");
    const wary = new HomeAssistantInventory(
      new HomeAssistantClient({ url: impostor.url(), token: impostor.token }),
      QUICK_RETRIES,
    );
    await wary.connect();
    expect(wary.view().status).toMatchObject({ connected: false, error: expect.stringMatching(/trusted CA/) });
    expect(impostor.authAttempts).toBe(0);
    wary.stop();
    await impostor.close();
  });

  it("stops trying when the token is refused, so Home Assistant has no reason to ban the address", async () => {
    const refused = new HomeAssistantInventory(
      new HomeAssistantClient({ url: home.url(), token: "not-the-token" }),
      QUICK_RETRIES,
    );
    const attemptsBefore = home.authAttempts;
    await refused.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(home.authAttempts - attemptsBefore).toBe(1);
    expect(refused.view().status).toMatchObject({
      connected: false,
      error: expect.stringMatching(/refused the token/),
    });
    refused.stop();
  });
});

describe("the Home Assistant inventory in the dashboard", () => {
  let home: FakeHomeAssistant;
  let controlPlane: TestControlPlane;
  let admin: TestClient;

  beforeEach(async () => {
    home = await FakeHomeAssistant.start();
    furnish(home);
    controlPlane = await startTestControlPlane({ homeAssistant: { url: home.url(), token: home.token } });
    await controlPlane.services.homeAssistant.connect();
    admin = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    controlPlane.services.homeAssistant.stop();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await home.close();
  });

  it("serves the Home Assistant inventory to every signed-in user, and adds it to the overview", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const view = (await viewer.get(API_ROUTES.homeAssistant)).json<HomeAssistantView>();
    expect(view.zigbee).toHaveLength(3);
    expect(view.safety).toHaveLength(1);
    expect(view.unavailableEntities).toBe(2);
    expect((await admin.get(API_ROUTES.overview)).json<OverviewView>().homeAssistant).toMatchObject({
      connected: true,
      safety: { total: 1, problems: 1 },
    });
    expect(JSON.stringify(view)).not.toContain(home.token);
  });

  it("says when it is not configured", async () => {
    const plain = await startTestControlPlane();
    const plainAdmin = (await fullySignedInAdmin(plain)).client;
    expect((await plainAdmin.get(API_ROUTES.homeAssistant)).json<HomeAssistantView>().status.configured).toBe(false);
    expect((await plainAdmin.get(API_ROUTES.overview)).json<OverviewView>().homeAssistant).toBeNull();
    await plain.app.close();
    await plain.runnerApp.close();
  });

  it("connects as soon as an admin sets it up in Settings, and lets go when it is removed", async () => {
    const plain = await startTestControlPlane();
    const plainAdmin = (await fullySignedInAdmin(plain)).client;
    const settings = apiPath(API_ROUTES.integration, { kind: "homeAssistant" });
    const status = async () => (await plainAdmin.get(API_ROUTES.homeAssistant)).json<HomeAssistantView>().status;
    expect((await plainAdmin.put(settings, { url: home.url(), token: home.token })).statusCode).toBe(204);
    let connected = false;
    for (let attempt = 0; attempt < 100 && !connected; attempt += 1) {
      connected = (await status()).connected;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connected).toBe(true);
    expect((await plainAdmin.delete(settings)).statusCode).toBe(204);
    expect((await status()).configured).toBe(false);
    plain.services.homeAssistant.stop();
    await plain.app.close();
    await plain.runnerApp.close();
  });
});
