import { describe, expect, it } from "vitest";
import { containerSnapshot, heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import { SELF_UPDATE } from "../../shared/constants.js";
import { changesBetween } from "./host-changes.js";

const FIRST_BOOT = "11111111-1111-4111-8111-111111111111";
const SECOND_BOOT = "22222222-2222-4222-8222-222222222222";

describe("what changed between two reports", () => {
  it("never counts Autoheal's own update helper, which older runners report and newer ones leave out", () => {
    const helper = containerSnapshot({ name: SELF_UPDATE.helperName });
    const host = containerSnapshot({ name: "tika" });
    const reported = (containers: ReturnType<typeof containerSnapshot>[]) => ({ containers, health: null });

    expect(changesBetween(reported([host, helper]), heartbeatWith({ containers: [host], host: null }))).toEqual([]);
    expect(changesBetween(reported([host]), heartbeatWith({ containers: [host, helper], host: null }))).toEqual([]);
  });

  it("names each container that appeared, went, was recreated with its image, stopped or started, and the host's own", () => {
    const previous = {
      containers: [
        containerSnapshot({ name: "paperless-db", containerId: "aaaaaaaaaaaa", image: "postgres:16" }),
        containerSnapshot({ name: "tika" }),
        containerSnapshot({ name: "old-wiki" }),
        containerSnapshot({ name: "backup", state: "exited", exitCode: 0 }),
      ],
      health: hostHealth({ bootId: FIRST_BOOT, dockerVersion: "29.0.0", kernel: "6.8.0-85-generic" }),
    };
    const next = heartbeatWith({
      containers: [
        containerSnapshot({ name: "paperless-db", containerId: "bbbbbbbbbbbb", image: "postgres:17" }),
        containerSnapshot({ name: "tika", state: "exited", exitCode: 137, oomKilled: true }),
        containerSnapshot({ name: "backup" }),
        containerSnapshot({ name: "immich", image: "immich:2" }),
      ],
      host: hostHealth({ bootId: SECOND_BOOT, dockerVersion: "29.1.0", kernel: "6.8.0-86-generic" }),
    });
    expect(changesBetween(previous, next)).toEqual([
      { kind: "rebooted", containerName: null, details: {} },
      { kind: "docker_upgraded", containerName: null, details: { before: "29.0.0", after: "29.1.0" } },
      {
        kind: "kernel_changed",
        containerName: null,
        details: { before: "6.8.0-85-generic", after: "6.8.0-86-generic" },
      },
      { kind: "appeared", containerName: "immich", details: { image: "immich:2" } },
      { kind: "removed", containerName: "old-wiki", details: { image: "ghcr.io/paperless-ngx/paperless-ngx:2.13" } },
      {
        kind: "recreated",
        containerName: "paperless-db",
        details: { imageBefore: "postgres:16", imageAfter: "postgres:17" },
      },
      { kind: "stopped", containerName: "tika", details: { exitCode: 137, oomKilled: true } },
      { kind: "started", containerName: "backup", details: {} },
    ]);
  });

  it("counts Docker's own restarts, and says nothing of what stayed as it was", () => {
    const previous = { containers: [containerSnapshot({ restartCount: 2 })], health: hostHealth() };
    expect(changesBetween(previous, heartbeatWith({ containers: [containerSnapshot({ restartCount: 5 })] }))).toEqual([
      { kind: "restarted", containerName: "paperless", details: { times: 3 } },
    ]);
    expect(changesBetween(previous, heartbeatWith({ containers: [containerSnapshot({ restartCount: 2 })] }))).toEqual(
      [],
    );
  });

  it("leaves the host out when either report could not read it, or did not say", () => {
    const previous = { containers: [], health: hostHealth({ bootId: FIRST_BOOT, kernel: "6.8.0-85-generic" }) };
    expect(changesBetween(previous, heartbeatWith({ containers: [], host: null }))).toEqual([]);
    expect(changesBetween({ ...previous, health: null }, heartbeatWith({ containers: [] }))).toEqual([]);
    // An older runner sends no boot id: no reboot is made up from it.
    expect(
      changesBetween(previous, heartbeatWith({ containers: [], host: hostHealth({ bootId: undefined }) })),
    ).toEqual([]);
  });
});
