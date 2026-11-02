import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, type InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  HOST_STATE,
  HOST_STATUS_ACTIVE,
  JARVIS_KEY_SCOPE,
  SETTING_KEYS,
  TARGET_INTEGRATION,
  TASK_RESOURCE,
} from "../../shared/constants.js";
import {
  JARVIS_LIMITS,
  JARVIS_STATUS,
  jarvisSay,
  jarvisSetup,
  jarvisText,
  matchSpoken,
  spokenList,
  spokenKey,
  type JarvisSummary,
  safeName,
  type JarvisConnected,
  type JarvisMessage,
  type JarvisView,
} from "../../shared/jarvis.js";
import { log } from "../../shared/log.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jarvisItems, tasks } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { IntegrationsService } from "../settings/integrations-service.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { WidgetKeysService } from "../widget/widget-keys-service.js";
import { isBuildContainer, planJarvis, type JarvisCandidate } from "./jarvis-filter.js";
import { fleetSummary, hostSummary } from "./jarvis-summary.js";

const WEBHOOK_PATH = "/api/webhook/";
const JSON_HEADERS = { "content-type": "application/json" };
const TEST_KIND = "test";
const LIVE_STATUSES = [JARVIS_STATUS.waiting, JARVIS_STATUS.sent];

const aliasesSchema = z.record(z.string(), z.array(z.string()));
const storedSchema = z.object({ webhookId: z.string(), keyId: z.string(), paused: z.boolean() });
type Stored = z.infer<typeof storedSchema>;
type Item = InferSelectModel<typeof jarvisItems>;

export type JarvisSend = (url: string, body: unknown) => Promise<boolean>;

const sendOverHttp: JarvisSend = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(JARVIS_LIMITS.sendTimeoutMilliseconds),
  });
  return response.ok;
};

/**
 * The link to Jarvis: Home Assistant's voice. Autoheal says what is worth saying through a webhook there, and Home
 * Assistant answers on its own key. Nothing here touches Home Assistant beyond sending that webhook, and nothing
 * here heals: if this stops, Autoheal goes on as before.
 */
export class JarvisService {
  private test: { nonce: string; startedAt: number } | null = null;
  private lastTestMilliseconds: number | null = null;
  private sending = false;

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly store: SettingsStore,
    private readonly integrations: IntegrationsService,
    private readonly keys: WidgetKeysService,
    private readonly secretBox: SecretBox,
    private readonly auditLog: AuditLog,
    private readonly inventory: Pick<InventoryService, "hosts" | "containers">,
    private readonly dashboard: string,
    private readonly clock: () => number = Date.now,
    private readonly send: JarvisSend = sendOverHttp,
  ) {}

  view(): JarvisView {
    const stored = this.connection();
    const webhookId = stored === null ? null : this.secretBox.open(stored.webhookId);
    const database = this.databaseHandle.database;
    const recent = database
      .select()
      .from(jarvisItems)
      .where(eq(jarvisItems.status, JARVIS_STATUS.told))
      .orderBy(desc(jarvisItems.sentAt))
      .limit(JARVIS_LIMITS.recentShown)
      .all();
    const waiting = database.select().from(jarvisItems).where(eq(jarvisItems.status, JARVIS_STATUS.waiting)).all();
    return {
      homeAssistantSet: this.integrations.homeAssistant() !== null,
      connected: stored !== null,
      paused: stored?.paused ?? false,
      setup: webhookId === null ? null : jarvisSetup(this.dashboard, webhookId, this.machineNames()),
      testing: this.testOpen(),
      lastTestMilliseconds: this.lastTestMilliseconds,
      lastHeardAt: stored === null ? null : this.keys.lastUsed(stored.keyId),
      waiting: waiting.length,
      notConfirmed: this.notConfirmed(),
      summary: this.summary("").text,
      hosts: this.activeHosts().map(({ id, label }) => ({ id, label, aliases: this.aliases()[id] ?? [] })),
      recent: recent.map((item) => {
        const message = this.messageOf(item);
        return { id: item.id, kind: message.kind, tier: message.tier, text: message.text, sentAt: item.sentAt! };
      }),
    };
  }

  connect(actor: Actor): JarvisConnected {
    if (this.integrations.homeAssistant() === null) throw new DomainError(API_ERRORS.integrationNotSet);
    this.revokeKey(actor);
    const webhookId = `autoheal-${randomBytes(JARVIS_LIMITS.webhookIdBytes).toString("base64url")}`;
    const created = this.keys.create(actor, "Jarvis", JARVIS_KEY_SCOPE);
    this.store.write(SETTING_KEYS.jarvis, {
      webhookId: this.secretBox.seal(webhookId),
      keyId: created.key.id,
      paused: false,
    } satisfies Stored);
    this.audit(actor, AUDIT_ACTIONS.integrationSaved);
    const view = this.view();
    return {
      view: { ...view, setup: jarvisSetup(this.dashboard, webhookId, this.machineNames()) },
      secret: created.secret,
    };
  }

  disconnect(actor: Actor) {
    this.revokeKey(actor);
    this.store.remove(SETTING_KEYS.jarvis);
    this.test = null;
    this.audit(actor, AUDIT_ACTIONS.integrationRemoved);
  }

  pause(actor: Actor, paused: boolean) {
    const stored = this.connection();
    if (stored === null) throw new DomainError(API_ERRORS.integrationNotSet);
    this.store.write(SETTING_KEYS.jarvis, { ...stored, paused } satisfies Stored);
    this.audit(actor, AUDIT_ACTIONS.integrationSaved);
  }

  /** Sends a test Jarvis answers by itself: only its answer proves both roads, as Home Assistant accepts any webhook. */
  async startTest() {
    const url = this.webhookUrl();
    if (url === null) throw new DomainError(API_ERRORS.integrationNotSet);
    const nonce = randomBytes(JARVIS_LIMITS.nonceBytes).toString("hex");
    this.test = { nonce, startedAt: this.clock() };
    this.lastTestMilliseconds = null;
    const delivered = await this.send(url, { kind: TEST_KIND, nonce }).catch(() => false);
    if (!delivered) this.test = null;
    return { delivered };
  }

  /** Jarvis's answer: to a test, or that a message arrived. Anything else is ignored. */
  heard(nonce: string) {
    this.confirm(nonce);
    if (!this.testOpen() || this.test!.nonce !== nonce) return;
    this.lastTestMilliseconds = this.clock() - this.test!.startedAt;
    this.test = null;
  }

  /** How the servers are, or the one machine asked about, in fixed words a model has no part in. */
  summary(about: string): JarvisSummary {
    const hosts = this.activeHosts();
    const containers = this.inventory.containers();
    const tasks = this.candidates();
    if (about.trim() === "") return fleetSummary(hosts, containers, tasks);
    const aliases = this.aliases();
    const found = matchSpoken(
      about,
      hosts.map((host) => ({ target: host, names: [host.label, ...(aliases[host.id] ?? [])] })),
    );
    if (found.length === 1) return hostSummary(found[0]!, containers, tasks);
    if (found.length === 0) {
      const heard = safeName(about);
      return { say: `I know no machine called ${heard}, sir.`, text: `No machine called ${heard}.` };
    }
    const names = found.map(({ label }) => safeName(label));
    return {
      say: `Did you mean ${spokenList(names).replace(/ and /, " or ")}, sir?`,
      text: `Which: ${names.join(", ")}?`,
    };
  }

  setAliases(actor: Actor, hostId: string, aliases: readonly string[]) {
    const clean = [...new Set(aliases.map(safeName).filter((alias) => spokenKey(alias) !== ""))];
    const others = this.activeHosts().filter(({ id }) => id !== hostId);
    const stored = this.aliases();
    const taken = new Set(others.flatMap(({ id, label }) => [label, ...(stored[id] ?? [])]).map(spokenKey));
    if (clean.some((alias) => taken.has(spokenKey(alias)))) throw new DomainError(API_ERRORS.jarvisNameTaken);
    this.store.write(SETTING_KEYS.jarvisAliases, { ...stored, [hostId]: clean });
    this.audit(actor, AUDIT_ACTIONS.integrationSaved);
  }

  /** A machine's old name still means it, unless another machine has it now. */
  rememberOldName(hostId: string, oldName: string, newName: string) {
    const stored = this.aliases();
    const own = stored[hostId] ?? [];
    const taken = this.activeHosts()
      .filter(({ id }) => id !== hostId)
      .flatMap(({ id, label }) => [label, ...(stored[id] ?? [])])
      .map(spokenKey);
    const kept = own.filter((alias) => spokenKey(alias) !== spokenKey(newName));
    const add = spokenKey(oldName) !== spokenKey(newName) && !taken.includes(spokenKey(oldName));
    const already = kept.some((alias) => spokenKey(alias) === spokenKey(oldName));
    this.store.write(SETTING_KEYS.jarvisAliases, { ...stored, [hostId]: add && !already ? [...kept, oldName] : kept });
  }

  /** What a restarted Home Assistant may have missed. */
  recentMessages(): JarvisMessage[] {
    const since = this.clock() - JARVIS_LIMITS.dayMilliseconds;
    return this.databaseHandle.database
      .select()
      .from(jarvisItems)
      .where(eq(jarvisItems.status, JARVIS_STATUS.told))
      .orderBy(desc(jarvisItems.sentAt))
      .all()
      .filter((item) => item.sentAt! >= since)
      .map((item) => this.messageOf(item));
  }

  /** Decides what to say and sends it: what could not be sent waits for the next tick, unless it stopped being true. */
  async tick() {
    if (this.sending) return;
    const url = this.webhookUrl();
    if (url === null || this.connection()?.paused) return;
    this.sending = true;
    try {
      this.forgetOld();
      const candidates = this.candidates();
      this.dropWhatEnded(candidates);
      this.sendAgainWhatWasNotConfirmed();
      this.plan(candidates);
      await this.sendWaiting(url);
    } finally {
      this.sending = false;
    }
  }

  private plan(candidates: readonly JarvisCandidate[]) {
    const database = this.databaseHandle.database;
    const now = this.clock();
    const said = database
      .select()
      .from(jarvisItems)
      .where(inArray(jarvisItems.status, [...LIVE_STATUSES, JARVIS_STATUS.told, JARVIS_STATUS.unconfirmed]))
      .all()
      .map((item) => {
        const unconfirmed = item.status === JARVIS_STATUS.unconfirmed;
        return {
          groupKey: item.groupKey,
          // What never reached anyone may be told again once the repeat wait is over.
          fingerprint: unconfirmed ? "" : item.fingerprint,
          tier: this.messageOf(item).tier,
          at: item.sentAt ?? item.createdAt,
          counted: !unconfirmed,
        };
      });
    for (const planned of planJarvis(candidates, said, now)) {
      const facts = { kind: planned.kind, host: safeName(planned.hostLabel), names: planned.names.map(safeName) };
      const id = randomUUID();
      const message: JarvisMessage = {
        id,
        kind: planned.kind,
        tier: planned.tier,
        host: facts.host,
        names: facts.names,
        say: jarvisSay(facts),
        text: jarvisText(facts),
      };
      database
        .insert(jarvisItems)
        .values({
          id,
          groupKey: planned.groupKey,
          fingerprint: planned.fingerprint,
          taskIdsJson: JSON.stringify(planned.taskIds),
          messageJson: JSON.stringify(message),
          status: JARVIS_STATUS.waiting,
          createdAt: now,
        })
        .run();
    }
  }

  private async sendWaiting(url: string) {
    const database = this.databaseHandle.database;
    const waiting = database.select().from(jarvisItems).where(eq(jarvisItems.status, JARVIS_STATUS.waiting)).all();
    for (const item of waiting) {
      const delivered = await this.send(url, this.messageOf(item)).catch((error: unknown) => {
        log(`Jarvis could not be reached: ${error instanceof Error ? error.name : "unknown"}`);
        return false;
      });
      if (!delivered) return;
      database
        .update(jarvisItems)
        .set({ status: JARVIS_STATUS.sent, sentAt: this.clock(), attempts: item.attempts + 1 })
        .where(eq(jarvisItems.id, item.id))
        .run();
    }
  }

  private dropWhatEnded(candidates: readonly JarvisCandidate[]) {
    const open = new Set(candidates.map(({ taskId }) => taskId));
    const database = this.databaseHandle.database;
    for (const item of database.select().from(jarvisItems).where(inArray(jarvisItems.status, LIVE_STATUSES)).all()) {
      const taskIds = z.array(z.string()).parse(JSON.parse(item.taskIdsJson));
      if (taskIds.some((taskId) => open.has(taskId))) continue;
      database.update(jarvisItems).set({ status: JARVIS_STATUS.dropped }).where(eq(jarvisItems.id, item.id)).run();
    }
  }

  private machineNames() {
    const aliases = this.aliases();
    return this.activeHosts().map(({ id, label }) => ({ label, aliases: aliases[id] ?? [] }));
  }

  private activeHosts() {
    return this.inventory.hosts().filter(({ state }) => state !== HOST_STATE.revoked);
  }

  private aliases(): Record<string, string[]> {
    return this.store.read(SETTING_KEYS.jarvisAliases, aliasesSchema) ?? {};
  }

  private confirm(id: string) {
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ status: JARVIS_STATUS.told })
      .where(and(eq(jarvisItems.id, id), inArray(jarvisItems.status, LIVE_STATUSES)))
      .run();
  }

  // Only once Jarvis has confirmed something: an automation from before it could confirm would say it all again.
  private sendAgainWhatWasNotConfirmed() {
    const database = this.databaseHandle.database;
    const confirms = database.select().from(jarvisItems).where(eq(jarvisItems.status, JARVIS_STATUS.told)).get();
    if (confirms === undefined) return;
    const before = this.clock() - JARVIS_LIMITS.resendMilliseconds;
    const overdue = database
      .select()
      .from(jarvisItems)
      .where(and(eq(jarvisItems.status, JARVIS_STATUS.sent), lt(jarvisItems.sentAt, before)))
      .all();
    for (const item of overdue) {
      const status = item.attempts >= JARVIS_LIMITS.sendsAtMost ? JARVIS_STATUS.unconfirmed : JARVIS_STATUS.waiting;
      database.update(jarvisItems).set({ status }).where(eq(jarvisItems.id, item.id)).run();
    }
  }

  private notConfirmed() {
    const now = this.clock();
    return this.databaseHandle.database
      .select()
      .from(jarvisItems)
      .where(inArray(jarvisItems.status, [JARVIS_STATUS.sent, JARVIS_STATUS.unconfirmed]))
      .all()
      .filter((item) => {
        const age = now - (item.sentAt ?? now);
        return age >= JARVIS_LIMITS.confirmMilliseconds && age < JARVIS_LIMITS.dayMilliseconds;
      }).length;
  }

  private candidates(): JarvisCandidate[] {
    const now = this.clock();
    const images = new Map(this.inventory.containers().map(({ hostId, name, image }) => [`${hostId}/${name}`, image]));
    return this.databaseHandle.database
      .select({
        taskId: tasks.id,
        detectorKey: tasks.detectorKey,
        priority: tasks.priority,
        hostId: tasks.hostId,
        hostLabel: hosts.label,
        resource: tasks.resourceLabel,
        resourceKind: tasks.resourceKind,
        createdAt: tasks.createdAt,
        snoozedUntil: tasks.snoozedUntil,
      })
      .from(tasks)
      .innerJoin(hosts, eq(hosts.id, tasks.hostId))
      .where(and(isNull(tasks.closedAt), eq(hosts.status, HOST_STATUS_ACTIVE)))
      .all()
      .filter((row) => row.detectorKey !== null && (row.snoozedUntil === null || row.snoozedUntil <= now))
      .filter((row) => {
        if (row.resourceKind !== TASK_RESOURCE.container || row.resource === null) return true;
        return !isBuildContainer(row.resource, images.get(`${row.hostId}/${row.resource}`) ?? null);
      })
      .map((row) => ({ ...row, hostId: row.hostId!, detectorKey: row.detectorKey! }));
  }

  private forgetOld() {
    this.databaseHandle.database
      .delete(jarvisItems)
      .where(lt(jarvisItems.createdAt, this.clock() - JARVIS_LIMITS.retentionMilliseconds))
      .run();
  }

  private messageOf(item: Item): JarvisMessage {
    return JSON.parse(item.messageJson) as JarvisMessage;
  }

  private connection(): Stored | null {
    return this.store.read(SETTING_KEYS.jarvis, storedSchema);
  }

  private webhookUrl(): string | null {
    const stored = this.connection();
    const homeAssistant = this.integrations.homeAssistant();
    const webhookId = stored === null ? null : this.secretBox.open(stored.webhookId);
    if (homeAssistant === null || webhookId === null) return null;
    return new URL(`${WEBHOOK_PATH}${webhookId}`, homeAssistant.url).toString();
  }

  private testOpen() {
    return this.test !== null && this.clock() - this.test.startedAt < JARVIS_LIMITS.testAnswerMilliseconds;
  }

  private revokeKey(actor: Actor) {
    const stored = this.connection();
    if (stored !== null) this.keys.revokeIfLive(actor, stored.keyId);
  }

  private audit(actor: Actor, action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]) {
    this.auditLog.recordUserAction(actor, action, { kind: TARGET_INTEGRATION, id: "jarvis" }, {});
  }
}
