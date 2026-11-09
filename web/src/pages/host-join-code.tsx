import { useMutation, useQuery } from "@tanstack/react-query";
import { API_ROUTES, apiPath, type EnrolledHostView, type HostView } from "../../../src/shared/api.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { TEXT } from "../constants.js";
import { timeOfDay } from "../format.js";
import { localHostQuery } from "../queries.js";
import { CommandBlock } from "./ssh-setup.js";

const text = TEXT.hosts.joinCode;

/**
 * A new join code for a runner that joined before and must join again: the line in its .env changes, the rest stays.
 * Hidden until known not to be this machine's runner container, which joins through its volume.
 */
export function JoinCodeCard({ host }: { host: HostView }) {
  const local = useQuery(localHostQuery);
  const make = useMutation({
    mutationFn: () => api<EnrolledHostView>("POST", apiPath(API_ROUTES.hostJoinCode, { hostId: host.id }), {}),
  });
  if (local.data === undefined || local.data.hostId === host.id) {
    return null;
  }
  const made = make.data;
  return (
    <section className="card join-code" aria-labelledby="join-code-title">
      <div>
        <h2 id="join-code-title">{text.title}</h2>
        <p className="small muted">{text.explanation}</p>
      </div>
      <button type="button" disabled={make.isPending} onClick={() => make.mutate()}>
        {text.make}
      </button>
      {made !== undefined && (
        <div className="join-code-made">
          <p className="small">{text.paste(host.label, timeOfDay(made.joinCodeExpiresAt))}</p>
          <CommandBlock command={made.rejoinCommand} />
          <p className="small muted">{text.nas}</p>
        </div>
      )}
      <ErrorNotice error={make.error} />
    </section>
  );
}
