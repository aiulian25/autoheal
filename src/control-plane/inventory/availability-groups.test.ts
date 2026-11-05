import { describe, expect, it } from "vitest";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "../database/connection.js";
import { IN_MEMORY_DATABASE } from "../../shared/constants.js";
import type { Actor } from "../audit/audit-log.js";
import {
  MEMBER_EVIDENCE,
  availabilityGroupBodySchema,
  availabilityProblem,
  domainsOf,
  type AvailabilityGroupBody,
  type MemberStanding,
} from "../../shared/availability-groups.js";
import { hosts } from "../database/schema.js";
import { AvailabilityGroupsService, type AffectedReplicas, type ReplicaFacts } from "./availability-groups-service.js";

const ACTOR: Actor = { userId: "u1", username: "admin", ip: "127.0.0.1", requestId: "r1" };
const HOST = { alder: "6f1c9a1e-0000-4000-8000-000000000001", birch: "6f1c9a1e-0000-4000-8000-000000000002" };
const NOW = Date.UTC(2026, 10, 5, 12);

const replicaOn = (hostId: string, containerName: string, failureDomain: string | null = null) => ({
  hostId,
  containerName,
  failureDomain,
  probeId: null,
});
const bodyWith = (change: Partial<AvailabilityGroupBody> = {}): AvailabilityGroupBody => ({
  name: "Wiki",
  minimumAvailable: 1,
  evidenceFreshSeconds: 300,
  members: [replicaOn(HOST.alder, "wiki"), replicaOn(HOST.birch, "wiki")],
  ...change,
});

/** A fleet with two hosts, each running one replica, both reporting just now. */
function fleet() {
  const databaseHandle = new DatabaseHandle(IN_MEMORY_DATABASE);
  const lines: string[] = [];
  const auditLog = new AuditLog(databaseHandle, (line) => lines.push(line));
  for (const [label, id] of Object.entries(HOST)) {
    databaseHandle.database
      .insert(hosts)
      .values({ id, label, tokenHash: `${label}-hash`, tokenHint: label.slice(0, 4), enrolledAt: NOW })
      .run();
  }
  const facts = new Map<string, ReplicaFacts>([
    [`${HOST.alder}/wiki`, { hostLabel: "alder", reportedAt: NOW, running: true }],
    [`${HOST.birch}/wiki`, { hostLabel: "birch", reportedAt: NOW, running: true }],
  ]);
  const hostFacts = (hostId: string): ReplicaFacts => ({
    hostLabel: Object.values(HOST).includes(hostId) ? "known" : null,
    reportedAt: NOW,
    running: null,
  });
  let underWay: AffectedReplicas[] = [];
  let probeProblem: (probeId: string, since: number) => string | null = () => null;
  const service = new AvailabilityGroupsService({
    databaseHandle,
    auditLog,
    replica: (hostId, containerName) =>
      containerName === "" ? hostFacts(hostId) : (facts.get(`${hostId}/${containerName}`) ?? hostFacts(hostId)),
    probeProblem: (probeId, since) => probeProblem(probeId, since),
    underWay: () => underWay,
    clock: () => NOW,
  });
  return {
    service,
    facts,
    audit: () => lines.join("\n"),
    setUnderWay: (affected: AffectedReplicas[]) => {
      underWay = affected;
    },
    setProbeProblem: (answer: (probeId: string, since: number) => string | null) => {
      probeProblem = answer;
    },
  };
}

describe("what a group asks of the fleet", () => {
  const standing = (change: Partial<MemberStanding> = {}): MemberStanding => ({
    ...replicaOn(HOST.alder, "wiki"),
    evidence: MEMBER_EVIDENCE.available,
    problem: null,
    goingDown: false,
    ...change,
  });

  it("counts a domain once, however many replicas it holds", () => {
    const members = [
      replicaOn(HOST.alder, "wiki", "rack-a"),
      replicaOn(HOST.alder, "wiki-two", "rack-a"),
      replicaOn(HOST.birch, "wiki", "rack-b"),
    ];
    expect(domainsOf(members).size).toBe(2);
  });

  it("gives a replica with no domain of its own one all to itself", () => {
    expect(domainsOf([replicaOn(HOST.alder, "wiki"), replicaOn(HOST.birch, "wiki")]).size).toBe(2);
  });

  it("refuses when what would remain is below the minimum, and says the numbers", () => {
    const problem = availabilityProblem({
      name: "Wiki",
      minimumAvailable: 2,
      standings: [standing({ goingDown: true }), standing({ hostId: HOST.birch })],
    });
    expect(problem).toContain("Wiki would be left with 1 of the 2 it needs serving.");
  });

  it("never counts a replica nothing shows as serving, and says how many those are", () => {
    const problem = availabilityProblem({
      name: "Wiki",
      minimumAvailable: 2,
      standings: [standing(), standing({ hostId: HOST.birch, evidence: MEMBER_EVIDENCE.unknown })],
    });
    expect(problem).toContain("Nothing shows whether 1 replica is serving");
  });

  it("will not take a minimum no membership could ever meet", () => {
    expect(availabilityGroupBodySchema.safeParse(bodyWith({ minimumAvailable: 3 })).success).toBe(false);
    expect(availabilityGroupBodySchema.safeParse(bodyWith({ minimumAvailable: 2 })).success).toBe(true);
  });

  it("will not take the same replica twice, nor a group of none", () => {
    const twice = bodyWith({ members: [replicaOn(HOST.alder, "wiki"), replicaOn(HOST.alder, "wiki")] });
    expect(availabilityGroupBodySchema.safeParse(twice).success).toBe(false);
    expect(availabilityGroupBodySchema.safeParse(bodyWith({ members: [] })).success).toBe(false);
  });
});

describe("a group guarding what the fleet is asked to do", () => {
  it("lets one host go down while the other replica serves, and refuses the last one", () => {
    const { service } = fleet();
    service.add(ACTOR, bodyWith());

    expect(service.problemFor({ hostIds: [HOST.alder] })).toBeNull();
    expect(service.problemFor({ hostIds: [HOST.alder, HOST.birch] })).toContain("would be left with 0");
  });

  it("will not let two operations together take the last replica", () => {
    const { service, setUnderWay } = fleet();
    service.add(ACTOR, bodyWith());
    // One plan is already taking Birch down.
    setUnderWay([{ hostIds: [HOST.birch] }]);

    const problem = service.problemFor({ hostIds: [HOST.alder] });

    expect(problem).toContain("would be left with 0 of the 1 it needs serving");
  });

  it("counts a rollout under way as taking its container down", () => {
    const { service, setUnderWay } = fleet();
    service.add(ACTOR, bodyWith());
    setUnderWay([{ containers: [{ hostId: HOST.birch, containerName: "wiki" }] }]);

    expect(service.problemFor({ containers: [{ hostId: HOST.alder, containerName: "wiki" }] })).toContain(
      "would be left with 0",
    );
  });

  it("lets an unrelated group go on its own way", () => {
    const { service } = fleet();
    service.add(ACTOR, bodyWith({ name: "Wiki", members: [replicaOn(HOST.alder, "wiki")] }));
    service.add(ACTOR, bodyWith({ name: "Files", members: [replicaOn(HOST.birch, "files")] }));

    // Nothing of the Files group is touched by taking Birch's wiki down, and nothing of Wiki by Alder's files.
    expect(service.problemFor({ containers: [{ hostId: HOST.birch, containerName: "files" }] })).toContain("Files");
    expect(service.problemFor({ containers: [{ hostId: HOST.alder, containerName: "nothing-of-ours" }] })).toBeNull();
  });

  it("blocks a required gate when a host has not reported recently enough", () => {
    const { service, facts } = fleet();
    service.add(ACTOR, bodyWith());
    facts.set(`${HOST.birch}/wiki`, { hostLabel: "birch", reportedAt: NOW - 600_000, running: true });

    const problem = service.problemFor({ hostIds: [HOST.alder] });

    expect(problem).toContain("would be left with 0");
    expect(problem).toContain("Nothing shows whether 1 replica is serving");
  });

  it("blocks a required gate when the check a replica names is stale or down", () => {
    const { service, setProbeProblem } = fleet();
    service.add(ACTOR, {
      ...bodyWith(),
      members: [
        { ...replicaOn(HOST.alder, "wiki"), probeId: "6f1c9a1e-0000-4000-8000-00000000000a" },
        { ...replicaOn(HOST.birch, "wiki"), probeId: "6f1c9a1e-0000-4000-8000-00000000000b" },
      ],
    });
    setProbeProblem((probeId) => (probeId.endsWith("b") ? "Wiki has not been checked recently." : null));

    expect(service.problemFor({ hostIds: [HOST.alder] })).toContain("would be left with 0");
    // The check's own words are what a person is shown.
    const standings = service.views().flatMap(({ standings: each }) => each);
    expect(standings.find(({ hostId }) => hostId === HOST.birch)?.problem).toBe("Wiki has not been checked recently.");
  });

  it("counts a replica whose container is stopped as not serving, apart from one nothing shows", () => {
    const { service, facts } = fleet();
    service.add(ACTOR, bodyWith());
    facts.set(`${HOST.birch}/wiki`, { hostLabel: "birch", reportedAt: NOW, running: false });

    const standings = service.views().flatMap(({ standings: each }) => each);
    expect(standings.find(({ hostId }) => hostId === HOST.birch)).toMatchObject({
      evidence: MEMBER_EVIDENCE.unavailable,
      problem: "wiki is not running.",
    });
  });

  it("changes its revision when the membership changes, so a review of it is stale", () => {
    const { service } = fleet();
    const { id } = service.add(ACTOR, bodyWith());
    const before = service.revisions()[id];

    service.change(
      ACTOR,
      id,
      bodyWith({ members: [replicaOn(HOST.alder, "wiki"), replicaOn(HOST.birch, "wiki-two")] }),
    );

    expect(service.revisions()[id]).not.toBe(before);
  });

  it("refuses a second group by the same name, and a member on a host it does not know", () => {
    const { service } = fleet();
    service.add(ACTOR, bodyWith());

    expect(() => service.add(ACTOR, bodyWith())).toThrow(/availability_name_taken/);
    expect(() =>
      service.add(
        ACTOR,
        bodyWith({ name: "Other", members: [replicaOn("6f1c9a1e-0000-4000-8000-0000000000ff", "x")] }),
      ),
    ).toThrow(/host_not_found/);
  });

  it("records what was saved and what was removed, with the numbers and no fleet detail", () => {
    const { service, audit } = fleet();
    const { id } = service.add(ACTOR, bodyWith());
    service.remove(ACTOR, id);

    expect(audit()).toContain("availability.group_saved");
    expect(audit()).toContain("availability.group_removed");
    expect(service.views()).toEqual([]);
  });
});
