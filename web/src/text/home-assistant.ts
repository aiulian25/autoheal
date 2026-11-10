import { MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from "../../../src/shared/constants.js";
import { JARVIS_ANSWER_HOW, type JarvisAnswerHow } from "../../../src/shared/jarvis.js";

// The assistant as its card speaks of it: by the name the person gave it, or plainly.
const called = (name: string | null) => name ?? "the assistant";
const calledFirst = (name: string | null) => name ?? "The assistant";
const SECONDS_PER_MINUTE = MILLISECONDS_PER_MINUTE / MILLISECONDS_PER_SECOND;
// How long an answer took: in seconds up to two minutes, in minutes after that.
const IN_SECONDS_UNDER = 2 * SECONDS_PER_MINUTE;
const SECONDS = new Intl.NumberFormat("en", { style: "unit", unit: "second", unitDisplay: "long" });
const MINUTES = new Intl.NumberFormat("en", { style: "unit", unit: "minute", unitDisplay: "long" });
const secondsSpoken = (seconds: number) =>
  seconds < IN_SECONDS_UNDER ? SECONDS.format(seconds) : MINUTES.format(Math.round(seconds / SECONDS_PER_MINUTE));
const LIST = new Intl.ListFormat("en", { type: "conjunction" });
const ASKINGS = ["First", "Second", "Last"] as const;

/** The Home page: Home Assistant, its devices, its configuration review and the assistant. */
export const HOME_ASSISTANT_TEXT = {
  jarvis: {
    title: "Assistant",
    explanation: (name: string | null) =>
      `${calledFirst(name)} tells you what matters from what Autoheal finds, through Home Assistant, and can ask before Autoheal updates a container. Only what stays a problem is told, at most 3 a day unless it is urgent.`,
    needsHomeAssistant: "Connect Home Assistant first: the assistant lives there.",
    connected: "Connected",
    paused: "Paused",
    notConnected: "Not connected",
    name: "Name",
    nameHint: "What you call it, shown only here. Leave it empty for “the assistant”.",
    nameRefused: "Only letters, digits, spaces, ' and - can be used.",
    steps: "Set it up in Home Assistant",
    answerBox: "Make the answer box",
    answerBoxHint: "Add a Text helper. Any name.",
    openHelpers: "Open the helpers",
    automation: "Add the automation",
    automationHint: "Import the blueprint, paste this webhook ID into its form, and pick the answer box.",
    importBlueprint: "Import the blueprint",
    webhookId: "Webhook ID",
    webhookIdLater: "The webhook ID shows here once the blueprint is open.",
    showWebhookId: "Show the webhook ID",
    testQuestion: "Send a test question",
    testQuestionHint: (name: string | null) =>
      `“This is a test from Autoheal. Can you hear me?” Answer ${called(name)} aloud, or on the phone.`,
    testNeedsHomeAssistant:
      "Autoheal is not connected to Home Assistant, so no answer could come back. See Home Assistant's card.",
    asking: "Asked. Waiting for the answer…",
    answeredTest: (said: string, how: JarvisAnswerHow, seconds: number) =>
      `Answered ${said}, ${how === JARVIS_ANSWER_HOW.voice ? "by voice" : "on the phone"}, in ${secondsSpoken(seconds)}.`,
    notTaken: "Home Assistant did not take the message. Check its address and token on Home Assistant's card.",
    nothingBack: "Taken, but nothing came back. Is the answer box picked in the automation, with this webhook ID?",
    putOff:
      "Home Assistant put it off: quiet hours, nobody home or the satellite busy, and no phone. See the automation's form.",
    notAnswered: "Heard, but nobody answered. Is a voice satellite or a phone picked in the automation?",
    whoAnswers: "Whoever can change helpers in Home Assistant, or speak where it asks, can answer.",
    askUpdates: "Ask before updating a container",
    askVersions: "Ask about newer versions",
    notReady: "Answer a test question first: until then nothing is asked.",
    asked: (time: string, about: string, asks: number) =>
      `Asked at ${time}: ${about}. ${ASKINGS[Math.min(asks, ASKINGS.length) - 1]} of three.`,
    askedAbout: (names: readonly string[], host: string) => `${LIST.format(names)} on ${host}`,
    askedAboutVersion: (name: string, host: string, from: string, to: string) => `${name} on ${host}, ${from} to ${to}`,
    ownAutomations: "I write my own automations",
    contract: "What Autoheal sends, and the lines it reads back:",
    contractLink: "the contract",
    blockNote: "A house that confirms with a key uses the block below.",
    keyOnce: "This key is shown once. It goes in secrets.yaml, in the block below.",
    setupNote:
      "Change notify.YOUR_PHONE to your phone's and assist_satellite.YOUR_SATELLITE to your voice satellites (or leave it empty), reload REST, REST commands and automations (or restart Home Assistant), and send a test.",
    test: "Send a test",
    testing: (name: string | null) => `Waiting for ${called(name)} to answer…`,
    answered: (name: string | null, milliseconds: number) => `${calledFirst(name)} answered in ${milliseconds} ms.`,
    notDelivered: "Home Assistant could not be reached.",
    blockNotAnswered: (name: string | null) =>
      `Home Assistant took it, but ${called(name)} did not answer. Is the block added, and has Home Assistant reloaded it?`,
    lastHeard: "Last heard from",
    byAnswerBox: ", by the answer box",
    never: "Not heard from yet",
    pause: "Pause",
    resume: "Resume",
    disconnect: "Disconnect",
    disconnectConfirm: (name: string | null) =>
      `Disconnect ${called(name)}? Its webhook ID and key stop working at once.`,
    showSetup: "Show the Home Assistant block",
    hideSetup: "Hide the block",
    recent: "Asked and told",
    summaryNow: (name: string | null) => `Asked how the servers are, ${called(name)} would say`,
    address: "Form of address",
    addressHint: "How it addresses you, once in whatever it says: sir, ma'am or a name. Leave it empty for none.",
    addressRefused: "Only letters, spaces, ' and - can be said.",
    names: "Other names for your machines",
    namesHint: (name: string | null) =>
      `What you might call each machine out loud, separated by commas, including what ${called(name)} mishears. A renamed machine keeps its old name here. After any change, or a new machine, update its sentences from the Home Assistant block.`,
    namesOf: (label: string) => `Other names for ${label}`,
    save: "Save",
    saved: "Saved.",
    nameTaken: "Another machine already goes by one of those names.",
    waiting: (count: number) => `${count} waiting to be told.`,
    linesDropped: (count: number) =>
      `Home Assistant wrote into its answer box faster than Autoheal reads: ${count === 1 ? "1 line was" : `${count} lines were`} not read. Is an automation writing to it in a loop?`,
    notConfirmed: (name: string | null, count: number) =>
      `${calledFirst(name)} has not confirmed ${count === 1 ? "1 message" : `${count} messages`}, so nobody may have heard ${count === 1 ? "it" : "them"}. Is its automation on, with the confirming step from the block?`,
  },
  zigbee: {
    title: "Zigbee",
    summary: (total: number, unavailable: number, lowBattery: number, weakLink: number) =>
      `${total} devices: ${unavailable} unavailable, ${lowBattery} with a low battery, ${weakLink} with a weak link.`,
    device: "Device",
    area: "Area",
    role: "Role",
    status: "Status",
    battery: "Battery",
    linkQuality: "Link quality",
    lastSeen: "Last seen",
    online: "online",
    empty: "No Zigbee devices match.",
  },
  safety: {
    title: "Safety devices",
    explanation: "Smoke, heat and CO alarms. Autoheal only reads them; it never acts on them.",
    device: "Device",
    area: "Area",
    alarm: "Alarm",
    online: "Online",
    battery: "Battery",
    fault: "Fault",
    ok: "ok",
    empty: "No smoke, heat or CO alarms found in Home Assistant.",
  },
  watched: {
    title: "Watched by Home Assistant",
    explanation:
      "Systems Home Assistant already watches, shown read-only. Acting on them waits for their own connectors.",
    device: "Device",
    area: "Area",
    problems: "Problems",
    updates: "Updates",
    updatesAvailable: (count: number) => `${count} available`,
    empty: "Home Assistant watches no UniFi, Pi-hole, Synology, Uptime Kuma or ping devices.",
  },
  integrations: {
    unifi: "UniFi",
    pi_hole: "Pi-hole",
    synology_dsm: "Synology",
    uptime_kuma: "Uptime Kuma",
    ping: "Ping",
  } as Record<string, string>,
  homeReview: {
    title: "Your configuration",
    readBy: (server: string) => `Read by Ollama server ${server}. Change it in Settings > Connections.`,
    defaultServer: "the default server",
    lede: "Ollama reads your configuration and suggests. Nothing is changed: you decide, check its YAML, and paste it yourself.",
    notMounted:
      "Autoheal cannot see Home Assistant's configuration. On the machine running the dashboard, set HOME_ASSISTANT_CONFIG_PATH in .env to its folder, such as its Samba share, then run docker compose up -d. It is mounted read-only.",
    tabs: { errors: "Errors", rooms: "Automations", cleanup: "Clean up" },
    tabsLabel: "What to look at",
    checkAgain: "Check again",
    checked: "Checked",
    noLog: "Home Assistant would not give its log: it needs an admin's token.",
    logNone: "Home Assistant's log has no errors or warnings now.",
    deadTitle: "Entities your files name that this home does not have",
    deadNone: "Every entity your files name exists.",
    deadAt: (file: string, line: number) => `${file}, line ${line}`,
    meant: (entity: string) => `did you mean ${entity}?`,
    times: (count: number) => `${count} times`,
    askFix: "Ask Ollama how to fix it",
    askRoom: "Ask Ollama",
    askAgain: "Ask again",
    thinking: "Ollama is thinking. This can take a few minutes, and you can leave this page.",
    failed: (error: string | null) => `Ollama could not answer: ${error ?? ""}`,
    nothing: "Ollama had nothing to suggest.",
    kinds: { fix: "Fix", new: "New", improve: "Improve" },
    unknown: (names: string) => `Careful: this names what your home does not have: ${names}. Check it before using it.`,
    roomFacts: (entities: number, automations: number) => `${entities} entities, ${automations} automations`,
    noRooms: "Home Assistant has no rooms yet, or is not connected.",
    skippedTitle: "Files not read",
    skippedNote: "Autoheal did not open these, so nothing in them was checked or sent to a model.",
    skippedWhy: {
      link: "It is a link, so it could lead anywhere",
      second_name: "It is another name for a file",
      not_plain: "It is not a plain file",
      too_big: "It is too big to read",
      over_budget: "There was more to read than one look keeps",
    },
    scanIncomplete: {
      time: "The folder was too slow to read all of it in time, so this covers only part of your configuration.",
      entries: "The folder holds too many files to go through, so this covers only part of your configuration.",
      bytes: "There was more than one look keeps, so this covers only part of your configuration.",
    },
    leftoversTitle: "Old backups and dumps you could remove",
    leftoversTotal: (size: string) => `${size} in all`,
    leftoversNone: "No old backups or dumps found.",
    commentsTitle: "Lines commented out that you could remove",
    commentsNone: "No commented-out blocks found.",
    commentsAt: (file: string, from: number, to: number) => `${file}, lines ${from} to ${to}`,
    cleanupNote: "Only suggestions: Autoheal never deletes from this folder. Check Home Assistant's own backups first.",
  },
  homeAssistant: {
    title: "Home",
    lede: "What Home Assistant knows about your home, read only, life safety first.",
    notConfigured: "Home Assistant is not set up yet: an admin adds it in Settings > System.",
    disconnected: (error: string | null) => `Not connected to Home Assistant${error === null ? "" : `: ${error}`}`,
    // Home Assistant's own box, beside the hosts on Fleet and at the top of its page.
    box: {
      name: "Home Assistant",
      title: "The box it runs on",
      online: "online",
      offline: "offline",
      operatingSystem: (version: string) => `Home Assistant OS ${version}`,
      core: (version: string) => `Core ${version}`,
      load: (value: string) => `load ${value}`,
      noMonitor:
        "Add System Monitor in Home Assistant (Settings > Devices & services) to see its CPU, memory and disk here.",
      networkOff: "off in System Monitor",
      // The disk on its dial is the box's root filesystem.
      rootDisk: "/",
      networkOffHint:
        "Turn on System Monitor's network throughput sensors in Home Assistant to see this box's traffic here.",
      entities: (count: string) => `${count} entities`,
      unavailable: (count: string) => `${count} unavailable`,
      openLabel: "Open Home Assistant",
      update: (title: string, installed: string | null, latest: string | null) =>
        `${title}${installed === null ? "" : ` ${installed}`}${latest === null ? "" : ` → ${latest}`}`,
      noUpdates: "None waiting",
      facts: {
        core: "Core",
        operatingSystem: "Operating system",
        supervisor: "Supervisor",
        uptime: "Uptime",
        load: "Load",
        temperature: "CPU temperature",
        memory: "Memory",
        disk: "Disk",
        updates: "Updates waiting",
        entities: "Entities",
        lastReport: "Last report",
      },
    },
  },
} as const;
