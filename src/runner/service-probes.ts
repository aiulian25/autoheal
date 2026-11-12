import { runCheck } from "../control-plane/probes/probe-checks.js";
import { PROBE_LIMITS } from "../shared/probes.js";
import type { ProbeReport, RemoteProbe } from "../shared/protocol.js";

/**
 * The service checks this host is given to make from where it is: the same checking code the control plane runs, so
 * the destinations a check may reach, the addresses no check may ever reach, and its own deadline are enforced here,
 * on the host that makes the request, and not only where it was asked for.
 *
 * Nothing is remembered: each check is made, reported with the generation and the hand-out it came with, and
 * forgotten; a report sent again, after its answer was lost, the control plane takes once. A check
 * whose answer never arrives is the control plane's to call unknown, never this side's to guess at.
 */
export class ServiceProbes {
  constructor(
    private readonly check: typeof runCheck = runCheck,
    private readonly limit = PROBE_LIMITS.atOnce,
  ) {}

  /** What the checks given saw, as many at a time as a runner makes, and no more than one report holds. */
  async run(given: readonly RemoteProbe[], stop: AbortSignal): Promise<ProbeReport[]> {
    const asked = given.slice(0, PROBE_LIMITS.resultsPerReport);
    const reports: ProbeReport[] = [];
    for (let start = 0; start < asked.length; start += this.limit) {
      const batch = asked.slice(start, start + this.limit);
      reports.push(...(await Promise.all(batch.map((probe) => this.one(probe, stop)))));
    }
    return reports;
  }

  private async one(probe: RemoteProbe, stop: AbortSignal): Promise<ProbeReport> {
    const result = await this.check(probe.body, stop).catch((error: unknown) => ({
      ok: false,
      latencyMilliseconds: null,
      problem: error instanceof Error ? error.message.slice(0, PROBE_LIMITS.problemCharacters) : null,
      certificate: undefined,
    }));
    return {
      id: probe.id,
      generation: probe.generation,
      ...(probe.attempt === undefined ? {} : { attempt: probe.attempt }),
      ok: result.ok,
      latencyMilliseconds: result.latencyMilliseconds,
      problem: result.problem === null ? null : result.problem.slice(0, PROBE_LIMITS.problemCharacters),
      ...(result.certificate === undefined ? {} : { certificate: result.certificate }),
    };
  }
}
