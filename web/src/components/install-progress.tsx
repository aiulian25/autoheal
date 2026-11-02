import type { JobView } from "../../../src/shared/api.js";
import { UPDATE_PHASE, sizeText } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";

const text = TEXT.addContainer;

/** An install's steps, the one it is on marked, with how much it has downloaded. */
export function Progress({ job }: { job: JobView }) {
  const phase = job.progress?.phase ?? UPDATE_PHASE.waiting;
  const steps = text.steps;
  const order: string[] = [UPDATE_PHASE.working, UPDATE_PHASE.pulling, UPDATE_PHASE.starting, UPDATE_PHASE.checking];
  const at = order.indexOf(phase);
  const downloaded = job.progress?.downloaded ?? 0;
  const total = job.progress?.total ?? null;
  return (
    <ol className="install-steps">
      {order.map((step, index) => {
        const state = index < at ? "done" : index === at ? "now" : "later";
        return (
          <li key={step} className={`install-step ${state}`}>
            <span aria-hidden="true">{state === "done" ? "✓" : state === "now" ? "●" : "○"}</span>
            <span>{steps[step as keyof typeof steps]}</span>
            {step === UPDATE_PHASE.pulling && state === "now" && total !== null && (
              <>
                <span className="muted small">{text.downloaded(sizeText(downloaded), sizeText(total))}</span>
                <meter min={0} max={total} value={downloaded} />
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
