import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEXT } from "../constants.js";
import {
  host,
  hostHealthWithout,
  packageView,
  client,
  answers,
  show,
  resetHostPage,
} from "../test-support/host-page.js";

afterEach(resetHostPage);

it("says how the machine Autoheal runs on is looked after, why it waits, and offers no switch to SSH", async () => {
  answers.localHostId = "h0";
  const waiting = "its Autoheal runner container still runs here: remove it";
  show(packageView, undefined, { ...host, kind: "local", inPlace: { problem: waiting } });
  expect(await screen.findByText(waiting, { selector: "p.notice" })).toBeTruthy();
  // Not even asked which machine Autoheal runs on: a host looked after in place is never a runner host.
  expect(screen.queryByText(TEXT.ssh.add.switchTitle)).toBeNull();
});

it("says its containers are shown as they were while its Docker cannot list them, and nothing once it can", async () => {
  show(packageView, undefined, { ...host, containersStaleSince: Date.now() - 5 * 60 * 1000 });
  const notice = await screen.findByText(TEXT.hosts.containersStale, { exact: false, selector: "p.notice" });
  expect(notice.textContent).toContain("5 minutes ago");
  cleanup();

  show(packageView, undefined, { ...host, containersStaleSince: null });
  await screen.findByRole("heading", { level: 1, name: host.label });
  expect(screen.queryByText(TEXT.hosts.containersStale, { exact: false })).toBeNull();
});

it("names what a report too large to send whole left out, shown as last reported", async () => {
  show(packageView, undefined, { ...host, reportTrimmed: ["networks", "host"] });
  expect(
    await screen.findByText(
      "This host's report is too large to send whole, so for its networks and its system facts you see what it reported last.",
    ),
  ).toBeTruthy();
});

describe("the almost-full disks banner", () => {
  const BYTES = 1_000_000_000;
  const diskAt = (path: string, used: number) => ({
    path,
    totalBytes: 100 * BYTES,
    usedBytes: used * BYTES,
    availableBytes: (100 - used) * BYTES,
  });
  const fullHost = {
    ...host,
    health: { ...hostHealthWithout, disks: [diskAt("/mnt/storage", 99), diskAt("/mnt/fast", 96)] },
  };
  const taskOn = (path: string, snoozedUntil: number | null = null) => ({
    id: `task-${path.split("/").at(-1)}`,
    title: `${path} is full`,
    priority: "high",
    labels: ["disk"],
    updatedAt: 1,
    snoozedUntil,
    resource: { kind: "disk", id: path, label: path },
  });
  beforeEach(() => {
    answers.taskChanges = [];
  });
  afterEach(() => {
    answers.openTasks = [];
  });

  it("snoozes every disk it names at one press", async () => {
    answers.openTasks = [taskOn("/mnt/storage"), taskOn("/mnt/fast")];
    show(undefined, undefined, fullHost);

    fireEvent.click(await screen.findByRole("button", { name: "Snooze 3 months" }));

    await waitFor(() => expect(answers.taskChanges).toHaveLength(2));
    expect(answers.taskChanges).toEqual(
      expect.arrayContaining([
        ["task-storage", '{"snoozed":"3_months"}'],
        ["task-fast", '{"snoozed":"3_months"}'],
      ]),
    );
  });

  it("leaves out a snoozed disk, and goes once all are", async () => {
    const later = Date.now() + 1_000_000;
    answers.openTasks = [taskOn("/mnt/storage", later), taskOn("/mnt/fast")];
    show(undefined, undefined, fullHost);
    const banner = (await screen.findByRole("button", { name: "Snooze 1 month" })).closest(".banner")!;
    expect(banner.textContent).toContain("/mnt/fast");
    expect(banner.textContent).not.toContain("/mnt/storage");
    cleanup();

    answers.openTasks = [taskOn("/mnt/storage", later), taskOn("/mnt/fast", later)];
    show(undefined, undefined, fullHost);
    await waitFor(() => expect(client.getQueryData(["tasks", "host", host.id])).toHaveLength(2));
    await waitFor(() => expect(document.querySelector(".banner.danger")).toBeNull());
  });

  it("offers no snooze before its disks have tasks, and still warns", async () => {
    show(undefined, undefined, fullHost);
    await waitFor(() => expect(client.getQueryData(["tasks", "host", host.id])).toEqual([]));
    expect(document.querySelector(".banner.danger")?.textContent).toContain("/mnt/storage");
    expect(screen.queryByRole("button", { name: "Snooze 1 month" })).toBeNull();
  });
});
