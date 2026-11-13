import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, max, ne, type InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS, type ApiErrorCode, type ContainerView } from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  APP_VERSION,
  AUDIT_ACTIONS,
  HOST_STATE,
  HOST_STATUS_ACTIVE,
  JARVIS_KEY_SCOPE,
  JOB_ACTION,
  MILLISECONDS_PER_MINUTE,
  ROLE_ADMIN,
  SETTING_KEYS,
  TARGET_INTEGRATION,
  TASK_ACTIVITY,
  TASK_RESOURCE,
  USER_STATUS_ACTIVE,
} from "../../shared/constants.js";
import {
  JARVIS_ADDRESS,
  JARVIS_ANSWER,
  JARVIS_ANSWER_HOW,
  JARVIS_KIND,
  JARVIS_LIMITS,
  JARVIS_NAME,
  JARVIS_STATUS,
  JARVIS_TEST_OUTCOME,
  JARVIS_TIER,
  assistantSetupLinks,
  jarvisHostUpdatesQuestion,
  jarvisOutcome,
  jarvisPackagesOutcome,
  jarvisQuestion,
  jarvisReplies,
  jarvisRestartOutcome,
  jarvisRestartQuestion,
  jarvisSay,
  jarvisTestQuestionWords,
  jarvisTestWords,
  jarvisVersionQuestion,
  jarvisSetup,
  jarvisText,
  matchSpoken,
  spokenList,
  spokenKey,
  spokenTo,
  type JarvisSummary,
  safeName,
  type JarvisConnected,
  type JarvisMessage,
  type JarvisOpenQuestionView,
  type JarvisReplies,
  type JarvisStatus,
  type JarvisTestQuestionView,
  type JarvisView,
} from "../../shared/jarvis.js";
import { describeError } from "../../shared/errors.js";
import { sha256Hex } from "../../shared/hash.js";
import { imageTag } from "../../shared/image-reference.js";
import { log } from "../../shared/log.js";
import type { DispatchService } from "../agent/dispatch-service.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jarvisItems, tasks, users, widgetKeys } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { accepts, DomainError } from "../domain-error.js";
import type { HomeAssistantConnection } from "../home-assistant/home-assistant-inventory.js";
import type { HostControlService } from "../host-control/host-control-service.js";
import type { HostPackagesService } from "../host-packages/host-packages-service.js";
import type { AssessedPackage } from "../host-packages/package-rules.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { JobRow } from "../jobs/job-views.js";
import type { IntegrationsService } from "../settings/integrations-service.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { tagOfNewerVersionKey } from "../tasks/detectors.js";
import type { TaskAuthor, TasksService } from "../tasks/tasks-service.js";
import type { WidgetKeysService } from "../widget/widget-keys-service.js";
import {
  isBuildContainer,
  kindOf,
  memberKey,
  memberOf,
  planJarvis,
  type JarvisCandidate,
  type JarvisPlanned,
  type JarvisQuestion,
} from "./jarvis-filter.js";
import {
  answerSchema,
  ENDED_UNANSWERED,
  OPEN_TO_ANSWERS,
  outcomeOf,
  refusalWords,
  sameCode,
  type AssistantAnswer,
} from "./assistant-answers.js";
import { ANSWER_BOX_DOMAIN, LINE_PREFIX, LINE_VERB, parseAssistantLine, type AssistantLine } from "./assistant-line.js";
import { fleetSummary, hostSummary } from "./jarvis-summary.js";
import { TestQuestion } from "./test-question.js";

const WEBHOOK_PATH = "/api/webhook/";
const JSON_HEADERS = { "content-type": "application/json" };
const TEST_KIND = "test";
const KEY_LABEL = "Assistant";
const LIVE_STATUSES = [JARVIS_STATUS.waiting, JARVIS_STATUS.sent];
const OPEN_STATUSES = [...LIVE_STATUSES, JARVIS_STATUS.asked];

const aliasesSchema = z.record(z.string(), z.array(z.string()));
const storedSchema = z.object({
  webhookId: z.string(),
  keyId: z.string(),
  paused: z.boolean(),
  // Updates, and newer versions, a person could say yes to are asked about rather than told.
  askUpdates: z.boolean().optional(),
  askVersions: z.boolean().optional(),
  // How it addresses people, once in each spoken sentence; null for not at all. Absent from a connection made before
  // it could be chosen, which keeps the "sir" it always said.
  address: z.string().nullable().optional(),
  // What the person calls it; null for none. Absent from a connection made before it could be chosen: "Jarvis".
  name: z.string().nullable().optional(),
  // The last test question's answer. Until there is one, nothing is asked: nobody could answer it.
  testAnswered: z
    .object({
      said: z.enum(Object.values(JARVIS_ANSWER)),
      how: z.enum(Object.values(JARVIS_ANSWER_HOW)),
      seconds: z.number(),
      at: z.number(),
    })
    .nullable()
    .optional(),
  // When a line about the test question was last read: a word from the house, as any line is.
  testLineAt: z.number().nullable().optional(),
});
type Stored = z.infer<typeof storedSchema>;
const isProven = (stored: Stored | null) => (stored?.testAnswered ?? null) !== null;
type Item = InferSelectModel<typeof jarvisItems>;
type Answer = Extract<AssistantLine, { code: string }>;
type Named = Extract<AssistantLine, { verb: typeof LINE_VERB.update }>;

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
// The jobs a yes starts: an update's, a newer version's tag change, a host's upgrade or its restart. Their end is what
// came of it; a restart's is the host back from a new boot.
const STARTED_BY_A_YES: readonly string[] = [
  JOB_ACTION.update,
  JOB_ACTION.changeTag,
  JOB_ACTION.upgradePackages,
  JOB_ACTION.reboot,
];
// What a person may answer by name: a container's update or newer version, by the container; a host's updates, by the
// host. Never a restart: a host is restarted only by a yes to its own question, or its button.
const ANSWERED_BY_NAME: readonly JarvisMessage["kind"][] = [
  JARVIS_KIND.containerUpdates,
  JARVIS_KIND.newerVersion,
  JARVIS_KIND.hostUpdates,
];
// Said around a name, never part of one: "update the npm container now, Jarvis".
const NOT_A_NAME = new Set(["the", "container", "please", "now"]);
const HOST_SEPARATOR = "on";

// What a yes to a host's updates installs, as one key: a package added, or a newer one out, makes it another question.
const updatesKey = (offered: readonly Pick<AssessedPackage, "name" | "candidate">[]) =>
  sha256Hex(
    offered
      .map(({ name, candidate }) => `${name}=${candidate}`)
      .sort()
      .join(" "),
  );

interface Switches {
  updates: boolean;
  versions: boolean;
}

// A newer version's tags, as its question names them.
const tagsOf = ({ from, to }: JarvisMessage) => (from === undefined || to === undefined ? null : { from, to });

// What a question is answered by, by name: its container, or its host for the host's updates.
const namedIn = (message: JarvisMessage) =>
  message.kind === JARVIS_KIND.hostUpdates ? message.host : (message.names[0] ?? "");

// What is said back to a yes that was taken: what is being done now.
function yesWords(message: JarvisMessage, replies: JarvisReplies) {
  if (message.kind === JARVIS_KIND.reboot) return replies.restarting(message.host);
  if (message.kind === JARVIS_KIND.hostUpdates) return replies.installing(message.host, message.names.length);
  const tags = tagsOf(message);
  if (tags !== null) return replies.moving({ host: message.host, name: message.names[0]!, to: tags.to });
  return replies.updating(message.host, message.names);
}

// A line counts once: one no later than the last counted about its message, as a restart restores, is ignored.
const isNewer = (at: number | null, last: number | null) => at === null || last === null || at > last;
const isNewLine = (item: Item, at: number | null) => isNewer(at, item.lastLineAt);
// An answer is weighed against answers alone: a phone pressed at once writes it in the same second as its heard.
const isNewAnswer = (item: Item, at: number | null) => isNewer(at, item.lastAnswerAt);

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
  private testQuestion: TestQuestion | null = null;
  private lastTestMilliseconds: number | null = null;
  private sending = false;
  private lineWindow = { startedAt: 0, lines: 0 };
  private linesDropped = 0;
  // The time on the last answer by name read: one no later, as a reconnect brings the same line again, is ignored.
  private lastNamedAt: number | null = null;

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly store: SettingsStore,
    private readonly integrations: IntegrationsService,
    private readonly keys: WidgetKeysService,
    private readonly secretBox: SecretBox,
    private readonly auditLog: AuditLog,
    private readonly inventory: Pick<InventoryService, "hosts" | "containers">,
    private readonly handOver: Pick<DispatchService, "takesUpdate" | "takesTag" | "takesPackages" | "dispatch">,
    private readonly hostPackages: Pick<HostPackagesService, "plan" | "request" | "requireRestart">,
    private readonly homeAssistant: Pick<HomeAssistantConnection, "connected">,
    private readonly tasks: Pick<TasksService, "addActivity">,
    private readonly hostControl: Pick<HostControlService, "ignoreVersions">,
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
    const homeAssistant = this.integrations.homeAssistant();
    return {
      homeAssistantSet: homeAssistant !== null,
      connected: stored !== null,
      paused: stored?.paused ?? false,
      setup: webhookId === null ? null : jarvisSetup(this.dashboard, webhookId, this.machineNames(), this.address()),
      address: this.address(),
      name: this.name(),
      webhookId,
      links: homeAssistant === null ? null : assistantSetupLinks(homeAssistant.url, APP_VERSION),
      homeAssistantConnected: this.homeAssistant.connected(),
      testQuestion: this.testQuestionView(stored),
      asking: { ready: isProven(stored), updates: stored?.askUpdates === true, versions: stored?.askVersions === true },
      open: this.openQuestions(),
      testing: this.testOpen(),
      lastTestMilliseconds: this.lastTestMilliseconds,
      ...this.lastHeard(stored),
      linesDropped: this.linesDropped,
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
    this.dropOpenQuestions();
    const webhookId = `autoheal-${randomBytes(JARVIS_LIMITS.webhookIdBytes).toString("base64url")}`;
    const created = this.keys.create(actor, KEY_LABEL, JARVIS_KEY_SCOPE);
    this.store.write(SETTING_KEYS.jarvis, {
      webhookId: this.secretBox.seal(webhookId),
      keyId: created.key.id,
      paused: false,
      address: null,
      name: null,
      testAnswered: null,
      testLineAt: null,
    } satisfies Stored);
    this.testQuestion = null;
    this.audit(actor, AUDIT_ACTIONS.integrationSaved);
    const view = this.view();
    return {
      view: { ...view, setup: jarvisSetup(this.dashboard, webhookId, this.machineNames(), this.address()) },
      secret: created.secret,
    };
  }

  disconnect(actor: Actor) {
    this.revokeKey(actor);
    this.dropOpenQuestions();
    this.store.remove(SETTING_KEYS.jarvis);
    this.test = null;
    this.testQuestion = null;
    this.audit(actor, AUDIT_ACTIONS.integrationRemoved);
  }

  // A question is the say of the connection that asked it: one made since, by whoever, or none, takes no answer to
  // it, so each code given out before answers nothing any more.
  private dropOpenQuestions() {
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ status: JARVIS_STATUS.dropped })
      .where(and(isNotNull(jarvisItems.codeSealed), inArray(jarvisItems.status, [...OPEN_TO_ANSWERS])))
      .run();
  }

  /** How it addresses people from now on: a few words said once in each sentence, or none when empty. */
  setAddress(actor: Actor, address: string) {
    const stored = this.connection();
    if (stored === null) throw new DomainError(API_ERRORS.integrationNotSet);
    this.store.write(SETTING_KEYS.jarvis, { ...stored, address: address === "" ? null : address } satisfies Stored);
    this.audit(actor, AUDIT_ACTIONS.integrationSaved);
  }

  /** What the person calls it from now on, as the card shows it; none when empty. */
  setName(actor: Actor, name: string) {
    const stored = this.connection();
    if (stored === null) throw new DomainError(API_ERRORS.integrationNotSet);
    this.store.write(SETTING_KEYS.jarvis, { ...stored, name: name === "" ? null : name } satisfies Stored);
    this.audit(actor, AUDIT_ACTIONS.integrationSaved);
  }

  /** What is asked rather than told. Each turns on only once a test question was answered; off, any time. */
  setAsking(actor: Actor, asking: { updates: boolean; versions: boolean }) {
    const stored = this.connection();
    if (stored === null) throw new DomainError(API_ERRORS.integrationNotSet);
    const turnsOn = (asking.updates && stored.askUpdates !== true) || (asking.versions && stored.askVersions !== true);
    if (turnsOn && !isProven(stored)) throw new DomainError(API_ERRORS.assistantNotTested);
    this.store.write(SETTING_KEYS.jarvis, {
      ...stored,
      askUpdates: asking.updates,
      askVersions: asking.versions,
    } satisfies Stored);
    // A kind turned off takes its open questions with it now, not at the next look: a yes to one starts nothing.
    this.dropWhatEnded(this.candidates());
    this.audit(actor, AUDIT_ACTIONS.integrationSaved);
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
    const message = { id: nonce, kind: TEST_KIND, tier: JARVIS_TIER.say, nonce, ...jarvisTestWords(this.address()) };
    const delivered = await this.send(url, message).catch(() => false);
    if (!delivered) this.test = null;
    return { delivered };
  }

  /**
   * The card's test question, asked as any question is. Until it is answered nothing is asked, as an answer might not
   * come back: only its answer, by voice or by phone, proves the way back.
   */
  async startTestQuestion() {
    const url = this.webhookUrl();
    const stored = this.connection();
    if (url === null || stored === null) throw new DomainError(API_ERRORS.integrationNotSet);
    const test = new TestQuestion(this.clock());
    this.testQuestion = test;
    this.store.write(SETTING_KEYS.jarvis, { ...stored, testAnswered: null } satisfies Stored);
    const message = {
      id: test.id,
      kind: TEST_KIND,
      tier: JARVIS_TIER.ask,
      nonce: test.id,
      code: test.code,
      ...jarvisTestQuestionWords(this.address()),
    };
    test.delivered = await this.send(url, message).catch(() => false);
    return { delivered: test.delivered };
  }

  /** Jarvis's answer: to a test, or that a message arrived. Anything else is ignored. */
  heard(nonce: string) {
    this.confirm(nonce, null);
    this.answerTest(nonce);
    this.testQuestion?.hear(nonce);
  }

  /**
   * A line Home Assistant wrote into a Text helper: `heard`, as its key's call says it, or `later`. Each counts once,
   * by the time it carries; anything else is left alone, and past thirty a minute they are not read, only counted.
   */
  read(entityId: string, text: string) {
    const isLine = entityId.startsWith(ANSWER_BOX_DOMAIN) && text.startsWith(LINE_PREFIX);
    if (!isLine || this.connection() === null) return;
    if (!this.withinLineRate()) {
      this.linesDropped += 1;
      return;
    }
    const line = parseAssistantLine(text);
    if (line === null) return;
    if (line.verb === LINE_VERB.update) {
      this.answerByName(line);
      this.soon();
      return;
    }
    if ("code" in line) {
      this.answer(line);
      this.soon();
      return;
    }
    if (line.id === this.testQuestion?.id) this.keepTestLine(line.at);
    if (line.verb === LINE_VERB.later) {
      this.putOff(line.id, line.at);
      this.testQuestion?.postpone(line.id);
      return;
    }
    this.confirm(line.id, line.at);
    this.answerTest(line.id);
    this.testQuestion?.hear(line.id);
  }

  /** A job's end. An update a yes started counts toward its question; once each has ended, what came of it is told. */
  jobFinished(job: JobRow, succeeded: boolean) {
    const { taskId } = job;
    if (!STARTED_BY_A_YES.includes(job.action) || taskId === null) return;
    for (const question of this.itemsWith(JARVIS_STATUS.accepted)) {
      const answer = this.answerOf(question);
      if (answer === null || !this.startedBy(question, answer, job)) continue;
      const outcomes = { ...answer.outcomes, [taskId]: succeeded };
      this.keepAnswer(question, { ...answer, outcomes });
      if (this.taskIdsOf(question).every((member) => member in outcomes)) this.tellOutcome(question, outcomes);
    }
    this.soon();
  }

  /** How the servers are, or the one machine asked about, in fixed words a model has no part in. */
  summary(about: string): JarvisSummary {
    const hosts = this.activeHosts();
    const containers = this.inventory.containers();
    const tasks = this.candidates();
    const address = this.address();
    const toYou = spokenTo(address);
    if (about.trim() === "") return fleetSummary(hosts, containers, tasks, address);
    const aliases = this.aliases();
    const found = matchSpoken(
      about,
      hosts.map((host) => ({ target: host, names: [host.label, ...(aliases[host.id] ?? [])] })),
    );
    if (found.length === 1) return hostSummary(found[0]!, containers, tasks, address);
    if (found.length === 0) {
      const heard = safeName(about);
      return { say: `I know no machine called ${heard}${toYou}.`, text: `No machine called ${heard}.` };
    }
    const names = found.map(({ label }) => safeName(label));
    return {
      say: `Did you mean ${spokenList(names).replace(/ and /, " or ")}${toYou}?`,
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
      this.retireWhatWasAskedEnough();
      this.tellOverdueOutcomes();
      this.sendAgainWhatWasNotConfirmed();
      this.plan(candidates);
      await this.sendWaiting(url);
    } finally {
      this.sending = false;
    }
  }

  private plan(candidates: readonly JarvisCandidate[]) {
    const now = this.clock();
    const items = this.databaseHandle.database
      .select()
      .from(jarvisItems)
      .where(ne(jarvisItems.status, JARVIS_STATUS.dropped))
      .all();
    const said = items.map((item) => {
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
    const questions = items.flatMap((item) => this.asQuestion(item, now));
    for (const planned of planJarvis(candidates, said, now, questions)) {
      if (planned.again !== undefined) {
        this.askAgain(planned.again);
        continue;
      }
      this.add(planned, now);
    }
  }

  private asQuestion(item: Item, now: number): JarvisQuestion[] {
    const members = this.membersOf(item);
    if (members === null) return [];
    const waitIsOver = item.nextAskAt !== null && item.nextAskAt <= now;
    const due = item.status === JARVIS_STATUS.asked && item.asks < JARVIS_LIMITS.asksAtMost && waitIsOver;
    return [{ id: item.id, groupKey: item.groupKey, members, status: item.status, sentAt: item.sentAt, due }];
  }

  private add(planned: JarvisPlanned, now: number) {
    const facts = { kind: planned.kind, host: safeName(planned.hostLabel), names: this.namesOf(planned) };
    const asking = planned.tier === JARVIS_TIER.ask;
    const tags = planned.kind === JARVIS_KIND.newerVersion ? this.versionTags(planned) : null;
    const id = randomUUID();
    const message: JarvisMessage = {
      id,
      kind: planned.kind,
      tier: planned.tier,
      host: facts.host,
      names: facts.names,
      ...this.wordsOf(facts, planned.tier, tags, false, this.address()),
      ...(tags ?? {}),
    };
    this.databaseHandle.database
      .insert(jarvisItems)
      .values({
        id,
        groupKey: planned.groupKey,
        fingerprint: planned.fingerprint,
        taskIdsJson: JSON.stringify(planned.taskIds),
        messageJson: JSON.stringify(message),
        status: JARVIS_STATUS.waiting,
        createdAt: now,
        membersJson: asking ? JSON.stringify(planned.members) : null,
        codeSealed: asking ? this.newCode() : null,
      })
      .run();
  }

  // A question about a host's updates names its packages, so it can say how many; anything else names what it planned.
  private namesOf(planned: JarvisPlanned): string[] {
    const asksHostUpdates = planned.tier === JARVIS_TIER.ask && planned.kind === JARVIS_KIND.hostUpdates;
    const names = asksHostUpdates ? this.offeredUpdates(planned.hostId).map(({ name }) => name) : planned.names;
    return names.map(safeName);
  }

  // The same question with the same code; the last time, it says it will not ask again.
  private askAgain(id: string) {
    const database = this.databaseHandle.database;
    const item = database.select().from(jarvisItems).where(eq(jarvisItems.id, id)).get();
    if (item === undefined) return;
    const message = this.messageOf(item);
    const lastAsking = item.asks + 1 >= JARVIS_LIMITS.asksAtMost;
    database
      .update(jarvisItems)
      .set({
        status: JARVIS_STATUS.waiting,
        messageJson: JSON.stringify({
          ...message,
          ...this.wordsOf(message, JARVIS_TIER.ask, tagsOf(message), lastAsking, this.address()),
        }),
        nextAskAt: null,
        attempts: 0,
      })
      .where(eq(jarvisItems.id, id))
      .run();
  }

  private async sendWaiting(url: string) {
    const database = this.databaseHandle.database;
    const now = this.clock();
    const waiting = database
      .select()
      .from(jarvisItems)
      .where(eq(jarvisItems.status, JARVIS_STATUS.waiting))
      .all()
      .filter(({ nextAskAt }) => nextAskAt === null || nextAskAt <= now);
    for (const item of waiting) {
      // Disconnected, paused or pointed elsewhere while the last one was on its way: nothing more goes where it went.
      if (this.webhookUrl() !== url || this.connection()?.paused === true) return;
      const message = this.outgoing(item);
      if (message === null) {
        database.update(jarvisItems).set({ status: JARVIS_STATUS.dropped }).where(eq(jarvisItems.id, item.id)).run();
        continue;
      }
      const delivered = await this.send(url, message).catch((error: unknown) => {
        log(`Jarvis could not be reached: ${error instanceof Error ? error.name : "unknown"}`);
        return false;
      });
      if (!delivered) return;
      this.markSent(item);
    }
  }

  // A line Home Assistant wrote while it was on its way stands: heard, put off or answered, it is not marked sent over
  // that. When it went out is kept either way: what was told is shown by it.
  private markSent(item: Item) {
    const database = this.databaseHandle.database;
    const itself = eq(jarvisItems.id, item.id);
    const noLineSince =
      item.lastLineAt === null ? isNull(jarvisItems.lastLineAt) : eq(jarvisItems.lastLineAt, item.lastLineAt);
    database.update(jarvisItems).set({ sentAt: this.clock() }).where(itself).run();
    database
      .update(jarvisItems)
      .set({ status: JARVIS_STATUS.sent, attempts: item.attempts + 1 })
      .where(and(itself, eq(jarvisItems.status, JARVIS_STATUS.waiting), noLineSince))
      .run();
  }

  // A question goes out with its code. One whose code cannot be opened (another backup passphrase sealed it) could
  // never be answered, so it is not asked.
  private outgoing(item: Item): JarvisMessage | null {
    const message = this.messageOf(item);
    if (item.codeSealed === null) return message;
    const code = this.secretBox.open(item.codeSealed);
    return code === null ? null : { ...message, code };
  }

  private dropWhatEnded(candidates: readonly JarvisCandidate[]) {
    const open = new Set(candidates.map(({ taskId }) => taskId));
    const askable = new Set(
      candidates.flatMap(({ taskId, ask }) => (ask?.askable === true ? [memberKey(taskId, ask.brings)] : [])),
    );
    const database = this.databaseHandle.database;
    for (const item of database.select().from(jarvisItems).where(inArray(jarvisItems.status, OPEN_STATUSES)).all()) {
      if (!this.hasEnded(item, open, askable)) continue;
      database.update(jarvisItems).set({ status: JARVIS_STATUS.dropped }).where(eq(jarvisItems.id, item.id)).run();
    }
  }

  // A statement ends with the last of its tasks. A question ends as soon as one of its updates is no longer one a yes
  // would take as it was asked: done another way, a newer image out, or not the hand-over's any more.
  private hasEnded(item: Item, open: ReadonlySet<string>, askable: ReadonlySet<string>) {
    if (this.messageOf(item).tier === JARVIS_TIER.reply) return false;
    const members = this.membersOf(item);
    if (members !== null) return members.some((member) => !askable.has(member));
    return this.taskIdsOf(item).every((taskId) => !open.has(taskId));
  }

  // Asked as often as it may be, and its last wait is over: it is not asked again, and stays on the dashboard.
  private retireWhatWasAskedEnough() {
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ status: JARVIS_STATUS.retired })
      .where(
        and(
          eq(jarvisItems.status, JARVIS_STATUS.asked),
          gte(jarvisItems.asks, JARVIS_LIMITS.asksAtMost),
          lte(jarvisItems.nextAskAt, this.clock()),
        ),
      )
      .run();
  }

  // An answer, by its question's code, checked in this order before anything is done.
  private answer(line: Answer) {
    if (this.testQuestion?.owns(line.code)) {
      this.keepTestLine(line.at);
      this.answerTestQuestion(this.testQuestion, line);
      return;
    }
    const replies = jarvisReplies(this.address());
    const question = this.questionWithCode(line.code);
    if (question === null || !isNewAnswer(question, line.at)) return;
    if (ENDED_UNANSWERED.includes(question.status)) {
      this.reply(question, replies.noLongerOpen);
      // Counted, so the same line read again, as a reconnect brings it, is not answered again.
      this.settleWithout(question, line, question.status);
      return;
    }
    if (!OPEN_TO_ANSWERS.includes(question.status)) return;
    const stored = this.connection()!;
    if (stored.paused) {
      this.refuse(question, line);
      return;
    }
    const connector = this.connector(stored);
    if (connector === null) {
      this.reply(question, replies.notAdmin);
      this.refuse(question, line);
      return;
    }
    if (line.verb === LINE_VERB.no) {
      this.settle(question, line, connector, JARVIS_STATUS.declined);
      this.ignoreVersion(question, connector);
      return;
    }
    this.takeYes(question, line, connector, replies);
  }

  /**
   * A yes by name ("update npm on Rowan, Jarvis"): to the one open question it fits, answered as that question's own
   * code would be, with every check a code's answer meets. Several, and it asks which; none, and it says so. Only while
   * fresh, and each line once.
   */
  private answerByName(line: Named) {
    const stale = this.clock() - line.at > JARVIS_LIMITS.namedAnswerMilliseconds;
    const seen = this.lastNamedAt !== null && line.at <= this.lastNamedAt;
    if (stale || seen) return;
    this.lastNamedAt = line.at;
    const meant = this.nameMeant(line.heard);
    if (meant === null) return;
    const replies = jarvisReplies(this.address());
    const fits = this.openQuestionsNamed(meant);
    if (fits.length === 0) {
      this.replyAlone(replies.nothingOpen(safeName(meant.spoken)));
      return;
    }
    if (fits.length > 1) {
      this.reply(fits[0]!.item, replies.whichOne(fits.map(({ named }) => named)));
      return;
    }
    const code = this.secretBox.open(fits[0]!.item.codeSealed!);
    if (code === null) return;
    this.answer({ verb: LINE_VERB.yes, code, at: line.at, how: line.how, room: null });
  }

  // The name heard, without the words said around one or the assistant's own name; and its host, after the last "on".
  private nameMeant(heard: string) {
    const own = this.name();
    const assistant = own === null ? null : spokenKey(own);
    const words = heard
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((word) => word !== "" && !NOT_A_NAME.has(word) && spokenKey(word) !== assistant);
    const at = words.lastIndexOf(HOST_SEPARATOR);
    const name = (at < 0 ? words : words.slice(0, at)).join(" ");
    if (name === "") return null;
    const hostWords = at < 0 ? "" : words.slice(at + 1).join(" ");
    return { name, host: hostWords === "" ? null : hostWords, spoken: words.join(" ") };
  }

  // The open questions a name fits, of those put to someone already: a container's by the container, a host's updates
  // by the host; with a host heard too, only those on it.
  private openQuestionsNamed(meant: { name: string; host: string | null }) {
    const open = this.databaseHandle.database
      .select()
      .from(jarvisItems)
      .where(
        and(
          inArray(jarvisItems.status, [...OPEN_TO_ANSWERS]),
          isNotNull(jarvisItems.codeSealed),
          isNotNull(jarvisItems.sentAt),
        ),
      )
      .all()
      .map((item) => ({ item, message: this.messageOf(item) }))
      .filter(({ message }) => ANSWERED_BY_NAME.includes(message.kind))
      .map(({ item, message }) => ({ item, named: { host: message.host, name: namedIn(message) } }));
    const byName = matchSpoken(
      meant.name,
      open.map((entry) => ({ target: entry, names: [entry.named.name] })),
    );
    const { host } = meant;
    if (host === null) return byName;
    return byName.filter(({ named }) => matchSpoken(host, [{ target: named, names: [named.host] }]).length > 0);
  }

  // A yes: exactly the updates it was asked about, if they still are as asked and their host could do them now.
  private takeYes(question: Item, line: Answer, connector: Actor, replies: JarvisReplies) {
    const message = this.messageOf(question);
    const candidates = this.candidates();
    const changed = this.changeSince(question, candidates, replies);
    if (changed !== null) {
      this.settleWithout(question, line, JARVIS_STATUS.dropped);
      this.reply(question, changed);
      return;
    }
    const first = candidates.find(({ taskId }) => taskId === this.taskIdsOf(question)[0])!;
    const host = this.activeHosts().find(({ id }) => id === first.hostId);
    if (host?.state !== HOST_STATE.online) {
      this.reply(question, replies.hostSilent(message.host));
      this.refuse(question, line);
      return;
    }
    if (host.dryRun === true) {
      this.reply(question, replies.hostReports(message.host));
      this.refuse(question, line);
      return;
    }
    // Its moment is before the hand-over, which may make its jobs at once: each job a yes made comes after it.
    const at = this.clock();
    const refusal = this.carryOut(question, connector, first);
    if (refusal !== null) {
      this.reply(question, refusalWords(refusal, message.host, replies));
      this.refuse(question, line);
      return;
    }
    this.settle(question, line, connector, JARVIS_STATUS.accepted, at);
    this.reply(question, yesWords(message, replies));
  }

  // Each update as it was asked about: its task open, still one a yes is taken for (its kind still asked about, still
  // waiting on a person), with the same newer image. Otherwise, what a yes is told.
  private changeSince(question: Item, candidates: readonly JarvisCandidate[], replies: JarvisReplies) {
    const asks = new Map(candidates.map(({ taskId, ask }) => [taskId, ask ?? null]));
    const members = (this.membersOf(question) ?? []).map(memberOf);
    const now = members.map(({ taskId, brings }) => ({ brings, ask: asks.get(taskId) ?? null }));
    if (now.some(({ ask }) => ask === null)) return replies.gone;
    if (now.some(({ ask }) => ask?.askable !== true)) return replies.noLongerOpen;
    return now.some(({ brings, ask }) => ask?.brings !== brings) ? replies.newerOut : null;
  }

  // What a yes was to, as whoever connected the assistant; the refusal it met, or null once it is under way.
  private carryOut(question: Item, connector: Actor, first: JarvisCandidate): ApiErrorCode | null {
    try {
      this.act(question, connector, first);
      return null;
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
  }

  // The dashboard's own Restart for a host's restart; for the rest its own hand-over: a host's updates, a newer version
  // with its tag changed where the container's files write it, or each update of the question, to the very image it
  // was asked about, or back to its person, never to one its tag moved to since.
  private act(question: Item, connector: Actor, first: JarvisCandidate) {
    const kind = kindOf(first.detectorKey);
    if (kind === JARVIS_KIND.reboot) {
      const author: TaskAuthor = { kind: "user", actor: connector };
      this.hostPackages.request(author, first.hostId, JOB_ACTION.reboot, [], first.taskId);
      return;
    }
    const nothing = { updates: [], packages: [], incidents: [], tags: [] };
    if (kind === JARVIS_KIND.hostUpdates) {
      const names = this.offeredUpdates(first.hostId).map(({ name }) => name);
      this.handOver.dispatch(connector, { ...nothing, packages: [{ hostId: first.hostId, names }] });
      return;
    }
    if (kind === JARVIS_KIND.newerVersion) {
      const tag = { hostId: first.hostId, container: first.resource ?? "", tag: first.ask!.brings };
      this.handOver.dispatch(connector, { ...nothing, tags: [tag] });
      return;
    }
    const approved = new Map(
      (this.membersOf(question) ?? []).map(memberOf).map(({ taskId, brings }) => [taskId, brings]),
    );
    this.handOver.dispatch(connector, { ...nothing, updates: this.taskIdsOf(question) }, approved);
  }

  // A no to a newer version ignores that version, as Ignore this version on the dashboard does: a later one is asked.
  // For the container its task is about: the name in the words may be cut short, or match another's.
  private ignoreVersion(question: Item, connector: Actor) {
    const { kind } = this.messageOf(question);
    const [member] = (this.membersOf(question) ?? []).map(memberOf);
    if (kind !== JARVIS_KIND.newerVersion || member === undefined) return;
    const task = this.databaseHandle.database
      .select({ hostId: tasks.hostId, container: tasks.resourceId })
      .from(tasks)
      .where(eq(tasks.id, member.taskId))
      .get();
    if (task?.hostId == null || task.container == null) return;
    try {
      this.hostControl.ignoreVersions(connector, task.hostId, [{ container: task.container, version: member.brings }]);
    } catch (error) {
      // Its container is gone: there is no version of it left to ignore.
      if (!(error instanceof DomainError)) throw error;
    }
  }

  // Statements in their fixed words; a question about a host's restart or its updates, one newer version with its
  // tags, or one container's update.
  private wordsOf(
    facts: Pick<JarvisMessage, "kind" | "host" | "names">,
    tier: JarvisMessage["tier"],
    tags: { from: string; to: string } | null,
    lastAsking: boolean,
    address: string | null,
  ) {
    const { kind, host, names } = facts;
    if (tier !== JARVIS_TIER.ask) return { say: jarvisSay(facts, address), text: jarvisText(facts) };
    if (kind === JARVIS_KIND.reboot) return jarvisRestartQuestion(host, lastAsking, address);
    if (kind === JARVIS_KIND.hostUpdates) {
      return jarvisHostUpdatesQuestion({ host, count: names.length }, lastAsking, address);
    }
    if (tags !== null) return jarvisVersionQuestion({ host, name: names[0]!, ...tags }, lastAsking, address);
    return jarvisQuestion({ host, names }, lastAsking, address);
  }

  // The tag a container runs, and the newer one its question is about, as its runner reported them.
  private versionTags(planned: JarvisPlanned) {
    const [member] = (planned.members ?? []).map(memberOf);
    const container = this.inventory
      .containers()
      .find(({ hostId, name }) => hostId === planned.hostId && name === planned.names[0]);
    if (member === undefined || container === undefined) return null;
    return { from: imageTag(container.image), to: member.brings };
  }

  // Taken: kept with the question, said on each of its tasks, and in the audit log as whoever connected it.
  private settle(question: Item, line: Answer, connector: Actor, status: JarvisStatus, at = this.clock()) {
    const said = { answer: line.verb, how: line.how, room: line.room };
    const answer: AssistantAnswer = { ...said, by: connector.username, at, outcomes: {} };
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ status, answerJson: JSON.stringify(answer), lastLineAt: line.at, lastAnswerAt: line.at })
      .where(eq(jarvisItems.id, question.id))
      .run();
    const author: TaskAuthor = { kind: "user", actor: connector };
    this.taskIdsOf(question).forEach((taskId) =>
      this.tasks.addActivity(taskId, TASK_ACTIVITY.assistantAnswered, author, said),
    );
    const { host, names } = this.messageOf(question);
    this.auditLog.recordUserAction(
      connector,
      AUDIT_ACTIONS.assistantAnswered,
      { kind: TARGET_INTEGRATION, id: "jarvis" },
      { ...said, host, containers: names },
    );
  }

  private settleWithout(question: Item, line: Answer, status: JarvisStatus) {
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ status, lastLineAt: line.at, lastAnswerAt: line.at })
      .where(eq(jarvisItems.id, question.id))
      .run();
  }

  // Not taken: its code is used up, and it is asked again with a new one once a yes could be carried out.
  private refuse(question: Item, line: Answer) {
    this.databaseHandle.database
      .update(jarvisItems)
      .set({
        status: JARVIS_STATUS.asked,
        nextAskAt: this.clock(),
        codeSealed: this.newCode(),
        lastLineAt: line.at,
        lastAnswerAt: line.at,
      })
      .where(eq(jarvisItems.id, question.id))
      .run();
  }

  // Autoheal's word on an answer: sent at once, never counted against the day, never sent twice.
  private reply(about: Item, said: { say: string; text: string }) {
    const { kind, host, names } = this.messageOf(about);
    this.sendReply({ kind, host, names, ...said }, `${JARVIS_TIER.reply}:${about.id}`, about.taskIdsJson);
  }

  // Autoheal's word when the words heard fit no question, said as any reply is: about nothing of its own.
  private replyAlone(said: { say: string; text: string }) {
    this.sendReply({ kind: JARVIS_KIND.containerUpdates, host: "", names: [], ...said }, null, JSON.stringify([]));
  }

  private sendReply(facts: Omit<JarvisMessage, "id" | "tier">, groupKey: string | null, taskIdsJson: string) {
    const id = randomUUID();
    const message: JarvisMessage = { id, tier: JARVIS_TIER.reply, ...facts };
    this.databaseHandle.database
      .insert(jarvisItems)
      .values({
        id,
        groupKey: groupKey ?? `${JARVIS_TIER.reply}:${id}`,
        fingerprint: id,
        taskIdsJson,
        messageJson: JSON.stringify(message),
        status: JARVIS_STATUS.waiting,
        createdAt: this.clock(),
      })
      .run();
  }

  // An update job started after its question's yes, about one of its tasks, and not counted yet.
  private startedBy(question: Item, answer: AssistantAnswer, job: JobRow) {
    return (
      this.taskIdsOf(question).includes(job.taskId!) && job.createdAt >= answer.at && !(job.taskId! in answer.outcomes)
    );
  }

  private tellOutcome(question: Item, outcomes: Readonly<Record<string, boolean>>) {
    this.reply(question, this.outcomeWords(this.messageOf(question), this.taskIdsOf(question), outcomes));
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ status: JARVIS_STATUS.done })
      .where(eq(jarvisItems.id, question.id))
      .run();
  }

  // What came of a yes: a host's restart, its updates, or each container's update in the question's order.
  private outcomeWords(
    message: JarvisMessage,
    taskIds: readonly string[],
    outcomes: Readonly<Record<string, boolean>>,
  ) {
    const { kind, host, names } = message;
    const address = this.address();
    const ended: boolean | undefined = outcomes[taskIds[0]!];
    if (kind === JARVIS_KIND.reboot) return jarvisRestartOutcome(host, ended, address);
    if (kind === JARVIS_KIND.hostUpdates) return jarvisPackagesOutcome(host, ended, address);
    return jarvisOutcome(host, outcomeOf(names, taskIds, outcomes), address);
  }

  // A while after a yes, what came of it is told, done or not.
  private tellOverdueOutcomes() {
    const due = this.clock() - JARVIS_LIMITS.outcomeWaitMilliseconds;
    for (const question of this.itemsWith(JARVIS_STATUS.accepted)) {
      const answer = this.answerOf(question);
      if (answer !== null && answer.at <= due) this.tellOutcome(question, answer.outcomes);
    }
  }

  private questionWithCode(code: string): Item | null {
    const questions = this.databaseHandle.database
      .select()
      .from(jarvisItems)
      .where(isNotNull(jarvisItems.codeSealed))
      .all();
    return questions.find((item) => sameCode(this.secretBox.open(item.codeSealed!), code)) ?? null;
  }

  // Whoever connected the assistant: a yes acts as them, and only while they are an active admin.
  private connector(stored: Stored): Actor | null {
    const user = this.databaseHandle.database
      .select({ userId: users.id, username: users.username, role: users.role, status: users.status })
      .from(widgetKeys)
      .innerJoin(users, eq(users.id, widgetKeys.createdBy))
      .where(eq(widgetKeys.id, stored.keyId))
      .get();
    if (user === undefined || user.role !== ROLE_ADMIN || user.status !== USER_STATUS_ACTIVE) return null;
    return { userId: user.userId, username: user.username, ip: "", requestId: stored.keyId };
  }

  // Sends what waits now, and lets the next question go, without waiting for the next tick.
  private soon() {
    void this.tick().catch((error: unknown) => log(`Jarvis could not send: ${describeError(error)}`));
  }

  private newCode() {
    return this.secretBox.seal(randomBytes(JARVIS_LIMITS.codeBytes).toString("base64url"));
  }

  private itemsWith(status: JarvisStatus) {
    return this.databaseHandle.database.select().from(jarvisItems).where(eq(jarvisItems.status, status)).all();
  }

  private answerOf(item: Item): AssistantAnswer | null {
    return item.answerJson === null ? null : answerSchema.parse(JSON.parse(item.answerJson));
  }

  private keepAnswer(item: Item, answer: AssistantAnswer) {
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ answerJson: JSON.stringify(answer) })
      .where(eq(jarvisItems.id, item.id))
      .run();
  }

  private taskIdsOf(item: Item): string[] {
    return z.array(z.string()).parse(JSON.parse(item.taskIdsJson));
  }

  private membersOf(item: Item): string[] | null {
    return item.membersJson === null ? null : z.array(z.string()).parse(JSON.parse(item.membersJson));
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

  // Heard: a statement is told; a question was asked once more, and waits a day before it is asked again.
  private confirm(id: string, at: number | null) {
    const item = this.liveItem(id);
    if (item === undefined || !isNewLine(item, at)) return;
    const database = this.databaseHandle.database;
    const lastLineAt = at ?? item.lastLineAt;
    if (item.membersJson === null) {
      database.update(jarvisItems).set({ status: JARVIS_STATUS.told, lastLineAt }).where(eq(jarvisItems.id, id)).run();
      return;
    }
    database
      .update(jarvisItems)
      .set({
        status: JARVIS_STATUS.asked,
        asks: item.asks + 1,
        nextAskAt: this.clock() + JARVIS_LIMITS.repeatMilliseconds,
        lastLineAt,
      })
      .where(eq(jarvisItems.id, id))
      .run();
    this.taskIdsOf(item).forEach((taskId) =>
      this.tasks.addActivity(taskId, TASK_ACTIVITY.assistantAsked, AUTOHEAL, { asking: item.asks + 1 }),
    );
  }

  // Not now: quiet hours, nobody home, the satellite busy. Nothing is counted, and it goes out again in an hour. A
  // reply answered someone then: an hour later it would only mislead, so it is not sent again.
  private putOff(id: string, at: number) {
    const item = this.liveItem(id);
    if (item === undefined || !isNewLine(item, at)) return;
    const again =
      this.messageOf(item).tier === JARVIS_TIER.reply
        ? { status: JARVIS_STATUS.unconfirmed }
        : { status: JARVIS_STATUS.waiting, nextAskAt: this.clock() + JARVIS_LIMITS.laterMilliseconds, attempts: 0 };
    this.databaseHandle.database
      .update(jarvisItems)
      .set({ ...again, lastLineAt: at })
      .where(eq(jarvisItems.id, id))
      .run();
  }

  // Its lines are kept with the connection, not a message: they outlast the next test question and a restart.
  private keepTestLine(at: number) {
    const stored = this.connection();
    if (stored === null) return;
    // An older line, as a restarted Home Assistant restores, says nothing newer.
    const kept = stored.testLineAt ?? null;
    if (kept !== null && kept >= at) return;
    this.store.write(SETTING_KEYS.jarvis, { ...stored, testLineAt: at } satisfies Stored);
  }

  // The test question proves the way back: from its answer on, what the ticks turn on is asked.
  private answerTestQuestion(test: TestQuestion, line: Answer) {
    const answered = test.answer(line.verb, line.how, this.clock());
    const stored = this.connection();
    if (answered === null || stored === null) return;
    this.store.write(SETTING_KEYS.jarvis, {
      ...stored,
      testAnswered: { ...answered, at: this.clock() },
    } satisfies Stored);
  }

  private testQuestionView(stored: Stored | null): JarvisTestQuestionView | null {
    if (this.testQuestion !== null) return this.testQuestion.view(this.clock());
    const answered = stored?.testAnswered ?? null;
    if (answered === null) return null;
    const { said, how, seconds } = answered;
    return { outcome: JARVIS_TEST_OUTCOME.answered, answer: { said, how, seconds } };
  }

  // Heard, and waiting for their answer: newest first.
  private openQuestions(): JarvisOpenQuestionView[] {
    return this.databaseHandle.database
      .select()
      .from(jarvisItems)
      .where(and(eq(jarvisItems.status, JARVIS_STATUS.asked), isNotNull(jarvisItems.membersJson)))
      .orderBy(desc(jarvisItems.sentAt))
      .all()
      .map((item) => {
        const { kind, host, names, from, to } = this.messageOf(item);
        const asked = { askedAt: item.sentAt!, asks: item.asks };
        return { id: item.id, kind, host, names, from: from ?? null, to: to ?? null, ...asked };
      });
  }

  // As set on its card, or none; a connection from before that could be chosen is called Jarvis, as it always was.
  private name(): string | null {
    const stored = this.connection();
    if (stored === null) return null;
    return stored.name === undefined ? JARVIS_NAME.before : stored.name;
  }

  // As set on its card, or none; a connection from before that could be chosen keeps the "sir" it always said.
  private address(): string | null {
    const stored = this.connection();
    if (stored === null) return null;
    return stored.address === undefined ? JARVIS_ADDRESS.before : stored.address;
  }

  private liveItem(id: string) {
    return this.databaseHandle.database
      .select()
      .from(jarvisItems)
      .where(and(eq(jarvisItems.id, id), inArray(jarvisItems.status, LIVE_STATUSES)))
      .get();
  }

  private answerTest(nonce: string) {
    if (!this.testOpen() || this.test!.nonce !== nonce) return;
    this.lastTestMilliseconds = this.clock() - this.test!.startedAt;
    this.test = null;
  }

  // More lines in a minute than a house writes are not read: a loop in an automation cannot keep Autoheal busy.
  private withinLineRate() {
    const now = this.clock();
    if (now - this.lineWindow.startedAt >= MILLISECONDS_PER_MINUTE) this.lineWindow = { startedAt: now, lines: 0 };
    this.lineWindow.lines += 1;
    return this.lineWindow.lines <= JARVIS_LIMITS.ratePerMinute;
  }

  // The last word from Home Assistant: a call on its key, or a line in its answer box, whichever came last.
  private lastHeard(stored: Stored | null) {
    const byKey = stored === null ? null : this.keys.lastUsed(stored.keyId);
    const byMessage =
      this.databaseHandle.database
        .select({ at: max(jarvisItems.lastLineAt) })
        .from(jarvisItems)
        .get()?.at ?? null;
    const lines = [byMessage, stored?.testLineAt ?? null].filter((at): at is number => at !== null);
    const byLine = lines.length === 0 ? null : Math.max(...lines);
    const heardByAnswerBox = byLine !== null && (byKey === null || byLine > byKey);
    return { lastHeardAt: heardByAnswerBox ? byLine : byKey, heardByAnswerBox };
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
      // A reply is about the moment it answers: late, it would only mislead.
      const sentEnough = item.attempts >= JARVIS_LIMITS.sendsAtMost || this.messageOf(item).tier === JARVIS_TIER.reply;
      const status = sentEnough ? JARVIS_STATUS.unconfirmed : JARVIS_STATUS.waiting;
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
    const containers = new Map(
      this.inventory.containers().map((container) => [`${container.hostId}/${container.name}`, container]),
    );
    const online = new Set(
      this.activeHosts()
        .filter(({ state }) => state === HOST_STATE.online)
        .map(({ id }) => id),
    );
    const stored = this.connection();
    const connected = stored !== null && this.connector(stored) !== null ? stored : null;
    const proven = isProven(connected);
    const switches = {
      updates: proven && connected?.askUpdates === true,
      versions: proven && connected?.askVersions === true,
    };
    const reachable = this.homeAssistant.connected();
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
        assigneeAgent: tasks.assigneeAgent,
      })
      .from(tasks)
      .innerJoin(hosts, eq(hosts.id, tasks.hostId))
      .where(and(isNull(tasks.closedAt), eq(hosts.status, HOST_STATUS_ACTIVE)))
      .all()
      .filter((row) => row.detectorKey !== null && (row.snoozedUntil === null || row.snoozedUntil <= now))
      .filter((row) => {
        if (row.resourceKind !== TASK_RESOURCE.container || row.resource === null) return true;
        return !isBuildContainer(row.resource, containers.get(`${row.hostId}/${row.resource}`)?.image ?? null);
      })
      .map(({ assigneeAgent, ...row }) => {
        const candidate = { ...row, hostId: row.hostId!, detectorKey: row.detectorKey! };
        const container = containers.get(`${row.hostId}/${row.resource}`);
        const asked = this.askedAbout(candidate, container, assigneeAgent === null, switches);
        if (asked === null) return candidate;
        return { ...candidate, ask: { ...asked, ready: reachable && online.has(candidate.hostId) } };
      });
  }

  /**
   * What a yes would bring: an update's newer image, a newer version's tag, a host's updates, or the boot a restart
   * ends. Asked about when questions of its kind are on, it waits on a person, and the dashboard would take it now.
   * Null for anything only told.
   */
  private askedAbout(
    candidate: Omit<JarvisCandidate, "ask">,
    container: ContainerView | undefined,
    waitsOnPerson: boolean,
    switches: Switches,
  ) {
    const kind = kindOf(candidate.detectorKey);
    const { hostId } = candidate;
    if (kind === JARVIS_KIND.newerVersion) {
      const tag = tagOfNewerVersionKey(candidate.detectorKey);
      const request = { hostId, container: candidate.resource ?? "", tag };
      return { brings: tag, askable: switches.versions && waitsOnPerson && this.handOver.takesTag(request) };
    }
    const wanted = switches.updates && waitsOnPerson;
    if (kind === JARVIS_KIND.hostUpdates) return this.hostUpdatesAsked(hostId, wanted);
    if (kind === JARVIS_KIND.reboot) return this.restartAsked(hostId, wanted);
    const digest = container?.update.remoteDigest ?? null;
    if (kind !== JARVIS_KIND.containerUpdates || digest === null) return null;
    return { brings: digest, askable: wanted && this.handOver.takesUpdate(candidate.taskId) };
  }

  // The updates waiting on a host that a yes would install, as the dashboard's hand-over takes them.
  private hostUpdatesAsked(hostId: string, wanted: boolean) {
    const offered = this.offeredUpdates(hostId);
    if (offered.length === 0) return null;
    const names = offered.map(({ name }) => name);
    return { brings: updatesKey(offered), askable: wanted && this.handOver.takesPackages(hostId, names) };
  }

  // A restart, for the boot it is asked on: once the host has booted again, it is another question. Not on a host that
  // only reports; a package job on its way ends by itself.
  private restartAsked(hostId: string, wanted: boolean) {
    const host = this.activeHosts().find(({ id }) => id === hostId);
    const bootId = host?.health?.bootId ?? null;
    if (host === undefined || bootId === null) return null;
    const restartable = () =>
      host.dryRun !== true && accepts(() => this.hostPackages.requireRestart(hostId), [API_ERRORS.hostPackagesBusy]);
    return { brings: bootId, askable: wanted && restartable() };
  }

  /**
   * What waits on a person among a host's updates, and is not held back: Docker, the kernel and data packages stay on
   * the dashboard, and what the host's window or unattended-upgrades installs is never asked about.
   */
  private offeredUpdates(hostId: string): AssessedPackage[] {
    const host = this.activeHosts().find(({ id }) => id === hostId);
    const plan = host === undefined ? null : this.hostPackages.plan(host);
    if (plan === null) return [];
    const forPerson = new Set(plan.forPerson);
    return plan.packages.filter(({ name, held }) => forPerson.has(name) && !held);
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
