import { describe, expect, it } from "vitest";
import { MILLISECONDS_PER_DAY } from "../shared/constants.js";
import { recentPackageChanges } from "./apt-history.js";

// 22 October 2026, 09:00 in London (BST, an hour ahead of UTC).
const NOW = Date.UTC(2026, 9, 22, 8, 0, 0);
const LONDON = "Europe/Lisbon";

const HISTORY = `
Start-Date: 2026-10-12  10:00:00
Commandline: apt-get remove old-thing
Remove: old-thing:amd64 (1.0)
End-Date: 2026-10-12  10:00:05

Start-Date: 2026-10-20  21:14:02
Commandline: apt-get install curl jq
Requested-By: owner (1000)
Install: jq:amd64 (1.7.1-3build1), libjq1:amd64 (1.7.1-3build1, automatic)
Upgrade: curl:amd64 (8.5.0-2ubuntu10.4, 8.5.0-2ubuntu10.6)
End-Date: 2026-10-20  21:14:09

Start-Date: 2026-10-21  06:25:31
Commandline: /usr/bin/unattended-upgrade
Upgrade: libssl3t64:amd64 (3.0.13-0ubuntu3.4, 3.0.13-0ubuntu3.5), openssl:amd64 (3.0.13-0ubuntu3.4, 3.0.13-0ubuntu3.5)
End-Date: 2026-10-21  06:25:40

Start-Date: 2026-10-22  03:10:00
Commandline: apt-get -q -y install --only-upgrade docker-ce
Upgrade: docker-ce:amd64 (5:28.5.0-1~ubuntu.24.04~noble, 5:28.5.1-1~ubuntu.24.04~noble)
Purge: leftover:amd64 (2.0)
`;

describe("apt's history of what it changed", () => {
  it("lists the last week's runs, newest first, in the host's own time", () => {
    const changes = recentPackageChanges(HISTORY, LONDON, NOW);

    expect(changes.map(({ endedAt }) => new Date(endedAt).toISOString())).toEqual([
      // Interrupted, so its start is the best there is.
      "2026-10-22T02:10:00.000Z",
      "2026-10-21T05:25:40.000Z",
      "2026-10-20T20:14:09.000Z",
    ]);
  });

  it("says what each run upgraded, installed and removed, by name and new version", () => {
    const [docker, security, manual] = recentPackageChanges(HISTORY, LONDON, NOW);

    expect(security).toEqual({
      endedAt: Date.UTC(2026, 9, 21, 5, 25, 40),
      byUnattendedUpgrades: true,
      upgraded: [
        { name: "libssl3t64", version: "3.0.13-0ubuntu3.5" },
        { name: "openssl", version: "3.0.13-0ubuntu3.5" },
      ],
      upgradedCount: 2,
      installed: [],
      removed: [],
    });
    expect(manual).toMatchObject({
      byUnattendedUpgrades: false,
      upgraded: [{ name: "curl", version: "8.5.0-2ubuntu10.6" }],
      installed: ["jq", "libjq1"],
    });
    expect(docker).toMatchObject({
      upgraded: [{ name: "docker-ce", version: "5:28.5.1-1~ubuntu.24.04~noble" }],
      removed: ["leftover"],
    });
  });

  it("keeps a long run's list short but its count whole", () => {
    const many = Array.from({ length: 80 }, (_, index) => `package-${index}:amd64 (1.0, 1.1)`).join(", ");
    const history = `Start-Date: 2026-10-22  02:00:00\nUpgrade: ${many}\nEnd-Date: 2026-10-22  02:05:00\n`;

    const [change] = recentPackageChanges(history, LONDON, NOW);

    expect(change?.upgraded).toHaveLength(50);
    expect(change?.upgradedCount).toBe(80);
  });

  it("skips what isn't an entry, and names that aren't package names", () => {
    const history = `garbage\n\nStart-Date: someday\n\nStart-Date: 2026-10-22  02:00:00\nUpgrade: $(reboot) (1, 2), ok (1, 2)\n`;

    expect(recentPackageChanges(history, LONDON, NOW)).toEqual([
      expect.objectContaining({ upgraded: [{ name: "ok", version: "2" }], upgradedCount: 1 }),
    ]);
    expect(recentPackageChanges("", LONDON, NOW)).toEqual([]);
  });

  it("keeps at most ten runs", () => {
    const runs = Array.from(
      { length: 12 },
      (_, index) =>
        `Start-Date: 2026-10-21  0${index % 10}:00:00\nUpgrade: run${index} (1, 2)\nEnd-Date: 2026-10-21  0${index % 10}:00:01`,
    ).join("\n\n");

    const changes = recentPackageChanges(runs, LONDON, NOW + MILLISECONDS_PER_DAY);

    expect(changes).toHaveLength(10);
  });
});
