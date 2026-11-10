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
  // A newer version of the tag a container runs: only ever asked about.
  newerVersion: "newer_version",
  hostUpdates: "host_updates",
  reboot: "reboot",
} as const;
export type JarvisKind = (typeof JARVIS_KIND)[keyof typeof JARVIS_KIND];

// Urgent and say are told; ask is a question, put to a person, whose yes Autoheal carries out; reply is Autoheal's
// word on an answer, said at once, never counted, never sent twice.
export const JARVIS_TIER = { urgent: "urgent", say: "say", ask: "ask", reply: "reply" } as const;
export type JarvisTier = (typeof JARVIS_TIER)[keyof typeof JARVIS_TIER];

// Home Assistant accepts a webhook even with nothing listening, so sent proves nothing: only told is Jarvis's own word.
export const JARVIS_STATUS = {
  waiting: "waiting",
  sent: "sent",
  told: "told",
  // Sent as often as it may be, and Jarvis never confirmed it.
  unconfirmed: "unconfirmed",
  dropped: "dropped",
  // A question Home Assistant put to someone, waiting for the answer.
  asked: "asked",
  accepted: "accepted",
  declined: "declined",
  // A yes carried out, and what came of it told.
  done: "done",
  // Asked as often as it may be, and never answered.
  retired: "retired",
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
  // A question names this many updates at most, and a yes covers only those.
  namesAsked: 3,
  asksAtMost: 3,
  // While a question waits to be heard, no other goes out: for this long at most.
  hearMilliseconds: 2 * 60 * 1000,
  codeBytes: 16,
  // Home Assistant said not now: it is sent again after this long.
  laterMilliseconds: 60 * 60 * 1000,
  // A Text helper holds 100 characters unless made longer; a message's id is a UUID.
  lineCharacters: 100,
  messageIdCharacters: 36,
  roomCharacters: 30,
  // How long after a yes what came of it is told, done or not.
  outcomeWaitMilliseconds: 30 * 60 * 1000,
  recentShown: 5,
  ratePerMinute: 30,
  testAnswerMilliseconds: 60 * 1000,
  // The card's test question waits this long for its answer before the card says what did not come back.
  testQuestionMilliseconds: 2 * 60 * 1000,
  webhookIdBytes: 24,
  nonceBytes: 16,
  nonceCharacters: 64,
} as const;

const BITS_PER_BYTE = 8;
const BITS_PER_BASE64_CHARACTER = 6;
// A question's code as it goes out: its bytes in base64url, unpadded.
export const JARVIS_CODE_CHARACTERS = Math.ceil((JARVIS_LIMITS.codeBytes * BITS_PER_BYTE) / BITS_PER_BASE64_CHARACTER);

// How an answer was given, as Home Assistant says: shown, never trusted.
export const JARVIS_ANSWER_HOW = { voice: "voice", phone: "phone" } as const;
export type JarvisAnswerHow = (typeof JARVIS_ANSWER_HOW)[keyof typeof JARVIS_ANSWER_HOW];
// What a person answered: only ever to a question Autoheal asked.
export const JARVIS_ANSWER = { yes: "yes", no: "no" } as const;
export type JarvisAnswer = (typeof JARVIS_ANSWER)[keyof typeof JARVIS_ANSWER];

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

/** A host or container's name as Piper should say it: OrionBx3 is "Orion B x three", Orion2480 "Orion twenty four eighty". */
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

// How the assistant addresses people: once in a spoken sentence, after a comma ("…, sir."), or not at all. A
// connection made before it could be chosen keeps "sir", as it always said; a new one has none until its card says.
export const JARVIS_ADDRESS = { before: "sir", characters: 20 } as const;
// Letters, spaces, ' and - only: it is spoken in Autoheal's own sentences, so it can end none, nor carry its own.
export const jarvisAddressSchema = z.object({
  address: z
    .string()
    .trim()
    .max(JARVIS_ADDRESS.characters)
    .regex(/^[\p{L} '-]*$/u),
});
/** The form of address after its comma, as each spoken sentence takes it, or nothing. */
export const spokenTo = (address: string | null) => (address === null ? "" : `, ${address}`);

// What the person calls the assistant, as its card shows it: Autoheal never says it. A connection made before it could
// be chosen keeps "Jarvis"; a new one has none, and the card says "the assistant".
export const JARVIS_NAME = { before: "Jarvis", characters: 20 } as const;
export const jarvisNameSchema = z.object({
  name: z
    .string()
    .trim()
    .max(JARVIS_NAME.characters)
    .regex(/^[\p{L}\p{N} '-]*$/u),
});

export interface JarvisFacts {
  kind: JarvisKind;
  host: string;
  // What it is about, by name: containers, or a disk's path.
  names: string[];
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

// Fact first, in the words that let the owner act. Home Assistant adds the aside if it wants one.
// Each spoken sentence with `toYou`, the form of address after its comma, or nothing.
type Spoken = (host: string, names: readonly string[], toYou: string) => string;
const SPOKEN: Record<Exclude<JarvisKind, "test">, Spoken> = {
  host_silent: (host, _names, toYou) => `${host} has stopped answering${toYou}. It deserves a look.`,
  disk: (host, _names, toYou) => `A disk on ${host} is nearly full${toYou}. I would clear it before it clears itself.`,
  drive: (host, _names, toYou) => `A drive on ${host} is reporting trouble${toYou}. Its data should be somewhere else.`,
  container: (host, names, toYou) => `${spokenList(names)} on ${host} is unwell, and I could not settle it${toYou}.`,
  recovery_held: (host, _names, toYou) => `Automatic repairs are held back on ${host}${toYou}, and need your eye.`,
  container_updates: (host, names, toYou) =>
    names.length > LIST_LIMIT
      ? `${names.length} containers on ${host} have updates waiting${toYou}.`
      : `An update is waiting for ${spokenList(names)} on ${host}${toYou}.`,
  newer_version: (host, names, toYou) => `A newer version of ${spokenList(names)} is out on ${host}${toYou}.`,
  host_updates: (host, _names, toYou) => `${host} has system updates waiting${toYou}.`,
  reboot: (host, _names, toYou) => `${host} would like a restart${toYou}, for updates it has already taken.`,
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
  newer_version: (host, names) => `${host}: a newer version of ${names.join(", ")} is out.`,
  host_updates: (host) => `${host}: system updates are waiting.`,
  reboot: (host) => `${host} would like a restart.`,
};

type TaskKind = Exclude<JarvisKind, "test">;

const capitalised = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
const LAST_ASKING = " I will not ask again.";

/** A question about a host's updates, three names at most; the last time it is asked, it says so. */
export function jarvisQuestion(
  facts: Pick<JarvisFacts, "host" | "names">,
  lastAsking: boolean,
  address: string | null,
) {
  const { names } = facts;
  const host = spokenName(facts.host);
  const toYou = spokenTo(address);
  const ending = lastAsking ? LAST_ASKING : "";
  const say =
    names.length === 1
      ? `An update is waiting for ${spokenList(names)} on ${host}${toYou}. Shall I update it?`
      : `${capitalised(DIGIT_WORDS[names.length]!)} updates are waiting on ${host}${toYou}: ${spokenList(names)}. Shall I update them?`;
  const text = `${facts.host}: ${plural(names.length, "an update is", `${names.length} updates are`)} waiting: ${names.join(", ")}. ${plural(names.length, "Update it?", "Update them?")}`;
  return { say: `${say}${ending}`, text: `${text}${ending}` };
}

// A version read out as it is written: a few short numbers with dots. Anything else is only written down.
const SAID_AS_WRITTEN = /^\d{1,4}(\.\d{1,4}){0,3}$/;
const sayable = (...tags: readonly string[]) => tags.every((tag) => SAID_AS_WRITTEN.test(tag));

export interface JarvisVersionFacts {
  host: string;
  name: string;
  from: string;
  to: string;
}

/** A question about a newer version of one container's tag; the last time it is asked, it says so. */
export function jarvisVersionQuestion(facts: JarvisVersionFacts, lastAsking: boolean, address: string | null) {
  const { host, name, from, to } = facts;
  const toYou = spokenTo(address);
  const ending = lastAsking ? LAST_ASKING : "";
  const say = sayable(from, to)
    ? `Version ${to} of ${spokenName(name)} is out, and ${spokenName(host)} runs ${from}${toYou}. Shall I move it to ${to}?`
    : `A newer version of ${spokenName(name)} is out on ${spokenName(host)}${toYou}. Shall I move to it?`;
  return { say: `${say}${ending}`, text: `${host}: ${name} can move from ${from} to ${to}. Move it?${ending}` };
}

const is = (count: number) => (count === 1 ? "is" : "are");
const was = (count: number) => (count === 1 ? "was" : "were");
const words = (say: string, text: string) => ({ say, text });

/** What Autoheal says back to an answer, in fixed words and its form of address: at once, never counted. */
export function jarvisReplies(address: string | null) {
  const toYou = spokenTo(address);
  return {
    updating: (host: string, names: readonly string[]) =>
      words(
        `Updating ${spokenList(names)} on ${spokenName(host)} now${toYou}.`,
        `${host}: updating ${names.join(", ")} now.`,
      ),
    moving: ({ host, name, to }: Omit<JarvisVersionFacts, "from">) =>
      words(
        sayable(to)
          ? `Moving ${spokenName(name)} on ${spokenName(host)} to ${to} now${toYou}.`
          : `Moving ${spokenName(name)} on ${spokenName(host)} to its newer version now${toYou}.`,
        `${host}: moving ${name} to ${to} now.`,
      ),
    noLongerOpen: words(`That question is no longer open${toYou}.`, "That question is no longer open."),
    gone: words(`That update is gone${toYou}, so there is nothing to do.`, "That update is gone: nothing to do."),
    newerOut: words(
      `A newer version came out since I asked${toYou}, so I left it. I will ask again.`,
      "A newer version came out since the question: nothing changed, and it is asked again.",
    ),
    hostSilent: (host: string) =>
      words(
        `${spokenName(host)} is not answering${toYou}, so I left it. I will ask again once it is back.`,
        `${host} is not answering: nothing changed, and it is asked again once it is back.`,
      ),
    hostReports: (host: string) =>
      words(
        `${spokenName(host)} only reports now${toYou}, so I left it.`,
        `${host} only reports now: nothing changed.`,
      ),
    handsOff: (host: string) =>
      words(
        `${spokenName(host)} keeps my hands off that now${toYou}, so I left it.`,
        `${host} keeps Autoheal's hands off it now: nothing changed.`,
      ),
    notHandedOver: words(
      `I could not hand that over${toYou}. The dashboard says why.`,
      "Not handed over: the dashboard says why.",
    ),
    notAdmin: words(
      `I cannot act on that${toYou}: whoever connected me is no longer an admin.`,
      "Not taken: whoever connected the assistant is no longer an admin.",
    ),
  };
}
export type JarvisReplies = ReturnType<typeof jarvisReplies>;

export interface JarvisOutcome {
  updated: readonly string[];
  notUpdated: readonly string[];
  notDone: readonly string[];
}

const OUTCOME_PARTS = [
  ["updated", (count: number) => `${is(count)} updated`],
  ["notUpdated", (count: number) => `${was(count)} not updated: the dashboard says why`],
  ["notDone", (count: number) => `${is(count)} not done yet`],
] as const;

/** What came of a yes, the host named once: "whoami on Rowan is updated. gitea was not updated: …". */
export function jarvisOutcome(host: string, outcome: JarvisOutcome, address: string | null) {
  const parts = OUTCOME_PARTS.filter(([kind]) => outcome[kind].length > 0);
  const spoken = parts.map(([kind, ending], index) => {
    const where = index === 0 ? ` on ${spokenName(host)}` : "";
    return `${spokenList(outcome[kind])}${where} ${ending(outcome[kind].length)}`;
  });
  const written = parts.map(([kind, ending]) => `${outcome[kind].join(", ")} ${ending(outcome[kind].length)}`);
  const rest = spoken.slice(1).map((part) => ` ${part}.`);
  return words(`${spoken[0]}${spokenTo(address)}.${rest.join("")}`, `${host}: ${written.join(". ")}.`);
}

export const jarvisSay = (facts: JarvisFacts & { kind: TaskKind }, address: string | null) =>
  SPOKEN[facts.kind](spokenName(facts.host), facts.names, spokenTo(address));
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

// All a name's letters as they are said: "OrionBx3", "Orion BX 3" and "orion b x three" are one name.
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

// The test: shaped like any message, so a house that answers messages answers it too, by either road.
export const jarvisTestWords = (address: string | null) =>
  words(`This is a test from Autoheal${spokenTo(address)}.`, "A test from Autoheal.");

// The card's test question: asked as any question is, so answering it proves the way an answer comes back.
export const jarvisTestQuestionWords = (address: string | null) =>
  words(`This is a test from Autoheal${spokenTo(address)}. Can you hear me?`, "A test from Autoheal. Can you hear me?");

export const jarvisHeardSchema = z.object({ nonce: z.string().min(1).max(JARVIS_LIMITS.nonceCharacters) });
export const jarvisPauseSchema = z.object({ paused: z.boolean() });
export const jarvisAskingSchema = z.object({ updates: z.boolean(), versions: z.boolean() });

// What became of the card's test question. Each but the answer names the step to look at.
export const JARVIS_TEST_OUTCOME = {
  asking: "asking",
  notTaken: "not_taken",
  nothingBack: "nothing_back",
  putOff: "put_off",
  notAnswered: "not_answered",
  answered: "answered",
} as const;
export type JarvisTestOutcome = (typeof JARVIS_TEST_OUTCOME)[keyof typeof JARVIS_TEST_OUTCOME];

export interface JarvisTestAnswer {
  said: JarvisAnswer;
  how: JarvisAnswerHow;
  seconds: number;
}

export interface JarvisTestQuestionView {
  outcome: JarvisTestOutcome;
  // Only once it was answered.
  answer: JarvisTestAnswer | null;
}

// The public files a house sets the assistant up from, at the version that is running.
const PUBLIC_FILES = "https://github.com/aiulian25/autoheal/blob";
export const ASSISTANT_FILES = {
  blueprint: "docs/home-assistant/autoheal-assistant.yaml",
  contract: "docs/home-assistant/README.md",
} as const;
export const assistantFileLink = (version: string, file: string) => `${PUBLIC_FILES}/v${version}/${file}`;

// Home Assistant's own pages, by the redirects its frontend keeps for My Home Assistant links.
const HOME_ASSISTANT_PAGES = {
  helpers: "/_my_redirect/helpers",
  blueprintImport: "/_my_redirect/blueprint_import",
  blueprintParameter: "blueprint_url",
} as const;

export interface JarvisSetupLinks {
  helpers: string;
  blueprintImport: string;
}

/** The setup steps' pages, at the address Autoheal already has for Home Assistant: nobody types it. */
export function assistantSetupLinks(homeAssistantUrl: string, version: string): JarvisSetupLinks {
  const blueprintImport = new URL(HOME_ASSISTANT_PAGES.blueprintImport, homeAssistantUrl);
  blueprintImport.searchParams.set(
    HOME_ASSISTANT_PAGES.blueprintParameter,
    assistantFileLink(version, ASSISTANT_FILES.blueprint),
  );
  return {
    helpers: new URL(HOME_ASSISTANT_PAGES.helpers, homeAssistantUrl).toString(),
    blueprintImport: blueprintImport.toString(),
  };
}

export interface JarvisMessage {
  id: string;
  kind: TaskKind;
  tier: JarvisTier;
  host: string;
  names: string[];
  say: string;
  text: string;
  // A question only, as it goes out: it names the question, and comes back with its answer.
  code?: string;
  // A newer version only: the tag it runs, and the tag a yes moves it to.
  from?: string;
  to?: string;
}

export interface JarvisRecentView {
  id: string;
  kind: TaskKind;
  tier: JarvisTier;
  text: string;
  sentAt: number;
}

// A question that was heard, and waits for its answer.
export interface JarvisOpenQuestionView {
  id: string;
  host: string;
  names: string[];
  // A newer version's: the tag it runs, and the tag a yes moves it to.
  from: string | null;
  to: string | null;
  askedAt: number;
  asks: number;
}

// Asking is ready once a test question was answered; until then each switch is kept but asks nothing.
export interface JarvisAskingView {
  ready: boolean;
  updates: boolean;
  versions: boolean;
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
  // How it addresses people, once in each spoken sentence; null for not at all.
  address: string | null;
  // What the person calls it, shown on the card; null for none.
  name: string | null;
  // To paste into the automation; null until connected, or when another backup passphrase sealed it.
  webhookId: string | null;
  // Home Assistant's pages for the setup steps; null until Home Assistant is set.
  links: JarvisSetupLinks | null;
  // Autoheal's own connection to Home Assistant, which every answer comes back by.
  homeAssistantConnected: boolean;
  testQuestion: JarvisTestQuestionView | null;
  asking: JarvisAskingView;
  open: JarvisOpenQuestionView[];
  // Null when it could not be opened: another backup passphrase sealed it.
  setup: string | null;
  testing: boolean;
  lastTestMilliseconds: number | null;
  // The last word from Home Assistant: a call on its key, or a line in its answer box, whichever came last.
  lastHeardAt: number | null;
  heardByAnswerBox: boolean;
  // Lines past the most Autoheal reads in a minute, not read since it started.
  linesDropped: number;
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

export const JARVIS_SECRET_NAME = "autoheal_assistant_key";
const SECRET_PLACEHOLDER = "<the key shown once when you connected>";

/** What goes into Home Assistant, whole. The key stays out of it: one line for secrets.yaml, by hand. */
export function jarvisSetup(
  dashboard: string,
  webhookId: string,
  machines: readonly JarvisMachineNames[],
  address: string | null,
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
- id: assistant_hears_from_autoheal
  alias: Assistant hears from Autoheal
  mode: queued
  triggers:
    - trigger: webhook
      webhook_id: ${webhookId}
      allowed_methods: [POST]
      local_only: true
  actions:
    - variables:
        message: "{{ trigger.json }}"
        # Your voice satellites, comma separated. Left empty, the phone gets every message.
        rooms: "assist_satellite.YOUR_SATELLITE"
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

- id: assistant_says_how_the_servers_are
  alias: Assistant says how the servers are
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
        else "Autoheal is not answering${spokenTo(address)}." }}

- id: assistant_notices_autoheal_is_silent
  alias: Assistant notices Autoheal is silent
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
