/** The Network page. */
export const NETWORK_TEXT = {
  network: {
    title: "Network",
    lede: "What your router says, read only. Autoheal never changes anything on it.",
    tabsLabel: "What to look at",
    tabs: {
      overview: "Overview",
      devices: "Devices",
      map: "Map",
      internet: "Internet",
      firewall: "Firewall",
      reports: "Reports",
    },
    unknown: "not yet",
    notSet: "not set",
    close: "Close",
    nothingYet: "Nothing to show yet.",
    learning: "Still learning what is usual here: nothing is called unusual for the first 7 days.",
    cannotRead: (problem: string) => `Autoheal cannot read the router: ${problem}.`,
    checkConnection: "Check the connection",
    thinking: "Ollama is thinking. This can take a few minutes, and you can leave this page.",
    askFailed: (error: string | null) => `Ollama could not answer: ${error ?? ""}`,
    answeredBy: (server: string | null) =>
      `Written by Ollama${server === null ? "" : `, ${server}`}. Its figures come from Autoheal's records.`,
    usingMost: "Using the most in the last 24 hours",
    stats: {
      internet: "Internet",
      internetLine: (outages: number, minutes: number) =>
        `this month · ${outages} ${outages === 1 ? "outage" : "outages"}, ${minutes} min`,
      contract: "Your contract",
      contractValue: (met: number, fair: number) => `${met} of ${fair}`,
      contractLine: (contract: { downMbps: number; upMbps: number }) => `fair tests met ${contract.downMbps} Mb down`,
      contractUnset: "enter it in Settings > Connections",
      newDevices: "New devices",
      newLine: "waiting for you to say you know them",
      dropping: "Dropping often",
      noneDropping: "none",
      firewall: "Firewall",
      firewallChanged: "changed",
      firewallSame: "no change",
      firewallLine: "rules and port forwards",
      updates: "Updates",
      noUpdates: "all up to date",
    },
    device: {
      filterLabel: "Which devices",
      periodLabel: "Over how long",
      filters: { all: "All", new: "New", dropping: "Often drop", unusual: "Unusual", offline: "Offline" },
      periods: { day: "24 hours", week: "Week", month: "Month" },
      columns: { device: "Device", network: "Network", used: "Used", usual: "Usual", drops: "Drops", now: "Now" },
      learning: "learning",
      online: "online",
      tagNew: "new",
      tagUnusual: "unusual",
      tagDrops: "often drops",
      tagPrivate: "changes its address",
      tagMuted: "muted",
      ask: "Ask Ollama",
      askAgain: "Ask again",
      known: "I know this one",
      name: "Name it",
      namePrompt: "What should this device be called?",
      mute: "Stop telling me about it",
      unmute: "Tell me about it again",
      notMine: "Autoheal cannot block it, as it only reads. To remove a device that is not yours, block it in UniFi.",
      dropped: (times: number) =>
        times === 0 ? "No drops in the last 7 days." : `Dropped ${times} times in the last 7 days:`,
      talk: (other: string, port: number, lines: number, blocked: boolean) =>
        `${blocked ? "Blocked from reaching" : "Talks to"} ${other}${port === 0 ? "" : `, port ${port}`} · ${lines} seen`,
      facts: (device: {
        network: string | null;
        ip: string | null;
        uplink: string | null;
        uplinkPort: number | null;
        signal: number | null;
        linkMbps: number | null;
      }) =>
        [
          device.network,
          device.ip,
          device.uplink === null
            ? null
            : `on ${device.uplink}${device.uplinkPort === null ? "" : `, port ${device.uplinkPort}`}`,
          device.signal === null ? null : `signal ${device.signal} dBm`,
          device.linkMbps === null ? null : `${device.linkMbps} Mb link`,
        ]
          .filter((part) => part !== null)
          .join(" · "),
    },
    internet: {
      speedTitle: "Speed against your contract",
      fairNote:
        "Grey: the line was already busy, so that test does not count against your provider. Blue: measured from the Autoheal machine, so it does not count either.",
      chartLabel: "Download speed of each test against your contract",
      contractLine: (mbps: number) => `${mbps} Mb`,
      barTitle: (mbps: number, when: string, fair: boolean) => `${mbps} Mb, ${when}${fair ? "" : ", not counted"}`,
      noTests:
        "No speed tests yet. Turn on the router's own speed test schedule, or set your contract speeds in Settings.",
      refused:
        "This router user may not start a speed test. Those run on their own come only from the router's own schedule.",
      run: "Run a speed test",
      running: "Testing. This can take up to 3 minutes, and it fills your line while it runs.",
      runFailed: (error: string | null) => `The speed test did not finish: ${error ?? ""}`,
      latest: (down: number, up: number, ping: number | null) =>
        `Latest: ${Math.round(down)} Mb down, ${Math.round(up)} Mb up${ping === null ? "" : `, ${ping} ms`}`,
      byThisMachine:
        "Measured from the machine Autoheal runs on, through Cloudflare, as the router did not run it. That machine's own cable or Wi-Fi can hold it down, so it does not count towards your contract.",
      byRouter: "Measured by the router.",
      serverNote: "A speed test measures to a test server, not to what your provider promises.",
      download: "Download the report",
      outages: "Outages this month",
      noOutages: "None while Autoheal was watching.",
      lasted: (minutes: number | null) => (minutes === null ? "still going" : `${minutes} min`),
      notWatched: "Time Autoheal itself was off is not counted either way.",
      line: "The line now",
      lineUp: "up",
      lineDown: "down",
    },
    firewall: {
      evidence: "How we know it holds",
      noClaim: "No router can prove this in one reading, so this lists what was checked, and what was not.",
      checks: {
        rules: {
          passed: "Rules and port forwards are as you last confirmed",
          failed: "Rules or port forwards changed, and wait for you to confirm",
          not_tested: "Rules and port forwards could not be read by this user",
        },
        logs: {
          passed: "The router's log export is arriving",
          failed: "The router's log export has stopped arriving",
          not_tested: "No log export yet: send the router's logs to this machine, and set ROUTER_LOG_PORT",
        },
        separation: {
          passed: "Networks stay apart",
          failed: "Networks do not stay apart",
          not_tested: "Whether your networks stay apart has not been tested from inside them",
        },
        outside: {
          passed: "A scan from outside found nothing unexpected",
          failed: "A scan from outside found something unexpected",
          not_tested: "No scan from outside your network: Autoheal will not scan without you choosing a machine",
        },
      },
      open: "Port forwards",
      cannotRead: "This router user cannot read them.",
      noForwards: "None.",
      isNew: "new",
      rules: (count: number) => `${count} firewall ${count === 1 ? "rule" : "rules"} also watched for changes.`,
      iMadeThis: "I made this change",
      blocked: "Blocked in the last 7 days",
      logsOff: "Needs the router's log export.",
      logsLast: "Last line from the router",
      logsTrust:
        "Lines are read only from the router's address, but anything on your network can send one in its name, so what they show is evidence, not proof.",
      logsIgnored: (lines: number, sender: string) =>
        `${lines} log ${lines === 1 ? "line" : "lines"} from addresses that are not the router's ${lines === 1 ? "was" : "were"} not read. The last came from ${sender}`,
      logsRefused: (sender: string) =>
        `Log lines are arriving from ${sender}, which is not the router's address, so they are not read. If that is the router, set it by that address, or point its name there.`,
      logsNameUnresolved: "The router's name could not be looked up just now, so its log lines may not be read.",
      blockedNote: "Only what the router blocked. It says nothing of what it let through.",
      to: "to",
      crossing: (port: number, lines: number, blocked: boolean) =>
        `${blocked ? "blocked" : "allowed"}${port === 0 ? "" : `, port ${port}`} · ${lines} seen`,
    },
    map: {
      title: "What is connected, and who talks",
      legend:
        "blue: cable · dashed green: Wi-Fi · point at a device to see who it talks to · purple: traffic · red: blocked · amber: first time",
      signal: (signal: number, band: string | null) => (band === null ? `${signal} dBm` : `${signal} dBm, ${band} GHz`),
      port: (port: number) => `port ${port}`,
      offline: "offline",
      noTalks: "No traffic seen for this one crossing the router.",
      controls: "Move the map",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      fit: "Show all of it",
      internet: "Internet",
      lines: (lines: number, blocked: boolean) => `${lines} seen${blocked ? ", blocked" : ""}`,
      noFlows:
        "Only what is plugged into what, for now. For who talks to whom, send the router's logs to this machine, and set ROUTER_LOG_PORT.",
      limit:
        "The router only sees traffic crossing it. Two devices on the same network talking through a switch do not show, so no line does not mean no talk.",
    },
    reports: {
      none: "The first report comes after a week of watching.",
      figures: "The figures it was given",
    },
    connection: {
      title: "Router",
      explanation: "Autoheal reads your network from it, and never changes anything on it.",
      connected: "connected",
      address: "Address",
      addressPlaceholder: "https://192.168.10.1",
      username: "Read-only user",
      usernameHint: "Make a local View Only user on the router for this.",
      password: "Password",
      passwordKept: "Kept unless you type a new one",
      trustTitle: "Check this is your router",
      trustNew: (url: string) =>
        `Autoheal has sent nothing yet. This is the certificate ${url} shows. Compare it with the one in your router's own settings: if they match, your password goes to this router and no other.`,
      trustChanged: (url: string) =>
        `The certificate at ${url} is not the one Autoheal knows, and your password has not been sent. If you changed it, compare this with the one in your router's own settings. If you did not, something may be in the way: do not trust it.`,
      trustFingerprint: "SHA-256 fingerprint",
      trustConfirm: "They match: trust this certificate",
      trustCancel: "Don't trust it",
      test: "Try it",
      trying: "Asking the router…",
      save: "Save",
      asked: "Asked the router",
      askedRouter: (name: string, version: string | null) =>
        version === null ? `Asked ${name}` : `Asked ${name}, version ${version}`,
      capabilities: {
        clients: "Devices on the network",
        devices: "Router and switches",
        internet: "Internet health",
        events: "Events",
        exposure: "Rules and port forwards",
      },
      speedTestNote: "Whether this user may start a speed test is found out at the first one.",
      certificate: (start: string) => `· certificate ${start}…`,
      logsOn: (port: number) =>
        `Log export received on UDP ${port}. Send it from the router, in its SIEM or activity logging settings. Only lines from the address above are read, so that address must be its number, not a name.`,
      logsOff:
        "Log export off. For firewall evidence and who talks to whom, set ROUTER_LOG_PORT, then send the router's logs here.",
      contract: "Your contract with your provider",
      contractHint: "The speeds it promises, to measure it against.",
      contractDown: "Download, Mb",
      contractUp: "Upload, Mb",
      change: "Change",
      remove: "Remove",
      removeConfirm: "Stop reading this router? What was recorded stays.",
    },
    card: {
      title: "Network",
      toLookAt: (count: number) => `${count} to look at`,
      allFine: "all fine",
      notRead: "cannot read",
    },
  },
} as const;
