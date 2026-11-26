import { hasNewerVersion, type ContainerView } from "../../src/shared/api.js";
import { UPDATE_POLICY, UPDATE_STATUS } from "../../src/shared/constants.js";

/** Its last look at the registry failed: what it shows is what the one before found, and its reason says why. */
export const lastCheckFailed = ({ update }: ContainerView) =>
  update.reason !== null && (update.status === UPDATE_STATUS.current || update.status === UPDATE_STATUS.available);

// Checked, and found up to date by its last look: nothing less says so.
const foundCurrent = ({ update }: ContainerView) => update.status === UPDATE_STATUS.current && update.reason === null;

/** What a host's last checks know of its containers' images; the ones with updates off are never checked. */
export function imageChecks(containers: readonly ContainerView[]) {
  const watched = containers.filter(({ update }) => update.policy !== UPDATE_POLICY.off);
  const current = watched.filter(foundCurrent);
  const checkedAt = current.flatMap(({ update }) => (update.checkedAt === null ? [] : [update.checkedAt]));
  return {
    watched: watched.length,
    notChecked: watched.filter(({ update }) => update.status === null).length,
    failed: watched.filter(
      (container) => container.update.status === UPDATE_STATUS.unknown || lastCheckFailed(container),
    ).length,
    allCurrent: watched.length > 0 && current.length === watched.length && !watched.some(hasNewerVersion),
    // Every one of them was found up to date at least this recently.
    oldestCheckAt: checkedAt.length === 0 ? null : Math.min(...checkedAt),
  };
}
