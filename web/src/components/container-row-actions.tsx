import { lazy, Suspense, type ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";
import { type BulkAction, isStopped, targetsOf, type RowAction } from "../container-bulk.js";
import { JOB_ACTION, CONTAINER_STATE_PAUSED, CONTAINER_STATE_RUNNING } from "../../../src/shared/constants.js";
import type { ContainerView, HostView } from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import { actionPermission, type ResourceAction } from "../../../src/shared/resource-permissions.js";
import { Loading } from "./common.js";
import { ComposePanel } from "./compose-panel.js";
import { ContainerFiles } from "./container-files.js";
import { ContainerSettingsEditor } from "./container-settings.js";
import { type BackupDialogMode, BACKUP_DIALOG } from "../pages/container-backup.js";
import { useAskInPlace } from "./ask-in-place.js";
import type { Ask } from "./host-bulk-bar.js";

// The terminal and xterm.js load when a shell first opens: most visits never need them.
const ContainerTerminal = lazy(() =>
  import("../components/shell-terminal.js").then((module) => ({ default: module.ContainerTerminal })),
);
// --- each row's own buttons, and its ports -------------------------------------------------------------
// The row's buttons in order; one that does not fit the container is shown, but off.
function rowActionsOf(container: ContainerView): { action: BulkAction | typeof JOB_ACTION.rollBack; icon: IconName }[] {
  if (container.recovery !== undefined)
    return container.recovery.owner === container.name ? [{ action: JOB_ACTION.rollBack, icon: "rotateCw" }] : [];
  const paused = container.state === CONTAINER_STATE_PAUSED;
  return [
    { action: JOB_ACTION.restart, icon: "rotateCw" },
    paused ? { action: JOB_ACTION.unpause, icon: "play" } : { action: JOB_ACTION.pause, icon: "pause" },
    isStopped(container) ? { action: JOB_ACTION.start, icon: "play" } : { action: JOB_ACTION.stop, icon: "square" },
    { action: JOB_ACTION.remove, icon: "trash" },
  ];
}
// What opens under a row to reach inside its container: a shell, or its files. One at a time on the page.
const REACH = { shell: "shell", files: "files", settings: "settings", compose: "compose" } as const;
export type Reach = (typeof REACH)[keyof typeof REACH];
// Why a row's shell, files or settings are off: the host's .env, the host's rules, or, for a shell and files,
// nothing running to reach into. Settings stay open on a stopped container: a wrong one may be why it stopped.
function reachRefusal(host: HostView, container: ContainerView, needsRunning: boolean): string | null {
  if (!host.containerAccess) {
    return TEXT.hostContainers.reachOff;
  }
  if (container.handsOff !== null) {
    return TEXT.actions.handsOff[container.handsOff](host.label);
  }
  if (needsRunning && container.state !== CONTAINER_STATE_RUNNING) {
    return TEXT.hostContainers.reachStopped(container.name);
  }
  return null;
}
export const permissionOf = (reach: Reach): ResourceAction => {
  if (reach === REACH.shell) return "terminal";
  return reach === REACH.compose ? "settings" : reach;
};
// What opens under a row to reach inside its container.
export function ReachPanel({
  reach,
  hostId,
  containerName,
  composeProject,
  keptByHost,
  onClose,
}: {
  reach: Reach;
  hostId: string;
  containerName: string;
  composeProject: string | null;
  keptByHost: boolean;
  onClose: () => void;
}) {
  if (reach === REACH.compose && composeProject !== null) {
    return <ComposePanel hostId={hostId} project={composeProject} readOnly={keptByHost} onClose={onClose} />;
  }
  if (reach === REACH.shell) {
    return (
      <Suspense fallback={<Loading />}>
        <ContainerTerminal hostId={hostId} containerName={containerName} onClose={onClose} />
      </Suspense>
    );
  }
  if (reach === REACH.files) {
    return <ContainerFiles hostId={hostId} containerName={containerName} onClose={onClose} />;
  }
  return <ContainerSettingsEditor hostId={hostId} containerName={containerName} onClose={onClose} />;
}
// Under its row: the shell and settings the icons on the row open, by name.
export function PanelReach({
  host,
  container,
  reaching,
  files,
  onReach,
  allowed,
}: {
  host: HostView;
  container: ContainerView;
  reaching: Reach | null;
  files: ReactNode;
  onReach: (reach: Reach) => void;
  allowed: (action: ResourceAction) => boolean;
}) {
  const text = TEXT.containerDetails;
  const button = (reach: Reach, icon: IconName, label: string) => {
    if (!allowed(permissionOf(reach))) return null;
    const refusal = reachRefusal(host, container, reach !== REACH.settings);
    return (
      <button
        type="button"
        title={refusal ?? undefined}
        aria-pressed={reaching === reach}
        disabled={(refusal !== null && reaching !== reach) || container.recovery !== undefined}
        onClick={() => onReach(reach)}
      >
        <Icon name={icon} />
        {label}
      </button>
    );
  };
  return (
    <>
      {button(REACH.shell, "terminal", text.terminal)}
      {files}
      {button(REACH.settings, "pencil", text.editSettings)}
    </>
  );
}
export function RowActions({
  host,
  container,
  open,
  reaching,
  busy,
  ask,
  onToggle,
  onLogs,
  onReach,
  allowed,
  admin,
  onBackup,
}: {
  admin: boolean;
  onBackup: (mode: BackupDialogMode) => void;
  host: HostView;
  container: ContainerView;
  open: boolean;
  reaching: Reach | null;
  busy: boolean;
  ask: Ask;
  onToggle: () => void;
  onLogs: () => void;
  onReach: (reach: Reach) => void;
  allowed: (action: ResourceAction) => boolean;
}) {
  const text = TEXT.hostContainers;
  const asking = useAskInPlace();
  // Read only where the host keeps it to itself, so unlike the others it stays open then.
  const composeRefusal = () => {
    if (container.composeProject === null) return TEXT.stacks.noCompose;
    return host.containerAccess === false ? text.reachOff : null;
  };
  const composeLabel = TEXT.stacks.labels.compose(container.composeProject ?? container.name);
  const composeButton = allowed("settings") && (
    <button
      type="button"
      className="icon-button"
      title={composeRefusal() ?? composeLabel}
      aria-label={composeLabel}
      aria-pressed={reaching === REACH.compose}
      disabled={composeRefusal() !== null && reaching !== REACH.compose}
      onClick={() => onReach(REACH.compose)}
    >
      <Icon name="file" />
    </button>
  );
  const reachButton = (reach: Reach, icon: IconName, label: string) => {
    if (!allowed(permissionOf(reach))) return null;
    const refusal = reachRefusal(host, container, reach !== REACH.settings);
    return (
      <button
        type="button"
        className="icon-button"
        title={refusal ?? label}
        aria-label={label}
        aria-pressed={reaching === reach}
        disabled={(refusal !== null && reaching !== reach) || container.recovery !== undefined}
        onClick={() => onReach(reach)}
      >
        <Icon name={icon} />
      </button>
    );
  };
  const button = (action: RowAction, icon: IconName, enabled: boolean, onClick: () => void) => {
    const permission = actionPermission(action);
    if (permission === null || !allowed(permission)) return null;
    return (
      <button
        key={action}
        type="button"
        className={action === JOB_ACTION.remove ? "icon-button danger" : "icon-button"}
        title={TEXT.actions.names[action]}
        aria-label={text.rowAction(TEXT.actions.names[action], container.name)}
        disabled={busy || !enabled}
        onClick={onClick}
      >
        <Icon name={icon} />
      </button>
    );
  };
  // Its logs have a tab under the row, which reads them as it opens.
  const readLogs = () => {
    onLogs();
    if (!open) {
      onToggle();
    }
  };
  return (
    <span className="row-actions-icons" role="group" aria-label={TEXT.actions.label(container.name)}>
      {button(JOB_ACTION.logs, "fileText", true, readLogs)}
      {reachButton(REACH.shell, "terminal", text.shell(container.name))}
      {reachButton(REACH.files, "folder", text.files(container.name))}
      <button
        type="button"
        className="icon-button"
        title={text.stats(container.name)}
        aria-label={text.stats(container.name)}
        aria-pressed={open}
        onClick={onToggle}
      >
        <Icon name="eye" />
      </button>
      {reachButton(REACH.settings, "pencil", text.settings(container.name))}
      {composeButton}
      {admin && (
        <>
          <button
            type="button"
            className="icon-button"
            title={TEXT.containerBackup.rowBackUp(container.name)}
            aria-label={TEXT.containerBackup.rowBackUp(container.name)}
            disabled={busy}
            onClick={() => onBackup(BACKUP_DIALOG.backUp)}
          >
            <Icon name="archive" />
          </button>
          <button
            type="button"
            className="icon-button"
            title={TEXT.containerBackup.rowRestore(container.name)}
            aria-label={TEXT.containerBackup.rowRestore(container.name)}
            disabled={busy}
            onClick={() => onBackup(BACKUP_DIALOG.restore)}
          >
            <Icon name="history" />
          </button>
        </>
      )}
      {container.recovery !== undefined && (
        <span className="small text-warning" role="status">
          {TEXT.actions.recovery(container.recovery.owner)}
        </span>
      )}
      {rowActionsOf(container).map(({ action, icon }) =>
        button(
          action,
          icon,
          action === JOB_ACTION.rollBack ? container.handsOff === null : targetsOf(action, [container]).length > 0,
          () => {
            // Rolling back puts its data back as it was, and what changed since is lost: asked first.
            if (action !== JOB_ACTION.rollBack) {
              ask(action, [container]);
              return;
            }
            asking.confirm(TEXT.actions.confirmRollBack(container.name), () => ask(action, [container]));
          },
        ),
      )}
      {asking.question}
    </span>
  );
}
