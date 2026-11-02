import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeDockerEngine } from "../../../test/fakes/fake-docker-engine.js";
import type { TestClient } from "../../../test/support/control-plane.js";
import { runningContainer, startEmbeddedSshHost, until } from "../../../test/support/embedded-ssh-host.js";
import { API_ROUTES, apiPath, type HostView, type JobView, type TerminalView } from "../../shared/api.js";
import { FILE_OPERATION, JOB_STATUS } from "../../shared/constants.js";
import type { ContainerSettings, FileAnswer, SettingsAnswer } from "../../shared/protocol.js";

const IMAGE = "example/paperless:2";
const CONTAINER = "paperless";
// `ls -la /srv/` as BusyBox prints it.
const LISTING = `total 12
drwxr-xr-x    3 root     root          4096 Oct 24 13:13 .
drwxr-xr-x    1 root     root          4096 Oct 24 13:13 ..
-rw-r-----    1 root     root             4 Oct 24 13:13 app.env
drwxr-xr-x    2 root     root          4096 Oct 24 13:13 data
`;
const decode = (base64: string) => Buffer.from(base64, "base64").toString();
const encode = (text: string) => Buffer.from(text).toString("base64");

describe("a container's shell, files and settings on an SSH host", () => {
  let engine: FakeDockerEngine;
  let admin: TestClient;
  let hostId: string;
  let stop: () => Promise<void>;
  let started: Awaited<ReturnType<typeof startEmbeddedSshHost>>;

  beforeEach(async () => {
    const paperless = runningContainer(CONTAINER, {
      Id: "c".repeat(64),
      Image: IMAGE,
      Config: { Image: IMAGE, Env: ["PAPERLESS_PORT=8000"], Labels: {}, Tty: false },
    });
    started = await startEmbeddedSshHost([paperless]);
    ({ engine, admin, hostId, stop } = started);
    // Recreating by its tag needs the image it runs: in the fake, an image's id is its reference.
    engine.imageLabels.set(IMAGE, {});
    // A new host starts in dry run, as a new runner does, and lets nothing be changed until a person says.
    const { sshHostsService, embeddedRunners } = started.controlPlane.services;
    sshHostsService.updateSettings(started.actor, hostId, { ...sshHostsService.settingsOf(hostId), dryRun: false });
    embeddedRunners.begin();
    await until(
      async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((host) => host.id === hostId)!,
      (host) => host.dryRun === false && host.containerAccess === true && host.runningCount === 1,
    );
  });

  afterEach(() => stop());

  const containerPath = (route: string) => apiPath(route, { hostId, containerName: CONTAINER });
  const files = async (request: object) => {
    const answered = await admin.post(containerPath(API_ROUTES.containerFiles), request);
    expect(answered.statusCode, answered.body).toBe(200);
    return answered.json<FileAnswer>();
  };

  it("closes all three when the host's settings take container access away, as a runner's .env does", async () => {
    const { sshHostsService } = started.controlPlane.services;
    sshHostsService.updateSettings(started.actor, hostId, {
      ...sshHostsService.settingsOf(hostId),
      containerAccess: false,
    });
    await until(
      async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((host) => host.id === hostId)!,
      (host) => host.containerAccess === false,
    );
    const refusals = await Promise.all([
      admin.post(containerPath(API_ROUTES.terminals), { columns: 80, rows: 24 }),
      admin.post(containerPath(API_ROUTES.containerFiles), { operation: FILE_OPERATION.list, path: "/" }),
      admin.get(containerPath(API_ROUTES.containerSettings)),
    ]);
    expect(refusals.map((refusal) => refusal.json())).toEqual(Array(3).fill({ error: "container_access_off" }));
    expect(engine.execs.size).toBe(0);
  });

  it("opens a shell over the session that takes what is typed, resizes, and says how it ended", async () => {
    const opened = await admin.post(containerPath(API_ROUTES.terminals), { columns: 120, rows: 30 });
    expect(opened.statusCode, opened.body).toBe(200);
    const { id: terminalId } = opened.json<TerminalView>();
    // Typed before the shell is there: kept, and given to it once it is.
    expect(
      (await admin.post(apiPath(API_ROUTES.terminalInput, { terminalId }), { data: "echo early\r" })).statusCode,
    ).toBe(204);
    const streaming = admin.get(apiPath(API_ROUTES.terminalStream, { terminalId }));
    await until(
      () => [...engine.execs.values()].filter((exec) => exec.tty).length,
      (count) => count === 1,
    );
    await admin.post(apiPath(API_ROUTES.terminalResize, { terminalId }), { columns: 100, rows: 40 });
    await until(
      () => [...engine.execs.values()][0]!.sizes,
      (sizes) => sizes.includes("h=40&w=100"),
    );
    await admin.post(apiPath(API_ROUTES.terminalInput, { terminalId }), { data: "exit\r" });

    const stream = (await streaming).body;
    const printed = [...stream.matchAll(/^event: output\ndata: (.+)$/gm)].map(([, data]) => decode(data!)).join("");
    expect(printed).toContain("echo early\r");
    expect(printed).toContain("bye\r\n");
    expect(stream).toMatch(/event: ended\ndata: \{[^}]*"exitCode":0/);
    expect([...engine.execs.values()][0]).toMatchObject({ container: CONTAINER, tty: true });
  });

  it("lists, reads, writes, makes a folder in, renames and removes a container's files over the session", async () => {
    const commands: string[][] = [];
    engine.commandResult = (command) => {
      commands.push(command);
      return { stdout: command[0] === "ls" ? LISTING : "", stderr: "", exitCode: 0 };
    };
    engine.files.set(
      CONTAINER,
      new Map([
        ["/srv", { folder: true, content: Buffer.alloc(0), mode: 0o755, uid: 0, gid: 0 }],
        ["/srv/app.env", { folder: false, content: Buffer.from("A=1\n"), mode: 0o640, uid: 0, gid: 0 }],
      ]),
    );

    const listed = await files({ operation: FILE_OPERATION.list, path: "/srv" });
    expect(listed.error).toBeNull();
    expect(listed.entries!.map((entry) => [entry.name, entry.kind])).toEqual([
      ["app.env", "file"],
      ["data", "folder"],
    ]);
    // Downloading and opening read the same way.
    expect(decode((await files({ operation: FILE_OPERATION.read, path: "/srv/app.env" })).content!)).toBe("A=1\n");
    // Saving an edit and uploading write the same way: the owner and mode stay the file's.
    expect(
      (await files({ operation: FILE_OPERATION.write, path: "/srv/app.env", content: encode("A=2\n") })).error,
    ).toBeNull();
    expect(engine.files.get(CONTAINER)!.get("/srv/app.env")).toMatchObject({
      content: Buffer.from("A=2\n"),
      mode: 0o640,
    });
    expect((await files({ operation: FILE_OPERATION.makeFolder, path: "/srv/new" })).error).toBeNull();
    expect(engine.files.get(CONTAINER)!.get("/srv/new")).toMatchObject({ folder: true });
    expect(
      (await files({ operation: FILE_OPERATION.rename, path: "/srv/app.env", to: "/srv/old.env" })).error,
    ).toBeNull();
    expect((await files({ operation: FILE_OPERATION.remove, path: "/srv/old.env" })).error).toBeNull();
    expect(commands.slice(1)).toEqual([
      ["mv", "/srv/app.env", "/srv/old.env"],
      ["rm", "-rf", "/srv/old.env"],
    ]);
  });

  it("reads a container's settings, and applies a changed one by recreating it, which then runs with it", async () => {
    const read = await admin.get(containerPath(API_ROUTES.containerSettings));
    expect(read.statusCode, read.body).toBe(200);
    const { settings } = read.json<SettingsAnswer>();
    expect(settings!.environment).toEqual([{ name: "PAPERLESS_PORT", value: "8000" }]);

    const changed: ContainerSettings = {
      ...settings!,
      environment: [...settings!.environment, { name: "PAPERLESS_OCR_LANGUAGE", value: "ron" }],
    };
    const applied = await admin.put(containerPath(API_ROUTES.containerSettings), changed);
    expect(applied.statusCode, applied.body).toBe(200);
    const { id } = applied.json<JobView>();
    const done = await until(
      async () =>
        (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}&containerName=${CONTAINER}`))
          .json<JobView[]>()
          .find((job) => job.id === id)!,
      (job) => job.status !== JOB_STATUS.pending && job.status !== JOB_STATUS.delivered,
    );
    expect(done.status, done.outcome ?? "").toBe(JOB_STATUS.succeeded);
    const recreated = engine.containers.get(CONTAINER)!;
    expect(recreated.Id).not.toBe("c".repeat(64));
    expect(recreated.State.Running).toBe(true);
    expect(recreated.Config.Env).toContain("PAPERLESS_OCR_LANGUAGE=ron");
    expect(engine.creations.map((creation) => creation.specification.Image)).toEqual([IMAGE]);
  });
});
