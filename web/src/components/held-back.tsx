import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  API_ROUTES,
  apiPath,
  heldBackBy,
  type HostView,
  type InterruptedOperationView,
} from "../../../src/shared/api.js";
import { JOURNAL_OPERATION, REPLACING_JOB_ACTIONS, RUNNER_MESSAGES } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { boardQuery, hostsQuery } from "../queries.js";
import { useAskInPlace } from "./ask-in-place.js";
import { ErrorNotice } from "./common.js";

const text = TEXT.heldBack;

// What a person looks at before clearing a record, by what was cut short.
function adviceOf({ operation, target }: InterruptedOperationView): string {
  if (JOURNAL_OPERATION.hostPackages.test(operation)) {
    return text.advice.packages;
  }
  const action = JOURNAL_OPERATION.job.exec(operation)?.[1];
  const replaced = action !== undefined && REPLACING_JOB_ACTIONS.has(action);
  return replaced ? text.advice.replaced(target) : text.advice.other;
}

/** What holds a host's runner back, what to look at for each, and for an admin the way past it once they have. */
export function HeldBack({ host, admin }: { host: HostView; admin: boolean }) {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
  const clear = useMutation({
    mutationFn: () => api<string[]>("DELETE", apiPath(API_ROUTES.sshHostInterrupted, { hostId: host.id })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
    },
  });
  const records = heldBackBy(host);
  if (records.length === 0) {
    return null;
  }
  return (
    <div className="stack held-back">
      <ul className="small">
        {records.map((record) => (
          <li key={`${record.operation}-${record.at}`}>
            <div className="mono">{RUNNER_MESSAGES.recoverySaid(record)}</div>
            <div className="muted">{adviceOf(record)}</div>
          </li>
        ))}
      </ul>
      {admin && (
        <p className="row">
          <button
            type="button"
            className="danger"
            disabled={clear.isPending}
            onClick={() => asking.confirm(text.confirm, () => clear.mutate())}
          >
            {text.clear}
          </button>
        </p>
      )}
      {asking.question}
      <ErrorNotice error={clear.error} />
    </div>
  );
}
