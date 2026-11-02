import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, useRef } from "react";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { HOST_KIND, HOST_SECTIONS } from "../../../src/shared/constants.js";
import { useLocation } from "react-router";
import {
  TOPOLOGY_EDGE_KINDS,
  operationPreviewAnswerSchema,
  type OperationImpactView,
  type PreviewAction,
  type TopologyView,
} from "../../../src/shared/topology.js";
import { api, ReadableError } from "../api-client.js";
import { DEPENDENCY_MAP_TEXT, INVENTORY_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { ErrorNotice, Loading } from "./common.js";
import { StackMap } from "./stack-map.js";

const EDGE_WORDS = {
  network_namespace: "Shares network namespace",
  compose_association: "Same Compose project (association only)",
  shared_writable_data: "Shares writable data",
  declared_dependency: "Declared dependency (Compose depends_on or autoheal.depends-on)",
} as const;
// Without a report: none can come without Docker; a runner may need updating; Autoheal's own runners send one soon.
function noReportText(host: HostView): string {
  if (host.docker === false) {
    return DEPENDENCY_MAP_TEXT.noDocker;
  }
  const byRunner = (host.kind ?? HOST_KIND.runner) === HOST_KIND.runner;
  return byRunner ? DEPENDENCY_MAP_TEXT.noReportFromRunner : DEPENDENCY_MAP_TEXT.notYet;
}

/**
 * The host's containers and what links them, folded away until opened: its report is read only then. The page's
 * Dependencies tab opens it.
 */
export function DependencyMap({ host }: { host: HostView }) {
  const id = useId();
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === `#${HOST_SECTIONS.dependencies}`);
  useEffect(() => {
    if (hash === `#${HOST_SECTIONS.dependencies}`) setOpen(true);
  }, [hash]);
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <details className="fold" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <h2 id={`${id}-title`}>{DEPENDENCY_MAP_TEXT.title}</h2>
        </summary>
        {open && <DependencyGraph host={host} />}
      </details>
    </section>
  );
}

function DependencyGraph({ host }: { host: HostView }) {
  const hostId = host.id;
  const view = useQuery({
    queryKey: ["topology", hostId],
    queryFn: () => api<TopologyView>("GET", apiPath(API_ROUTES.topology, { hostId })),
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
  });
  const snapshot = view.data?.snapshot;
  return (
    <>
      <p className="small muted">
        Network namespace sharing and shared writable data can enlarge an operation’s scope. Compose membership is an
        association, not a startup order. Declared dependencies come from the optional autoheal.depends-on label and do
        not change execution policy.
      </p>
      {view.isPending && <Loading />}
      {view.data?.available === false && <p className="notice warning">{noReportText(host)}</p>}
      {view.data?.stale && snapshot && (
        <p className="notice warning">This report is stale. A mutation requires a fresh runner review.</p>
      )}
      {snapshot?.truncated && (
        <p className="notice warning">
          This report is partial because a graph or byte limit was reached. Operation review uses the full coordinator
          discovery.
        </p>
      )}
      {snapshot?.notes.includes("unresolved_reference") && (
        <p className="notice warning">Some referenced containers could not be resolved.</p>
      )}
      {snapshot && (
        <>
          <p className="small muted">
            Captured{" "}
            <time dateTime={new Date(snapshot.capturedAt).toISOString()}>
              {new Date(snapshot.capturedAt).toLocaleString()}
            </time>{" "}
            · {snapshot.nodes.length} containers · {snapshot.edges.length} links
          </p>
          {snapshot.nodes.length > 0 && <StackMap snapshot={snapshot} />}
          <details>
            <summary>Accessible link list</summary>
            {TOPOLOGY_EDGE_KINDS.map((kind) => {
              const edges = snapshot.edges.filter((edge) => edge.kind === kind);
              return edges.length ? (
                <section key={kind}>
                  <h3>{EDGE_WORDS[kind]}</h3>
                  <ul>
                    {edges.map((edge, index) => (
                      <li key={index}>
                        <span className="mono">{edge.from}</span> · <span className="mono">{edge.to}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null;
            })}
            {snapshot.edges.length === 0 && <p className="muted">No supported relationships were reported.</p>}
          </details>
        </>
      )}
      <ErrorNotice error={view.error} />
    </>
  );
}

/** A fresh, session-bound review, asked for at once. No action is submitted until its complete scope is confirmed. */
export function useOperationReview(hostId: string, action: PreviewAction, names: readonly string[]) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const key = JSON.stringify(names);
  const preview = useMutation({
    mutationFn: async () => {
      if (names.length > 16) throw new ReadableError("Review at most 16 containers at once.");
      const views: OperationImpactView[] = [];
      for (let index = 0; index < names.length; index += 4)
        views.push(
          ...(await Promise.all(
            names.slice(index, index + 4).map((containerName) =>
              api<OperationImpactView>("POST", apiPath(API_ROUTES.operationPreview, { hostId, containerName }), {
                action,
              }).then((view) => {
                const answer = operationPreviewAnswerSchema.safeParse(view?.answer);
                if (
                  !answer.success ||
                  typeof view.id !== "string" ||
                  !Number.isFinite(view.expiresAt) ||
                  view.hostId !== hostId ||
                  view.containerName !== containerName ||
                  view.action !== action
                )
                  throw new ReadableError(
                    "No usable operation review was returned. Update the runner and refresh the review.",
                  );
                return { ...view, answer: answer.data };
              }),
            ),
          )),
        );
      return views;
    },
  });
  const request = preview.mutate;
  const requested = useRef<string | null>(null);
  useEffect(() => {
    const identity = JSON.stringify([hostId, action, key]);
    if (requested.current === identity) return;
    requested.current = identity;
    request();
  }, [hostId, action, key, request]);
  const views = preview.data;
  const canConfirm =
    views?.length === names.length &&
    views.every((view) => view.answer.ok && view.answer.refusals.length === 0 && view.expiresAt > now);
  return { preview, request, views, canConfirm };
}

export const previewIdsOf = (views: readonly OperationImpactView[]) =>
  Object.fromEntries(views.map((view) => [view.containerName, view.id]));

/** The whole review as a card: for several containers, and for an action that puts data back. */
export function OperationImpactReview({
  hostId,
  action,
  names,
  onConfirm,
  onCancel,
}: {
  hostId: string;
  action: PreviewAction;
  names: readonly string[];
  onConfirm: (previews: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const { preview, request, views, canConfirm } = useOperationReview(hostId, action, names);
  return (
    <section className="card notice warning" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Review {TEXT.actions.names[action].toLowerCase()} impact</h3>
      <p>
        The runner inspected and locked the same resource set used for execution. Shared-data writers and namespace
        providers can be locked even when they are not replaced. A changed set will refuse the job.
      </p>
      {preview.isPending && <Loading />}
      {views?.map((view) => (
        <div key={view.containerName}>
          <strong>{view.containerName}</strong>
          {view.answer.ok ? (
            <>
              <ul>
                {view.answer.members.map((member) => (
                  <li key={member.name}>
                    <span className="mono">{member.name}</span>
                    {member.protected ? " · protected" : ""}
                  </li>
                ))}
              </ul>
              <p className="small muted">
                {view.answer.resources.length} coordinator resources · review expires{" "}
                {new Date(view.expiresAt).toLocaleTimeString()}
              </p>
              {view.answer.refusals.map((refusal) => (
                <p className="notice error" key={refusal}>
                  {refusal}
                </p>
              ))}
            </>
          ) : (
            <p className="notice error">{view.answer.reason}</p>
          )}
        </div>
      ))}
      <ErrorNotice error={preview.error} />
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!canConfirm || preview.isPending}
          onClick={() => views && onConfirm(previewIdsOf(views))}
        >
          Confirm reviewed operation
        </button>
        <button type="button" disabled={preview.isPending} onClick={() => request()}>
          Refresh review
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
