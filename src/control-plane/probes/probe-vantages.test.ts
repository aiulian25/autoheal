import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { decodeJoinCode } from "../../shared/join-code.js";
import { PROBE_LIMITS, PROBE_SCOPE, PROBE_STATE, type ProbeBody, type ProbeView } from "../../shared/probes.js";
import { RUNNER_ROUTES, type HeartbeatResponse, type ProbeReport } from "../../shared/protocol.js";
import { ServiceProbes } from "../../runner/service-probes.js";

const INTERVAL_SECONDS = 60;
const bodyWith = (change: Partial<ProbeBody> = {}): ProbeBody => ({
  name: "Wiki",
  scope: PROBE_SCOPE.localNetwork,
  vantage: null,
  intervalSeconds: INTERVAL_SECONDS,
  timeoutSeconds: 1,
  failuresBeforeDown: 1,
  objectivePercent: null,
  target: { kind: "tcp", host: "wiki.example.internal", port: 443 },
  ...change,
});

describe("checks made from a host rather than from Autoheal", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let hostIds: Record<string, string>;
  let tokens: Record<string, string>;

  const heartbeat = async (label: string, extra: Record<string, unknown> = {}) =>
    (
      await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: { ...heartbeatWith({ hostLabel: label }), serviceProbes: true, ...extra },
        headers: { authorization: `Bearer ${tokens[label]!}` },
      })
    ).json<HeartbeatResponse>();
  const probesOf = async (label: string) =>
    (await admin.get(apiPath(API_ROUTES.hostProbes, { hostId: hostIds[label]! }))).json<ProbeView[]>();
  const add = (label: string, body: ProbeBody) =>
    admin.post(apiPath(API_ROUTES.hostProbes, { hostId: hostIds[label]! }), body);
  const tick = () => controlPlane.services.probes.tick();

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    hostIds = {};
    tokens = {};
    for (const label of ["Alder", "Birch"]) {
      const enrolled = (await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>();
      tokens[label] = decodeJoinCode(enrolled.joinCode)!.token;
      await heartbeat(label);
    }
    const hosts = (await admin.get(API_ROUTES.hosts)).json<{ id: string; label: string }[]>();
    for (const host of hosts) hostIds[host.label] = host.id;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  it("gives a check to the host it is made from, and to no other", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));
    await tick();

    const alder = await heartbeat("Alder");
    const birch = await heartbeat("Birch");

    expect(alder.probes?.map(({ body }) => body.name)).toEqual(["Wiki"]);
    expect(alder.probes?.[0]!.generation).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(birch.probes).toBeUndefined();
  });

  it("keeps two hosts' observations of the same service apart", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder!, name: "Wiki from Alder" }));
    await add("Birch", bodyWith({ vantage: hostIds.Birch!, name: "Wiki from Birch" }));
    await tick();

    const fromAlder = (await heartbeat("Alder")).probes!;
    const fromBirch = (await heartbeat("Birch")).probes!;
    // One network reaches it; the other does not.
    await heartbeat("Alder", {
      probeResults: [{ ...fromAlder[0]!, ok: true, latencyMilliseconds: 12, problem: null }],
    });
    await heartbeat("Birch", {
      probeResults: [{ ...fromBirch[0]!, ok: false, latencyMilliseconds: null, problem: "No route to that network." }],
    });

    const alder = (await probesOf("Alder"))[0]!;
    const birch = (await probesOf("Birch"))[0]!;
    expect(alder).toMatchObject({ state: PROBE_STATE.up, lastLatencyMilliseconds: 12, lastProblem: null });
    expect(birch).toMatchObject({ state: PROBE_STATE.down, lastProblem: "No route to that network." });
  });

  it("leaves a check unknown when the host it is made from says nothing within the deadline", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));
    await tick();
    await heartbeat("Alder");
    expect((await probesOf("Alder"))[0]!.state).toBe(PROBE_STATE.unknown);

    controlPlane.clock.now += PROBE_LIMITS.vantageDeadlineSeconds * 1000 + INTERVAL_SECONDS * 1000;
    await tick();

    const probe = (await probesOf("Alder"))[0]!;
    expect(probe.state).toBe(PROBE_STATE.unknown);
    expect(probe.lastProblem).toContain("has not reported this check");
    // Nothing was assumed: no sample was kept either way.
    expect(probe.samples).toEqual([]);
  });

  it("says a runner that cannot make checks cannot, rather than calling the service down", async () => {
    const { services } = controlPlane;
    await add("Birch", bodyWith({ vantage: hostIds.Birch! }));
    // A runner from before this feature: its heartbeat says nothing about making checks.
    await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ hostLabel: "Birch" }),
      headers: { authorization: `Bearer ${tokens.Birch!}` },
    });
    await services.probes.tick();

    const probe = (await probesOf("Birch"))[0]!;
    expect(probe.state).toBe(PROBE_STATE.unknown);
    expect(probe.lastProblem).toContain("cannot make checks itself");
  });

  it("will not take a report for another host's check, nor for a version that has changed", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));
    await tick();
    const given = (await heartbeat("Alder")).probes![0]!;
    const answer = (report: Partial<ProbeReport>): ProbeReport => ({
      id: given.id,
      generation: given.generation,
      ok: true,
      latencyMilliseconds: 7,
      problem: null,
      ...report,
    });

    // Another host answering for it.
    await heartbeat("Birch", { probeResults: [answer({})] });
    expect((await probesOf("Alder"))[0]!.state).toBe(PROBE_STATE.unknown);

    // The right host, the wrong generation.
    await heartbeat("Alder", { probeResults: [answer({ generation: "0123456789abcdef" })] });
    expect((await probesOf("Alder"))[0]!.state).toBe(PROBE_STATE.unknown);

    // The right host and generation.
    await heartbeat("Alder", { probeResults: [answer({})] });
    expect((await probesOf("Alder"))[0]!.state).toBe(PROBE_STATE.up);
  });

  it("asks again with a new generation once the check itself changes", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));
    await tick();
    const first = (await heartbeat("Alder")).probes![0]!;

    const probeId = (await probesOf("Alder"))[0]!.id;
    await admin.delete(apiPath(API_ROUTES.hostProbe, { hostId: hostIds.Alder!, probeId }));
    await add("Alder", bodyWith({ vantage: hostIds.Alder!, timeoutSeconds: 2 }));
    controlPlane.clock.now += INTERVAL_SECONDS * 1000;
    await tick();

    const second = (await heartbeat("Alder")).probes![0]!;
    expect(second.generation).not.toBe(first.generation);
    expect(second.body.timeoutSeconds).toBe(2);
  });

  it("still makes a check with no host named from Autoheal itself", async () => {
    await add("Alder", bodyWith({ vantage: null }));
    await tick();

    expect((await heartbeat("Alder")).probes).toBeUndefined();
    // It ran here, and said what it found about a name that does not resolve.
    expect((await probesOf("Alder"))[0]!.lastCheckedAt).not.toBeNull();
  });

  it("makes the checks a runner is given with the same code and bounds the control plane uses", async () => {
    const asked: ProbeBody[] = [];
    const checks = new ServiceProbes(async (body) => {
      asked.push(body);
      return { ok: true, latencyMilliseconds: 3, problem: null };
    });

    const reports = await checks.run(
      [
        { id: "p1", generation: "g1", body: bodyWith({ vantage: hostIds.Alder! }) },
        { id: "p2", generation: "g2", body: bodyWith({ vantage: hostIds.Alder!, name: "Second" }) },
      ],
      AbortSignal.timeout(5000),
    );

    expect(reports).toEqual([
      { id: "p1", generation: "g1", ok: true, latencyMilliseconds: 3, problem: null },
      { id: "p2", generation: "g2", ok: true, latencyMilliseconds: 3, problem: null },
    ]);
    expect(asked.map(({ name }) => name)).toEqual(["Wiki", "Second"]);
  });

  it("will not let a reboot plan go on a check nothing shows either way", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));
    await tick();
    const probeId = (await probesOf("Alder"))[0]!.id;
    const given = (await heartbeat("Alder")).probes![0]!;
    await heartbeat("Alder", { probeResults: [{ ...given, ok: true, latencyMilliseconds: 5, problem: null }] });
    expect(controlPlane.services.probes.evidence(probeId, null)).toBeNull();

    // It is handed out again when due, and then its host goes quiet past the deadline: the gate says nothing
    // shows it, never that it is answering.
    controlPlane.clock.now += INTERVAL_SECONDS * 1000;
    await tick();
    await heartbeat("Alder");
    controlPlane.clock.now += PROBE_LIMITS.vantageDeadlineSeconds * 1000;
    await tick();

    expect(controlPlane.services.probes.evidence(probeId, null)).toContain("Nothing shows whether");
  });

  it("gives a check made from somewhere else an id of its own, so a reviewed plan cannot follow it", async () => {
    await add("Alder", bodyWith({ vantage: null }));
    const first = (await probesOf("Alder"))[0]!.id;

    // There is no way to change where a check is made from: the old one goes and a new one is made.
    await admin.delete(apiPath(API_ROUTES.hostProbe, { hostId: hostIds.Alder!, probeId: first }));
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));

    const second = (await probesOf("Alder"))[0]!;
    expect(second.id).not.toBe(first);
    expect(second.vantage).toBe(hostIds.Alder!);
    // A plan reviewed against the old check no longer finds it.
    expect(controlPlane.services.probes.evidence(first, null)).toContain("no longer exists");
  });

  it("reports a check that threw as not answering, with nothing else guessed at", async () => {
    const checks = new ServiceProbes(async () => {
      throw new Error("the host has no network at all");
    });

    const reports = await checks.run([{ id: "p1", generation: "g1", body: bodyWith() }], AbortSignal.timeout(5000));

    expect(reports[0]).toMatchObject({ ok: false, latencyMilliseconds: null });
    expect(reports[0]!.problem).toContain("no network");
  });
});
