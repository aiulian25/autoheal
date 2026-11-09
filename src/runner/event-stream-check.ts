import {
  CONTAINER_STATE_DEAD,
  CONTAINER_STATE_EXITED,
  CONTAINER_STATE_RESTARTING,
  CONTAINER_STATE_RUNNING,
  EVENT_DIE,
  EVENT_HEALTHY,
  EVENT_START,
  EVENT_UNHEALTHY,
  HEALTH_UNHEALTHY,
} from "../shared/constants.js";
import { listedHealth, listingKey, nameOf } from "./container-inventory.js";
import type { ContainerSummary, DockerEvent } from "./docker-client.js";

// The states a die leaves a container in: stopped, or waiting for Docker to start it again.
const DOWN_STATES: ReadonlySet<string> = new Set([
  CONTAINER_STATE_EXITED,
  CONTAINER_STATE_DEAD,
  CONTAINER_STATE_RESTARTING,
]);

// What the stream last said of a container: whether it went down, and whether it is unhealthy.
interface Told {
  down: boolean;
  unhealthy: boolean;
}

// What these events say; any other leaves what was said before.
const TOLD_BY_EVENT: ReadonlyMap<string, Told> = new Map([
  [EVENT_DIE, { down: true, unhealthy: false }],
  [EVENT_START, { down: false, unhealthy: false }],
  [EVENT_UNHEALTHY, { down: false, unhealthy: true }],
  [EVENT_HEALTHY, { down: false, unhealthy: false }],
]);

/**
 * Docker writes nothing on its event stream while nothing happens, so a stream that stopped without closing looks
 * like a quiet one. The container listing tells them apart: a container down or unhealthy where the stream last said
 * otherwise, or said nothing at all since it was first listed otherwise, at two looks in a row. One per connection.
 */
export class EventStreamCheck {
  private readonly told = new Map<string, Told>();
  // Each container as first listed on this connection: one that was down then is no news.
  private readonly firstListed = new Map<string, string>();
  private untoldBefore = new Set<string>();

  /** What an event on the stream says of its container. */
  note(event: DockerEvent) {
    const name = event.Actor?.Attributes?.name;
    const told = TOLD_BY_EVENT.get(event.Action ?? "");
    if (name !== undefined && told !== undefined) this.told.set(name, told);
  }

  /** One look at the listing: a container the stream left untold at this look and the one before, else null. */
  missed(summaries: readonly ContainerSummary[]): string | null {
    const listed = new Set(summaries.map(nameOf));
    // One that went away comes back as new; one that came and went between looks is forgotten.
    for (const known of [this.firstListed, this.told]) {
      for (const name of [...known.keys()].filter((name) => !listed.has(name))) known.delete(name);
    }
    for (const summary of summaries) {
      if (!this.firstListed.has(nameOf(summary))) this.firstListed.set(nameOf(summary), listingKey(summary));
    }
    const untold = new Set(summaries.filter((summary) => this.isUntold(summary)).map(nameOf));
    const missed = [...untold].find((name) => this.untoldBefore.has(name)) ?? null;
    this.untoldBefore = untold;
    return missed;
  }

  private isUntold(summary: ContainerSummary): boolean {
    const down = DOWN_STATES.has(summary.State);
    const unhealthy = summary.State === CONTAINER_STATE_RUNNING && listedHealth(summary) === HEALTH_UNHEALTHY;
    if (!down && !unhealthy) return false;
    const told = this.told.get(nameOf(summary));
    if (told === undefined) return listingKey(summary) !== this.firstListed.get(nameOf(summary));
    return down ? !told.down : !told.unhealthy;
  }
}
