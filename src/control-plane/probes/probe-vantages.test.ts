import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import {
  PROBE_LIMITS,
  PROBE_OUTCOME,
  PROBE_SCOPE,
  PROBE_STATE,
  type ProbeBody,
  type ProbeView,
} from "../../shared/probes.js";
import { RUNNER_ROUTES, type HeartbeatResponse, type ProbeReport } from "../../shared/protocol.js";
import { ServiceProbes } from "../../runner/service-probes.js";
import { ProbeService } from "./probe-service.js";

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
        payload: { ...heartbeatWith({ hostLabel: label }), serviceProbes: true, probeAttempts: true, ...extra },
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
      tokens[label] = runnerTokenOf(enrolled);
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

  it("lets what a host last saw go unknown once the host goes quiet, and takes its next answer", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));
    await tick();
    const given = (await heartbeat("Alder")).probes![0]!;
    await heartbeat("Alder", { probeResults: [{ ...given, ok: true, latencyMilliseconds: 9, problem: null }] });
    const answered = (await probesOf("Alder"))[0]!;
    expect(answered.state).toBe(PROBE_STATE.up);

    // Alder reports nothing more. Quiet past the deadline, but its next answer not yet due to have come: it still
    // shows what it saw.
    controlPlane.clock.now += (PROBE_LIMITS.vantageDeadlineSeconds + 1) * 1000;
    await tick();
    expect((await probesOf("Alder"))[0]!.state).toBe(PROBE_STATE.up);
    // Past the check's interval and the deadline after it, nothing has come.
    controlPlane.clock.now += INTERVAL_SECONDS * 1000;
    await tick();
    const quiet = (await probesOf("Alder"))[0]!;
    expect(quiet.state).toBe(PROBE_STATE.unknown);
    expect(quiet.lastProblem).toContain("has not reported this check");
    expect(quiet.samples).toEqual(answered.samples);

    // Back, and once the check is due it is handed out again: its fresh answer is taken.
    controlPlane.clock.now += INTERVAL_SECONDS * 1000;
    const again = (await heartbeat("Alder")).probes![0]!;
    await heartbeat("Alder", { probeResults: [{ ...again, ok: true, latencyMilliseconds: 7, problem: null }] });
    expect((await probesOf("Alder"))[0]!).toMatchObject({ state: PROBE_STATE.up, lastLatencyMilliseconds: 7 });
  });

  it("keeps what a reporting host last saw while its check waits its turn", async () => {
    await add("Alder", bodyWith({ vantage: hostIds.Alder! }));
    await tick();
    const given = (await heartbeat("Alder")).probes![0]!;
    await heartbeat("Alder", { probeResults: [{ ...given, ok: true, latencyMilliseconds: 9, problem: null }] });
    // Past the interval and the deadline, but Alder still reports: its checks wait their turn, they are not lost.
    controlPlane.clock.now += (INTERVAL_SECONDS + PROBE_LIMITS.vantageDeadlineSeconds + 1) * 1000;
    vi.spyOn(controlPlane.services.probes, "probesFor").mockReturnValue([]);
    await heartbeat("Alder");
    await tick();
    expect((await probesOf("Alder"))[0]!.state).toBe(PROBE_STATE.up);
  });

  describe("a check of one host's service made from another, during maintenance", () => {
    const failing = { ok: false, latencyMilliseconds: null, problem: "No route to that network." };
    // Both runners keep windows, so either host may have one.
    const beat = (label: string, extra: Record<string, unknown> = {}) =>
      heartbeat(label, { maintenanceGeneration: 0, ...extra });
    const openWindow = async (label: string) => {
      await beat(label);
      const window = await admin.post(apiPath(API_ROUTES.hostMaintenance, { hostId: hostIds[label]! }), {
        containerName: null,
        reason: "Planned",
        expiresAt: controlPlane.clock.now + 60 * 60_000,
      });
      expect(window.statusCode, window.body).toBe(200);
    };
    // Alder's check, made from Birch: one failure is enough to call it down.
    const failedOnce = async () => {
      await add("Alder", bodyWith({ vantage: hostIds.Birch! }));
      await tick();
      const given = (await beat("Birch")).probes![0]!;
      await beat("Birch", { probeResults: [{ ...given, ...failing }] });
      return (await probesOf("Alder"))[0]!;
    };

    it("holds it while the host it is about is in maintenance, wherever it is made from", async () => {
      await openWindow("Alder");
      const probe = await failedOnce();
      expect(probe.state).not.toBe(PROBE_STATE.down);
      expect(probe.samples.map(({ outcome }) => outcome)).toEqual([PROBE_OUTCOME.maintenance]);
    });

    it("still counts it while only the host it is made from is in maintenance", async () => {
      await openWindow("Birch");
      const probe = await failedOnce();
      expect(probe.state).toBe(PROBE_STATE.down);
      expect(probe.samples.map(({ outcome }) => outcome)).toEqual([PROBE_OUTCOME.down]);
    });
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
      attempt: given.attempt,
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

  describe("one result for each time a check is handed out", () => {
    const failing = { ok: false, latencyMilliseconds: null, problem: "No route to that network." };
    const handedOut = async () => {
      await add("Alder", bodyWith({ vantage: hostIds.Alder!, failuresBeforeDown: 2 }));
      await tick();
      return (await heartbeat("Alder")).probes![0]!;
    };

    it("takes a result sent again, after its answer was lost, as the one result it is", async () => {
      const given = await handedOut();
      await heartbeat("Alder", { probeResults: [{ ...given, ...failing }] });
      const once = (await probesOf("Alder"))[0]!;
      controlPlane.clock.now += 5_000;
      await heartbeat("Alder", { probeResults: [{ ...given, ...failing }] });

      const probe = (await probesOf("Alder"))[0]!;
      expect(probe.state).not.toBe(PROBE_STATE.down);
      expect(probe.lastCheckedAt).toBe(once.lastCheckedAt);
      expect(probe.samples).toHaveLength(1);
    });

    it("takes no result that came after its deadline, nor one for a hand-out since replaced", async () => {
      const given = await handedOut();
      controlPlane.clock.now += PROBE_LIMITS.vantageDeadlineSeconds * 1000;
      const late = await heartbeat("Alder", { probeResults: [{ ...given, ...failing }] });
      expect((await probesOf("Alder"))[0]!.samples).toEqual([]);
      // The answer to that late report hands the check out afresh.
      const again = late.probes![0]!;
      expect(again.attempt).not.toBe(given.attempt);
      await heartbeat("Alder", { probeResults: [{ ...given, ...failing }] });
      expect((await probesOf("Alder"))[0]!.samples).toEqual([]);
      await heartbeat("Alder", { probeResults: [{ ...again, ...failing }] });
      expect((await probesOf("Alder"))[0]!.samples).toHaveLength(1);
    });

    it("takes no result for a hand-out from before the control plane restarted", async () => {
      const given = await handedOut();
      const { databaseHandle, maintenance } = controlPlane.services;
      const restarted = new ProbeService({ databaseHandle, maintenance, clock: () => controlPlane.clock.now });
      restarted.recordReports(hostIds.Alder!, [{ ...given, ...failing }]);
      expect((await probesOf("Alder"))[0]!.samples).toEqual([]);
    });

    it("gives none to a runner that would not say which time each result answers", async () => {
      await add("Birch", bodyWith({ vantage: hostIds.Birch! }));
      // One from before attempts: it makes checks, but its results carry no attempt, so one could count twice.
      expect((await heartbeat("Birch", { probeAttempts: undefined })).probes).toBeUndefined();
      await tick();
      expect((await probesOf("Birch"))[0]!.lastProblem).toContain("cannot make checks itself");
    });
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
        { id: "p1", generation: "g1", attempt: "a1", body: bodyWith({ vantage: hostIds.Alder! }) },
        { id: "p2", generation: "g2", body: bodyWith({ vantage: hostIds.Alder!, name: "Second" }) },
      ],
      AbortSignal.timeout(5000),
    );

    expect(reports).toEqual([
      { id: "p1", generation: "g1", attempt: "a1", ok: true, latencyMilliseconds: 3, problem: null },
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
