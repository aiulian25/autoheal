import { randomUUID } from "node:crypto";
import { eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { OllamaSettings } from "../../config/shared-settings.js";
import { API_ERRORS } from "../../shared/api.js";
import { AUDIT_ACTIONS, SETTING_KEYS, TARGET_INTEGRATION } from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, ollamaServers } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import { checked } from "./ollama-settings-service.js";
import type { SettingsStore } from "./settings-store.js";

export interface OllamaServerRow extends OllamaSettings {
  id: string;
  name: string;
}

const reviewSchema = z.object({ serverId: z.string() });
const defaultNameSchema = z.object({ name: z.string() });
const DEFAULT_SERVER = "default";
const targetOf = (id: string) => ({ kind: TARGET_INTEGRATION, id: `ollama:${id}` }) as const;

/** The Ollama servers beside the default one, which hosts each watches, and which reads Home Assistant's files. */
export class OllamaServersService {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly store: SettingsStore,
    private readonly auditLog: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  list(): OllamaServerRow[] {
    return this.databaseHandle.database
      .select({
        id: ollamaServers.id,
        name: ollamaServers.name,
        url: ollamaServers.url,
        model: ollamaServers.model,
        contextTokens: ollamaServers.contextTokens,
      })
      .from(ollamaServers)
      .orderBy(ollamaServers.createdAt)
      .all();
  }

  /** The server a host is given; null for the default. */
  serverIdOf(hostId: string): string | null {
    const row = this.databaseHandle.database
      .select({ serverId: hosts.ollamaServerId })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .get();
    return row?.serverId ?? null;
  }

  /** Which hosts each server watches. A host on the default is in none of these. */
  hostIdsByServer(): Map<string, string[]> {
    const rows = this.databaseHandle.database
      .select({ id: hosts.id, serverId: hosts.ollamaServerId })
      .from(hosts)
      .where(isNotNull(hosts.ollamaServerId))
      .all();
    const found = new Map<string, string[]>();
    for (const { id, serverId } of rows) found.set(serverId!, [...(found.get(serverId!) ?? []), id]);
    return found;
  }

  reviewServerId(): string | null {
    const serverId = this.store.read(SETTING_KEYS.ollamaReviewServer, reviewSchema)?.serverId ?? null;
    return this.list().some(({ id }) => id === serverId) ? serverId : null;
  }

  routerServerId(): string | null {
    const serverId = this.store.read(SETTING_KEYS.ollamaRouterServer, reviewSchema)?.serverId ?? null;
    return this.list().some(({ id }) => id === serverId) ? serverId : null;
  }

  chooseRouterServer(actor: Actor, id: string | null) {
    if (id === null) this.store.remove(SETTING_KEYS.ollamaRouterServer);
    else {
      this.require(id);
      this.store.write(SETTING_KEYS.ollamaRouterServer, { serverId: id });
    }
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaRouterServerChosen, targetOf(id ?? DEFAULT_SERVER), {});
    this.changed();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  private changed() {
    this.listeners.forEach((listener) => listener());
  }

  defaultName(): string | null {
    return this.store.read(SETTING_KEYS.ollamaDefaultName, defaultNameSchema)?.name ?? null;
  }

  private requireNameFree(name: string, exceptId: string | null) {
    const taken = this.list().some((server) => server.name === name && server.id !== exceptId);
    if (taken || (exceptId !== DEFAULT_SERVER && this.defaultName() === name)) {
      throw new DomainError(API_ERRORS.ollamaServerNameTaken);
    }
  }

  /** Blank goes back to calling it Default. Its address stays wherever it is set, in Settings or the .env. */
  nameDefault(actor: Actor, name: string) {
    if (name === "") this.store.remove(SETTING_KEYS.ollamaDefaultName);
    else {
      this.requireNameFree(name, DEFAULT_SERVER);
      this.store.write(SETTING_KEYS.ollamaDefaultName, { name });
    }
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaDefaultNamed, targetOf(DEFAULT_SERVER), { name });
    this.changed();
  }

  private require(id: string): OllamaServerRow {
    const server = this.list().find((each) => each.id === id);
    if (server === undefined) throw new DomainError(API_ERRORS.ollamaServerNotFound);
    return server;
  }

  /** Stored only once that Ollama answers with the model, as the default is. */
  async add(actor: Actor, server: OllamaSettings & { name: string }): Promise<string> {
    this.requireNameFree(server.name, null);
    await checked(server);
    const id = randomUUID();
    this.databaseHandle.database
      .insert(ollamaServers)
      .values({ id, ...server, createdAt: this.clock() })
      .run();
    const { name, url, model, contextTokens: contextWindow } = server;
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaServerAdded, targetOf(id), {
      name,
      url,
      model,
      contextWindow,
    });
    this.changed();
    return id;
  }

  async change(actor: Actor, id: string, server: OllamaSettings & { name: string }) {
    this.require(id);
    this.requireNameFree(server.name, id);
    await checked(server);
    this.databaseHandle.database.update(ollamaServers).set(server).where(eq(ollamaServers.id, id)).run();
    const { name, url, model, contextTokens: contextWindow } = server;
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaServerChanged, targetOf(id), {
      name,
      url,
      model,
      contextWindow,
    });
    this.changed();
  }

  /** Its hosts go back to the default, and the audit log names them. */
  remove(actor: Actor, id: string) {
    const server = this.require(id);
    const moved = this.hostIdsByServer().get(id) ?? [];
    this.databaseHandle.database.delete(ollamaServers).where(eq(ollamaServers.id, id)).run();
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaServerRemoved, targetOf(id), {
      name: server.name,
      hostsMovedToDefault: moved,
    });
    this.changed();
  }

  /** Sets exactly which hosts it watches: one ticked here moves from any other, and one unticked goes to the default. */
  assign(actor: Actor, id: string, hostIds: readonly string[]) {
    const server = this.require(id);
    const { database } = this.databaseHandle;
    database.transaction((transaction) => {
      transaction.update(hosts).set({ ollamaServerId: null }).where(eq(hosts.ollamaServerId, id)).run();
      if (hostIds.length > 0) {
        transaction
          .update(hosts)
          .set({ ollamaServerId: id })
          .where(inArray(hosts.id, [...hostIds]))
          .run();
      }
    });
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaHostsAssigned, targetOf(id), {
      name: server.name,
      hostIds,
    });
    this.changed();
  }

  chooseReviewServer(actor: Actor, id: string | null) {
    if (id === null) this.store.remove(SETTING_KEYS.ollamaReviewServer);
    else {
      this.require(id);
      this.store.write(SETTING_KEYS.ollamaReviewServer, { serverId: id });
    }
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.ollamaReviewServerChosen, targetOf(id ?? DEFAULT_SERVER), {});
    this.changed();
  }
}
