import Fastify from "fastify";
import { expect, it } from "vitest";
import { RestoreCoordinator } from "../database/restore-coordinator.js";
import { registerErrorHandling } from "./errors.js";
import { registerRestoreMaintenance } from "./restore-maintenance.js";

it("drains an admitted HTTP handler and rejects new requests during restore", async () => {
  const app = Fastify();
  const coordinator = new RestoreCoordinator();
  registerErrorHandling(app);
  registerRestoreMaintenance(app, coordinator);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldWrite = false;
  app.get("/slow", async () => {
    entered();
    await paused;
    oldWrite = true;
    return { ok: true };
  });
  app.get("/read", () => ({ ok: true }));
  const request = app.inject("/slow").then((response) => response);
  await started;
  let swapped = false;
  const restore = coordinator.exclusive(async () => {
    expect(oldWrite).toBe(true);
    swapped = true;
    coordinator.replaced();
  });
  expect((await app.inject("/read")).statusCode).toBe(503);
  expect(swapped).toBe(false);
  release();
  await request;
  await restore;
  expect((await app.inject("/read")).statusCode).toBe(200);
  await app.close();
});
