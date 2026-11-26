import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath, type ContainerControlChange, type ContainerView } from "../../../src/shared/api.js";
import { JOB_ACTION } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { askFirstQuestion } from "../ask-first.js";
import { targetsOf, type useBulkAction } from "../container-bulk.js";
import { hostContainersQuery } from "../queries.js";
import type { useAskInPlace } from "./ask-in-place.js";
import { ticksOf } from "./container-table.js";
import type { Ask } from "./host-bulk-bar.js";

/**
 * What a host's containers table asks of the control plane: the owner's actions go as the tick bar's; an update or a
 * rollback is reviewed first, and a stop or a removal asked about first where this browser chose that. The choices a
 * row sets show at once.
 */
export function useContainerActions({
  hostId,
  admin,
  bulk,
  asking,
  onSaved,
}: {
  hostId: string;
  admin: boolean;
  bulk: ReturnType<typeof useBulkAction>;
  asking: Pick<ReturnType<typeof useAskInPlace>, "confirm">;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  // The update asked for by a row's icon, and the icon its small box opens from.
  const [updateAsked, setUpdateAsked] = useState<{ target: ContainerView; anchor: HTMLElement } | null>(null);
  const canUpdate = (container: ContainerView) => admin && targetsOf(JOB_ACTION.update, [container]).length > 0;
  const proceed: Ask = (action, targets) => {
    if (action === JOB_ACTION.update || action === JOB_ACTION.rollBack) bulk.review(action, targets);
    else bulk.run.mutate({ action, targets });
  };
  // A removal asks once first, and a stop where this browser chose that, for one row or the ticked ones alike.
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
    bulk.run.mutate({ action: JOB_ACTION.update, targets: [target], previews });
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
    updateAsked,
    setUpdateAsked,
    canUpdate,
    ask,
    updateConfirmed,
    choose,
  };
}
