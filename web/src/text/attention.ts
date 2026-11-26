import {
  MAX_RESTARTS_PER_WINDOW,
  TASK_SNOOZE,
  type HeldReason,
  type TaskActivityKind,
  type TaskSnooze,
  type TaskStatus,
  type Trigger,
  type UpdateAssessment,
  wordsOf,
} from "../../../src/shared/constants.js";
import type { ATTENTION_PLACE, AttentionPlaceKind } from "../constants.js";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const things = (count: number) => plural(count, "thing", "things");
const onHosts = (hosts: number) => (hosts === 0 ? "" : `, on ${plural(hosts, "host", "hosts")}`);

// What waits for a look, after what needs a person or alone: "6 more wait" or "12 things wait".
function forALook(count: number, more: boolean): string {
  const counted = more ? `${count} more` : things(count);
  return `${counted} ${count === 1 ? "waits" : "wait"} for a look when you have time.`;
}

// What Autoheal did by itself in the last day, in a sentence; nothing when it did nothing.
function lastDay(healed: number, updated: number): string {
  const restarted = `restarted ${plural(healed, "container", "containers")} that stopped`;
  const wentIn = `${plural(updated, "update", "updates")} went in by themselves`;
  if (healed > 0 && updated > 0) return `In the last 24 hours Autoheal ${restarted}, and ${wentIn}.`;
  if (healed > 0) return `In the last 24 hours Autoheal ${restarted}.`;
  return updated > 0 ? `In the last 24 hours ${wentIn}.` : "";
}

// What comes next: the image check and the host packages' window, where each is known.
function nextUp(checkInMinutes: number | null, windowStart: string | null): string {
  const parts = [
    checkInMinutes === null ? null : `the image update check in ${plural(checkInMinutes, "minute", "minutes")}`,
    windowStart === null ? null : `host packages tonight at ${windowStart}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "" : `Next: ${parts.join(", ")}.`;
}

/** Attention, the board and tasks. */
export const ATTENTION_TEXT = {
  savedViews: {
    label: "Saved view",
    none: "None",
    save: "Save this view",
    name: "Name",
    saveNow: "Save",
    cancel: "Cancel",
    remove: "Remove this view",
    hostGone: "This view was for a host no longer available, so it shows every host.",
  },
  boardArrangement: {
    open: "Arrange board",
    close: "Done arranging",
    up: (column: string) => `Move ${column} earlier`,
    down: (column: string) => `Move ${column} later`,
    show: (column: string) => `Show ${column}`,
    reset: "Reset to the usual board",
    hidden: (columns: string) => `Hidden: ${columns}`,
  },
  board: {
    title: "Board",
    lede: "Every open problem, in the column of who has it now.",
    columns: {
      noticed: { title: "Noticed", hint: "Problems that may still clear by themselves.", empty: "Nothing new." },
      autoheal: { title: "Autoheal is on it", hint: "What it is deciding or doing now.", empty: "Nothing in hand." },
      needsYou: { title: "Needs you", hint: "Autoheal may not decide these alone.", empty: "Nothing needs you." },
      done: { title: "Done", hint: "Settled in the last 24 hours.", empty: "Nothing settled today." },
    },
    close: "Close",
    details: "Logs and every step",
    asList: "As a list",
  },
  attention: {
    title: "Attention",
    // What needs a person, on how many hosts, and how much more waits for a look.
    lede: (needs: number, hosts: number, lookAt: number) => {
      const rest = lookAt === 0 ? "Everything else is running or already in hand." : forALook(lookAt, needs > 0);
      if (needs > 0) return `${things(needs)} ${needs === 1 ? "needs" : "need"} you${onHosts(hosts)}. ${rest}`;
      return lookAt === 0
        ? "Nothing needs you. Everything is running or already in hand."
        : `Nothing needs you. ${rest}`;
    },
    // The line under the title: how the fleet stands, naming only what is wrong.
    fleet: {
      label: "How the fleet stands",
      hostsOnline: (online: number, total: number) => `${online} of ${total} hosts`,
      online: "online",
      containers: (running: number, total: number) => `${running} of ${total}`,
      running: "containers running",
      fullestDisk: "fullest disk",
      on: (host: string) => `on ${host}`,
      link: "Fleet",
    },
    needsYou: { label: "Needs you", hint: "Most pressing first, each with its own buttons" },
    lookAt: {
      label: "To look at",
      hint: "When you have time · Done and Snooze in the row, no need to open the board",
      more: (count: number, names: string) => `${count} more · ${names}`,
    },
    snoozed: (count: number) => `${count} snoozed`,
    snoozedUntil: (when: string) => `until ${when}`,
    allClear: {
      title: "All clear",
      nothing: "Nothing needs you and nothing waits for a look.",
      lastDay,
      next: nextUp,
    },
    // Where it happens, for what has no host of its own.
    places: {
      "home-assistant": "Home Assistant",
      network: "Network",
      ollama: "Ollama",
      other: "Tasks",
    } satisfies Record<Exclude<AttentionPlaceKind, typeof ATTENTION_PLACE.host>, string>,
    tags: { decide: "Decide", escalated: "Escalated", fix: "Fix" },
    rebootWaiting: "reboot waiting",
    disk: "disk",
    lastReport: (time: string) => `last report ${time}`,
    // A host's packages in one row, opened in place to tick them.
    packageUpdates: (count: number) => plural(count, "host package update", "host package updates"),
    securityFixes: (count: number) => plural(count, "security fix", "security fixes"),
    waitForYou: (count: number) => `${count} ${count === 1 ? "waits" : "wait"} for you`,
    reviewCount: (count: number) => `Review ${count}`,
    hideList: "Hide the list",
    update: "Update",
    handTicked: (count: number) => `Hand ${count} to Ollama`,
    imageCheckIn: (minutes: number) => `in ${minutes} min`,
    allItems: (count: number) => `See all ${count} board ${count === 1 ? "item" : "items"}`,
    services: "Hosts and services",
    fullestDisk: (percent: string) => `disk ${percent}`,
    homeAssistant: {
      title: "Home Assistant",
      notConnected: "not connected",
      connect: "Connect it to watch your home",
      connected: "connected",
      notAnswering: "not answering",
      checkIt: "Check its connection",
      allFine: "Nothing to look at",
      toLookAt: (count: number) => `${count} to look at`,
    },
    ollama: {
      title: "Ollama Agent",
      answering: "answering",
      notAnswering: "not answering",
      answeringOf: (answering: number, total: number) => `${answering} of ${total} answering`,
      defaultName: "Default",
      defaultServer: "the default server",
      watching: (hosts: number) => `${hosts} ${hosts === 1 ? "host" : "hosts"}`,
      onDefault: (server: string) => `its hosts use ${server} for now`,
    },
    // The Ollama agent: what people hand to it, by dragging onto its card or by ticking.
    agent: {
      dropTarget: "Drop Target",
      goesTo: (server: string) => `Goes to ${server}`,
      goesToServers: (count: number) => `Goes to ${count} servers`,
      dropHere: "Drop updates or escalated incidents here to hand them to Ollama",
      handOver: "Hand to Ollama",
      handed: (count: number) => `Handed ${count} ${count === 1 ? "item" : "items"} to Ollama.`,
      drag: (name: string) => `Drag ${name} onto the Ollama Agent`,
      ready: "Agent ready",
      working: "Agent working",
      offline: "Agent offline",
      partlyOffline: "Partly offline",
    },
    happened: { die: "stopped", oom: "killed for memory", unhealthy: "turned unhealthy" } satisfies Record<
      Trigger,
      string
    >,
    suggestsRestart: "Ollama suggests a restart.",
    suggestsDependency: (target: string) => `Ollama suggests restarting ${target}.`,
    ruleAsksFirst: "This container's rule asks you first.",
    handedOver: "Ollama did not find a safe fix and handed it to you.",
    restartsUsed: (used: number) => `${used} of ${MAX_RESTARTS_PER_WINDOW} restarts used this hour`,
    approve: "Approve restart",
    restartIt: "Restart it",
    leave: "Leave it stopped",
    stopIt: "Stop it",
    stopWatching: "Stop watching this container",
    seeWhy: "See why",
    open: (where: string) => `Open ${where}`,
    done: "Done",
    yoursSince: (since: string) => `yours since ${since}`,
    theirsSince: (name: string, since: string) => `${name}'s since ${since}`,
    openSince: (since: string) => `open since ${since}`,
    review: "Review",
    containerImage: "Container image · recreated with its settings and volumes",
    newerVersion: (from: string, to: string) => `Newer version · ${from} → ${to}, its tag changed in its files`,
    // Home Assistant's own updates: Autoheal only reads Home Assistant, so a person installs them there.
    installInHomeAssistant: (count: number) =>
      `Install ${count === 1 ? "it" : "them"} in Home Assistant: Settings → System → Updates.`,
    hostPackage: (security: boolean) => (security ? "Host package · security fix" : "Host package"),
    goesInTonight: (start: string, end: string) => `Goes in tonight, ${start} to ${end}`,
    // The assistant in Home Assistant asked about an update: then the answer it heard, how, and when.
    assistant: {
      asked: "Asked the assistant",
      answered: (answer: "yes" | "no", how: string | null, time: string) =>
        `${answer === "yes" ? "Yes" : "No"}${how === null ? "" : `, by ${how}`}, ${time}`,
    },
    advice: { update: "Ollama: safe to apply", hold: "Ollama: hold it for you" } satisfies Record<
      UpdateAssessment,
      string
    >,
    heldBecause: { data_not_kept: "Its data could not be copied first" } satisfies Record<HeldReason, string>,
    updateNow: (count: number) => `Update ${count} ${count === 1 ? "container" : "containers"} now`,
    oneAtATime: "One at a time. If one fails to come back healthy, the rest wait.",
    onItNow: "On it now",
    nothingInHand: "Nothing in hand.",
    healed: "Healed in the last 24 hours",
    nothingHealed: "Nothing needed healing.",
    comingUp: "Coming up",
    imageCheck: "Image update check",
    everyHours: (hours: number) => (hours === 1 ? "every hour" : `every ${hours} hours`),
    hostPackages: "Host packages",
    tonightAt: (time: string) => `tonight ${time}`,
    databaseBackup: "Database backup",
    daily: "daily",
    dailyVerified: "daily, verified",
  },
  tasks: {
    title: "Tasks",
    snoozedUntil: (when: string) => `Snoozed until ${when}: it waits among what was noticed until then.`,
    wake: "Wake it now",
    snooze: {
      label: "Snooze",
      choice: (length: string) => `Snooze ${length}`,
      lengths: {
        [TASK_SNOOZE.day]: "a day",
        [TASK_SNOOZE.oneMonth]: "1 month",
        [TASK_SNOOZE.threeMonths]: "3 months",
        [TASK_SNOOZE.sixMonths]: "6 months",
      } satisfies Record<TaskSnooze, string>,
      // Short enough for one line of an Attention card; the lengths above are what a screen reader says.
      shown: {
        [TASK_SNOOZE.day]: "1 day",
        [TASK_SNOOZE.oneMonth]: "1 mo",
        [TASK_SNOOZE.threeMonths]: "3 mo",
        [TASK_SNOOZE.sixMonths]: "6 mo",
      } satisfies Record<TaskSnooze, string>,
    },
    newTitle: "New task",
    newPlaceholder: "What needs doing?",
    add: "Add",
    showLabel: "Show",
    show: { open: "Open", mine: "Mine", autoheal: "Autoheal's", updates: "Updates", closed: "Closed" },
    search: "Search tasks",
    viewLabel: "View",
    list: "List",
    board: "Board",
    empty: "Nothing here.",
    number: "#",
    numbered: (number: number) => `#${number}`,
    task: "Task",
    priority: "Priority",
    status: "Status",
    assignee: "Assignee",
    updated: "Updated",
    nobody: "Nobody",
    panel: (number: number, title: string) => `#${number} ${title}`,
    close: "Close the task",
    removeMark: "×",
    working: "Autoheal is on it",
    openedBy: (who: string) => `Opened by ${who}`,
    occurrences: (count: number) => `seen ${count} times`,
    incident: "The incident",
    addLabel: "add a label",
    removeLabel: (label: string) => `Remove the label ${label}`,
    subtasks: "Sub-tasks",
    waitingOn: "Waiting on",
    holdsUp: "Holds up",
    waitsOn: "Waits on",
    chooseTask: "Choose a task",
    addBlocker: "Add",
    stopWaiting: (number: number) => `Stop waiting on #${number}`,
    timeline: "Activity",
    comment: "Comment",
    commentPlaceholder: "Write a comment",
    send: "Comment",
    statusNames: {
      backlog: "Backlog",
      todo: "To do",
      in_progress: "In progress",
      blocked: "Blocked",
      in_review: "In review",
      done: "Done",
      cancelled: "Cancelled",
    } satisfies Record<TaskStatus, string>,
    activity: {
      created: () => "opened it",
      status_changed: (data: Record<string, unknown>) => `moved it to ${wordsOf(String(data.to))}`,
      priority_changed: (data: Record<string, unknown>) => `set its priority to ${String(data.to)}`,
      assigned: (data: Record<string, unknown>) => (data.to ? `gave it to ${String(data.to)}` : "left it with nobody"),
      edited: () => "edited it",
      labelled: (data: Record<string, unknown>) =>
        `labelled it ${(data.labels as string[]).join(", ") || "with nothing"}`,
      parent_changed: () => "moved it under another task",
      blocker_added: () => "made it wait on another task",
      blocker_removed: () => "stopped it waiting on another task",
      happened_again: (data: Record<string, unknown>) => `saw it happen again (${String(data.occurrences)} times)`,
      cleared: (data: Record<string, unknown>) =>
        data.closed
          ? "saw the problem clear, and closed it"
          : "saw the problem clear; it stays open for whoever is on it",
      reopened: (data: Record<string, unknown>) =>
        `saw it come back (${String(data.occurrences)} times) and reopened it`,
      incident_linked: () => "linked the incident",
      job_requested: (data: Record<string, unknown>) => `asked to ${wordsOf(String(data.action))}`,
      job_finished: (data: Record<string, unknown>) => String(data.outcome),
      assessed: (data: Record<string, unknown>) =>
        data.decision === null
          ? `could not ask Ollama (${String(data.reason)})`
          : `asked Ollama: ${String(data.decision)}`,
      snoozed: (data: Record<string, unknown>) =>
        data.until === null
          ? "woke it up again"
          : `snoozed it until ${new Date(Number(data.until)).toLocaleDateString()}`,
      checked_out: () => "started working on it",
      released: () => "let go of it",
      dispatched: () => "handed it to the Ollama agent",
      reported: () => "had Ollama look into why it failed",
      assistant_asked: () => "asked about it through the assistant",
      assistant_answered: (data: Record<string, unknown>) =>
        `answered ${String(data.answer)} through the assistant (${String(data.how)}${data.room ? `, ${String(data.room)}` : ""})`,
    } satisfies Record<TaskActivityKind, (data: Record<string, unknown>) => string>,
  },
} as const;
