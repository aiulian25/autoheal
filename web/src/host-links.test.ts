import { describe, expect, it } from "vitest";
import type { TaskSummaryView } from "../../src/shared/api.js";
import { taskPlaceLink } from "./host-links.js";

const task = (overrides: Partial<TaskSummaryView>): TaskSummaryView => ({
  id: "t1",
  number: 1,
  title: "A task",
  status: "todo",
  priority: "medium",
  source: "detector",
  assignee: null,
  labels: [],
  hostId: "h1",
  hostLabel: "Alder",
  resource: null,
  parentId: null,
  occurrences: 1,
  checkedOut: false,
  advice: null,
  snoozedUntil: null,
  incidentId: null,
  createdAt: 1,
  updatedAt: 1,
  lastSeenAt: 1,
  closedAt: null,
  ...overrides,
});

describe("where a task is looked at on its host", () => {
  it.each([
    [
      "a container's problem or update: its row",
      { resource: { kind: "container", id: "quantum", label: "quantum" } },
      "/hosts/h1?container=quantum",
    ],
    [
      "a disk: the dials",
      { resource: { kind: "disk", id: "/mnt/storage", label: "/mnt/storage" }, labels: ["disk"] },
      "/hosts/h1#overview",
    ],
    [
      "the host's packages: its updates",
      { labels: ["packages"], resource: { kind: "host", id: "h1", label: "Alder" } },
      "/hosts/h1#updates",
    ],
    ["anything else on the host: the host", { labels: ["battery"] }, "/hosts/h1"],
  ] as const)("%s", (_case, overrides, expected) => {
    expect(taskPlaceLink(task(overrides as Partial<TaskSummaryView>))).toBe(expected);
  });

  it("has nowhere on a host for a task without one", () => {
    expect(taskPlaceLink(task({ hostId: null }))).toBeNull();
  });
});
