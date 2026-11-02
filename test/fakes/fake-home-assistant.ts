import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AreaEntry,
  DeviceEntry,
  EntityEntry,
  StateEntry,
} from "../../src/control-plane/home-assistant/home-assistant-views.js";

const fixture = (name: string) => readFileSync(`test/fixtures/tls/${name}`);

const FAKE_HOME_ASSISTANT_VERSION = "2026.10.2";

interface Command {
  id: number;
  type: string;
  access_token?: string;
  event_type?: string;
}

/** Home Assistant's WebSocket API, as much of it as Autoheal uses, over real TLS. */
export class FakeHomeAssistant {
  readonly areas: AreaEntry[] = [];
  readonly devices: DeviceEntry[] = [];
  readonly entities: EntityEntry[] = [];
  readonly states = new Map<string, StateEntry>();
  // Every command type received after authentication, in order.
  readonly received: string[] = [];
  authAttempts = 0;
  // Each connection's subscriptions: the event type, and the id its events go out under.
  private readonly subscribers = new Map<WebSocket, Map<string, number>>();
  private server: Server | null = null;
  private sockets: WebSocketServer | null = null;

  private constructor(readonly token: string) {}

  /** `certificate` "untrusted" serves a certificate from a CA the tests do not trust. */
  static async start(token = "home-assistant-test-token", certificate = "trusted"): Promise<FakeHomeAssistant> {
    const fake = new FakeHomeAssistant(token);
    const prefix = certificate === "untrusted" ? "untrusted-" : "";
    fake.server = createServer({ cert: fixture(`${prefix}server.pem`), key: fixture(`${prefix}server-key.pem`) });
    fake.sockets = new WebSocketServer({ server: fake.server, path: "/api/websocket" });
    fake.sockets.on("connection", (socket) => fake.serve(socket));
    await new Promise<void>((resolve) => fake.server!.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  url() {
    return `https://localhost:${(this.server!.address() as AddressInfo).port}`;
  }

  addDevice(device: Partial<DeviceEntry> & Pick<DeviceEntry, "id" | "name">) {
    this.devices.push({
      name_by_user: null,
      manufacturer: null,
      model: null,
      area_id: null,
      identifiers: [],
      via_device_id: null,
      disabled_by: null,
      ...device,
    });
  }

  /** An entity on a device, with its state; `platform` is the integration it comes from. */
  addEntity(
    deviceId: string,
    platform: string,
    entityId: string,
    state: string,
    attributes: StateEntry["attributes"] = {},
    registry: Partial<EntityEntry> = {},
  ) {
    this.entities.push({
      entity_id: entityId,
      device_id: deviceId,
      platform,
      unique_id: `${entityId}-unique`,
      disabled_by: null,
      translation_key: null,
      ...registry,
    });
    this.setState(entityId, state, attributes);
  }

  /** An entity its integration ships switched off: in the registry, with no state. */
  addDisabledEntity(deviceId: string, platform: string, entityId: string, registry: Partial<EntityEntry> = {}) {
    this.entities.push({
      entity_id: entityId,
      device_id: deviceId,
      platform,
      unique_id: `${entityId}-unique`,
      disabled_by: "integration",
      translation_key: null,
      ...registry,
    });
  }

  /** Changes a state and tells every subscriber, the way Home Assistant does. */
  setState(entityId: string, state: string, attributes?: StateEntry["attributes"]) {
    const now = new Date().toISOString();
    const known = this.states.get(entityId);
    const next = {
      entity_id: entityId,
      state,
      attributes: attributes ?? known?.attributes ?? {},
      last_updated: now,
      last_reported: now,
    };
    this.states.set(entityId, next);
    this.fire("state_changed", { entity_id: entityId, old_state: known ?? null, new_state: next });
  }

  /** Turns on an entity its integration shipped off, as a person does in Home Assistant: it says so, then reports. */
  enableEntity(entityId: string, state: string, attributes: StateEntry["attributes"] = {}) {
    const entity = this.entities.find((candidate) => candidate.entity_id === entityId)!;
    entity.disabled_by = null;
    this.fire("entity_registry_updated", { action: "update", entity_id: entityId, changes: { disabled_by: null } });
    this.setState(entityId, state, attributes);
  }

  private fire(eventType: string, data: unknown) {
    for (const [socket, subscriptions] of this.subscribers) {
      const subscription = subscriptions.get(eventType);
      if (subscription !== undefined) {
        socket.send(JSON.stringify({ id: subscription, type: "event", event: { event_type: eventType, data } }));
      }
    }
  }

  // Runs once the state list is taken but before it is sent: a change in that moment reaches the
  // client as an event ahead of the older list.
  whileAnsweringStates: (() => void) | null = null;

  dropConnections() {
    for (const socket of this.sockets!.clients) {
      socket.terminate();
    }
  }

  async close() {
    this.dropConnections();
    await new Promise<void>((resolve) => this.sockets!.close(() => resolve()));
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private serve(socket: WebSocket) {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: FAKE_HOME_ASSISTANT_VERSION }));
    let authenticated = false;
    const answers: Record<string, () => unknown> = {
      get_states: () => [...this.states.values()],
      "config/area_registry/list": () => this.areas,
      "config/device_registry/list": () => this.devices,
      "config/entity_registry/list": () => this.entities,
    };
    socket.on("message", (raw) => {
      const command = JSON.parse(String(raw)) as Command;
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ id: command.id, type: "result", success: true, result }));
      if (!authenticated) {
        this.authAttempts += 1;
        authenticated = command.type === "auth" && command.access_token === this.token;
        socket.send(
          JSON.stringify(
            authenticated
              ? { type: "auth_ok", ha_version: FAKE_HOME_ASSISTANT_VERSION }
              : { type: "auth_invalid", message: "Invalid access token or password" },
          ),
        );
        if (!authenticated) {
          socket.close();
        }
        return;
      }
      this.received.push(command.type);
      if (command.type === "subscribe_events") {
        const subscriptions = this.subscribers.get(socket) ?? new Map<string, number>();
        subscriptions.set(command.event_type ?? "", command.id);
        this.subscribers.set(socket, subscriptions);
        reply(null);
        return;
      }
      const answer = answers[command.type];
      if (answer === undefined) {
        const error = { code: "unknown_command", message: "Unknown command." };
        socket.send(JSON.stringify({ id: command.id, type: "result", success: false, error }));
        return;
      }
      const result = answer();
      if (command.type === "get_states") {
        this.whileAnsweringStates?.();
      }
      reply(result);
    });
    socket.on("close", () => this.subscribers.delete(socket));
  }
}
