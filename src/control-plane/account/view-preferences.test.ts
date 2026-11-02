import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { currentCode, fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { TOTP_PERIOD_SECONDS } from "../../shared/constants.js";
import { VIEW_LIMITS, type BoardArrangement, type ViewPreferences } from "../../shared/view-preferences.js";
import { userViewPreferences } from "../database/schema.js";

const VIEW = { name: "Problems on Alder", search: "", problemsOnly: true, hostId: "host-1" };
const ARRANGED: BoardArrangement = { order: ["needsYou", "noticed", "autoheal", "done"], hidden: ["done"] };

describe("a person's own views and board", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  const stored = async (client = admin) =>
    (await client.get(API_ROUTES.accountViewPreferences)).json<ViewPreferences>();
  const save = (body: object = VIEW, client = admin) => client.post(API_ROUTES.accountSavedViews, body);
  const adminRow = () => plane.services.databaseHandle.database.select().from(userViewPreferences).get();
  const writeStored = (text: string) =>
    plane.services.databaseHandle.database.update(userViewPreferences).set({ preferencesJson: text }).run();

  beforeEach(async () => {
    plane = await startTestControlPlane();
    ({ client: admin } = await fullySignedInAdmin(plane));
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });

  it("is nothing at all until someone opts in", async () => {
    expect(await stored()).toEqual({ views: [], board: null });
    expect(adminRow()).toBeUndefined();
  });

  it("saves, updates by name, and removes a view", async () => {
    expect((await save()).statusCode).toBe(200);
    const [first] = (await stored()).views;
    expect(first).toMatchObject(VIEW);
    await save({ ...VIEW, search: "db" });
    const updated = (await stored()).views;
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ id: first!.id, search: "db" });

    const gone = await admin.delete(apiPath(API_ROUTES.accountSavedView, { viewId: first!.id }));
    expect(gone.statusCode).toBe(200);
    expect((await stored()).views).toEqual([]);
    expect((await admin.delete(apiPath(API_ROUTES.accountSavedView, { viewId: first!.id }))).statusCode).toBe(404);
  });

  it("survives signing out and back in", async () => {
    const operator = await fullySignedInUser(plane, admin, "operator", "viewer");
    await save(VIEW, operator.client);
    await operator.client.put(API_ROUTES.accountBoardArrangement, ARRANGED);
    await operator.client.post(API_ROUTES.logout);
    expect((await operator.client.get(API_ROUTES.accountViewPreferences)).statusCode).toBe(401);

    plane.clock.now += TOTP_PERIOD_SECONDS * 1000;
    await operator.client.signIn("operator", operator.password);
    await operator.client.post(API_ROUTES.secondFactor, { code: currentCode(operator.secret, plane.clock.now) });
    const after = await stored(operator.client);
    expect(after.views).toHaveLength(1);
    expect(after.board).toEqual(ARRANGED);
  });

  it("is private to its owner, whatever anyone else asks", async () => {
    await save();
    const viewer = await fullySignedInUser(plane, admin, "operator", "viewer");
    expect(await stored(viewer.client)).toEqual({ views: [], board: null });
    const [view] = (await stored()).views;
    expect((await viewer.client.delete(apiPath(API_ROUTES.accountSavedView, { viewId: view!.id }))).statusCode).toBe(
      404,
    );
    expect((await stored()).views).toHaveLength(1);
    await viewer.client.delete(API_ROUTES.accountBoardArrangement);
    expect((await stored()).views).toHaveLength(1);
  });

  it("lets a viewer keep their own, and that grants them nothing", async () => {
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    const viewer = await fullySignedInUser(plane, admin, "operator", "viewer");
    const hostId = enrolled.host.id;
    expect((await save({ ...VIEW, hostId }, viewer.client)).statusCode).toBe(200);
    const denied = await viewer.client.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "reboot" });
    expect(denied.statusCode).toBe(403);
    expect((await viewer.client.get(API_ROUTES.hosts)).statusCode).toBe(200);
  });

  it("refuses anything but the few settings allowed, and keeps to its bounds", async () => {
    expect((await save({ ...VIEW, grants: ["*"] })).statusCode).toBe(400);
    expect((await save({ ...VIEW, password: "secret" })).statusCode).toBe(400);
    expect((await save({ ...VIEW, name: "" })).statusCode).toBe(400);
    expect((await save({ ...VIEW, search: "x".repeat(VIEW_LIMITS.searchCharacters + 1) })).statusCode).toBe(400);
    expect((await admin.put(API_ROUTES.accountBoardArrangement, { ...ARRANGED, panels: [] })).statusCode).toBe(400);
    for (let index = 0; index < VIEW_LIMITS.views; index += 1) await save({ ...VIEW, name: `View ${index}` });
    expect((await save({ ...VIEW, name: "One too many" })).statusCode).toBe(409);
    // Updating one already there still works at the limit.
    expect((await save({ ...VIEW, name: "View 0", search: "db" })).statusCode).toBe(200);
  });

  it("refuses a board that leaves out a column, repeats one, or shows none", async () => {
    const put = (body: object) => admin.put(API_ROUTES.accountBoardArrangement, body);
    expect((await put({ order: ["noticed"], hidden: [] })).statusCode).toBe(400);
    expect((await put({ ...ARRANGED, order: ["noticed", "noticed", "autoheal", "done"] })).statusCode).toBe(400);
    expect((await put({ ...ARRANGED, order: [...ARRANGED.order.slice(0, 3), "secrets"] })).statusCode).toBe(400);
    expect((await put({ order: ARRANGED.order, hidden: ARRANGED.order })).statusCode).toBe(400);
  });

  it("resets the board without losing saved views", async () => {
    await save();
    expect((await admin.put(API_ROUTES.accountBoardArrangement, ARRANGED)).statusCode).toBe(200);
    expect((await stored()).board).toEqual(ARRANGED);
    expect((await admin.delete(API_ROUTES.accountBoardArrangement)).statusCode).toBe(200);
    const after = await stored();
    expect(after.board).toBeNull();
    expect(after.views).toHaveLength(1);
  });

  it("removing a view leaves the board as arranged", async () => {
    await save();
    await admin.put(API_ROUTES.accountBoardArrangement, ARRANGED);
    const [view] = (await stored()).views;
    await admin.delete(apiPath(API_ROUTES.accountSavedView, { viewId: view!.id }));
    expect((await stored()).board).toEqual(ARRANGED);
  });

  describe("what is stored from another version, or damaged", () => {
    beforeEach(async () => {
      await save();
    });

    it("keeps what it supports, and discards the rest", async () => {
      writeStored(
        JSON.stringify({
          version: 1,
          extra: "ignored",
          views: [{ ...VIEW, id: "a" }, { ...VIEW, id: "b", name: "" }, { id: "c", grants: ["*"] }, "nonsense"],
          board: { order: ["done", "retired", "noticed"], hidden: ["retired", "done"], panels: ["x"] },
        }),
      );
      const read = await stored();
      expect(read.views.map(({ id }) => id)).toEqual(["a"]);
      // A column it no longer has is gone; those it has that were not saved go last, as they come.
      expect(read.board).toEqual({ order: ["done", "noticed", "autoheal", "needsYou"], hidden: ["done"] });
    });

    it.each([
      ["not JSON", "{broken"],
      ["a version it does not know", JSON.stringify({ version: 2, views: [{ ...VIEW, id: "a" }] })],
      ["no record at all", "null"],
    ])("treats %s as nothing saved, and can save over it", async (_name, text) => {
      writeStored(text);
      expect(await stored()).toEqual({ views: [], board: null });
      expect((await save()).statusCode).toBe(200);
      expect((await stored()).views).toHaveLength(1);
    });

    it("goes with its owner", async () => {
      const { sqlite, database } = plane.services.databaseHandle;
      const { userId } = database.select().from(userViewPreferences).get()!;
      sqlite.pragma("foreign_keys = OFF");
      const references = sqlite.prepare("PRAGMA foreign_key_list(user_view_preferences)").all();
      sqlite.pragma("foreign_keys = ON");
      expect(references).toMatchObject([{ table: "users", on_delete: "CASCADE" }]);
      expect(
        database.select().from(userViewPreferences).where(eq(userViewPreferences.userId, userId)).get(),
      ).toBeDefined();
    });
  });
});
