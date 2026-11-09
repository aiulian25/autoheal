import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type HostView, type JobView } from "../../../../src/shared/api.js";
import { JOB_STATUS } from "../../../../src/shared/constants.js";
import { type InstallDraft } from "../../../../src/shared/install.js";
import { CopyButton, PlainText } from "../../components/common.js";
import { isWaiting } from "../../components/container-actions.js";
import { Progress } from "../../components/install-progress.js";
import { TakeAway, useInstallJob } from "../../components/take-away.js";
import { TEXT } from "../../constants.js";
import { lanAddressOf, proxyOf } from "./install-options.js";

const text = TEXT.addContainer;

export function Installing({
  host,
  draft,
  started,
  onClose,
}: {
  host: HostView;
  draft: InstallDraft;
  started: JobView;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useInstallJob(host.id, started)!;
  const { spec } = draft;
  const waiting = isWaiting(job);
  useEffect(() => {
    if (!waiting) void queryClient.invalidateQueries();
  }, [waiting]);
  if (waiting) {
    return (
      <>
        <h2>{text.installingTitle(spec.name, host.label)}</h2>
        <div className="connect-host-body install-body">
          <Progress job={job} />
          <p className="small muted">{text.canClose}</p>
        </div>
        <div className="connect-host-foot">
          <button type="button" onClick={onClose}>
            {text.close}
          </button>
        </div>
      </>
    );
  }
  const succeeded = job.status === JOB_STATUS.succeeded;
  const address = host.health?.address ?? null;
  const lanAddress = address === null ? null : lanAddressOf(spec, address);
  const proxyEntry = spec.networks.length > 0 && spec.port !== null ? `${spec.name}:${spec.port.target}` : null;
  return (
    <>
      <h2>{text.readyTitle(spec.name, host.label)}</h2>
      <div className="connect-host-body install-body">
        <p className={succeeded ? "install-done" : "install-failed"} role="status">
          {succeeded ? text.running(spec.name) : text.failed(spec.name)}
        </p>
        {!succeeded && job.outcome !== null && <p className="small">{job.outcome}</p>}
        {!succeeded && job.output !== null && <PlainText text={job.output} />}
        {succeeded && proxyEntry !== null && (
          <p className="row small">
            <span className="muted">{text.inProxy(proxyOf(draft, spec.networks))}</span>{" "}
            <span className="mono">{proxyEntry}</span>
            <CopyButton text={proxyEntry} />
          </p>
        )}
        {succeeded && lanAddress !== null && (
          <p className="row small">
            <span className="muted">{text.onTheLan}</span> <span className="mono">{lanAddress}</span>
            <CopyButton text={lanAddress} />
          </p>
        )}
        {succeeded && spec.secrets.length > 0 && (
          <p className="small muted">{text.secretsWhere(`${spec.folder}/.env`)}</p>
        )}
        {!succeeded && <p className="small muted">{text.nothingElse(host.label, spec.folder)}</p>}
      </div>
      <div className="connect-host-foot">
        <TakeAway hostId={host.id} name={spec.name} folder={spec.folder} onDone={onClose} />
        <button type="button" className={succeeded && lanAddress !== null ? undefined : "primary"} onClick={onClose}>
          {text.close}
        </button>
        {succeeded && lanAddress !== null && (
          <a className="button primary" href={`http://${lanAddress}`} target="_blank" rel="noopener noreferrer">
            {text.open(spec.name)}
          </a>
        )}
      </div>
    </>
  );
}
