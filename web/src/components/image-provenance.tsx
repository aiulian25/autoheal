import { PROVENANCE_STATUS, type ImageProvenance } from "../../../src/shared/image-provenance.js";
import { TEXT } from "../constants.js";

const text = TEXT.provenance;

const WORDING: Record<ImageProvenance["status"], (publisher: string | null) => string> = {
  [PROVENANCE_STATUS.verified]: (publisher) => text.verified(publisher ?? ""),
  [PROVENANCE_STATUS.unsigned]: () => text.unsigned,
  [PROVENANCE_STATUS.invalid]: () => text.invalid,
  [PROVENANCE_STATUS.unreachable]: () => text.unreachable,
  [PROVENANCE_STATUS.notChecked]: () => text.notChecked,
};

/**
 * Who published the image an update would bring, where an admin asked for proof: one line beside the update's own
 * status, saying what was found and why it is not proof when it is not.
 */
export function ImageProvenanceLine({ provenance }: { provenance: ImageProvenance | null | undefined }) {
  if (provenance === null || provenance === undefined) {
    return null;
  }
  const verified = provenance.status === PROVENANCE_STATUS.verified;
  return (
    <p className={verified ? "small text-good" : "small text-warning"} role="status">
      {WORDING[provenance.status](provenance.publisher)}
      {!verified && provenance.problem !== null && `${TEXT.separator}${provenance.problem}`}
    </p>
  );
}
