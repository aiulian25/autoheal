import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { addLegacyPeople } from "../../../test/support/legacy-people.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import { JOB_ACTION } from "../../shared/constants.js";
import { resourcePermissions, users } from "../database/schema.js";
import { keepOneOwner } from "./single-owner.js";

describe("what a person may do to a host's containers", () => {
  let plane: TestControlPlane;

  beforeEach(async () => {
    plane = await startTestControlPlane();
  });

  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });

  it("is everything for its owner, and nothing for anyone kept from signing in, a grant left over or not", async () => {
    const { client: owner } = await fullySignedInAdmin(plane);
    const hostId = (await owner.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>().host.id;
    const { databaseHandle: handle, auditLog, resourcePermissions: permissions } = plane.services;
    const ownerId = handle.database.select({ id: users.id }).from(users).get()!.id;
    const rowan = (await addLegacyPeople(handle, [{ username: "rowan" }])).get("rowan")!;
    const everything = [
      { hostId, scope: "host", resource: null, actions: ["lifecycle", "update", "logs", "terminal", "files"] },
    ];
    handle.database
      .insert(resourcePermissions)
      .values({ userId: rowan, revision: 1, grantsJson: JSON.stringify(everything) })
      .run();
    const members = [{ name: "paperless", composeProject: null }];

    expect(permissions.isAdmin(ownerId)).toBe(true);
    expect(() => permissions.requireJob(ownerId, hostId, "paperless", JOB_ACTION.restart)).not.toThrow();
    expect(() => permissions.requireMembers(ownerId, hostId, "terminal", members)).not.toThrow();

    keepOneOwner(handle, auditLog);
    expect(() => permissions.isAdmin(rowan)).toThrow(API_ERRORS.resourceForbidden);
    expect(() => permissions.requireJob(rowan, hostId, "paperless", JOB_ACTION.restart)).toThrow(
      API_ERRORS.resourceForbidden,
    );
    expect(() => permissions.requireMembers(rowan, hostId, "terminal", members)).toThrow(API_ERRORS.resourceForbidden);
  });
});
