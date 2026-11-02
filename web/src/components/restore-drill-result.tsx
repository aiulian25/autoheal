import type { ApplicationBootEvidence } from "../../../src/shared/application-backups.js";
import { TEXT } from "../constants.js";

const text = TEXT.applicationBackups.boot;

/** What a boot drill found, as evidence: how it knows, what went wrong, and anything it could not clean up. */
export function RestoreDrillResult({ boot }: { boot: ApplicationBootEvidence }) {
  return (
    <div className="stack">
      {boot.readiness !== null && <p className="small">{text.readiness[boot.readiness](boot.readySeconds)}</p>}
      {boot.imageId !== null && <p className="small muted mono">{boot.imageId}</p>}
      {boot.logs !== null && <pre className="small">{boot.logs}</pre>}
      {boot.left.length > 0 && <p className="notice warning small">{text.left(boot.left.join(", "))}</p>}
    </div>
  );
}
