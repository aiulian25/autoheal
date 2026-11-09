import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { API_ROUTES, apiPath, type HostView, type JobView } from "../../../src/shared/api.js";
import {
  withAddress,
  type InstallAnswer,
  type InstallCheck,
  type InstallDraft,
  type InstallSpec,
} from "../../../src/shared/install.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import { OwnComposeEditor, type OwnStart } from "./own-compose.js";
import { FindApp } from "./add-container/find-app.js";
import { ReadyToInstall } from "./add-container/ready-to-install.js";
import { Installing } from "./add-container/installing.js";

const text = TEXT.addContainer;

/** Puts a new app on a host: one box, then one screen with everything already filled in. */
export function AddContainer({ host }: { host: HostView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<InstallDraft | null>(null);
  const [checks, setChecks] = useState<InstallCheck[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [own, setOwn] = useState<OwnStart | null>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = () => {
    setOpen(false);
    setDraft(null);
    setChecks([]);
    setJob(null);
    setOwn(null);
  };
  const guided = useMutation({
    mutationFn: (compose: string) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallDraft, { hostId: host.id }), { compose }),
    onSuccess: (answer) => {
      if (answer.draft === null) return;
      setOwn(null);
      setDraft(answer.draft);
      setChecks(answer.checks);
    },
  });
  const check = useMutation({
    mutationFn: (spec: InstallSpec) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallCheck, { hostId: host.id }), { spec }),
    onSuccess: (answer) => setChecks(answer.checks),
  });
  const install = useMutation({
    mutationFn: (spec: InstallSpec) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostInstall, { hostId: host.id }), { spec }),
    onSuccess: setJob,
  });
  const version = useMutation({
    mutationFn: (composeFile: string) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallDraft, { hostId: host.id }), {
        project: draft?.project?.address,
        composeFile,
      }),
    onSuccess: (answer) => {
      if (answer.draft !== null) {
        setDraft(answer.draft);
        setChecks(answer.checks);
      }
    },
  });
  const changed = (spec: InstallSpec) => {
    if (draft === null) return;
    setDraft({ ...draft, spec });
    check.mutate(spec);
  };
  return (
    <>
      <button type="button" className="add-container" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        {text.add}
      </button>
      <dialog ref={dialog} className="connect-host add-container-dialog" onClose={close}>
        {open && own !== null && (
          <OwnComposeEditor
            host={host}
            start={own}
            onGuided={(compose) => guided.mutate(compose)}
            guidedBusy={guided.isPending}
            guidedRefusal={guided.data?.error ?? null}
            onClose={close}
          />
        )}
        {open && own === null && job === null && draft === null && (
          <FindApp
            host={host}
            onDraft={(answer) => {
              setDraft(answer.draft);
              setChecks(answer.checks);
            }}
            onOwn={setOwn}
          />
        )}
        {open && job === null && draft !== null && (
          <ReadyToInstall
            host={host}
            draft={draft}
            checks={checks}
            checking={check.isPending || version.isPending}
            onChange={changed}
            onInstall={() =>
              install.mutate(withAddress(draft.spec, draft.baseUrlVariable, host.health?.address ?? null))
            }
            onVersion={(file) => version.mutate(file)}
            installing={install.isPending}
          />
        )}
        {open && job !== null && draft !== null && (
          <Installing host={host} draft={draft} started={job} onClose={close} />
        )}
        <div className="install-errors">
          <ErrorNotice error={check.error ?? install.error ?? version.error ?? guided.error} />
          {version.data?.error != null && <p className="notice warning small">{version.data.error}</p>}
        </div>
        <button
          type="button"
          className="icon-button dialog-close"
          title={text.close}
          aria-label={text.close}
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </dialog>
    </>
  );
}
