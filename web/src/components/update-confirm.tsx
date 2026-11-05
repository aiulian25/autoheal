import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { updateVersions, type ContainerView } from "../../../src/shared/api.js";
import { JOB_ACTION } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";
import { ErrorNotice } from "./common.js";
import { previewIdsOf, useOperationReview } from "./dependency-map.js";
import { ImageProvenanceLine } from "./image-provenance.js";

const TEXTS = TEXT.hostContainers.updateBox;
const GAP_PIXELS = 6;
const EDGE_PIXELS = 12;
// Rem-sized in the stylesheet; near enough to keep it on screen, and it only decides which way it opens.
const BOX_WIDTH_PIXELS = 320;
const BOX_HEIGHT_PIXELS = 220;

function placedBy(anchor: HTMLElement) {
  const { left, top, bottom } = anchor.getBoundingClientRect();
  const fitsBelow = bottom + GAP_PIXELS + BOX_HEIGHT_PIXELS <= window.innerHeight;
  return {
    left: Math.max(EDGE_PIXELS, Math.min(left, window.innerWidth - BOX_WIDTH_PIXELS - EDGE_PIXELS)),
    ...(fitsBelow ? { top: bottom + GAP_PIXELS } : { bottom: window.innerHeight - top + GAP_PIXELS }),
  };
}

/**
 * A row's update, asked about beside its icon. The same review as the card's: Update stays off until the host's
 * runner has inspected and locked what this touches, and a refusal is said here.
 */
export function UpdateConfirm({
  hostId,
  container,
  anchor,
  onCancel,
  onConfirm,
}: {
  hostId: string;
  container: ContainerView;
  anchor: HTMLElement;
  onCancel: () => void;
  onConfirm: (previews: Record<string, string>) => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const { preview, request, views, canConfirm } = useOperationReview(hostId, JOB_ACTION.update, [container.name]);
  useEffect(() => {
    const outside = (target: EventTarget | null) => !box.current?.contains(target as Node);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    const onPress = (event: MouseEvent) => {
      if (outside(event.target) && !anchor.contains(event.target as Node)) onCancel();
    };
    // It stays where it opened, so it goes when its row moves away.
    const onScroll = (event: Event) => {
      if (outside(event.target)) onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPress);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPress);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onCancel]);
  useEffect(() => () => anchor.focus(), [anchor]);
  const versions = updateVersions(container);
  const view = views?.[0];
  const answer = view?.answer;
  const others = answer?.ok ? answer.members.map(({ name }) => name).filter((name) => name !== container.name) : [];
  const refused = answer !== undefined && (!answer.ok || answer.refusals.length > 0);
  const expired = view !== undefined && !refused && !canConfirm;
  return createPortal(
    <div ref={box} className="update-confirm" role="dialog" aria-labelledby={id} style={placedBy(anchor)}>
      <h3 id={id}>{TEXTS.title(container.name)}</h3>
      <p>{versions === null ? TEXTS.versionsUnknown : TEXT.updates.versions(versions.from, versions.to)}</p>
      <p className="small muted">{TEXTS.restarts}</p>
      <p className="small muted">{TEXTS.noCheckpoint}</p>
      <ImageProvenanceLine provenance={container.update.provenance} />
      {preview.isPending && <p className="small muted">{TEXTS.checking}</p>}
      {others.length > 0 && <p className="small">{TEXTS.alsoHeld(others.join(", "))}</p>}
      {answer !== undefined && !answer.ok && <p className="notice error small">{answer.reason}</p>}
      {answer?.ok &&
        answer.refusals.map((refusal) => (
          <p className="notice error small" key={refusal}>
            {refusal}
          </p>
        ))}
      {expired && <p className="small muted">{TEXTS.expired}</p>}
      <ErrorNotice error={preview.error} />
      <div className="actions">
        {(refused || expired || preview.isError) && (
          <button type="button" onClick={() => request()}>
            {TEXTS.checkAgain}
          </button>
        )}
        <button type="button" onClick={onCancel}>
          {TEXTS.cancel}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!canConfirm || preview.isPending}
          onClick={() => views && onConfirm(previewIdsOf(views))}
        >
          {TEXTS.confirm}
        </button>
      </div>
    </div>,
    document.body,
  );
}
