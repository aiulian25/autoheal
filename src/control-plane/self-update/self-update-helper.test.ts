import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, containerIdOf } from "../../../test/fakes/fake-docker-engine.js";
import { runningContainer } from "../../../test/support/embedded-ssh-host.js";
import { DockerClient } from "../../runner/docker-client.js";
import {
  DATABASE_FILE_NAME,
  EXIT_FAILURE,
  EXIT_USAGE,
  SELF_UPDATE,
  SELF_UPDATE_PHASE,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_TEXT,
  SELF_UPDATE_UNREADABLE,
} from "../../shared/constants.js";
import { runSelfUpdate } from "../../commands/self-update.js";
import { SelfUpdateDatabaseFiles, type SelfUpdateDatabase } from "./self-update-database.js";
import { selfUpdate, type SelfUpdateTiming } from "./self-update-helper.js";
import { SelfUpdateOutcomeFile, outcomeIn, type JournalledOutcome } from "./self-update-outcome.js";

const NAME = "autoheal-control-plane";
const PREVIOUS = `${NAME}-autoheal-previous`;
const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `sha256:${"2".repeat(64)}`;
// What an earlier update, never finished, was moving to.
const EARLIER_IMAGE = `sha256:${"3".repeat(64)}`;
const TIMING: SelfUpdateTiming = { healthyWithinMilliseconds: 400, watchMilliseconds: 300, pollMilliseconds: 20 };

describe("Autoheal's update helper", () => {
  let engine: FakeDockerEngine;
  let steps: JournalledOutcome[];
  let data: string;
  let path: string;
  let events: string[];

  const schema = (next?: number) => {
    const sqlite = new Database(path);
    if (next !== undefined) sqlite.pragma(`user_version = ${next}`);
    const version = sqlite.pragma("user_version", { simple: true });
    sqlite.close();
    return version;
  };
  const OLD_SCHEMA = 48;
  const NEW_SCHEMA = 49;

  beforeEach(async () => {
    data = mkdtempSync(join(tmpdir(), "autoheal-self-update-helper-"));
    path = join(data, DATABASE_FILE_NAME);
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec("CREATE TABLE kept (note TEXT)");
    sqlite.close();
    schema(OLD_SCHEMA);
    events = [];
    engine = await FakeDockerEngine.start();
    engine.add(
      runningContainer(NAME, {
        Id: containerIdOf(NAME),
        Image: OLD_IMAGE,
        Config: {
          Image: "autoheal:local",
          Env: ["PUBLIC_BASE_URL=https://autoheal.example.org"],
          Labels: { "com.docker.compose.service": "control-plane" },
          Tty: false,
          Cmd: ["control-plane"],
        },
        HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock"], RestartPolicy: { Name: "unless-stopped" } },
      }),
    );
    engine.imageLabels.set(OLD_IMAGE, {});
    steps = [];
  });

  afterEach(async () => {
    await engine.close();
    rmSync(data, { recursive: true, force: true });
  });

  // Docker as the helper finds it, noting the order of what matters; the new image migrates as it starts.
  class WatchedDocker extends DockerClient {
    migrates = false;
    // The image whose container will not stop when asked.
    stubborn: string | null = null;

    override async stop(reference: string, grace: number) {
      const image = engine.containers.get(reference)?.Image;
      events.push(`stop ${image}`);
      if (image === this.stubborn) return;
      return super.stop(reference, grace);
    }

    override async start(reference: string) {
      const image = engine.containers.get(reference)?.Image;
      events.push(`start ${image} on ${schema()}`);
      if (image === NEW_IMAGE && this.migrates) schema(NEW_SCHEMA);
      await super.start(reference);
      if (image === NEW_IMAGE && this.stubborn === NEW_IMAGE) {
        // Up, but never healthy: the case where something could still be writing.
        const container = engine.containers.get(reference)!;
        container.State = { ...container.State, Running: true, Health: { Status: "unhealthy" } };
      }
    }
  }
  const watchedDatabase = (): SelfUpdateDatabase => {
    const files = new SelfUpdateDatabaseFiles(data);
    return {
      snapshot: () => {
        events.push("snapshot");
        return files.snapshot();
      },
      needsRestore: (snapshot) => files.needsRestore(snapshot),
      restoreIfNeeded: (snapshot) => {
        events.push("restore?");
        return files.restoreIfNeeded(snapshot);
      },
      discard: (snapshot) => files.discard(snapshot),
    };
  };
  const snapshotFile = () => join(data, SELF_UPDATE.snapshotFile);
  const REQUEST = { container: containerIdOf(NAME), image: NEW_IMAGE, reference: "autoheal:local" };
  const update = (
    docker: DockerClient = new WatchedDocker(engine.socketPath),
    earlier: JournalledOutcome | null = null,
    database: SelfUpdateDatabase = watchedDatabase(),
  ) => selfUpdate(docker, REQUEST, (step) => steps.push(step), database, earlier, TIMING);
  // Each phase is recorded as it begins, so one status can be written more than once.
  const statuses = () => steps.map(({ status }) => status).filter((status, index, all) => status !== all[index - 1]);
  const lastStep = () => steps.at(-1)!;

  it("replaces the control plane's container on the new image, with what it was given, and removes the old once it held", async () => {
    const outcome = await update();
    expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.succeeded, from: OLD_IMAGE, to: NEW_IMAGE });
    expect(statuses()).toEqual([
      SELF_UPDATE_STATUS.updating,
      SELF_UPDATE_STATUS.watching,
      SELF_UPDATE_STATUS.succeeded,
    ]);
    const now = engine.containers.get(NAME)!;
    expect(now).toMatchObject({ Image: NEW_IMAGE, State: { Running: true } });
    // Its settings came across: environment, labels, mounts and restart policy.
    const made = engine.creations.find(({ name }) => name === NAME)!.specification;
    expect(made).toMatchObject({
      Image: NEW_IMAGE,
      Env: ["PUBLIC_BASE_URL=https://autoheal.example.org"],
      Labels: { "com.docker.compose.service": "control-plane", [SELF_UPDATE.referenceLabel]: "autoheal:local" },
      HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock"], RestartPolicy: { Name: "unless-stopped" } },
    });
    expect(engine.containers.has(PREVIOUS)).toBe(false);
  });

  describe("when Docker will not park the original under its kept name", () => {
    // Only the rename that parks the original is troublesome; putting it back afterwards still works.
    const parking = (to: string) => to === PREVIOUS;
    // Refuses before it does anything, as a name conflict does.
    class RefusingRename extends WatchedDocker {
      override async rename(from: string, to: string) {
        if (!parking(to)) return super.rename(from, to);
        events.push(`rename refused ${from}`);
        throw new Error(`conflict: a container named ${to} is already in use`);
      }
    }
    // Renames, then loses the answer: Docker did it, the helper only hears that it failed.
    class LostRenameAnswer extends WatchedDocker {
      override async rename(from: string, to: string) {
        await super.rename(from, to);
        if (!parking(to)) return;
        events.push(`rename done, answer lost ${from}`);
        throw new Error("socket hang up");
      }
    }

    it("puts the original back and says the update failed, rather than leaving it stopped", async () => {
      const outcome = await update(new RefusingRename(engine.socketPath));

      expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.failed, from: OLD_IMAGE, to: NEW_IMAGE });
      expect(outcome.message).toContain("already in use");
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
      // Its data was never touched, so nothing is put back and nothing says it was.
      expect(outcome.message).not.toContain(SELF_UPDATE_TEXT.dataRestored);
      expect(schema()).toBe(OLD_SCHEMA);
      // The original holds the name it always held: it is never removed to make room.
      expect(engine.removals).not.toContain(NAME);
      expect(engine.containers.has(PREVIOUS)).toBe(false);
      expect(lastStep()).toMatchObject({ status: SELF_UPDATE_STATUS.failed, recovery: null });
    });

    it("tells a rename Docker carried out from one it refused, and brings that original back under its name", async () => {
      const outcome = await update(new LostRenameAnswer(engine.socketPath));

      expect(outcome.status).toBe(SELF_UPDATE_STATUS.failed);
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
      expect(engine.containers.get(NAME)!.Id).toBe(containerIdOf(NAME));
      expect(engine.containers.has(PREVIOUS)).toBe(false);
      expect(engine.removals).not.toContain(NAME);
    });

    it("says it is blocked, keeping the copy, when the original cannot be brought back", async () => {
      // Start is accepted and the container still does not run: the case a bare start() would call a success.
      class RefusingRestart extends RefusingRename {
        override async start(reference: string) {
          if (engine.containers.get(reference)?.Image === OLD_IMAGE) {
            events.push("start ignored");
            return;
          }
          return super.start(reference);
        }
      }

      const outcome = await update(new RefusingRestart(engine.socketPath));

      expect(outcome.status).toBe(SELF_UPDATE_STATUS.blocked);
      expect(outcome.message).toContain("did not start");
      expect(outcome.finishedAt).toBeNull();
      // Blocked is not an ending: the copy and what a later helper needs to take it up are both kept.
      expect(existsSync(snapshotFile())).toBe(true);
      expect(lastStep().recovery).toMatchObject({ phase: SELF_UPDATE_PHASE.rollingBack, name: NAME });
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
    });
  });

  it("starts the old one again when the new one never becomes healthy", async () => {
    engine.failingImages.add(NEW_IMAGE);
    const outcome = await update();
    expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.rolledBack, message: SELF_UPDATE_TEXT.notHealthy });
    expect(statuses()).toEqual([SELF_UPDATE_STATUS.updating, SELF_UPDATE_STATUS.rolledBack]);
    expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    expect(engine.containers.has(PREVIOUS)).toBe(false);
  });

  it("starts the old one again when the new one stops being healthy within the watch", async () => {
    const outcome = await selfUpdate(
      new DockerClient(engine.socketPath),
      { container: containerIdOf(NAME), image: NEW_IMAGE, reference: "autoheal:local" },
      (step) => {
        steps.push(step);
        // Healthy at first, then down while it is watched.
        if (step.status === SELF_UPDATE_STATUS.watching) {
          engine.containers.get(NAME)!.State = {
            Status: "exited",
            Running: false,
            ExitCode: 1,
            OOMKilled: false,
            Error: "",
          };
        }
      },
      watchedDatabase(),
      null,
      TIMING,
    );
    expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.rolledBack, message: SELF_UPDATE_TEXT.didNotHold });
    expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    expect(engine.containers.has(PREVIOUS)).toBe(false);
  });

  describe("the database, when the new version migrated it and then failed", () => {
    const migrating = () => {
      const docker = new WatchedDocker(engine.socketPath);
      docker.migrates = true;
      engine.failingImages.add(NEW_IMAGE);
      return docker;
    };

    it("stops the new one, puts the copy back, and only then starts the old one", async () => {
      const outcome = await update(migrating());

      expect(outcome.status).toBe(SELF_UPDATE_STATUS.rolledBack);
      expect(outcome.message).toContain(SELF_UPDATE_TEXT.dataRestored);
      expect(schema()).toBe(OLD_SCHEMA);
      expect(events).toEqual([
        `stop ${OLD_IMAGE}`,
        "snapshot",
        `start ${NEW_IMAGE} on ${OLD_SCHEMA}`,
        `stop ${NEW_IMAGE}`,
        "restore?",
        `start ${OLD_IMAGE} on ${OLD_SCHEMA}`,
      ]);
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
      expect(existsSync(snapshotFile())).toBe(true);
      expect(engine.removals).toContain(NAME);
    });

    it("says the database went back before the file moves, so the old version settles what it dispatched", async () => {
      const marked: string[] = [];
      const docker = migrating();
      const files = new SelfUpdateDatabaseFiles(data);
      const watching: SelfUpdateDatabase = {
        snapshot: () => files.snapshot(),
        needsRestore: (snapshot) => files.needsRestore(snapshot),
        restoreIfNeeded: (snapshot) => {
          // What the record already said by the time the file is about to move.
          marked.push(`restoring, dataRestored=${String(steps.at(-1)!.dataRestored)}`);
          return files.restoreIfNeeded(snapshot);
        },
        discard: (snapshot) => files.discard(snapshot),
      };

      const outcome = await update(docker, null, watching);

      expect(outcome.status).toBe(SELF_UPDATE_STATUS.rolledBack);
      expect(marked).toEqual(["restoring, dataRestored=true"]);
      // And it is still said on the record the old control plane reads when it comes up.
      expect(steps.at(-1)).toMatchObject({ dataRestored: true, recovery: null });
      // The old container is only started after that promise is on disk.
      expect(events.indexOf(`start ${OLD_IMAGE} on ${OLD_SCHEMA}`)).toBeGreaterThan(
        events.indexOf("stop " + NEW_IMAGE),
      );
    });

    it("says nothing of the sort when the schema did not move and the file was kept", async () => {
      engine.failingImages.add(NEW_IMAGE);
      const outcome = await update();
      expect(outcome.status).toBe(SELF_UPDATE_STATUS.rolledBack);
      expect(steps.at(-1)!.dataRestored).toBe(false);
    });

    it("keeps its promise across a helper that died mid-restore, which would find nothing left to put back", async () => {
      const files = new SelfUpdateDatabaseFiles(data);
      const died: SelfUpdateDatabase = {
        snapshot: () => files.snapshot(),
        needsRestore: (snapshot) => files.needsRestore(snapshot),
        restoreIfNeeded: (snapshot) => {
          files.restoreIfNeeded(snapshot);
          throw new Error("helper died");
        },
        discard: (snapshot) => files.discard(snapshot),
      };
      const stopped = await update(migrating(), null, died);
      expect(stopped.status).toBe(SELF_UPDATE_STATUS.blocked);
      const interrupted = steps.at(-1)!;
      expect(interrupted.dataRestored).toBe(true);

      // The next helper finds the file already on the old schema, so it has nothing to restore; the promise stands.
      steps.length = 0;
      const resumed = await update(new WatchedDocker(engine.socketPath), interrupted);
      expect(steps.at(-1)!.dataRestored).toBe(true);
      expect(resumed.status).not.toBe(SELF_UPDATE_STATUS.updating);
    });

    it("leaves none of the new version's journal files beside the file it put back", async () => {
      await update(migrating());
      expect(existsSync(`${path}-wal`)).toBe(false);
      const sqlite = new Database(path);
      expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
      sqlite.close();
    });

    it("keeps what was written when the schema did not change, as the old version can read it", async () => {
      engine.failingImages.add(NEW_IMAGE);
      class Writing extends WatchedDocker {
        override async start(reference: string) {
          if (engine.containers.get(reference)?.Image === NEW_IMAGE) {
            const sqlite = new Database(path);
            sqlite.exec("INSERT INTO kept VALUES ('written by the new one')");
            sqlite.close();
          }
          return super.start(reference);
        }
      }
      const outcome = await update(new Writing(engine.socketPath));
      expect(outcome.message).not.toContain(SELF_UPDATE_TEXT.dataRestored);
      const sqlite = new Database(path);
      expect(sqlite.prepare("SELECT count(*) AS rows FROM kept").get()).toEqual({ rows: 1 });
      sqlite.close();
    });

    it("puts a damaged file back too, even on the same schema", async () => {
      engine.failingImages.add(NEW_IMAGE);
      class Damaging extends WatchedDocker {
        override async start(reference: string) {
          if (engine.containers.get(reference)?.Image === NEW_IMAGE) writeFileSync(path, "not a database");
          return super.start(reference);
        }
      }
      await update(new Damaging(engine.socketPath), null);
      expect(schema()).toBe(OLD_SCHEMA);
    });

    it("starts nothing when the new one will not stop, and goes on from there when asked again", async () => {
      const docker = new WatchedDocker(engine.socketPath);
      docker.migrates = true;
      docker.stubborn = NEW_IMAGE;
      const blocked = await update(docker);

      expect(blocked.status).toBe(SELF_UPDATE_STATUS.blocked);
      expect(schema()).toBe(NEW_SCHEMA);
      expect(engine.containers.get(PREVIOUS)!.State.Running).toBe(false);
      expect(existsSync(snapshotFile())).toBe(true);
      expect(lastStep().recovery).toMatchObject({
        phase: SELF_UPDATE_PHASE.rollingBack,
        original: containerIdOf(NAME),
        name: NAME,
        snapshot: { schemaVersion: OLD_SCHEMA },
      });

      const again = await update(new WatchedDocker(engine.socketPath), lastStep());
      expect(again.status).toBe(SELF_UPDATE_STATUS.rolledBack);
      expect(schema()).toBe(OLD_SCHEMA);
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
      expect(engine.containers.has(PREVIOUS)).toBe(false);
    });

    it("starts nothing when the copy cannot be put back", async () => {
      const files = new SelfUpdateDatabaseFiles(data);
      const outcome = await update(migrating(), null, {
        ...watchedDatabase(),
        snapshot: () => files.snapshot(),
        restoreIfNeeded: () => {
          throw new Error("disk full");
        },
      });
      expect(outcome.status).toBe(SELF_UPDATE_STATUS.blocked);
      expect(outcome.message).toContain("disk full");
      expect(engine.containers.get(PREVIOUS)!.State.Running).toBe(false);
    });
  });

  describe("when its old container is gone by the time the new one fails, as a docker compose up removes it", () => {
    it("leaves what runs as it is, with its database, rather than taking it down with nothing to go back to", async () => {
      const docker = new WatchedDocker(engine.socketPath);
      docker.migrates = true;
      engine.failingImages.add(NEW_IMAGE);
      // Taken away from outside the update, as Compose takes a spare copy of its service, just before it goes back.
      const removedFromOutside = (step: JournalledOutcome) => {
        steps.push(step);
        if (step.recovery?.phase === SELF_UPDATE_PHASE.rollingBack) engine.containers.delete(PREVIOUS);
      };

      const outcome = await selfUpdate(docker, REQUEST, removedFromOutside, watchedDatabase(), null, TIMING);

      expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.failed, message: SELF_UPDATE_TEXT.nothingToGoBackTo });
      // The new one was neither stopped nor removed, and its database was not put back.
      expect(events).toEqual([`stop ${OLD_IMAGE}`, "snapshot", `start ${NEW_IMAGE} on ${OLD_SCHEMA}`]);
      expect(engine.removals).not.toContain(NAME);
      expect(schema()).toBe(NEW_SCHEMA);
      // The copy from before the update is kept, and the record is finished: there is nothing to take up.
      expect(existsSync(snapshotFile())).toBe(true);
      expect(lastStep()).toMatchObject({ status: SELF_UPDATE_STATUS.failed, recovery: null, dataRestored: false });
    });
  });

  describe("before anything is replaced", () => {
    it("does not touch the database or the name while the old one still runs", async () => {
      const docker = new WatchedDocker(engine.socketPath);
      docker.stubborn = OLD_IMAGE;
      const outcome = await update(docker);
      expect(outcome.status).toBe(SELF_UPDATE_STATUS.failed);
      expect(events).not.toContain("snapshot");
      expect(engine.creations).toEqual([]);
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });

    it("starts the old one again when the copy cannot be made", async () => {
      const outcome = await update(new WatchedDocker(engine.socketPath), null, {
        ...watchedDatabase(),
        snapshot: () => Promise.reject(new Error("disk full")),
      });
      expect(outcome).toMatchObject({
        status: SELF_UPDATE_STATUS.failed,
        message: SELF_UPDATE_TEXT.helperFailed("disk full"),
      });
      expect(engine.creations).toEqual([]);
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });

    it("copies what was only in the journal, with the snapshot owner-only", async () => {
      const writer = new Database(path);
      writer.pragma("wal_autocheckpoint = 0");
      writer.exec("INSERT INTO kept VALUES ('only in the journal')");
      const snapshot = await new SelfUpdateDatabaseFiles(data).snapshot();
      writer.close();
      const copy = new Database(snapshot.path, { readonly: true });
      expect(copy.prepare("SELECT count(*) AS rows FROM kept").get()).toEqual({ rows: 1 });
      copy.close();
      expect(readFileSync(snapshot.path).length).toBeGreaterThan(0);
    });
  });

  it("starts a new update with nothing of an earlier one's database going back", async () => {
    const earlier: JournalledOutcome = {
      status: SELF_UPDATE_STATUS.rolledBack,
      from: OLD_IMAGE,
      to: EARLIER_IMAGE,
      reference: "autoheal:local",
      startedAt: 1,
      finishedAt: 2,
      message: `${SELF_UPDATE_TEXT.notHealthy} ${SELF_UPDATE_TEXT.dataRestored}`,
      recovery: null,
      dataRestored: true,
    };

    await update(new WatchedDocker(engine.socketPath), earlier);

    // Else the version it brings would settle work as if its own database had gone back.
    expect(steps.map(({ dataRestored }) => dataRestored)).not.toContain(true);
  });

  it("removes the old container and the copy only once the new one has held, and never by force", async () => {
    await update();
    expect(existsSync(snapshotFile())).toBe(false);
    expect(engine.removals).toContain(PREVIOUS);
    expect(engine.removals.filter((removal) => removal.includes("force"))).toEqual([]);
    expect(lastStep().recovery).toBeNull();
    expect(lastStep().finishedAt).not.toBeNull();
  });

  describe("taking up an update that stopped partway", () => {
    const stopPartway = async () => {
      const snapshot = await new SelfUpdateDatabaseFiles(data).snapshot();
      const old = engine.containers.get(NAME)!;
      old.State = { ...old.State, Status: "exited", Running: false };
      engine.containers.delete(NAME);
      engine.containers.set(PREVIOUS, { ...old, Name: `/${PREVIOUS}` });
      return {
        status: SELF_UPDATE_STATUS.updating,
        from: OLD_IMAGE,
        to: NEW_IMAGE,
        reference: "autoheal:local",
        startedAt: 1,
        finishedAt: null,
        message: SELF_UPDATE_TEXT.started,
        recovery: {
          version: SELF_UPDATE.recoveryVersion,
          phase: SELF_UPDATE_PHASE.replacing,
          original: containerIdOf(NAME),
          name: NAME,
          snapshot,
        },
      } as const;
    };

    it("watches a new one that is healthy, and finishes it", async () => {
      const earlier = await stopPartway();
      engine.add(runningContainer(NAME, { Image: NEW_IMAGE }));
      schema(NEW_SCHEMA);

      const outcome = await update(new WatchedDocker(engine.socketPath), {
        ...earlier,
        recovery: { ...earlier.recovery },
      });
      expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.succeeded, from: OLD_IMAGE, startedAt: 1 });
      expect(engine.containers.has(PREVIOUS)).toBe(false);
      expect(schema()).toBe(NEW_SCHEMA);
    });

    it("goes back when no new one was made, with the database as the old one needs it", async () => {
      const earlier = await stopPartway();
      schema(NEW_SCHEMA);
      const outcome = await update(new WatchedDocker(engine.socketPath), {
        ...earlier,
        recovery: { ...earlier.recovery },
      });
      expect(outcome.status).toBe(SELF_UPDATE_STATUS.rolledBack);
      expect(schema()).toBe(OLD_SCHEMA);
      expect(engine.containers.get(NAME)).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });

    it("finishes when the old one was already removed and the new one runs", async () => {
      const earlier = await stopPartway();
      engine.containers.delete(PREVIOUS);
      engine.add(runningContainer(NAME, { Image: NEW_IMAGE }));
      const outcome = await update(new WatchedDocker(engine.socketPath), {
        ...earlier,
        recovery: { ...earlier.recovery },
      });
      expect(outcome.status).toBe(SELF_UPDATE_STATUS.succeeded);
      expect(existsSync(snapshotFile())).toBe(false);
    });

    it("says it went back and a container started elsewhere runs, never that the new one held", async () => {
      const earlier = await stopPartway();
      engine.containers.delete(PREVIOUS);
      engine.add(runningContainer(NAME, { Image: NEW_IMAGE }));
      // A helper that put the database back, then found no old container to bring back.
      const wentBack = {
        ...earlier,
        status: SELF_UPDATE_STATUS.blocked,
        dataRestored: true,
        recovery: { ...earlier.recovery, phase: SELF_UPDATE_PHASE.rollingBack, original: containerIdOf("gone") },
      };

      const outcome = await update(new WatchedDocker(engine.socketPath), wentBack);

      expect(outcome).toMatchObject({
        status: SELF_UPDATE_STATUS.failed,
        message: `${SELF_UPDATE_TEXT.startedOutside} ${SELF_UPDATE_TEXT.dataRestored}`,
      });
      expect(lastStep()).toMatchObject({ recovery: null, dataRestored: true });
      expect(engine.containers.get(NAME)).toMatchObject({ Image: NEW_IMAGE, State: { Running: true } });
    });

    it("keeps the mark that its database going back was settled, as each step is written over the last", async () => {
      const outcomes = new SelfUpdateOutcomeFile(data);
      outcomes.write(
        {
          status: SELF_UPDATE_STATUS.blocked,
          from: OLD_IMAGE,
          to: NEW_IMAGE,
          reference: "autoheal:local",
          startedAt: 1,
          finishedAt: null,
          message: SELF_UPDATE_TEXT.interrupted,
          recovery: {
            version: SELF_UPDATE.recoveryVersion,
            phase: SELF_UPDATE_PHASE.rollingBack,
            original: containerIdOf("gone"),
            name: NAME,
            snapshot: null,
          },
          dataRestored: true,
        },
        { settled: true },
      );

      // As the helper's command writes them, on Docker as these tests fake it.
      await selfUpdate(
        new WatchedDocker(engine.socketPath),
        REQUEST,
        (step) => outcomes.write(step),
        watchedDatabase(),
        outcomeIn(outcomes.read()),
        TIMING,
      );

      // Its next start must not close the work handed out since, as a second settling would.
      expect(outcomeIn(outcomes.read())).toMatchObject({ status: SELF_UPDATE_STATUS.failed, settled: true });
    });

    it("says so when neither is there, rather than claiming anything", async () => {
      const earlier = await stopPartway();
      engine.containers.delete(PREVIOUS);
      const outcome = await update(new WatchedDocker(engine.socketPath), {
        ...earlier,
        recovery: { ...earlier.recovery },
      });
      expect(outcome.status).toBe(SELF_UPDATE_STATUS.blocked);
    });

    describe("one to another image, as a runner's next update finds it", () => {
      it("goes ahead once its old container is gone, as a docker compose up by hand leaves it", async () => {
        // A helper that found nothing to go back to; the container was brought up by hand since.
        const stuck: JournalledOutcome = {
          status: SELF_UPDATE_STATUS.blocked,
          from: OLD_IMAGE,
          to: EARLIER_IMAGE,
          reference: "autoheal:local",
          startedAt: 1,
          finishedAt: null,
          message: SELF_UPDATE_TEXT.blocked("no such container"),
          recovery: {
            version: SELF_UPDATE.recoveryVersion,
            phase: SELF_UPDATE_PHASE.rollingBack,
            original: containerIdOf("gone"),
            name: NAME,
            snapshot: null,
          },
          dataRestored: false,
        };

        const outcome = await update(new WatchedDocker(engine.socketPath), stuck);

        expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.succeeded, from: OLD_IMAGE, to: NEW_IMAGE });
        expect(steps[0]!.startedAt).not.toBe(1);
        expect(engine.containers.get(NAME)).toMatchObject({ Image: NEW_IMAGE, State: { Running: true } });
      });

      it("goes ahead once its old container is back under its name", async () => {
        const earlier = await stopPartway();
        const parked = engine.containers.get(PREVIOUS)!;
        engine.containers.delete(PREVIOUS);
        engine.add({ ...parked, Name: `/${NAME}`, State: { ...parked.State, Status: "running", Running: true } });

        const outcome = await update(new WatchedDocker(engine.socketPath), {
          ...earlier,
          status: SELF_UPDATE_STATUS.blocked,
          to: EARLIER_IMAGE,
          recovery: { ...earlier.recovery, phase: SELF_UPDATE_PHASE.rollingBack },
        });

        expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.succeeded, from: OLD_IMAGE, to: NEW_IMAGE });
      });

      it("removes the old container it kept aside, never by force, once a healthy one holds the name", async () => {
        const earlier = await stopPartway();
        // That update's new container, which has run since: the one this update replaces.
        engine.add(runningContainer(NAME, { Id: containerIdOf("earlier-new"), Image: EARLIER_IMAGE }));

        const outcome = await update(new WatchedDocker(engine.socketPath), {
          ...earlier,
          to: EARLIER_IMAGE,
          recovery: { ...earlier.recovery },
        });

        expect(outcome).toMatchObject({ status: SELF_UPDATE_STATUS.succeeded, from: EARLIER_IMAGE, to: NEW_IMAGE });
        expect([...engine.containers.values()].map(({ Image }) => Image)).toEqual([NEW_IMAGE]);
        expect(engine.removals.filter((removal) => removal.includes("force"))).toEqual([]);
      });

      it("starts nothing while its old container is kept aside with nothing healthy in its place", async () => {
        const earlier = await stopPartway();

        await expect(
          update(new WatchedDocker(engine.socketPath), {
            ...earlier,
            to: EARLIER_IMAGE,
            recovery: { ...earlier.recovery },
          }),
        ).rejects.toThrow(SELF_UPDATE_TEXT.earlierUnfinished(EARLIER_IMAGE));
        expect(engine.containers.get(PREVIOUS)).toMatchObject({ Image: OLD_IMAGE });
        expect(engine.creations).toEqual([]);
        expect(steps).toEqual([]);
      });
    });
  });

  // The helper runs with the Docker socket, so the block that stops the control plane has to stop it too.
  describe("the command the helper container runs", () => {
    const SECRET = "a-passphrase-nobody-should-see";
    const ARGUMENTS = [containerIdOf(NAME), NEW_IMAGE, "autoheal:local"];
    const said: string[] = [];
    const output = { log: (line: string) => said.push(line), error: (line: string) => said.push(line) };

    beforeEach(() => {
      said.length = 0;
    });

    it.each([
      ["bytes that are not JSON", `{ ${SECRET}`, SELF_UPDATE_UNREADABLE.notJson],
      ["JSON that is not a record", JSON.stringify({ kept: SECRET }), SELF_UPDATE_UNREADABLE.notTheShape],
    ])("stops before it touches Docker where the record cannot be read: %s", async (_case, body, reason) => {
      writeFileSync(join(data, SELF_UPDATE.outcomeFile), body);
      const creationsBefore = engine.creations.length;

      const code = await runSelfUpdate(ARGUMENTS, output, data);

      expect(code).toBe(EXIT_FAILURE);
      expect(said).toEqual([SELF_UPDATE_TEXT.recoveryBlocked(reason)]);
      expect(said.join("")).not.toContain(SECRET);
      // Nothing was replaced, and the record it could not read is still there for a person.
      expect(engine.creations.length).toBe(creationsBefore);
      expect(engine.containers.has(PREVIOUS)).toBe(false);
      expect(readFileSync(join(data, SELF_UPDATE.outcomeFile), "utf8")).toBe(body);
    });

    it("says in its last line why it started nothing over an earlier update still in hand, and fails", async () => {
      const old = engine.containers.get(NAME)!;
      engine.containers.delete(NAME);
      engine.add({ ...old, Name: `/${PREVIOUS}`, State: { ...old.State, Status: "exited", Running: false } });
      new SelfUpdateOutcomeFile(data).write({
        status: SELF_UPDATE_STATUS.blocked,
        from: OLD_IMAGE,
        to: EARLIER_IMAGE,
        reference: "autoheal:local",
        startedAt: 1,
        finishedAt: null,
        message: SELF_UPDATE_TEXT.interrupted,
        recovery: {
          version: SELF_UPDATE.recoveryVersion,
          phase: SELF_UPDATE_PHASE.replacing,
          original: containerIdOf(NAME),
          name: NAME,
          snapshot: null,
        },
      });

      const code = await runSelfUpdate(ARGUMENTS, output, data, new DockerClient(engine.socketPath));

      expect(code).toBe(EXIT_FAILURE);
      expect(said.at(-1)).toBe(SELF_UPDATE_TEXT.helperFailed(SELF_UPDATE_TEXT.earlierUnfinished(EARLIER_IMAGE)));
      expect(engine.creations).toEqual([]);
    });

    it("refuses the arguments it cannot use, as before", async () => {
      expect(await runSelfUpdate([], output, data)).toBe(EXIT_USAGE);
    });
  });
});
