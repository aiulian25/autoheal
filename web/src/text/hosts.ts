import {
  type ChangingPackageAction,
  DEFAULT_HOST_ROOT,
  type HostPackageManager,
  type HostRestartChoice,
  type HostUpdateChoice,
  type ImageCleanup,
  type LifecycleStatus,
  RECOVERY_HOLD,
  type RecoveryHoldReason,
} from "../../../src/shared/constants.js";
import type { TrimmableHeartbeatPart } from "../../../src/shared/protocol.js";
import { SEPARATOR } from "./basics.js";

// The parts a host's report can leave out, as its page names them.
const REPORT_PARTS: Record<TrimmableHeartbeatPart, string> = {
  topology: "its network map",
  stackDrift: "its stacks' drift",
  unusedImages: "its unused images",
  networks: "its networks",
  volumes: "its volumes",
  host: "its system facts",
};

/** The host list and a host's page: its system, packages, reboots, images and checks. */
export const HOSTS_TEXT = {
  rebootPlans: {
    title: "Plan reboots",
    lede: "Reboots the hosts you choose one at a time, in the order you tick them. Before each one it checks that enough of them are healthy now, and it stops if anything is unclear.",
    name: "Name",
    hosts: "Hosts, in the order you tick them",
    minimum: "Hosts that must stay healthy",
    checks: "Service checks that must be answering (optional)",
    returnMinutes: "Minutes each host has to come back",
    notBefore: "Not before (optional)",
    notAfter: "Start no reboots after (optional)",
    review: "Review",
    approve: "Approve and start",
    edit: "Change it",
    previewOf: (host: string, position: number) => `${position}. ${host}`,
    healthy: "healthy now",
    needsReboot: "needs a reboot",
    noReboot: "no reboot waiting",
    openJobs: (count: number) => `${count} ${count === 1 ? "job" : "jobs"} still open`,
    wouldNotStart: (problem: string) => `It would not start now: ${problem}`,
    wouldStart: "Nothing stops it starting now.",
    checksGone: (names: string) =>
      `These service checks are no longer set up, so this plan cannot start as reviewed: ${names}. Review it again.`,
    checkGoneUnnamed: "one that has since been removed",
    localHostNote: "The machine Autoheal runs on cannot be in a plan: nothing could follow it going down and back.",
    status: { running: "Running", paused: "Paused", completed: "Finished", cancelled: "Cancelled" },
    step: {
      waiting: "Waiting",
      asked: "Reboot asked",
      back: "Back, not ready yet",
      done: "Done",
      refused: "Did not take it",
      cancelled: "Will not be rebooted",
    },
    resume: "Resume",
    cancel: "Cancel what has not started",
    cancelConfirm:
      "Reboots not yet asked for will not happen. A reboot already asked of a host cannot be taken back: it goes on, and stays followed here.",
    cancelYes: "Yes, cancel the rest",
    keep: "Keep going",
    cancelling: "Cancelled for the rest. The reboot already asked is still being followed.",
  },
  probes: {
    vantage: {
      label: "Check from",
      controlPlane: "Autoheal itself",
      fromHost: (label: string) => `${label}, from where it is`,
      note: "A check made from a host reaches what that host reaches: its own network, its own resolver.",
      madeHere: "made from Autoheal",
      madeFrom: (label: string) => `made from ${label}`,
      hostGone: "the host it was made from has gone",
    },
    title: "Service checks",
    explanation:
      "Autoheal itself asks whether a service answers, by web address, port or name, from where Autoheal runs. A check that fails opens a task. It never restarts anything.",
    none: "No checks yet.",
    add: "Add a check",
    save: "Add it",
    cancel: "Cancel",
    remove: "Remove",
    removeConfirm: (name: string) => `Remove ${name} and its history?`,
    removeYes: "Yes, remove it",
    name: "Name",
    kind: "How to ask",
    kinds: { http: "Web address", tcp: "Port", dns: "Name lookup", tls: "Certificate" },
    serverName: "Name clients ask for (blank for the host)",
    warnDays: "Warn this many days before it expires",
    caPem: "Trust only this certificate or authority (blank for the usual authorities)",
    certificate: {
      valid: "Certificate valid",
      expiring: "Certificate expiring",
      expired: "Certificate expired",
      not_yet_valid: "Certificate not valid yet",
      wrong_name: "Certificate for another name",
      untrusted: "Certificate not trusted",
    },
    certificateFacts: (name: string, issuer: string) => `For ${name}, issued by ${issuer}`,
    certificateDates: "Valid until",
    certificateSeen: "Last seen",
    certificateSince: "This certificate first seen",
    scope: "It may reach",
    scopes: {
      "this-machine": "This machine only",
      "local-network": "My local network",
      internet: "The internet",
    },
    url: "Web address",
    expectedStatus: "Answer it should give",
    ignoreCertificate: "Accept any certificate",
    host: "Host or address",
    port: "Port",
    lookupName: "Name to look up",
    server: "Ask this DNS server (blank for this machine's)",
    expectedAnswer: "Address it should give (optional)",
    interval: "Check every (seconds)",
    timeout: "Give up after (seconds)",
    failures: "Failures in a row before it counts as down",
    objective: "Target availability, percent (optional)",
    states: { unknown: "Not checked yet", up: "Answering", down: "Not answering" },
    maintenance: "Under maintenance: not checked, and not counted.",
    since: "since",
    latency: "Answer time",
    checked: "Last checked",
    availability: (period: string, value: string) => `${period}: ${value}`,
    periods: { day: "Last day", month: "Last 30 days" },
    noFigure: "nothing seen yet",
    objectiveMet: (target: string) => `meets its ${target} target`,
    objectiveMissed: (target: string) => `below its ${target} target`,
    notLooked: (share: string) => `not checked for ${share} of the time`,
    milliseconds: (value: number) => `${Math.round(value)} ms`,
  },
  hostProfile: {
    title: "How this host is set up",
    explanation: "Worked out from its containers, and used as the starting point when you add a new one.",
    from: (containers: number) => `From its ${containers} containers.`,
    user: "User and group",
    timeZone: "Time zone",
    restart: "Restart policy",
    folder: "App folders",
    folderNote: (projects: number, of: number) => `${projects} of ${of} Compose projects`,
    places: "Data",
    placeNote: (mounts: number, free: string | null) =>
      free === null ? `${mounts} mounts` : `${mounts} mounts, ${free} free`,
    beside: "Beside the Compose file",
    besideNote: (mounts: number) => `${mounts} mounts`,
    networks: "Shared networks",
    networkNote: (containers: number) => `${containers} containers`,
    proxy: "Proxy",
    proxyNote: (container: string, network: string | null) =>
      network === null ? container : `${container}, on ${network}`,
    database: "Databases",
    databaseNote: (own: number, alone: number) => `${own} with their own app, ${alone} standing alone`,
    habitNote: (uses: number, of: number) => `${uses} of ${of}`,
    nothing: "Nothing shows yet",
  },
  hosts: {
    title: "Fleet",
    lede: (online: number, running: number, total: number) =>
      `${online} ${online === 1 ? "host" : "hosts"} online · ${running} of ${total} containers running`,
    localRevoked: "This machine's runner was revoked, so Autoheal no longer watches the machine the dashboard runs on.",
    addLocalAgain: "Add this machine again",
    cpus: (count: number) => `${count} CPUs`,
    reported: (ago: string) => `reported ${ago}`,
    noStats: "No live stats from this host yet.",
    running: (running: number, total: number) => `${running} of ${total} running`,
    // Where a host without Docker would count its containers.
    systemOnly: "No Docker: its system alone",
    updates: (count: number) => `${count} ${count === 1 ? "update" : "updates"}`,
    problems: (count: number) => `${count} ${count === 1 ? "problem" : "problems"}`,
    needYou: (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`,
    open: "Open",
    openHost: (label: string) => `Open ${label}`,
    stopped: (count: number, host: string) =>
      count === 1
        ? `1 container on ${host} is stopped. If it is stopped on purpose, tell Autoheal so it stops counting it.`
        : `${count} containers on ${host} are stopped. If they are stopped on purpose, tell Autoheal so it stops counting them.`,
    reviewStopped: "Review stopped containers",
    up: (duration: string) => `up ${duration}`,
    disksAlmostFull: (count: string) =>
      count === "One" ? "A disk is almost full: " : `${count} disks are almost full: `,
    diskAt: (percent: string) => ` at ${percent}`,
    seeDisks: "See disks",
    trail: "Where this host is",
    tabs: {
      label: "Sections of this host's page",
      overview: "Overview",
      containers: "Containers",
      updates: "Updates",
      dependencies: "Dependencies",
      control: "What Autoheal may do",
    },
    add: {
      nas: "A Synology or another NAS",
      nasHint: "It runs under sudo in the folder below, and watches the containers only: no disks or OS updates.",
      nasFolder: "Folder for the runner",
      nasCopyTitle: "First, copy the image over. Nothing can download it, as this installation built it itself.",
      nasCopySave: "On the machine this dashboard runs on:",
      nasCopyPut: (folder: string) =>
        `It makes autoheal-image.tar.gz in your home folder there. Put that file in ${folder} on the NAS, with its file manager.`,
      nasPaste: "Then paste this in a terminal on the NAS. sudo asks for your password.",
      nasAfter: (folder: string) => `cd ${folder} && sudo docker compose up -d`,
      nasEnv: (folder: string) => `Its .env is ${folder}/.env, and belongs to root, so edit it with sudo.`,
      worksUntil: (time: string) => `Its join code works once, until ${time}.`,
      expired: (time: string) => `Its join code expired at ${time}, unused. Make a new command and paste that one.`,
      makeAgain: "Make a new command",
      waiting: (label: string) => `Waiting for ${label} to connect…`,
      connected: (label: string) => `${label} is connected.`,
      // Around the setting and the command, which show in the code font.
      dryRunBefore:
        "It starts in dry-run: it reports what it would do and changes nothing. When its reports look right, add ",
      dryRunSetting: "DRY_RUN=0",
      dryRunMiddle: " to its .env and run ",
      dryRunCommand: "docker compose up -d",
      dryRunAfter: " there.",
    },
    lastReport: "Last report",
    dryRun: "Dry run",
    healingPaused: "healing paused",
    recoveryHeld: "recovery held",
    recoveryHeldUntil: (time: string) => `recovery held until ${time}`,
    recoveryHeldWhy: {
      [RECOVERY_HOLD.noSavedState]:
        "Its runner has no saved safety state yet (a new install, or erased state), so it restarts nothing on its own until the time shown. Failures still reach you.",
      [RECOVERY_HOLD.saveFailed]:
        "Its runner cannot save its safety state, so it restarts nothing on its own until that is fixed. Its task says what to do.",
      [RECOVERY_HOLD.stateFull]:
        "Its runner's safety state is full, so it restarts nothing on its own until that is fixed. Its task says what to do.",
    } satisfies Record<RecoveryHoldReason, string>,
    rebootRequired: "reboot needed",
    // Its Docker could not list its containers this time: what is shown is how they were, as of the time after it.
    containersStale: "Docker on this host is not answering, so its containers are shown as they were",
    // Its latest report left these out to fit: they are shown as it last reported them.
    reportTrimmed: (parts: readonly TrimmableHeartbeatPart[]) =>
      `This host's report is too large to send whole, so for ${new Intl.ListFormat("en").format(parts.map((part) => REPORT_PARTS[part]))} you see what it reported last.`,
    noReport: "No report yet",
    rename: "Rename",
    renaming: (label: string) => `Rename ${label}`,
    newName: (label: string) => `New name for ${label}`,
    // What the browser says when a name breaks HOST_LABEL_PATTERN.
    nameRule: "Letters, digits, dots, dashes and underscores, up to 64; no spaces.",
    save: "Save",
    cancel: "Cancel",
    joinCode: {
      title: "Join code",
      explanation:
        "A join code works once, within an hour: the runner trades it for a token it keeps in Docker on its host. Make a new one when the runner must join again, after its Docker volumes were removed, or to replace an older code.",
      make: "Make a new code",
      paste: (label: string, time: string) =>
        `In the runner's folder on ${label}, paste this: it puts the new code in its .env and starts the runner again. It works once, until ${time}.`,
      nas: "On a NAS, put sudo before sed and before docker.",
    },
    revoke: "Revoke",
    revokeTitle: (label: string) => `Take ${label} off the dashboard`,
    revokeExplanation: "Its runner keeps healing on its own but stops reporting here. Its tasks and incidents stay.",
    revokeConfirm: (label: string) => `Revoke ${label}? Its runner keeps healing locally but stops reporting.`,
    empty: "No hosts enrolled yet.",
    back: "All hosts",
    openHere: "Open on this host",
    snoozedUntil: (when: string) => `snoozed until ${when}`,
    nothingOpen: "Nothing open here.",
    recentIncidents: "Recent incidents",
    noIncidents: "No incidents on this host yet.",
    notFound: "This host is not enrolled.",
    hostRootHint: `No disks reported: its runner reads only its containers. For its disks too, mount the host's / read-only at ${DEFAULT_HOST_ROOT}, as the full runner's compose file does.`,
  },
  hostPackages: {
    title: "Host packages",
    inWindow: (start: string, end: string) =>
      `Installed in the nightly window, ${start} to ${end}. Security fixes go in on their own.`,
    someWaitForYou: (start: string, end: string) =>
      `Security fixes go in on their own in the nightly window, ${start} to ${end}. The rest waits for you.`,
    installNowInstead: "Install now instead",
    installNow: "Install now",
    whatChanged: "What changed this week",
    allowed: {
      apply:
        "Autoheal lists this host's packages, installs what you tick, and may install security fixes by itself: HOST_PACKAGES=apply in its .env.",
      check:
        "Tick what to install and install it from here. Autoheal installs nothing by itself (HOST_PACKAGES=apply in this host's .env lets it put security fixes in at night).",
      off: "Autoheal leaves this host's packages alone, so it cannot list its updates here. To see each one and tick which to install, add HOST_PACKAGES=check to this host's .env (HOST_PACKAGES=apply also lets Autoheal install security fixes by itself), then run docker compose up -d there.",
    },
    // A host reached over SSH keeps the same choice on its own page, and runs its jobs as root with its saved password.
    allowedOverSsh: {
      apply:
        "Autoheal lists this host's packages, installs what you tick, and may install security fixes by itself, as root with the password saved on its Over SSH card.",
      check:
        "Tick what to install and install it from here, as root with the password saved on its Over SSH card. Autoheal installs nothing by itself.",
      off: "Autoheal leaves this host's packages alone, so it cannot list its updates here. To see each one and tick which to install, choose “Check, and install what I tick” in the Settings of its Over SSH card, and save its root password there.",
    },
    unsupported: {
      no_package_manager:
        "This host has neither apt nor dnf: Autoheal looks after Debian, Ubuntu, Fedora and RHEL-family packages.",
      no_systemd: "This host was not booted by systemd, which runs Autoheal's package jobs.",
      no_dbus: "This host's D-Bus socket is not there, so its systemd cannot be asked.",
    },
    noFacts: "Its runner has not said anything about its packages yet: an older runner, or no host root mounted.",
    unattended: {
      apt: "unattended-upgrades installs the security fixes here; Autoheal only reports what it did.",
      dnf: "dnf-automatic installs updates here by itself; Autoheal only reports.",
    } satisfies Record<HostPackageManager, string>,
    alwaysAsks: "Every update here waits for you.",
    notChecked: "Not checked yet.",
    firstCheck: "Checking this host's packages for the first time…",
    checked: "Checked",
    notRefreshed: (problem: string) =>
      `The package lists could not be refreshed (${problem}): this is from the old ones.`,
    needsRepair: "dpkg was left half-done: nothing installs until it is repaired.",
    available: (count: number) =>
      count === 1 ? "1 package update is available." : `${count} package updates are available.`,
    upToDate: "All installed packages are up to date.",
    newVersion: (version: string) => `New version ${version}`,
    installedVersion: (version: string) => `installed ${version}`,
    kindAndWho: (kind: string, who: string) => `${kind} · ${who}`,
    selectOne: (name: string) => `Select ${name}`,
    whoNames: {
      automatic: "Autoheal, tonight",
      unattended: { apt: "unattended-upgrades", dnf: "dnf-automatic" } satisfies Record<HostPackageManager, string>,
      person: "you",
    },
    kindNames: {
      container_runtime: "container runtime",
      core_system: "core system",
      third_party: "other repository",
      keeps_data: "keeps data",
      kernel: "kernel",
      routine: "routine",
    },
    security: "security",
    held: "held for you",
    keptBack: (count: number) =>
      `Not offered yet (${count}): they need a package added or removed, or are phased in slowly.`,
    repair: "Repair dpkg",
    removeUnused: (count: number) => `Remove unused (${count})`,
    rebootNow: "Reboot now",
    hideAlert: "Hide alert",
    confirmRemove: (lines: readonly string[]) =>
      `Remove these from this host? Nothing needs them any more.\n\n${lines.join("\n")}`,
    confirmReboot: (host: string) =>
      `Reboot ${host} now? Every container on it stops and starts again; this can take a few minutes. A Proxmox VE node is not rebooted while a backup runs.`,
    removable: (count: number) => `No longer needed (${count}): old kernels, and what only they needed.`,
    lifecycle: {
      supported: (release: string, until: string | null) =>
        until === null ? `${release} gets security fixes.` : `${release} gets security fixes until ${until}.`,
      ending: (release: string, until: string | null) =>
        `${release} gets security fixes only until ${until}: time to plan the move to a newer release.`,
      extended: (release: string, until: string | null) =>
        `${release} gets security fixes only with paid or subscription support now${until === null ? "" : `, until ${until}`}.`,
      unsupported: (release: string) => `${release} gets no security fixes any more: move to a newer release.`,
    } satisfies Record<LifecycleStatus, (release: string, until: string | null) => string>,
    lifecycleDatesAsOf: (day: string) => `Support dates as of ${day}.`,
    rebootWarning:
      "Warning! Recent package updates (such as a new kernel version) require a reboot to be fully applied.",
    rebootDetails: (packages: readonly string[], kernel: string | null) =>
      [
        packages.length === 0 ? "" : `It waits for ${packages.join(", ")}.`,
        kernel === null ? "" : `Kernel ${kernel} starts at the next boot.`,
      ]
        .filter((sentence) => sentence !== "")
        .join(" "),
    running: "On its way to the host, or running there…",
    // A package run as a terminal shows it.
    run: {
      title: "What the host is doing",
      now: {
        upgrade_packages: (packages: readonly string[]) => `Now updating ${packages.join(" ")} ..`,
        autoremove_packages: () => "Now removing the packages nothing needs any more ..",
        repair_packages: () => "Now finishing what dpkg left half-done ..",
      } satisfies Record<ChangingPackageAction, (packages: readonly string[]) => string>,
      command: {
        upgrade_packages: (command: string) => `Installing package(s) with command ${command} ..`,
        autoremove_packages: (command: string) => `Removing package(s) with command ${command} ..`,
        repair_packages: (command: string) => `Running ${command} ..`,
      } satisfies Record<ChangingPackageAction, (command: string) => string>,
      waiting: "Waiting for the host's runner to start it…",
      continues:
        "You can leave this page or close the browser. This job runs independently on the host; return here to follow its progress.",
      done: {
        upgrade_packages: ".. install complete",
        autoremove_packages: ".. removal complete",
        repair_packages: ".. repair complete",
      } satisfies Record<ChangingPackageAction, string>,
      // The runner's own words: "It failed: …", "Refused: …".
      failed: (outcome: string) => `.. ${outcome}`,
      refetching: "Re-fetching available packages ..",
      refetched: "Re-fetching available packages .. done",
      back: "Return to package list",
    },
    recentJobs: "Package jobs",
    recentChanges: "What apt changed this week",
    changeBy: { unattended: "unattended-upgrades", apt: "apt" },
    upgraded: (names: string, more: number) => `upgraded ${names}${more > 0 ? ` and ${more} more` : ""}`,
    installed: (names: string) => `installed ${names}`,
    removed: (names: string) => `removed ${names}`,
    noChanges: "Nothing this week.",
  },
  hostControl: {
    title: (host: string) => `What Autoheal may do on ${host}`,
    saved: "Saved",
    watching:
      "This host's .env keeps DRY_RUN on: it tells you what it finds and changes nothing. DRY_RUN=0 there lets it act on what is chosen here.",
    unknown: "Its runner has not said yet whether its .env lets it act.",
    restartTitle: "When a container dies",
    restartChoices: {
      restart: { label: "Restart it, within the guard", note: "Containers set to ask still ask" },
      ask: { label: "Ask me every time", note: null },
      tell: { label: "Only tell me", note: null },
    } satisfies Record<HostRestartChoice, { label: string; note: string | null }>,
    updateTitle: "When a new image is out",
    updateChoices: {
      apply: { label: "Apply it if Ollama calls it safe", note: "Databases always ask" },
      ask: { label: "Ask me first", note: null },
      never: { label: "Never update", note: null },
    } satisfies Record<HostUpdateChoice, { label: string; note: string | null }>,
    cleanupTitle: "Clean up old images",
    howOften: "How often",
    cleanups: {
      off: "Never",
      weekly: "Weekly",
      fortnightly: "Every 2 weeks",
      monthly: "Monthly",
    } satisfies Record<ImageCleanup, string>,
    buildCache: "Also clear Docker's build cache",
    leftNetworks: "Also remove networks left behind",
    leftNetworksNote: "Only when nobody is on them, nothing stopped needs them, and their containers are gone.",
    nextRun: (when: string) => `Next run ${when}.`,
    keeps: "Images still in use are always kept.",
    never: "Unused images stay until you remove them.",
    watchOnly: "Nothing is removed while this host only watches.",
    last: "Last clean-up:",
  },
  hostSystem: {
    title: "System information",
    hostname: "Hostname",
    operatingSystem: "Operating system",
    runner: "Autoheal runner",
    docker: "Docker",
    time: "Time on system",
    kernel: "Kernel",
    kernelOn: (kernel: string, architecture: string | undefined) =>
      architecture === undefined ? `Linux ${kernel}` : `Linux ${kernel} · ${architecture}`,
    processor: "Processor",
    processorOf: (model: string | null, threads: number) =>
      model === null ? `${threads} threads` : `${model}, ${threads} threads`,
    cpuTemperatures: "CPU temperatures",
    drives: "Drive temperatures",
    driveHealth: "Drive health",
    driveHealthy: "No signs of wear or failure",
    driveReadAgo: "read by smartd",
    reading: (label: string, temperature: string) => `${label}${SEPARATOR}${temperature}`,
    uptime: "Uptime",
    clock: "Clock",
    clockInSync: "In sync",
    // "12 minutes behind", "5 seconds ahead of": how far from the control plane's.
    clockOff: (difference: string) => `${difference} the control plane's`,
    ntpActive: "NTP active",
    ntpInactive: "NTP inactive",
    clockPaused: "automatic recovery is paused",
    processes: "Running processes",
    load: "Load averages",
    // After each average, in a quieter grey.
    loadPeriods: [" 1 min", " 5 min", " 15 min"],
    memory: "Real memory",
    memoryOf: (used: string, cached: string | null, total: string) =>
      cached === null
        ? `${used} used${SEPARATOR}${total} total`
        : `${used} used${SEPARATOR}${cached} cached${SEPARATOR}${total} total`,
    swap: "Virtual memory",
    swapOf: (used: string, total: string) => `${used} used of ${total}`,
    disks: "Local disk space",
    disksOf: (used: string, free: string, total: string) =>
      `${used} used${SEPARATOR}${free} free${SEPARATOR}${total} total`,
    updates: "Package updates",
    updatesOf: (count: number, security: number) =>
      security === 0 ? `${count} available` : `${count} available, ${security} of them security`,
    upToDate: "All up to date",
  },
  hostImages: {
    title: "Old images",
    explanation:
      "No container on this host uses these, not even a stopped one: mostly what updates left behind. Docker pulls one again if a container needs it later.",
    summary: (count: number, size: string) => `${count} ${count === 1 ? "image" : "images"}, ${size}`,
    none: "None: every image on this host is used by a container.",
    notReported:
      "Its runner has not listed them yet. A runner older than this dashboard never does: update it to see them here.",
    actions: "Remove old images",
    image: "Image",
    size: "Size",
    unusedSince: "Unused since",
    selectAll: "Select every image",
    selectOne: (name: string) => `Select ${name}`,
    untagged: (repository: string) => `${repository}, without a tag`,
    kept: "What a container ran before its last update, kept for going back to it by hand.",
    remove: "Remove",
    removeOne: (name: string) => `Remove ${name}`,
    removeSelected: (count: number) => `Remove selected (${count})`,
    removeAll: "Remove all",
    confirmOne: (name: string, host: string, kept: boolean) =>
      `Remove ${name} from ${host}?${kept ? " Going back to it by hand needs it: a container ran it before its last update." : ""}`,
    confirmMany: (count: number, size: string, host: string, kept: number) =>
      `Remove ${count} images (${size}) from ${host}?${kept > 0 ? ` ${kept} of them ${kept === 1 ? "is" : "are"} kept from an update, for going back by hand.` : ""}`,
  },
  hostChanges: {
    title: "What changed",
    host: "Host",
    empty: "Nothing changed in the last two weeks.",
    earlier: (count: number) => `${count} earlier ${count === 1 ? "change" : "changes"}`,
  },
} as const;
