import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("validates dashboard schemas without probing runtime code generation under the strict CSP", async () => {
  const denied = vi.fn(() => {
    throw new EvalError("Code generation is disabled by the dashboard CSP.");
  });
  vi.stubGlobal("Function", denied);
  await import("./schema-runtime.js");
  const { z } = await import("zod");
  const { rolloutCreateSchema } = await import("../../src/shared/rollouts.js");
  expect(z.config().jitless).toBe(true);
  expect(rolloutCreateSchema.safeParse({}).success).toBe(false);
  expect(z.object({ value: z.string() }).parse({ value: "synthetic fixture" })).toEqual({ value: "synthetic fixture" });
  expect(denied).not.toHaveBeenCalled();
});
