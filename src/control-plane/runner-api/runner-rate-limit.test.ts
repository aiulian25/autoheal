import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerTokenOf, startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import { HTTP_STATUS, RUNNER_RATE_LIMIT_PER_MINUTE } from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";

describe("the runner API's rate limit", () => {
  let controlPlane: TestControlPlane;
  let tokens: string[];

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    const admin = (await fullySignedInAdmin(controlPlane)).client;
    tokens = [];
    for (const label of ["rowan", "cedar2"]) {
      tokens.push(runnerTokenOf((await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>()));
    }
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  // Every request from loopback, as the runners inside the control plane make them.
  const ask = async (token: string) =>
    (
      await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode;
  const askMany = async (token: string, count: number) => {
    const statuses = [];
    for (let request = 0; request < count; request += 1) statuses.push(await ask(token));
    return statuses;
  };

  it("gives each runner its own allowance, though they share an address", async () => {
    const [rowan, cedar2] = tokens as [string, string];
    expect(await askMany(rowan, RUNNER_RATE_LIMIT_PER_MINUTE)).not.toContain(HTTP_STATUS.tooManyRequests);
    expect(await ask(cedar2)).toBe(HTTP_STATUS.ok);
    expect(await ask(rowan)).toBe(HTTP_STATUS.tooManyRequests);
  });
});
