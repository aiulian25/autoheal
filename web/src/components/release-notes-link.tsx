import type { ContainerView } from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import { releaseNotesLink } from "../release-links.js";
import { Icon } from "./icons.js";

/** A small link beside a newer version to what it changes, in a new tab; none where its image names no known source. */
export function ReleaseNotesLink({
  container,
  version,
}: {
  container: Pick<ContainerView, "name" | "source">;
  version: string;
}) {
  const link = releaseNotesLink(container.source, version);
  if (link === null) {
    return null;
  }
  const label = TEXT.updates.releaseNotesOf(container.name, version);
  return (
    <a className="release-notes" href={link} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
      <Icon name="fileText" />
    </a>
  );
}
