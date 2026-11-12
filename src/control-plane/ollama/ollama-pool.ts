import type { OllamaSettings } from "../../config/shared-settings.js";
import type { OllamaServersView } from "../../shared/api.js";
import { PLAIN_HTTP_PROTOCOL } from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { OllamaClient } from "../../ollama/ollama-client.js";
import { DecisionQueue, type JobPriority } from "../decisions/decision-queue.js";
import type { OllamaServerRow, OllamaServersService } from "../settings/ollama-servers-service.js";
import { OllamaMonitor } from "./ollama-monitor.js";

/** What the work a host brings needs of the server that answers it. */
export interface ModelServer {
  // Null is the default.
  id: string | null;
  name: string | null;
  client: Pick<OllamaClient, "chat" | "contextTokens" | "model" | "modelDigest">;
}

export interface HostModels {
  /** The server a host's work goes to now: its own, unless that is known to be down. */
  serverFor(hostId: string): ModelServer;
  /**
   * Runs `work` in its server's queue. A server that cannot be reached hands it to the default, which `work` is
   * given to build for, as the two may read different amounts.
   */
  askFor<Result>(
    hostId: string,
    priority: JobPriority,
    work: (server: ModelServer, signal: AbortSignal) => Promise<Result>,
    onFellBack?: (from: string, reason: string) => void,
    // Aborts when whoever asked stops waiting: work still in the queue then leaves it, never run.
    waiting?: AbortSignal,
  ): Promise<Result>;
}

/** The one server there is: what work asks of a pool, without a pool. */
export function oneServer(client: ModelServer["client"], queue: Pick<DecisionQueue, "enqueue">): HostModels {
  const server: ModelServer = { id: null, name: null, client };
  return {
    serverFor: () => server,
    askFor: (hostId, priority, work, _onFellBack, waiting) =>
      queue.enqueue(priority, (signal) => work(server, signal), { owner: hostId, signal: waiting }),
  };
}

export interface PooledServer extends ModelServer {
  client: OllamaClient;
  queue: DecisionQueue;
  monitor: OllamaMonitor;
}

const NETWORK_FAILURE = new Set(["TimeoutError"]);

// Fetch says it could not reach a server with a TypeError; a call that ran out of time ends in a TimeoutError. An
// answer that was bad, a model that is missing, a person or a live incident stopping it: none of those is a server down.
const isUnreachable = (error: unknown) =>
  error instanceof TypeError || (error instanceof Error && NETWORK_FAILURE.has(error.name));

/**
 * Every Ollama server, each with its client, its own queue and its own monitor, so a slow machine holds up only its
 * own hosts. The default is what the .env or Settings says; with no other server this is just that.
 */
export class OllamaPool implements HostModels {
  private readonly extras = new Map<string, PooledServer & { settings: OllamaServerRow }>();

  constructor(
    readonly defaultServer: PooledServer,
    private readonly defaultSettings: () => OllamaSettings,
    private readonly servers: Pick<
      OllamaServersService,
      "list" | "serverIdOf" | "hostIdsByServer" | "reviewServerId" | "routerServerId" | "defaultName"
    >,
    private readonly clock: () => number = Date.now,
  ) {}

  // Each is made on first use. A removed one finishes what it holds, and goes.
  private refreshed() {
    const rows = this.servers.list();
    const wanted = new Set(rows.map(({ id }) => id));
    for (const id of this.extras.keys()) {
      if (!wanted.has(id)) this.extras.delete(id);
    }
    for (const row of rows) {
      const known = this.extras.get(row.id);
      if (known !== undefined) {
        known.settings = row;
        known.name = row.name;
        continue;
      }
      const client = new OllamaClient(() => this.extras.get(row.id)?.settings ?? row, this.clock);
      this.extras.set(row.id, {
        id: row.id,
        name: row.name,
        settings: row,
        client,
        queue: new DecisionQueue(),
        monitor: new OllamaMonitor(client, this.clock),
      });
    }
    return [...this.extras.values()];
  }

  all(): PooledServer[] {
    return [this.defaultServer, ...this.refreshed()];
  }

  private assignedTo(hostId: string): PooledServer {
    const id = this.servers.serverIdOf(hostId);
    if (id === null) return this.defaultServer;
    this.refreshed();
    return this.extras.get(id) ?? this.defaultServer;
  }

  private isDown(server: PooledServer) {
    const { checkedAt, reachable } = server.monitor.status();
    return checkedAt !== null && !reachable;
  }

  serverFor(hostId: string): PooledServer {
    const assigned = this.assignedTo(hostId);
    return this.isDown(assigned) ? this.defaultServer : assigned;
  }

  async askFor<Result>(
    hostId: string,
    priority: JobPriority,
    work: (server: ModelServer, signal: AbortSignal) => Promise<Result>,
    onFellBack?: (from: string, reason: string) => void,
    waiting?: AbortSignal,
  ): Promise<Result> {
    const queuedFor = { owner: hostId, signal: waiting };
    const onDefault = () =>
      this.defaultServer.queue.enqueue(priority, (signal) => work(this.defaultServer, signal), queuedFor);
    const assigned = this.assignedTo(hostId);
    if (assigned === this.defaultServer) return onDefault();
    if (this.isDown(assigned)) {
      onFellBack?.(assigned.name ?? "", assigned.monitor.status().error ?? "");
      return onDefault();
    }
    try {
      return await assigned.queue.enqueue(priority, (signal) => work(assigned, signal), queuedFor);
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      // Known at once, so the next call does not spend its time finding out.
      void assigned.monitor.check();
      onFellBack?.(assigned.name ?? "", describeError(error));
      return onDefault();
    }
  }

  /** What a runner is told to use when it decides alone, on the same rule. */
  settingsFor(hostId: string): OllamaSettings {
    const server = this.serverFor(hostId);
    const settings = this.extras.get(server.id ?? "")?.settings;
    if (settings === undefined) return this.defaultSettings();
    const { url, model, contextTokens } = settings;
    return { url, model, contextTokens };
  }

  /** The server that reads Home Assistant's files: not urgent, so it waits for its choice rather than falling back. */
  reviewServer(): PooledServer {
    const id = this.servers.reviewServerId();
    if (id === null) return this.defaultServer;
    this.refreshed();
    return this.extras.get(id) ?? this.defaultServer;
  }

  /** The server that reads the network, on the same rule. */
  routerServer(): PooledServer {
    const id = this.servers.routerServerId();
    if (id === null) return this.defaultServer;
    this.refreshed();
    return this.extras.get(id) ?? this.defaultServer;
  }

  async checkAll() {
    await Promise.all(this.all().map(({ monitor }) => monitor.check()));
  }

  view(): OllamaServersView {
    const hostIds = this.servers.hostIdsByServer();
    const extras = this.refreshed().map(({ id, name, settings, monitor }) => ({
      id: id!,
      name: name!,
      url: settings.url,
      model: settings.model,
      contextTokens: settings.contextTokens,
      plainHttp: new URL(settings.url).protocol === PLAIN_HTTP_PROTOCOL,
      status: monitor.status(),
      hostIds: hostIds.get(id!) ?? [],
    }));
    return {
      extras,
      reviewServerId: this.servers.reviewServerId(),
      routerServerId: this.servers.routerServerId(),
      defaultName: this.servers.defaultName(),
    };
  }

  /** Those beside the default, for the detector: which is down, and who that leaves on the default. */
  extraStatuses() {
    const hostIds = this.servers.hostIdsByServer();
    return this.refreshed().map(({ id, name, monitor }) => ({
      id: id!,
      name: name!,
      status: monitor.status(),
      hostIds: hostIds.get(id!) ?? [],
    }));
  }

  cancelAll() {
    this.all().forEach(({ queue }) => queue.cancelAll());
  }

  resume() {
    this.all().forEach(({ queue }) => queue.resume());
  }

  /** After a restore: the table may hold other servers now. */
  reset() {
    this.extras.clear();
    this.defaultServer.client.resetDigest();
    this.defaultServer.monitor.reset();
  }
}
