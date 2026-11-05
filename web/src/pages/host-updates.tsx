import { RolloutPlan } from "../components/rollout-plan.js";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { hasUpdate, type ContainerView, type HostView } from "../../../src/shared/api.js";
import { UPDATE_CHECK_INTERVAL_MILLISECONDS } from "../../../src/shared/constants.js";
import { ErrorNotice } from "../components/common.js";
import { ImageVersions } from "../components/container-actions.js";
import { INVENTORY_REFRESH_MILLISECONDS, MILLISECONDS_PER_HOUR, TEXT } from "../constants.js";
import { hostContainersQuery } from "../queries.js";
import { runLine, stateIn, useUpdateRun } from "../update-runs.js";
import { HostPackages, UpdateActions } from "./host-packages.js";

/**
 * New images for the host's containers, each ticked to begin with, and the way to apply the ticked ones:
 * one at a time, the rest waiting if one does not come back healthy.
 */
function ContainerImages({
  host,
  admin,
  actionsIn,
}: {
  host: HostView;
  admin: boolean;
  actionsIn: HTMLElement | null;
}) {
  const containers = useQuery({ ...hostContainersQuery(host.id), refetchInterval: INVENTORY_REFRESH_MILLISECONDS });
  const { run: latest, review, impact, busy, error } = useUpdateRun(host.id);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const text = TEXT.containerImages;
  // Protected or kept aside, a container is never updated from here.
  const waiting = (containers.data ?? []).filter(
    (container: ContainerView) => hasUpdate(container) && container.handsOff === null,
  );
  const newImages = (containers.data ?? []).filter(hasUpdate).length;
  const selected = waiting.map(({ name }) => name).filter((name) => !unticked.has(name));
  const toggle = (name: string) =>
    setUnticked(
      unticked.has(name) ? new Set([...unticked].filter((other) => other !== name)) : new Set([...unticked, name]),
    );
  return (
    <section className="card update-card" aria-labelledby="container-images-title">
      <div className="update-card-body">
        <h3 id="container-images-title">{text.title}</h3>
        <p className="update-card-line">{text.line(UPDATE_CHECK_INTERVAL_MILLISECONDS / MILLISECONDS_PER_HOUR)}</p>
        {newImages === 0 && containers.data !== undefined && <p className="muted">{text.allCurrent}</p>}
        {newImages > 0 && host.dryRun === true && <p className="muted">{text.watching(newImages)}</p>}
        {waiting.length > 0 && (
          <ul className="update-rows">
            {waiting.map((container) => {
              const state = stateIn(latest, container.name);
              return (
                <li key={container.name} className="update-row">
                  {admin ? (
                    <input
                      type="checkbox"
                      checked={!unticked.has(container.name)}
                      disabled={busy}
                      onChange={() => toggle(container.name)}
                      aria-label={text.selectOne(container.name)}
                    />
                  ) : (
                    <span className="tick-space" />
                  )}
                  <span className="update-what">
                    <span className="mono">{container.name}</span>
                    <ImageVersions container={container} />
                    {state !== null && <span className="small faint">{text.states[state]}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {latest !== null && <p className="small muted">{runLine(latest)}</p>}
      </div>
      {admin && waiting.length > 0 && (
        <footer className="update-card-foot">
          <UpdateActions into={actionsIn} title={text.title} ticked={selected.length}>
            <button
              type="button"
              className="primary"
              disabled={selected.length === 0 || busy}
              onClick={() => review(selected)}
            >
              {text.update(selected.length)}
            </button>
          </UpdateActions>
        </footer>
      )}
      {impact}
      <ErrorNotice error={error} />
    </section>
  );
}

// A host that reports itself but no packages: a containers-only runner (a Synology), which reads none of its files.
const reportsNoPackages = (host: HostView) => host.health !== null && (host.health.packages ?? null) === null;

/** What waits to be updated on a host: its containers' images, and its own packages where it reports them. */
export function HostUpdates({ host, admin }: { host: HostView; admin: boolean }) {
  const [imageActions, setImageActions] = useState<HTMLElement | null>(null);
  const [packageActions, setPackageActions] = useState<HTMLElement | null>(null);
  return (
    <section className="host-updates" aria-labelledby="host-updates-title">
      <h2 id="host-updates-title">{TEXT.containerImages.heading}</h2>
      <div className="action-bar update-actions" role="group" aria-label={TEXT.containerImages.actionsLabel}>
        <span ref={setImageActions} />
        <span ref={setPackageActions} />
      </div>
      {admin && host.docker !== false && <RolloutPlan hostId={host.id} />}
      <div className="update-cards">
        {host.docker !== false && <ContainerImages host={host} admin={admin} actionsIn={imageActions} />}
        {!reportsNoPackages(host) && <HostPackages hostId={host.id} admin={admin} actionsIn={packageActions} />}
      </div>
    </section>
  );
}
