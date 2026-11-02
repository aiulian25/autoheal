import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { API_ROUTES, apiPath, type HostView, type JobView } from "../../../src/shared/api.js";
import { JOB_ACTION, JOB_STATUS, VOLUME_NAME } from "../../../src/shared/constants.js";
import {
  VOLUME_SHARE,
  newVolumeSchema,
  type NewVolume,
  type VolumeReport,
  type VolumeShareKind,
} from "../../../src/shared/volumes.js";
import { api } from "../api-client.js";
import { CopyButton, ErrorNotice, Loading } from "../components/common.js";
import { isWaiting } from "../components/container-actions.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import { Choices, Row } from "./add-container.js";

const text = TEXT.hostVolumes.create;
const HERE = "here";
type Kind = typeof HERE | VolumeShareKind;

function nameProblem(name: string, volumes: readonly VolumeReport[]): string | null {
  if (!VOLUME_NAME.test(name)) return text.nameInvalid;
  return volumes.some((volume) => volume.name === name) ? text.nameTaken : null;
}

/** A new volume: only its name needs typing, unless it lives on a share. */
export function NewVolumeDialog({
  host,
  volumes,
  lastJob,
  onChanged,
  onClose,
}: {
  host: HostView;
  volumes: readonly VolumeReport[];
  lastJob: JobView | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>(HERE);
  const [address, setAddress] = useState("");
  const [path, setPath] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const create = useMutation({
    mutationFn: (volume: NewVolume) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId: host.id }), {
        action: JOB_ACTION.createVolume,
        volume,
      }),
    onSuccess: onChanged,
  });
  const job = create.data !== undefined && lastJob?.id === create.data.id ? lastJob : (create.data ?? null);
  const trimmed = name.trim();
  const problem = trimmed === "" ? null : nameProblem(trimmed, volumes);
  const asked: NewVolume = { name: trimmed, share: kind === HERE ? null : { kind, address, path } };
  const shareTyped = kind === HERE || (address !== "" && path !== "");
  const shareBad = kind !== HERE && shareTyped && !newVolumeSchema.safeParse({ ...asked, name: "x" }).success;
  const ready = trimmed !== "" && problem === null && shareTyped && !shareBad;
  const ended = job !== null && !isWaiting(job);
  const failed = ended && job.status === JOB_STATUS.failed;
  const line = text.composeLine(trimmed);
  return (
    <dialog ref={dialog} className="connect-host add-container-dialog" onClose={onClose}>
      {ended && !failed ? (
        <>
          <h2>{text.doneTitle(trimmed, host.label)}</h2>
          <div className="connect-host-body install-body">
            <p>{job.outcome}</p>
            <div className="install-rows">
              <Row label={text.inCompose} value={<span className="mono">{line}</span>} />
            </div>
            <CopyButton text={line} />
            <p className="small muted">{text.use}</p>
          </div>
          <div className="connect-host-foot">
            <button type="button" onClick={onClose}>
              {text.close}
            </button>
          </div>
        </>
      ) : (
        <>
          <h2>{text.title(host.label)}</h2>
          <div className="connect-host-body install-body">
            <div className="install-rows">
              <Row
                label={text.name}
                value={
                  <input
                    autoFocus
                    className="mono"
                    aria-label={text.name}
                    value={name}
                    placeholder={text.namePlaceholder}
                    onChange={(event) => setName(event.target.value)}
                  />
                }
              />
              <Row
                label={text.kind}
                value={
                  <Choices<Kind>
                    label={text.kind}
                    options={[
                      { value: HERE, label: text.here, note: text.hereNote(volumes.length) },
                      { value: VOLUME_SHARE.nfs, label: text.nfs, note: text.shareNote },
                      { value: VOLUME_SHARE.smb, label: text.smb, note: text.shareNote },
                    ]}
                    selected={(value) => value === kind}
                    onChoose={setKind}
                  />
                }
              />
              {kind !== HERE && (
                <>
                  <Row
                    label={text.address}
                    value={
                      <input
                        className="mono"
                        aria-label={text.address}
                        value={address}
                        placeholder={text.addressPlaceholder}
                        onChange={(event) => setAddress(event.target.value.trim())}
                      />
                    }
                  />
                  <Row
                    label={text.path}
                    value={
                      <input
                        className="mono"
                        aria-label={text.path}
                        value={path}
                        placeholder={text.pathPlaceholder}
                        onChange={(event) => setPath(event.target.value.trim())}
                      />
                    }
                  />
                </>
              )}
            </div>
            {trimmed !== "" && (
              <p className="install-checks small">
                {problem === null ? (
                  <span className="muted">
                    <span className="install-tick">✓</span> {text.nameFree}
                  </span>
                ) : (
                  <span className="text-danger">{problem}</span>
                )}
              </p>
            )}
            {shareBad && <p className="small text-danger">{text.shareInvalid}</p>}
            {failed && <p className="small text-danger">{job.outcome}</p>}
            <ErrorNotice error={create.error} />
          </div>
          <div className="connect-host-foot">
            {job !== null && isWaiting(job) ? (
              <Loading />
            ) : (
              <button
                type="button"
                className="primary"
                disabled={!ready || create.isPending}
                onClick={() => create.mutate(asked)}
              >
                {text.submit}
              </button>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        className="icon-button dialog-close"
        title={text.close}
        aria-label={text.close}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </dialog>
  );
}
