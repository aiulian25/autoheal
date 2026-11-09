import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  API_ROUTES,
  apiPath,
  type ContainerControlChange,
  type ContainerView,
  type JobView,
} from "../../../src/shared/api.js";
import { JOB_ACTION } from "../../../src/shared/constants.js";
import { actionPermission, type ResourceAction } from "../../../src/shared/resource-permissions.js";
import { api } from "../api-client.js";
import { askFirstQuestion } from "../ask-first.js";
import { targetsOf, type RowAction, type useBulkAction } from "../container-bulk.js";
import { hostContainersQuery } from "../queries.js";
import type { useAskInPlace } from "./ask-in-place.js";
import { ticksOf } from "./container-table.js";
import type { Ask } from "./host-bulk-bar.js";

/**
 * What a host's containers table asks of the control plane. An admin's actions go as the tick bar's, anyone else's
 * one container at a time where their permissions reach; an update or a rollback is reviewed first, and a stop or a
 * removal asked about first where this browser chose that. The choices a row sets show at once.
 */
export function useContainerActions({
  hostId,
  admin,
  allowed,
  bulk,
  asking,
  clearTicks,
  onSaved,
}: {
  hostId: string;
  admin: boolean;
  allowed: (action: ResourceAction, container: ContainerView) => boolean;
  bulk: ReturnType<typeof useBulkAction>;
  asking: Pick<ReturnType<typeof useAskInPlace>, "confirm">;
  clearTicks: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [operatorReview, setOperatorReview] = useState<{
    action: typeof JOB_ACTION.update | typeof JOB_ACTION.rollBack;
    target: ContainerView;
  } | null>(null);
  // The update asked for by a row's icon, and the icon its small box opens from.
  const [updateAsked, setUpdateAsked] = useState<{ target: ContainerView; anchor: HTMLElement } | null>(null);
  const canUpdate = (container: ContainerView) => {
    const permission = actionPermission(JOB_ACTION.update);
    return (
      permission !== null && allowed(permission, container) && targetsOf(JOB_ACTION.update, [container]).length > 0
    );
  };
  const operatorAction = useMutation({
    mutationFn: ({ action, target, previewId }: { action: RowAction; target: ContainerView; previewId?: string }) =>
      api<JobView>("POST", apiPath(API_ROUTES.containerActions, { hostId: hostId, containerName: target.name }), {
        action,
        ...(previewId ? { previewId } : {}),
      }),
    onSuccess: () => {
      clearTicks();
      void queryClient.invalidateQueries({ queryKey: ["jobs", hostId] });
      void queryClient.invalidateQueries({ queryKey: ["containers", hostId] });
    },
  });
  const proceed: Ask = (action, targets) => {
    if (admin) {
      if (action === JOB_ACTION.update || action === JOB_ACTION.rollBack) bulk.review(action, targets);
      else bulk.run.mutate({ action, targets });
      return;
    }
    const target = targets[0];
    const permission = actionPermission(action);
    if (targets.length === 1 && target && permission !== null && allowed(permission, target)) {
      if (action === JOB_ACTION.update || action === JOB_ACTION.rollBack) setOperatorReview({ action, target });
      else operatorAction.mutate({ action, target });
    }
  };
  // A stop or a removal asks once first where this browser chose that, for one row or the ticked ones alike.
  const ask: Ask = (action, targets) => {
    const question = askFirstQuestion(
      action,
      targets.map((target) => target.name),
    );
    if (question === null) {
      proceed(action, targets);
      return;
    }
    asking.confirm(question, () => proceed(action, targets));
  };
  const updateConfirmed = (target: ContainerView, previews: Record<string, string>) => {
    setUpdateAsked(null);
    if (admin) bulk.run.mutate({ action: JOB_ACTION.update, targets: [target], previews });
    else operatorAction.mutate({ action: JOB_ACTION.update, target, previewId: previews[target.name] });
  };
  const choose = useMutation({
    mutationFn: (change: ContainerControlChange) =>
      api<void>("PUT", apiPath(API_ROUTES.containerControls, { hostId: hostId }), change),
    // The choice shows at once; the list follows what the control plane kept.
    onMutate: (change) =>
      queryClient.setQueryData<ContainerView[]>(hostContainersQuery(hostId).queryKey, (current) =>
        current?.map((container) =>
          change.names.includes(container.name)
            ? { ...container, byItself: { ...container.byItself, ...ticksOf(change) } }
            : container,
        ),
      ),
    onSuccess: () => onSaved(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });
  return {
    operatorReview,
    setOperatorReview,
    updateAsked,
    setUpdateAsked,
    canUpdate,
    operatorAction,
    ask,
    updateConfirmed,
    choose,
  };
}
