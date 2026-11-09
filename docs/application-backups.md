# Application data backups

An application backup plan copies one application's Docker volumes, encrypted, when you ask or every few hours, and can put them back. It is a coordinated file backup, not a database dump, and it is separate from the dashboard's own database backup. Plans are in **Settings → Backups**, under **Application backup plans**, for admins.

A plan's host must be enrolled and heard from in the last few minutes, and its runner must report that it does application backups. Each backup is encrypted with a key of its own, which the dashboard keeps encrypted with the backup passphrase.

## What a plan covers

A plan names one container. Before every run, the host's runner finds every container that shares data with it, then every container that shares data with those: the writer group. A run stops, copies and starts the whole group, and refuses one that does not fit:

- At most 64 containers and 16 data mounts.
- Local Docker volumes only, with no driver options. Bind mounts, remote volumes and plugin volumes are refused: nothing could show that the group alone writes to them. **Create application plan** also asks you to confirm that no host process or outside export writes to them.
- Each container's stop timeout at most 30 seconds, and the running ones' at most five minutes together.
- At most 32 MiB of data and 100,000 files and folders per backup. Sockets, pipes, device files and a volume whose root is a symbolic link are refused, and so is a hard link shared with a file outside its volume.
- A protected container in the group refuses every run, and a host in dry-run refuses captures and restores.

A dashboard holds at most 32 plans and 512 MiB of application backups. A capture or a restore that could pass that is refused.

**Optional SQLite mount target** and **SQLite file within that mount** name one SQLite file: drills and restores run SQLite's own `integrity_check` on it, read-only. No other command, and no SQL, can be given.

## Capturing

**Capture application backup** takes one now; **Repeat every** so many hours (at least one) takes them on a schedule, and blank means only when asked. A capture turns off each container's restart policy, stops the running ones, and requires each to exit cleanly (exit code 0, not killed for memory). It checks that the group is still the same, then copies the volumes, and refuses the backup if any file changed meanwhile. Then it puts the restart policies back and starts the containers that were running. A schedule therefore means downtime.

The copy keeps numeric owners, permissions, timestamps, hard links, symbolic links, ACLs and extended attributes. It is made by a short-lived helper container from the runner's own image, with no network, a read-only root, every capability dropped and 128 MiB of memory. The unencrypted copy only exists in the helper's own memory-backed scratch folder: the helper encrypts the files and their manifest with age before anything leaves the host.

A run that its host's runner has not collected within 15 minutes is not run, and a host runs one application backup task at a time. A scheduled capture is refused while a maintenance window covers a container of the group, and one whose plan was paused or edited since is not run. A run asked for by someone who has lost admin access since is not run either.

## Where backups are kept

The dashboard keeps each backup in its `/data` folder, under `application-backups/`: `<id>.age.tar` is the encrypted backup, and `<id>.key.age` its key, encrypted with the backup passphrase. With `OFFBOX_BACKUP_DIRECTORY` set, both are copied there too. A plan made in the dashboard keeps its newest three backups, and one made through the API from one to eight, as each plan shows. An older one is deleted, its copies in the off-box folder too.

To restore, the dashboard needs the backup, its key and the backup passphrase. Keep all three.

## Isolated restore drill

**Run isolated restore drill** checks a backup without touching the application. The dashboard opens the backup's key with the passphrase and hands it to the host's runner, which decrypts the backup into new, temporary volumes. It checks every file's owner, permissions, time, size, links and content against the backup's own record, runs the SQLite check when the plan has one, and removes the temporary volumes. The application keeps running.

A backup that passed says **Isolated integrity drill passed**. Until then it says **Not yet restore-drilled**, and it cannot be restored.

## Restoring

**Review live restore** asks the runner for the writer group as it is now, and lists it: a restore stops every container listed and replaces all the data in their volumes. It goes ahead only if the group is the very one the backup was taken from (the same containers, volumes and mounts), the plan has not changed since, and you approve within a minute of the review, from the same sign-in: **I approve replacing this application's live data**, then **Restore reviewed application data**. After that minute, review again. A review approves one restore.

The restore then:

1. checks the backup again in isolated copies, as a drill does, before stopping anything;
2. turns off every container's restart policy and stops the running ones, each of which must exit cleanly;
3. takes a safety backup of the data as it is;
4. replaces all the data in the covered volumes with the backup's, and checks every file against the backup's record;
5. puts the restart policies back and starts the containers that were running.

Once the restore has succeeded, the safety backup is the plan's newest backup.

## When a run needs recovery

A restore that stops after the data was touched needs recovery: the group's containers stay stopped with their restart policies off, so nothing starts on half-restored data. So does a capture or a restore after which a container would not start again. Until the run is resumed, Autoheal does not heal the group, the host refuses other actions on it, and no other application task runs on it. A restore's safety backup is kept until then, marked **Retained for recovery**.

**Resume interrupted recovery** finishes a restore: it checks the backup again in isolated copies, replaces the data from it again and starts the containers. For a capture, it only starts the containers again; the backup is not taken again.

The runner records each task's progress in `autoheal-application-state-*` Docker volumes, labelled `autoheal.application-backup.journal`. These hold container names and IDs, never keys, mount sources or file names. It also works in temporary `autoheal-application-artifact-*`, `autoheal-application-download-*` and `autoheal-application-drill-*` volumes, and removes them when done. Do not prune any of these volumes while a task runs or needs recovery.
