import { useIsFetching, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router";
import { API_ROUTES, apiPath, type HostChangeView } from "../../../src/shared/api.js";
import { HOST_CHANGE_TEXT, HOST_CHANGES_ANCHOR } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { HOST_CHANGES_SHOWN, REFRESH_MILLISECONDS, TEXT } from "../constants.js";

const text = TEXT.hostChanges;

/**
 * A link to this list, a search result's for a change whose container is gone, brings it into view once per link,
 * when the whole page has its data: what loads above it before then would push it out of view again.
 */
function useBroughtIntoView(loaded: boolean) {
  const card = useRef<HTMLElement>(null);
  const broughtFor = useRef<string | null>(null);
  const { hash, key } = useLocation();
  const navigation = useNavigationType();
  const fetching = useIsFetching();
  const linked = hash === `#${HOST_CHANGES_ANCHOR}` && navigation !== NavigationType.Replace;
  const settled = loaded && fetching === 0;
  useEffect(() => {
    if (!linked || !settled || broughtFor.current === key) return;
    broughtFor.current = key;
    card.current?.scrollIntoView?.();
  }, [linked, settled, key]);
  return card;
}

function ChangeList({ changes }: { changes: readonly HostChangeView[] }) {
  return (
    <ul className="plain-list">
      {changes.map((change) => (
        <li key={change.id} className="row">
          <strong className="mono">{change.containerName ?? text.host}</strong>
          <span>{HOST_CHANGE_TEXT[change.kind](change.details)}</span>
          <TimeAgo timestamp={change.at} />
        </li>
      ))}
    </ul>
  );
}

/**
 * What changed on the host, newest first: what Autoheal saw between two of its runner's reports. The latest few show;
 * the rest are folded away under them.
 */
export function HostChanges({ hostId }: { hostId: string }) {
  const changes = useQuery({
    queryKey: ["host-changes", hostId],
    queryFn: () => api<HostChangeView[]>("GET", apiPath(API_ROUTES.hostChanges, { hostId })),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  const card = useBroughtIntoView(changes.data !== undefined);
  const all = changes.data ?? [];
  const recent = all.slice(0, HOST_CHANGES_SHOWN);
  const earlier = all.slice(HOST_CHANGES_SHOWN);
  return (
    <section id={HOST_CHANGES_ANCHOR} ref={card} className="card host-changes" aria-labelledby="host-changes-title">
      <h2 id="host-changes-title">{text.title}</h2>
      {changes.data === undefined && changes.error === null && <Loading />}
      {changes.data?.length === 0 && <p className="muted small">{text.empty}</p>}
      <ChangeList changes={recent} />
      {earlier.length > 0 && (
        <details className="fold">
          <summary>{text.earlier(earlier.length)}</summary>
          <ChangeList changes={earlier} />
        </details>
      )}
      <ErrorNotice error={changes.error} />
    </section>
  );
}
