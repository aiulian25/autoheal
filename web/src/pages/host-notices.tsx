import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { DETECTOR_THRESHOLDS, HOST_SECTIONS, TASK_RESOURCE, type TaskSnooze } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice, TimeAgo } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import { countInWords, listSeparator, percent } from "../format.js";
import { boardQuery, hostTasksQuery } from "../queries.js";
import { SnoozeChoices } from "../components/snooze-choices.js";
import { diskUsedPercent } from "./host-dial-values.js";

// Reached through a runner container of its own: older views name no kind.

/** This machine, while its runner waits to be looked after from Autoheal's own container: why, and what to do. */
export function InPlaceWaiting({ host }: { host: HostView }) {
  const problem = host.inPlace?.problem ?? null;
  if (problem === null) {
    return null;
  }
  return (
    <p className="notice warning small" role="status">
      {problem}
    </p>
  );
}

/** A list its Docker could not give this time: the containers below are as they were then, and say nothing of now. */
export function ContainersStale({ host }: { host: HostView }) {
  const since = host.containersStaleSince ?? null;
  if (since === null) {
    return null;
  }
  return (
    <p className="notice warning small" role="status">
      {TEXT.hosts.containersStale} <TimeAgo timestamp={since} />.
    </p>
  );
}

/** A report too large to send whole: what it left out is shown as last reported, and says nothing of now. */
export function ReportTrimmed({ host }: { host: HostView }) {
  const parts = host.reportTrimmed ?? [];
  if (parts.length === 0) {
    return null;
  }
  return (
    <p className="notice warning small" role="status">
      {TEXT.hosts.reportTrimmed(parts)}
    </p>
  );
}

/** The disks the tasks count as almost full, fullest first, in one sentence above everything else. */
export function DiskWarning({ host, admin }: { host: HostView; admin: boolean }) {
  const queryClient = useQueryClient();
  const tasks = useQuery(hostTasksQuery(host.id));
  const taskOf = (path: string) =>
    tasks.data?.find((task) => task.resource?.kind === TASK_RESOURCE.disk && task.resource.id === path);
  const full = (host.health?.disks ?? [])
    .map((disk) => ({ path: disk.path, used: diskUsedPercent(disk) }))
    .filter((disk) => disk.used >= DETECTOR_THRESHOLDS.diskPercent && !taskOf(disk.path)?.snoozedUntil)
    .sort((first, second) => second.used - first.used);
  const snooze = useMutation({
    mutationFn: (snoozed: TaskSnooze) =>
      Promise.all(
        full
          .flatMap((disk) => taskOf(disk.path) ?? [])
          .map((task) => api("PATCH", apiPath(API_ROUTES.task, { taskId: task.id }), { snoozed })),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
    },
  });
  if (full.length === 0) {
    return null;
  }
  const canSnooze = admin && full.every((disk) => taskOf(disk.path) !== undefined);
  return (
    <div className="banner danger" role="status">
      <Icon name="alert" />
      <p>
        {TEXT.hosts.disksAlmostFull(countInWords(full.length))}
        {full.map((disk, index) => (
          <Fragment key={disk.path}>
            {listSeparator(index, full.length)}
            <code>{disk.path}</code>
            {TEXT.hosts.diskAt(percent(disk.used))}
          </Fragment>
        ))}
        {TEXT.sentenceEnd}
      </p>
      {canSnooze && <SnoozeChoices disabled={snooze.isPending} onChoose={(length) => snooze.mutate(length)} />}
      <a href={`#${HOST_SECTIONS.overview}`}>{TEXT.hosts.seeDisks}</a>
      <ErrorNotice error={snooze.error} />
    </div>
  );
}
