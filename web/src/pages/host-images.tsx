import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath, type HostImagesView, type HostView, type JobView } from "../../../src/shared/api.js";
import { BYTES_PER_KILOBYTE, JOB_ACTION } from "../../../src/shared/constants.js";
import type { UnusedImage } from "../../../src/shared/protocol.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { LatestJob, isWaiting } from "../components/container-actions.js";
import { INVENTORY_REFRESH_MILLISECONDS, JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { bytes, shortImageId } from "../format.js";

const hostImagesQuery = (hostId: string) => ({
  queryKey: ["host-images", hostId],
  queryFn: () => api<HostImagesView>("GET", apiPath(API_ROUTES.hostImages, { hostId })),
});

const sizeText = (sizeBytes: number) => bytes(sizeBytes, BYTES_PER_KILOBYTE);
const totalOf = (images: readonly UnusedImage[]) => images.reduce((total, image) => total + image.sizeBytes, 0);

// Its names; where it came from, for one a newer pull took the name from; its id when Docker knows neither.
function nameOf(image: UnusedImage): string {
  if (image.tags.length > 0) {
    return image.tags.join(", ");
  }
  return image.repository === null ? shortImageId(image.id) : TEXT.hostImages.untagged(image.repository);
}

// The list follows a removal on its way closely, and otherwise refreshes as the containers do.
const refreshOf = (view: HostImagesView | undefined) =>
  view?.lastRemoval && isWaiting(view.lastRemoval) ? JOB_REFRESH_MILLISECONDS : INVENTORY_REFRESH_MILLISECONDS;

/**
 * The images no container on a host uses, newest first: removed one by one from their rows, the selected
 * ones, or all of them. The host's runner removes only what is still unused when the removal reaches it.
 */
export function HostImages({ host, admin }: { host: HostView; admin: boolean }) {
  const queryClient = useQueryClient();
  const query = hostImagesQuery(host.id);
  const view = useQuery({ ...query, refetchInterval: (current) => refreshOf(current.state.data) });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const remove = useMutation({
    mutationFn: (images: readonly UnusedImage[]) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId: host.id }), {
        action: JOB_ACTION.removeImages,
        images: images.map((image) => image.id),
      }),
    onSuccess: () => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
  });
  const data = view.data;
  if (data === undefined) {
    return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  }
  const images = data.images ?? [];
  // A host that only watches removes nothing: there is nothing to pick there.
  const watching = host.dryRun !== false;
  const canRemove = admin && !watching;
  const chosen = images.filter((image) => selected.has(image.id));
  const allChosen = images.length > 0 && chosen.length === images.length;
  const toggle = (id: string) =>
    setSelected((current) =>
      current.has(id) ? new Set([...current].filter((other) => other !== id)) : new Set([...current, id]),
    );
  const confirmRemove = (picked: readonly UnusedImage[]) => {
    const kept = picked.filter((image) => image.keptByUpdate).length;
    const question =
      picked.length === 1
        ? TEXT.hostImages.confirmOne(nameOf(picked[0]!), host.label, kept > 0)
        : TEXT.hostImages.confirmMany(picked.length, sizeText(totalOf(picked)), host.label, kept);
    if (window.confirm(question)) {
      remove.mutate(picked);
    }
  };
  return (
    <section className="section" aria-labelledby="host-images-title">
      <div className="row spread">
        <div className="stack">
          <h2 id="host-images-title">{TEXT.hostImages.title}</h2>
          <p className="muted small">{TEXT.hostImages.explanation}</p>
        </div>
        {images.length > 0 && (
          <span className="small muted">{TEXT.hostImages.summary(images.length, sizeText(totalOf(images)))}</span>
        )}
      </div>
      {data.images === null && <p className="muted">{TEXT.hostImages.notReported}</p>}
      {data.images?.length === 0 && <p className="muted">{TEXT.hostImages.none}</p>}
      {images.length > 0 && watching && <p className="muted small">{TEXT.hostControl.watchOnly}</p>}
      {images.length > 0 && canRemove && (
        <div className="row" role="group" aria-label={TEXT.hostImages.actions}>
          <button
            type="button"
            disabled={chosen.length === 0 || remove.isPending}
            onClick={() => confirmRemove(chosen)}
          >
            {TEXT.hostImages.removeSelected(chosen.length)}
          </button>
          <button type="button" className="danger" disabled={remove.isPending} onClick={() => confirmRemove(images)}>
            {TEXT.hostImages.removeAll}
          </button>
        </div>
      )}
      {images.length > 0 && (
        <div className="table-wrap host-images">
          <table>
            <thead>
              <tr>
                {canRemove && (
                  <th>
                    <input
                      type="checkbox"
                      checked={allChosen}
                      onChange={() => setSelected(allChosen ? new Set() : new Set(images.map((image) => image.id)))}
                      aria-label={TEXT.hostImages.selectAll}
                    />
                  </th>
                )}
                <th>{TEXT.hostImages.image}</th>
                <th>{TEXT.hostImages.size}</th>
                <th>{TEXT.hostImages.built}</th>
                {canRemove && <th />}
              </tr>
            </thead>
            <tbody>
              {images.map((image) => {
                const name = nameOf(image);
                return (
                  <tr key={image.id}>
                    {canRemove && (
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(image.id)}
                          onChange={() => toggle(image.id)}
                          aria-label={TEXT.hostImages.selectOne(name)}
                        />
                      </td>
                    )}
                    <td>
                      <div className="mono">{name}</div>
                      <div className="mono small muted">{shortImageId(image.id)}</div>
                      {image.keptByUpdate && <div className="small muted">{TEXT.hostImages.kept}</div>}
                    </td>
                    <td>{sizeText(image.sizeBytes)}</td>
                    <td>
                      <TimeAgo timestamp={image.createdAt} />
                    </td>
                    {canRemove && (
                      <td>
                        <button
                          type="button"
                          disabled={remove.isPending}
                          onClick={() => confirmRemove([image])}
                          aria-label={TEXT.hostImages.removeOne(name)}
                        >
                          {TEXT.hostImages.remove}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data.lastRemoval !== null && <LatestJob job={data.lastRemoval} />}
      <ErrorNotice error={remove.error} />
    </section>
  );
}
