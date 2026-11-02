import { z } from "zod";

// What Jarvis is told, and how to connect it: Autoheal decides what is true, Home Assistant when
// and where to say it, and every word and number comes from these templates, never from a model.
export const JARVIS_KIND = {
  test: "test",
  hostSilent: "host_silent",
  disk: "disk",
  drive: "drive",
  container: "container",
  recoveryHeld: "recovery_held",
  containerUpdates: "container_updates",
  hostUpdates: "host_updates",
  reboot: "reboot",
} as const;
export type JarvisKind = (typeof JARVIS_KIND)[keyof typeof JARVIS_KIND];

export const JARVIS_TIER = { urgent: "urgent", say: "say" } as const;
export type JarvisTier = (typeof JARVIS_TIER)[keyof typeof JARVIS_TIER];

// Home Assistant accepts a webhook even with nothing listening, so sent proves nothing: only told is Jarvis's own word.
export const JARVIS_STATUS = {
  waiting: "waiting",
  sent: "sent",
  told: "told",
  // Sent as often as it may be, and Jarvis never confirmed it.
  unconfirmed: "unconfirmed",
  dropped: "dropped",
} as const;
export const JARVIS_STATUSES = Object.values(JARVIS_STATUS);
export type JarvisStatus = (typeof JARVIS_STATUS)[keyof typeof JARVIS_STATUS];

export const JARVIS_LIMITS = {
  settleMilliseconds: 10 * 60 * 1000,
  urgentSettleMilliseconds: 5 * 60 * 1000,
  repeatMilliseconds: 24 * 60 * 60 * 1000,
  urgentRepeatMilliseconds: 6 * 60 * 60 * 1000,
  perDay: 3,
  dayMilliseconds: 24 * 60 * 60 * 1000,
  retentionMilliseconds: 30 * 24 * 60 * 60 * 1000,
  sendTimeoutMilliseconds: 10 * 1000,
  confirmMilliseconds: 60 * 1000,
  resendMilliseconds: 30 * 60 * 1000,
  sendsAtMost: 3,
  namesSpoken: 3,
  recentShown: 5,
  ratePerMinute: 30,
  testAnswerMilliseconds: 60 * 1000,
  webhookIdBytes: 24,
  nonceBytes: 16,
  nonceCharacters: 64,
} as const;

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEEN_WORDS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS_WORDS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const PAIR_DIGITS = 2;
const TENS = 10;

function pairInWords(pair: string): string {
  const number = Number(pair);
  if (number < TENS) return pair.length === PAIR_DIGITS ? `oh ${DIGIT_WORDS[number]}` : DIGIT_WORDS[number]!;
  if (number < 2 * TENS) return TEEN_WORDS[number - TENS]!;
  const ones = number % TENS;
  const tens = TENS_WORDS[Math.floor(number / TENS)]!;
  return ones === 0 ? tens : `${tens} ${DIGIT_WORDS[ones]}`;
}

// Read as people read a model number: 3640 is thirty-six forty, and anything longer goes digit by digit.
function digitsInWords(digits: string): string {
  if (digits.length > 2 * PAIR_DIGITS) return [...digits].map((digit) => DIGIT_WORDS[Number(digit)]).join(" ");
  if (digits.length <= PAIR_DIGITS) return pairInWords(digits);
  const firstLength = digits.length - PAIR_DIGITS;
  return `${pairInWords(digits.slice(0, firstLength))} ${pairInWords(digits.slice(firstLength))}`;
}

// A run of capitals is spelled when it is short: "Av" and "VM" read as letters, "OLLAMA" as a word.
const LONGEST_SPELLED = 3;
const SPOKEN_PART = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;
const spelled = (part: string) => (part.length <= LONGEST_SPELLED ? [...part].join(" ") : part.toLowerCase());
const SHORT_LOWER_CASE = /^[A-Z][a-z]$/;

/** A host or container's name as Piper should say it: DeltaAv1 is "Delta A v one", Delta3640 "Delta thirty six forty". */
export function spokenName(name: string): string {
  const parts = name.match(SPOKEN_PART) ?? [name];
  return parts
    .map((part) => {
      if (/^\d+$/.test(part)) return digitsInWords(part);
      if (SHORT_LOWER_CASE.test(part)) return [...part].join(" ");
      return /^[A-Z]+$/.test(part) ? spelled(part) : part;
    })
    .join(" ");
}

export function spokenList(names: readonly string[]): string {
  const spoken = names.map(spokenName);
  if (spoken.length === 1) return spoken[0]!;
  return `${spoken.slice(0, -1).join(", ")} and ${spoken.at(-1)}`;
}

export interface JarvisFacts {
  kind: JarvisKind;
  host: string;
  // What it is about, by name: containers, or a disk's path.
  names: string[];
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

// Fact first, in the words that let the owner act. Home Assistant adds the aside if it wants one.
const SPOKEN: Record<Exclude<JarvisKind, "test">, (host: string, names: readonly string[]) => string> = {
  host_silent: (host) => `${host} has stopped answering, sir. It deserves a look.`,
  disk: (host) => `A disk on ${host} is nearly full, sir. I would clear it before it clears itself.`,
  drive: (host) => `A drive on ${host} is reporting trouble, sir. Its data should be somewhere else.`,
  container: (host, names) => `${spokenList(names)} on ${host} is unwell, and I could not settle it, sir.`,
  recovery_held: (host) => `Automatic repairs are held back on ${host}, sir, and need your eye.`,
  container_updates: (host, names) =>
    names.length > LIST_LIMIT
      ? `${names.length} containers on ${host} have updates waiting, sir.`
      : `An update is waiting for ${spokenList(names)} on ${host}, sir.`,
  host_updates: (host) => `${host} has system updates waiting, sir.`,
  reboot: (host) => `${host} would like a restart, sir, for updates it has already taken.`,
};
const LIST_LIMIT = JARVIS_LIMITS.namesSpoken;

const WRITTEN: Record<Exclude<JarvisKind, "test">, (host: string, names: readonly string[]) => string> = {
  host_silent: (host) => `${host} has stopped answering.`,
  disk: (host, names) => `${host}: ${names.join(", ")} is nearly full.`,
  drive: (host, names) => `${host}: drive ${names.join(", ")} is reporting trouble.`,
  container: (host, names) => `${host}: ${names.join(", ")} is unwell, and Autoheal could not settle it.`,
  recovery_held: (host) => `${host}: automatic repairs are held back.`,
  container_updates: (host, names) =>
    `${host}: ${plural(names.length, "an update is", `${names.length} updates are`)} waiting: ${names.join(", ")}.`,
  host_updates: (host) => `${host}: system updates are waiting.`,
  reboot: (host) => `${host} would like a restart.`,
};

type TaskKind = Exclude<JarvisKind, "test">;

export const jarvisSay = (facts: JarvisFacts & { kind: TaskKind }) =>
  SPOKEN[facts.kind](spokenName(facts.host), facts.names);
export const jarvisText = (facts: JarvisFacts & { kind: TaskKind }) => WRITTEN[facts.kind](facts.host, facts.names);

// Names come from hosts' reports: what Jarvis says holds only what a name can, so none can carry a sentence.
const NOT_IN_A_NAME = /[^\w ./-]/g;
const NAME_CHARACTERS = 64;
export const safeName = (name: string) => name.replace(NOT_IN_A_NAME, "").slice(0, NAME_CHARACTERS);

export interface JarvisSummary {
  say: string;
  text: string;
}

export const JARVIS_ALIAS_LIMITS = { perHost: 8, characters: 40 } as const;
export const jarvisAliasesSchema = z.object({
  hostId: z.uuid(),
  aliases: z.array(z.string().trim().min(1).max(JARVIS_ALIAS_LIMITS.characters)).max(JARVIS_ALIAS_LIMITS.perHost),
});
export const jarvisSummaryQuerySchema = z.object({
  about: z.string().max(JARVIS_LIMITS.nonceCharacters).optional(),
});

const LONG_ENOUGH_TO_GUESS = 5;
const CLOSEST_GUESS = 1;

// All a name's letters as they are said: "DeltaAv1", "Delta AV 1" and "delta a v one" are one name.
export const spokenKey = (name: string) =>
  spokenName(name)
    .toLowerCase()
    .replace(/[^a-z]/g, "");

function editDistance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const next = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const swap = row[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      next[rightIndex] = Math.min(swap, row[rightIndex]! + 1, next[rightIndex - 1]! + 1);
    }
    row = next;
  }
  return row[right.length]!;
}

export interface SpokenTarget<Target> {
  target: Target;
  // Its own name first: that beats another's alias.
  names: readonly string[];
}

/**
 * Which of these was meant, from what speech-to-text heard. Exact as said, its own name before an alias; failing
 * that one letter off, on a name long enough to bear it. Several answers mean it must ask, and none that it says so.
 */
export function matchSpoken<Target>(heard: string, targets: readonly SpokenTarget<Target>[]): Target[] {
  const key = spokenKey(heard);
  if (key === "") return [];
  const own = targets.filter(({ names }) => spokenKey(names[0]!) === key);
  if (own.length > 0) return own.map(({ target }) => target);
  const exact = targets.filter(({ names }) => names.some((name) => spokenKey(name) === key));
  if (exact.length > 0) return exact.map(({ target }) => target);
  if (key.length < LONG_ENOUGH_TO_GUESS) return [];
  return targets
    .filter(({ names }) => names.some((name) => editDistance(spokenKey(name), key) <= CLOSEST_GUESS))
    .map(({ target }) => target);
}

export const jarvisHeardSchema = z.object({ nonce: z.string().min(1).max(JARVIS_LIMITS.nonceCharacters) });
export const jarvisPauseSchema = z.object({ paused: z.boolean() });

export interface JarvisMessage {
  id: string;
  kind: TaskKind;
  tier: JarvisTier;
  host: string;
  names: string[];
  say: string;
  text: string;
}

export interface JarvisRecentView {
  id: string;
  kind: TaskKind;
  tier: JarvisTier;
  text: string;
  sentAt: number;
}

export interface JarvisHostNames {
  id: string;
  label: string;
  aliases: string[];
}

export interface JarvisView {
  // Jarvis is reached through the Home Assistant Autoheal already knows.
  homeAssistantSet: boolean;
  connected: boolean;
  paused: boolean;
  // Null when it could not be opened: another backup passphrase sealed it.
  setup: string | null;
  testing: boolean;
  lastTestMilliseconds: number | null;
  lastHeardAt: number | null;
  waiting: number;
  // Sent, and Jarvis has not said it arrived: its automation may be missing, off, or without its confirming step.
  notConfirmed: number;
  // What it would say now, if asked how the servers are.
  summary: string;
  hosts: JarvisHostNames[];
  recent: JarvisRecentView[];
}

export interface JarvisConnected {
  view: JarvisView;
  // Shown this once.
  secret: string;
}

export interface JarvisMachineNames {
  label: string;
  aliases: readonly string[];
}

// What can sit in a fixed sentence: lower case words and digits.
const NOT_IN_A_SENTENCE = /[^a-z0-9 ]+/g;
const asSentenceWords = (name: string) =>
  name.toLowerCase().replace(/[._-]/g, " ").replace(NOT_IN_A_SENTENCE, "").replace(/ +/g, " ").trim();

// However a name may be heard: as written, and as said.
function sentenceNames({ label, aliases }: JarvisMachineNames): string[] {
  const forms = [label, ...aliases].flatMap((name) => [asSentenceWords(name), asSentenceWords(spokenName(name))]);
  return [...new Set(forms.filter((form) => form !== ""))];
}

// Each machine by name, with no wildcard: "how is {anything}" would also fire on every other "how is" in the house.
const machineTriggers = (machines: readonly JarvisMachineNames[]) =>
  machines
    .map(
      (machine) => `    - trigger: conversation
      id: ${asSentenceWords(machine.label).replace(/ /g, "_")}
      command:
        - (how is|how's) (${sentenceNames(machine).join("|")}) [doing]
`,
    )
    .join("");

export const JARVIS_SECRET_NAME = "autoheal_jarvis_key";
const SECRET_PLACEHOLDER = "<the key shown once when you connected>";

/** What goes into Home Assistant, whole. The key stays out of it: one line for secrets.yaml, by hand. */
export function jarvisSetup(
  dashboard: string,
  webhookId: string,
  machines: readonly JarvisMachineNames[],
  secret: string = SECRET_PLACEHOLDER,
): string {
  return `# secrets.yaml
${JARVIS_SECRET_NAME}: "${secret}"

# configuration.yaml
rest_command:
  autoheal_summary:
    url: "${dashboard}/api/jarvis/summary?about={{ about | default('') | urlencode }}"
    method: GET
    headers:
      x-api-key: !secret ${JARVIS_SECRET_NAME}
    verify_ssl: true
  autoheal_heard:
    url: "${dashboard}/api/jarvis/heard"
    method: POST
    headers:
      x-api-key: !secret ${JARVIS_SECRET_NAME}
    content_type: application/json
    payload: '{"nonce": "{{ nonce }}"}'
    verify_ssl: true

rest:
  - resource: "${dashboard}/api/jarvis/status"
    headers:
      x-api-key: !secret ${JARVIS_SECRET_NAME}
    scan_interval: 60
    sensor:
      - name: Autoheal
        value_template: "{{ value_json.state }}"

# automations.yaml
- id: jarvis_hears_from_autoheal
  alias: Jarvis hears from Autoheal
  mode: queued
  triggers:
    - trigger: webhook
      webhook_id: ${webhookId}
      allowed_methods: [POST]
      local_only: true
  actions:
    - variables:
        message: "{{ trigger.json }}"
        rooms: "{{ states('sensor.jarvis_speak_here') }}"
    # Confirm first: speaking can block for minutes, and Autoheal sends again what is not confirmed.
    - if: "{{ message.kind != 'test' }}"
      then:
        - action: rest_command.autoheal_heard
          continue_on_error: true
          data:
            nonce: "{{ message.id }}"
    - choose:
        - conditions: "{{ message.kind == 'test' }}"
          sequence:
            - action: rest_command.autoheal_heard
              data:
                nonce: "{{ message.nonce }}"
        - conditions: "{{ message.tier == 'urgent' or 'assist_satellite' not in rooms }}"
          sequence:
            # Your phone's notify action.
            - action: notify.YOUR_PHONE
              data:
                title: Autoheal
                message: "{{ message.text }}"
    - if: "{{ message.kind != 'test' and 'assist_satellite' in rooms }}"
      then:
        - action: assist_satellite.announce
          target:
            entity_id: "{{ rooms.split(',') }}"
          data:
            message: "{{ message.say }}"

- id: jarvis_says_how_the_servers_are
  alias: Jarvis says how the servers are
  mode: parallel
  triggers:
    - trigger: conversation
      id: all
      command:
        - (how are|how're) [the|my] (servers|machines) [doing]
        - how is everything on [the|my] servers
        - (what is|what's) [the] server status
        - server status
        - (give me|tell me) [a|the] server report
        - (how is|how's) [the] (server|machine|host) {machine} [doing]
        - (what is|what's) the status of [the] (server|machine|host) {machine}
${machineTriggers(machines)}  actions:
    - action: rest_command.autoheal_summary
      continue_on_error: true
      data:
        about: "{{ trigger.slots.machine | default('' if trigger.id == 'all' else trigger.id) }}"
      response_variable: answer
    - set_conversation_response: >-
        {{ answer.content.say if answer is defined and answer.status == 200
        else 'Autoheal is not answering, sir.' }}

- id: jarvis_notices_autoheal_is_silent
  alias: Jarvis notices Autoheal is silent
  triggers:
    - trigger: state
      entity_id: sensor.autoheal
      to: unavailable
      for: "00:15:00"
  actions:
    - action: notify.YOUR_PHONE
      data:
        title: Autoheal
        message: Autoheal has stopped answering. It may not be healing anything.
`;
}
