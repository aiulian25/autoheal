import type { ContainerDetails } from "./incident-report.js";
import { dataMountsOf } from "./volume-checkpoints.js";

/** Writable mount identities, including Docker's physical volume paths for bind/volume aliases. */
export function rollbackDataSources(container: ContainerDetails) {
  const targets = new Set(dataMountsOf(container).map(({ target }) => target));
  return (container.Mounts ?? [])
    .filter((mount) => targets.has(mount.Destination))
    .flatMap((mount) => [
      ...(mount.Type === "volume" && mount.Name ? [{ type: "volume", source: mount.Name }] : []),
      ...(mount.Source?.startsWith("/") ? [{ type: "path", source: mount.Source.replace(/\/+$/, "") || "/" }] : []),
    ]);
}

/** Nested bind mounts can write part of a restored tree; similarly named sibling paths do not overlap. */
export function sharesRollbackData(a: ContainerDetails, b: ContainerDetails): boolean {
  return rollbackDataSources(a).some((left) =>
    rollbackDataSources(b).some(
      (right) =>
        left.type === right.type &&
        (left.source === right.source ||
          (left.type === "path" &&
            (left.source === "/" ||
              right.source === "/" ||
              left.source.startsWith(`${right.source}/`) ||
              right.source.startsWith(`${left.source}/`)))),
    ),
  );
}
