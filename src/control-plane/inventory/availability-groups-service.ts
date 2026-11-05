import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import {
  availabilityProblem,
  domainsOf,
  MEMBER_EVIDENCE,
  type AvailabilityGroupBody,
  type AvailabilityGroupView,
  type GroupMember,
  type MemberStanding,
} from "../../shared/availability-groups.js";
import { AUDIT_ACTIONS, AVAILABILITY_GROUPS, AVAILABILITY_TEXT, TARGET_HOST } from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { availabilityGroupMembers, availabilityGroups } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

const MILLISECONDS_PER_SECOND = 1000;

/** One replica of an application, as the fleet sees it now. */
export interface ReplicaFacts {
  /** The host's label; null when it is no longer part of the fleet. */
  hostLabel: string | null;
  /** When that host last reported; null when it never has. */
  reportedAt: number | null;
  /** Whether the container is there and running; null when the host has not said. */
  running: boolean | null;
}

/** What one operation would take down, whether it is being asked for now or is already under way. */
export interface AffectedReplicas {
  hostIds?: readonly string[];
  containers?: readonly { hostId: string; containerName: string }[];
}

export interface AvailabilityDependencies {
  databaseHandle: DatabaseHandle;
  auditLog: AuditLog;
  /** What the fleet sees of one replica. */
  replica: (hostId: string, containerName: string) => ReplicaFacts;
  /** Why a check does not show a replica serving; null when it does. Fresh evidence only, since the moment given. */
  probeProblem: (probeId: string, since: number) => string | null;
  /** What every operation already under way takes down: open reboot plans and rollouts alike. */
  underWay: () => readonly AffectedReplicas[];
  clock: () => number;
}

const affects = (affected: AffectedReplicas, member: GroupMember) => {
  if ((affected.hostIds ?? []).includes(member.hostId)) return true;
  return (affected.containers ?? []).some(
    (container) => container.hostId === member.hostId && container.containerName === member.containerName,
  );
};

/**
 * Named groups of an application's replicas, and the guard they put on fleet operations: a reboot or a rollout that
 * would leave fewer failure domains serving than the group asks for is refused, and so is one that would do it
 * together with an operation already under way.
 *
 * What is already under way is read from the operations themselves, not held in a reservation of its own, so a
 * restart loses nothing and a plan that ends — finished, cancelled or rolled back — releases its hold by being over.
 */
export class AvailabilityGroupsService {
  constructor(private readonly dependencies: AvailabilityDependencies) {}

  private get database() {
    return this.dependencies.databaseHandle.database;
  }

  /** Every group with what the fleet sees of each replica now, and what would remain after what is under way. */
  views(asking: AffectedReplicas = {}): AvailabilityGroupView[] {
    const underWay = this.dependencies.underWay();
    return this.rows().map((group) => {
      const members = this.membersOf(group.id);
      const standings = members.map((member) =>
        this.standingOf(member, group.evidenceFreshSeconds, [asking, ...underWay]),
      );
      const available = standings.filter(({ evidence }) => evidence === MEMBER_EVIDENCE.available);
      return {
        id: group.id,
        name: group.name,
        minimumAvailable: group.minimumAvailable,
        evidenceFreshSeconds: group.evidenceFreshSeconds,
        members,
        createdBy: group.createdBy,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        revision: revisionOf(members),
        standings,
        availableDomains: domainsOf(available).size,
        remainingDomains: domainsOf(available.filter(({ goingDown }) => !goingDown)).size,
      };
    });
  }

  /**
   * Why an operation may not go ahead: the first group it would leave short. Asked at review and again immediately
   * before the operation, so a membership or a health change between the two is caught.
   */
  problemFor(asking: AffectedReplicas): string | null {
    for (const group of this.views(asking)) {
      const touched = group.standings.some(({ goingDown }) => goingDown);
      if (!touched) continue;
      const problem = availabilityProblem(group);
      if (problem !== null) return problem;
    }
    return null;
  }

  /** What a review saw, so a changed membership invalidates it rather than quietly widening what was approved. */
  revisions(): Record<string, string> {
    return Object.fromEntries(this.rows().map((group) => [group.id, revisionOf(this.membersOf(group.id))]));
  }

  add(actor: Actor, body: AvailabilityGroupBody): { id: string } {
    if (this.rows().length >= AVAILABILITY_GROUPS.groupsLimit) throw new DomainError(API_ERRORS.availabilityGroupsFull);
    if (this.rows().some(({ name }) => name === body.name)) throw new DomainError(API_ERRORS.availabilityNameTaken);
    this.requireKnownHosts(body.members);
    const now = this.dependencies.clock();
    const id = randomUUID();
    this.database.transaction(() => {
      this.database
        .insert(availabilityGroups)
        .values({
          id,
          name: body.name,
          minimumAvailable: body.minimumAvailable,
          evidenceFreshSeconds: body.evidenceFreshSeconds,
          createdBy: actor.username,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      this.writeMembers(id, body.members);
    });
    this.record(actor, AUDIT_ACTIONS.availabilityGroupSaved, id, body);
    return { id };
  }

  /** A group's membership or its minimum, changed as one: whatever was reviewed against the old one is invalid. */
  change(actor: Actor, groupId: string, body: AvailabilityGroupBody) {
    const group = this.require(groupId);
    if (this.rows().some((row) => row.name === body.name && row.id !== group.id)) {
      throw new DomainError(API_ERRORS.availabilityNameTaken);
    }
    this.requireKnownHosts(body.members);
    this.database.transaction(() => {
      this.database
        .update(availabilityGroups)
        .set({
          name: body.name,
          minimumAvailable: body.minimumAvailable,
          evidenceFreshSeconds: body.evidenceFreshSeconds,
          updatedAt: this.dependencies.clock(),
        })
        .where(eq(availabilityGroups.id, groupId))
        .run();
      this.database.delete(availabilityGroupMembers).where(eq(availabilityGroupMembers.groupId, groupId)).run();
      this.writeMembers(groupId, body.members);
    });
    this.record(actor, AUDIT_ACTIONS.availabilityGroupSaved, groupId, body);
  }

  remove(actor: Actor, groupId: string) {
    const group = this.require(groupId);
    this.database.transaction(() => {
      this.database.delete(availabilityGroupMembers).where(eq(availabilityGroupMembers.groupId, groupId)).run();
      this.database.delete(availabilityGroups).where(eq(availabilityGroups.id, groupId)).run();
    });
    this.dependencies.auditLog.recordUserAction(actor, AUDIT_ACTIONS.availabilityGroupRemoved, targetOf(groupId), {
      name: group.name,
    });
  }

  /** What the fleet sees of one replica: available, not available, or not known, with why. */
  private standingOf(member: GroupMember, freshSeconds: number, affected: readonly AffectedReplicas[]): MemberStanding {
    const goingDown = affected.some((one) => affects(one, member));
    const standing = (evidence: MemberStanding["evidence"], problem: string | null) => ({
      ...member,
      evidence,
      problem,
      goingDown,
    });
    const facts = this.dependencies.replica(member.hostId, member.containerName);
    if (facts.hostLabel === null) return standing(MEMBER_EVIDENCE.unavailable, AVAILABILITY_TEXT.hostGone);
    const since = this.dependencies.clock() - freshSeconds * MILLISECONDS_PER_SECOND;
    if (facts.reportedAt === null || facts.reportedAt < since) {
      return standing(MEMBER_EVIDENCE.unknown, AVAILABILITY_TEXT.hostQuiet(facts.hostLabel));
    }
    if (member.probeId !== null) {
      const problem = this.dependencies.probeProblem(member.probeId, since);
      return problem === null ? standing(MEMBER_EVIDENCE.available, null) : standing(MEMBER_EVIDENCE.unknown, problem);
    }
    if (facts.running === null)
      return standing(MEMBER_EVIDENCE.unknown, AVAILABILITY_TEXT.notThere(member.containerName));
    return facts.running
      ? standing(MEMBER_EVIDENCE.available, null)
      : standing(MEMBER_EVIDENCE.unavailable, AVAILABILITY_TEXT.notRunning(member.containerName));
  }

  private rows() {
    return this.database.select().from(availabilityGroups).orderBy(availabilityGroups.name).all();
  }

  private membersOf(groupId: string): GroupMember[] {
    return this.database
      .select()
      .from(availabilityGroupMembers)
      .where(eq(availabilityGroupMembers.groupId, groupId))
      .orderBy(availabilityGroupMembers.containerName)
      .all()
      .map(({ hostId, containerName, failureDomain, probeId }) => ({
        hostId,
        containerName,
        failureDomain,
        probeId,
      }));
  }

  private writeMembers(groupId: string, members: readonly GroupMember[]) {
    for (const member of members) {
      this.database
        .insert(availabilityGroupMembers)
        .values({ groupId, ...member })
        .run();
    }
  }

  private require(groupId: string) {
    const group = this.database.select().from(availabilityGroups).where(eq(availabilityGroups.id, groupId)).get();
    if (group === undefined) throw new DomainError(API_ERRORS.availabilityGroupNotFound);
    return group;
  }

  private requireKnownHosts(members: readonly GroupMember[]) {
    const hostIds = [...new Set(members.map(({ hostId }) => hostId))];
    const known = hostIds.filter((hostId) => this.dependencies.replica(hostId, "").hostLabel !== null);
    if (known.length !== hostIds.length) throw new DomainError(API_ERRORS.hostNotFound);
  }

  private record(
    actor: Actor,
    action: typeof AUDIT_ACTIONS.availabilityGroupSaved,
    id: string,
    body: AvailabilityGroupBody,
  ) {
    this.dependencies.auditLog.recordUserAction(actor, action, targetOf(id), {
      name: body.name,
      minimumAvailable: body.minimumAvailable,
      members: body.members.length,
      domains: domainsOf(body.members).size,
    });
  }
}

const targetOf = (id: string) => ({ kind: TARGET_HOST, id }) as const;

/** What the membership is, as one value: a changed one makes a review of it stale. */
const revisionOf = (members: readonly GroupMember[]) =>
  createHash("sha256").update(JSON.stringify(members)).digest("base64url").slice(0, 16);

export const availabilityGroupIdsOn = (database: DatabaseHandle["database"], hostIds: readonly string[]) =>
  hostIds.length === 0
    ? []
    : database
        .select({ groupId: availabilityGroupMembers.groupId })
        .from(availabilityGroupMembers)
        .where(inArray(availabilityGroupMembers.hostId, [...hostIds]))
        .all()
        .map(({ groupId }) => groupId);
