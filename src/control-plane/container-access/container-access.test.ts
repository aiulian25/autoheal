import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  TEST_BACKUP_PASSPHRASE,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import {
  currentCode,
  fullySignedInAdmin,
  fullySignedInUser,
  NEW_ADMIN_PASSWORD,
} from "../../../test/support/second-factor.js";
import {
  API_ERRORS,
  API_ROUTES,
  apiPath,
  type AssignableView,
  type EnrolledHostView,
  type HostView,
  type JobView,
  type TerminalView,
} from "../../shared/api.js";
import {
  FILE_OPERATION,
  HTTP_HEADERS,
  JOB_EXPIRY_MILLISECONDS,
  SESSION_ID_LENGTH,
  SESSION_IDLE_MILLISECONDS,
  TERMINAL_ENDINGS,
  TERMINAL_BACKLOG_EVENTS,
  TERMINAL_IDLE_MILLISECONDS,
  TERMINAL_START_WAIT_MILLISECONDS,
  TERMINALS_PER_HOST,
} from "../../shared/constants.js";
import {
  RUNNER_ROUTES,
  type ContainerAccessWork,
  type ContainerSettings,
  type ContainerSnapshot,
  type FileAnswer,
  type SettingsAnswer,
  type TerminalInput,
  type WorkResponse,
} from "../../shared/protocol.js";
import { SecretBox } from "../database/secret-box.js";
import { auditEvents, sessions, users } from "../database/schema.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { SettingsService } from "./settings-service.js";

const SECONDS_PER_STEP = 30_000;

describe("reaching inside containers", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let secret: string;
  let token: string;
  let hostId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    ({ client: admin, secret } = await fullySignedInAdmin(controlPlane));
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const report = async (
    containerAccess: boolean | undefined,
    paperlessState: ContainerSnapshot["state"] = "running",
  ) => {
    const heartbeat = heartbeatWith({
      dryRun: false,
      protectedContainers: ["npm"],
      containers: [containerSnapshot({ name: "paperless", state: paperlessState }), containerSnapshot({ name: "npm" })],
    });
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: containerAccess === undefined ? heartbeat : { ...heartbeat, containerAccess },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  };
  // A code is good once: another sign-in's second step takes the next one, a step later.
  const nextCode = () => {
    controlPlane.clock.now += SECONDS_PER_STEP;
    return currentCode(secret, controlPlane.clock.now);
  };

  it("reaches a container at once where its host's .env allows it, and only one its host lets Autoheal change", async () => {
    await report(true);
    const { containerAccess } = controlPlane.services;
    expect(containerAccess.require(hostId, "paperless").name).toBe("paperless");
    expect(() => containerAccess.require(hostId, "npm")).toThrow("hands_off");
    expect(() => containerAccess.require(hostId, "ghost")).toThrow("container_not_found");

    // A runner from before the setting allows none of it.
    await report(undefined);
    expect(() => containerAccess.require(hostId, "paperless")).toThrow("container_access_off");
    const [host] = (await admin.get(API_ROUTES.hosts)).json<HostView[]>();
    expect(host!.containerAccess).toBe(false);
  });

  describe("a shell", () => {
    const runner = (method: "GET" | "POST", url: string, payload?: object) =>
      controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
    const paths = (terminalId: string) => ({
      terminal: apiPath(API_ROUTES.terminal, { terminalId }),
      stream: apiPath(API_ROUTES.terminalStream, { terminalId }),
      input: apiPath(API_ROUTES.terminalInput, { terminalId }),
      resize: apiPath(API_ROUTES.terminalResize, { terminalId }),
      runnerInput: apiPath(RUNNER_ROUTES.terminalInput, { terminalId }),
      runnerOutput: apiPath(RUNNER_ROUTES.terminalOutput, { terminalId }),
      runnerEnd: apiPath(RUNNER_ROUTES.terminalEnd, { terminalId }),
    });
    const openShell = () =>
      admin.post(apiPath(API_ROUTES.terminals, { hostId, containerName: "paperless" }), { columns: 100, rows: 40 });
    const started = async () =>
      (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>().terminals;
    const asked = async (terminalId: string) =>
      (await runner("GET", paths(terminalId).runnerInput)).json<TerminalInput>();
    const base64 = (text: string) => Buffer.from(text).toString("base64");

    beforeEach(async () => {
      await report(true);
    });

    it("starts on its runner, carries keystrokes and output both ways, and audits its lifecycle", async () => {
      const opened = await openShell();
      expect(opened.statusCode, opened.body).toBe(200);
      const { id } = opened.json<TerminalView>();
      const path = paths(id);
      expect(await started()).toEqual([
        { id, containerName: "paperless", columns: 100, rows: 40, requestedBy: "admin" },
      ]);
      // Handed over once: the next question waits for another.
      const host = controlPlane.services.hostsService.authenticate(token)!;
      expect(controlPlane.services.terminals.starts(host)).toEqual([]);

      // The runner's question waits for keystrokes, and is answered as soon as some are typed.
      const question = runner("GET", path.runnerInput);
      expect((await admin.post(path.input, { data: "ls -la\u001b[D\u007f\u007fa\r" })).statusCode).toBe(204);
      expect((await question).json<TerminalInput>()).toEqual({
        data: ["ls -la\u001b[D\u007f\u007fa\r"],
        size: null,
        closed: false,
      });
      // The shell gets the input unchanged; the audit log keeps no keystrokes.
      await admin.post(path.input, { data: "export DB_PASSWORD=hunter22\r" });
      expect((await asked(id)).data).toEqual(["export DB_PASSWORD=hunter22\r"]);
      await admin.post(path.resize, { columns: 120, rows: 50 });
      expect(await asked(id)).toEqual({ data: [], size: { columns: 120, rows: 50 }, closed: false });

      await runner("POST", path.runnerOutput, { data: base64("total 0\r\n") });
      await runner("POST", path.runnerOutput, { data: base64("$ ") });
      // Another sign-in, even the same person's, cannot follow it or type into it.
      const other = controlPlane.client();
      await other.signIn("admin", NEW_ADMIN_PASSWORD);
      await other.post(API_ROUTES.secondFactor, { code: nextCode() });
      expect((await other.get(path.stream)).statusCode).toBe(404);
      expect((await other.post(path.input, { data: "id\r" })).statusCode).toBe(404);

      expect((await admin.delete(path.terminal)).statusCode).toBe(204);
      expect(await asked(id)).toEqual({ data: [], size: null, closed: true });
      await runner("POST", path.runnerEnd, { exitCode: 0, reason: null });

      const stream = await admin.get(path.stream);
      expect(stream.headers[HTTP_HEADERS.contentType]).toContain("text/event-stream");
      expect(stream.body).toContain(`id: 1\nevent: output\ndata: ${base64("total 0\r\n")}\n\n`);
      expect(stream.body).toContain(`id: 2\nevent: output\ndata: ${base64("$ ")}\n\n`);
      expect(stream.body).toContain('event: ended\ndata: {"exitCode":0,"reason":null}\n\n');
      const resumed = await admin.request({
        method: "GET",
        url: path.stream,
        headers: { [HTTP_HEADERS.lastEventId]: "1" },
      });
      expect(resumed.body).not.toContain("id: 1\n");
      expect(resumed.body).toContain("id: 2\n");

      const audit = controlPlane.stdout.join("");
      expect(audit).toContain('"action":"container.terminal_opened"');
      expect(audit).not.toContain('"line":');
      expect(audit).not.toContain("container.terminal_line");
      expect(audit).toContain('"action":"container.terminal_closed"');
      expect(audit).not.toContain("export DB_PASSWORD=");
      expect(audit).not.toContain("hunter22");
    });

    it("replays the retained backlog with an explicit gap and resumes from its sequence", async () => {
      const { id } = (await openShell()).json<TerminalView>();
      await started();
      const { terminals, hostsService } = controlPlane.services;
      const host = hostsService.authenticate(token)!;
      for (let index = 1; index <= 6; index++)
        terminals.printed(host, id, base64(`piece-${index}:` + "x".repeat(30 * 1024)));
      terminals.ended(host, id, { exitCode: 0, reason: null });
      const response = await admin.request({
        method: "GET",
        url: paths(id).stream,
        headers: { [HTTP_HEADERS.lastEventId]: "1" },
      });
      expect(response.body).toContain("id: 5\nevent: gap\ndata: {}\n\n");
      expect(response.body).toContain("id: 6\nevent: output");
      expect(response.body).toContain('event: ended\ndata: {"exitCode":0,"reason":null}');
      expect(response.body).not.toContain(base64("piece-1:"));
      const resumed = await admin.request({
        method: "GET",
        url: paths(id).stream,
        headers: { [HTTP_HEADERS.lastEventId]: "6" },
      });
      expect(resumed.body).not.toContain("event: gap");
      expect(resumed.body).not.toContain("event: output");
      expect(resumed.body).toContain("event: ended");
    });

    it("bounds empty-output backlog metadata and stops a replay when its reader closes", async () => {
      const { id } = (await openShell()).json<TerminalView>();
      await started();
      const { terminals, hostsService, sessions } = controlPlane.services;
      const host = hostsService.authenticate(token)!;
      for (let index = 0; index < TERMINAL_BACKLOG_EVENTS + 8; index++) terminals.printed(host, id, "");
      const owner = sessions.resolve(admin.sessionToken!)!;
      const events: { kind: string; sequence?: number }[] = [];
      const stop = terminals.follow(owner, id, 0, (event) => events.push(event));
      expect(events[0]).toEqual({ kind: "gap", sequence: 8 });
      expect(events.filter((event) => event.kind === "output")).toHaveLength(TERMINAL_BACKLOG_EVENTS);
      stop();
      let open = true;
      const printed: unknown[] = [];
      terminals.follow(
        owner,
        id,
        8,
        (event) => {
          printed.push(event);
          open = false;
        },
        () => open,
      );
      terminals.printed(host, id, base64("next output"));
      expect(printed).toHaveLength(1);
    });

    it("ends a revoked host's shells at once, and its runner's waiting poll takes nothing more", async () => {
      const { files, hostsService, terminals, waitingRunners } = controlPlane.services;
      const adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
      const actor = { userId: adminId, username: "admin", ip: "127.0.0.1", requestId: "test" };
      const { id } = (await openShell()).json<TerminalView>();
      await started();
      const stream = admin.get(paths(id).stream);
      // Its runner waits for keystrokes, and for work, as its host is revoked.
      const askedForInput = vi.spyOn(terminals, "takeInput");
      const waited = vi.spyOn(waitingRunners, "wait");
      const input = asked(id);
      const polled = runner("GET", RUNNER_ROUTES.containerAccess);
      while (askedForInput.mock.calls.length === 0 || waited.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // A person's request wakes the poll, and the revoke comes before the poll has looked again.
      const listing = files
        .ask(actor, hostId, "paperless", { operation: FILE_OPERATION.list, path: "/", to: null, content: null })
        .then(
          () => "answered",
          (error: { code: string }) => error.code,
        );
      hostsService.revoke(actor, hostId);

      expect((await polled).json<ContainerAccessWork>().files).toEqual([]);
      expect(await listing).toBe(API_ERRORS.hostRevoked);
      expect(await input).toEqual({ data: [], size: null, closed: true });
      expect((await stream).body).toContain(TERMINAL_ENDINGS.hostRevoked);
    });

    it("ends an open stream and discards queued input when another session revokes its owner", async () => {
      const other = controlPlane.client();
      await other.signIn("admin", NEW_ADMIN_PASSWORD);
      await other.post(API_ROUTES.secondFactor, { code: nextCode() });
      const { id } = (await openShell()).json<TerminalView>();
      await started();
      const path = paths(id);
      await admin.post(path.input, { data: "SyntheticQueuedSecret" });
      const follow = vi.spyOn(controlPlane.services.terminals, "follow");
      const stream = admin.get(path.stream);
      while (follow.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      const owner = controlPlane.services.sessions.resolve(admin.sessionToken!)!;
      expect(
        (
          await other.delete(
            apiPath(API_ROUTES.accountSession, { sessionId: owner.tokenHash.slice(0, SESSION_ID_LENGTH) }),
          )
        ).statusCode,
      ).toBe(204);
      await runner("POST", path.runnerOutput, { data: base64("SyntheticRevokedOutput") });
      const input = await asked(id);
      // End explicitly as well so the regression completes against the old implementation.
      await runner("POST", path.runnerEnd, { exitCode: 0, reason: null });
      const response = await stream;
      expect(response.body).not.toContain(base64("SyntheticRevokedOutput"));
      expect(input).toEqual({ data: [], size: null, closed: true });
      expect(response.body).toContain("session");
      expect(follow.mock.results[0]!.value()).toBe(false);
      const closed = controlPlane.services.databaseHandle.database
        .select()
        .from(auditEvents)
        .all()
        .filter(
          (event) => event.action === "container.terminal_closed" && JSON.parse(event.detailsJson).terminalId === id,
        );
      expect(closed).toHaveLength(1);
      expect(JSON.parse(closed[0]!.detailsJson)).toMatchObject({
        inputBytes: Buffer.byteLength("SyntheticQueuedSecret"),
        outputBytes: 0,
        reason: TERMINAL_ENDINGS.sessionEnded,
      });
      expect(controlPlane.stdout.join("")).not.toContain("SyntheticQueuedSecret");
      expect(controlPlane.stdout.join("")).not.toContain("SyntheticRevokedOutput");
    });

    it.each(["logout", "idle expiry", "absolute expiry", "deactivated", "demoted", "password reset", "second factor"])(
      "closes quiet shells and waiting runner polls after %s without extending session lifetime",
      async (change) => {
        const owner = controlPlane.services.sessions.resolve(admin.sessionToken!)!;
        const { id } = (await openShell()).json<TerminalView>();
        const waiting = (await openShell()).json<TerminalView>().id;
        await started();
        const { terminals, hostsService, databaseHandle } = controlPlane.services;
        const host = hostsService.authenticate(token)!;
        const events: unknown[] = [];
        terminals.follow(owner, id, 0, (event) => events.push(event));
        const question = terminals.takeInput(host, id);
        const database = databaseHandle.database;
        const before = database.select().from(sessions).where(eq(sessions.tokenHash, owner.tokenHash)).get()!;
        if (change === "logout") await admin.post(API_ROUTES.logout);
        if (change === "idle expiry") controlPlane.clock.now += SESSION_IDLE_MILLISECONDS;
        if (change === "absolute expiry")
          database
            .update(sessions)
            .set({ expiresAt: controlPlane.clock.now })
            .where(eq(sessions.tokenHash, owner.tokenHash))
            .run();
        if (change === "deactivated")
          database.update(users).set({ status: "deactivated" }).where(eq(users.id, owner.user.id)).run();
        if (change === "demoted")
          database.update(users).set({ role: "viewer" }).where(eq(users.id, owner.user.id)).run();
        if (change === "password reset")
          database.update(users).set({ mustChangePassword: true }).where(eq(users.id, owner.user.id)).run();
        if (change === "second factor")
          database
            .update(sessions)
            .set({ secondFactorDone: false })
            .where(eq(sessions.tokenHash, owner.tokenHash))
            .run();
        terminals.sweep();
        expect(await question).toEqual({ data: [], size: null, closed: true });
        expect(events).toEqual([{ kind: "ended", end: { exitCode: null, reason: TERMINAL_ENDINGS.sessionEnded } }]);
        terminals.printed(host, id, base64("LateOutput"));
        terminals.type(owner, id, "LateInput");
        expect(await terminals.takeInput(host, id)).toEqual({ data: [], size: null, closed: true });
        expect(await terminals.takeInput(host, waiting)).toEqual({ data: [], size: null, closed: true });
        expect(events).toHaveLength(1);
        const after = database.select().from(sessions).where(eq(sessions.tokenHash, owner.tokenHash)).get();
        if (after) expect(after.lastSeenAt).toBe(before.lastSeenAt);
      },
    );

    it("never dispatches a waiting shell after owner revocation", async () => {
      const { id } = (await openShell()).json<TerminalView>();
      await admin.post(API_ROUTES.logout);
      const host = controlPlane.services.hostsService.authenticate(token)!;
      expect(controlPlane.services.terminals.starts(host)).toEqual([]);
      expect(await asked(id)).toEqual({ data: [], size: null, closed: true });
    });

    it("audits shell metadata without retaining interactive input or output", async () => {
      const opened = await openShell();
      expect(opened.statusCode).toBe(200);
      const { id } = opened.json<TerminalView>();
      const path = paths(id);
      await started();
      // A bare password, split requests, line endings, editing keys and an unfinished line are all private.
      const chunks = [
        "SyntheticPromptValue47",
        "\r",
        "SplitPrompt",
        "Value83\n",
        "export DB_PASSWORD=SyntheticAssignment29\r\n",
        "printf café\u001b[D\u007f\r",
        "UnfinishedPromptValue61",
      ];
      for (const data of chunks) {
        expect((await admin.post(path.input, { data })).statusCode).toBe(204);
        expect((await asked(id)).data).toEqual([data]);
      }
      const output = "SyntheticOutputValue52\r\n";
      expect((await runner("POST", path.runnerOutput, { data: base64(output) })).statusCode).toBe(204);
      expect((await admin.delete(path.terminal)).statusCode).toBe(204);
      expect((await asked(id)).closed).toBe(true);
      expect((await runner("POST", path.runnerEnd, { exitCode: 0, reason: null })).statusCode).toBe(204);

      const rows = controlPlane.services.databaseHandle.database.select().from(auditEvents).all();
      for (const stored of [JSON.stringify(rows), controlPlane.stdout.join("")]) {
        for (const value of [
          "SyntheticPromptValue47",
          "SplitPrompt",
          "Value83",
          "SyntheticAssignment29",
          "printf café",
          "UnfinishedPromptValue61",
          "SyntheticOutputValue52",
          base64(output),
        ]) {
          expect(stored).not.toContain(value);
        }
        expect(stored).not.toContain("container.terminal_line");
      }
      const events = rows.filter((row) => JSON.parse(row.detailsJson).terminalId === id);
      expect(events.map((event) => event.action)).toEqual(["container.terminal_opened", "container.terminal_closed"]);
      expect(events.every((event) => event.actorLabel === "admin" && event.targetId === `${hostId}/paperless`)).toBe(
        true,
      );
      expect(JSON.parse(events[1]!.detailsJson)).toEqual({
        hostId,
        terminalId: id,
        exitCode: 0,
        reason: null,
        inputBytes: Buffer.byteLength(chunks.join("")),
        outputBytes: Buffer.byteLength(output),
      });
      // Duplicate/late runner messages must not change the recorded lifecycle or traffic totals.
      await runner("POST", path.runnerOutput, { data: base64("ignored") });
      await admin.post(path.input, { data: "ignored" });
      await runner("POST", path.runnerEnd, { exitCode: 0, reason: null });
      expect(controlPlane.services.databaseHandle.database.select().from(auditEvents).all()).toEqual(rows);
    });

    it("needs a running container and room on its host, and ends those nobody started", async () => {
      await report(true, "exited");
      expect((await openShell()).json()).toEqual({ error: "container_not_running" });
      await report(true);

      const ids: string[] = [];
      for (let count = 0; count < TERMINALS_PER_HOST; count += 1) {
        ids.push((await openShell()).json<TerminalView>().id);
      }
      const full = await openShell();
      expect(full.statusCode).toBe(409);
      expect(full.json()).toEqual({ error: "terminals_full" });

      controlPlane.clock.now += TERMINAL_START_WAIT_MILLISECONDS + 1;
      controlPlane.services.terminals.sweep();
      const stream = await admin.get(paths(ids[0]!).stream);
      expect(stream.body).toContain(JSON.stringify({ exitCode: null, reason: TERMINAL_ENDINGS.notStarted }));
      expect((await openShell()).statusCode).toBe(200);
    });

    it("closes one nobody typed into for long, and ends one whose runner went quiet", async () => {
      const idle = (await openShell()).json<TerminalView>().id;
      const quiet = (await openShell()).json<TerminalView>().id;
      await started();
      const { terminals, hostsService } = controlPlane.services;

      controlPlane.clock.now += TERMINAL_IDLE_MILLISECONDS + 1;
      // The idle shell's runner keeps asking, and hears it is closed; the quiet one's stopped asking.
      const question = terminals.takeInput(hostsService.authenticate(token)!, idle);
      terminals.sweep();
      expect(await question).toEqual({ data: [], size: null, closed: true });
      expect((await admin.get(paths(quiet).stream)).body).toContain(TERMINAL_ENDINGS.runnerSilent);
      // Should it come back, it hears its shell is closed too.
      expect((await asked(quiet)).closed).toBe(true);

      await runner("POST", paths(idle).runnerEnd, { exitCode: 130, reason: null });
      expect((await admin.get(paths(idle).stream)).body).toContain(
        JSON.stringify({ exitCode: 130, reason: TERMINAL_ENDINGS.idle }),
      );
    });
  });

  describe("a shell on the host itself", () => {
    const reportHostTerminal = async (hostTerminal: boolean | undefined) => {
      const heartbeat = heartbeatWith({ dryRun: false });
      const response = await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: hostTerminal === undefined ? heartbeat : { ...heartbeat, hostTerminal },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
    };
    const openOnHost = (client: TestClient = admin) =>
      client.post(apiPath(API_ROUTES.hostTerminals, { hostId }), { columns: 100, rows: 40 });

    it("opens for an admin as root, goes to the runner with no container, and is on record as the host's", async () => {
      await reportHostTerminal(true);
      expect((await admin.get(API_ROUTES.hosts)).json<HostView[]>()[0]!.hostTerminal).toBe(true);
      const opened = await openOnHost();
      expect(opened.statusCode, opened.body).toBe(200);
      const { id, user } = opened.json<TerminalView>();
      expect(user).toBe("root");
      const work = await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.containerAccess,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(work.json<ContainerAccessWork>().terminals).toEqual([
        { id, containerName: null, columns: 100, rows: 40, requestedBy: "admin" },
      ]);
      await controlPlane.runnerApp.inject({
        method: "POST",
        url: apiPath(RUNNER_ROUTES.terminalEnd, { terminalId: id }),
        payload: { exitCode: 0, reason: null },
        headers: { authorization: `Bearer ${token}` },
      });
      const audit = controlPlane.stdout.join("");
      expect(audit).toContain('"action":"host.terminal_opened"');
      expect(audit).toContain('"action":"host.terminal_closed"');
    });

    it("is refused where the host's .env turns it off, where its runner cannot open one, and to anyone not an admin", async () => {
      await reportHostTerminal(undefined);
      expect((await openOnHost()).json()).toEqual({ error: "host_terminal_off" });
      await reportHostTerminal(false);
      expect((await openOnHost()).json()).toEqual({ error: "host_terminal_off" });
      await reportHostTerminal(true);
      const viewer = await fullySignedInUser(controlPlane, admin, "viewer", "viewer");
      // Hidden from a viewer's session, as every shell is.
      expect((await openOnHost(viewer.client)).statusCode).toBe(404);
    });
  });

  describe("its files", () => {
    const runner = (method: "GET" | "POST", url: string, payload?: object) =>
      controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
    const filesPath = () => apiPath(API_ROUTES.containerFiles, { hostId, containerName: "paperless" });
    const answer = (requestId: string, fields: Partial<FileAnswer>) =>
      runner("POST", apiPath(RUNNER_ROUTES.fileAnswer, { requestId }), {
        error: null,
        entries: null,
        truncated: false,
        content: null,
        ...fields,
      });

    beforeEach(async () => {
      await report(true);
    });

    it("reach the runner at once, and its answer the person; reads and changes are on record, contents never", async () => {
      // The runner is already waiting when the person asks.
      const waiting = runner("GET", RUNNER_ROUTES.containerAccess);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const asked = admin.post(filesPath(), { operation: "list", path: "/srv" });
      const [request] = (await waiting).json<ContainerAccessWork>().files;
      expect(request).toMatchObject({
        containerName: "paperless",
        operation: "list",
        path: "/srv",
        requestedBy: "admin",
      });
      const entry = {
        name: "app.env",
        kind: "file" as const,
        size: 4,
        mode: "-rw-r-----",
        owner: "www-data",
        group: "www-data",
        modified: "Oct 24 13:13",
        linkTarget: null,
      };
      expect((await answer(request!.id, { entries: [entry] })).statusCode).toBe(204);
      expect((await asked).json<FileAnswer>().entries).toEqual([entry]);

      const written = admin.post(filesPath(), { operation: "write", path: "/srv/app.env", content: "QT0yCg==" });
      const [write] = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>().files;
      expect(write).toMatchObject({ operation: "write", content: "QT0yCg==" });
      await answer(write!.id, {});
      expect((await written).json<FileAnswer>().error).toBeNull();
      const audit = controlPlane.stdout.join("");
      expect(audit).toContain('"action":"container.file_changed"');
      expect(audit).toContain('"path":"/srv/app.env"');
      expect(audit).not.toContain("QT0yCg==");
      expect(audit).not.toContain('"operation":"list"');
    });

    it("takes only plain absolute paths, never the root to change, and answers only the runner it went to", async () => {
      for (const body of [
        { operation: "list", path: "srv" },
        { operation: "read", path: "/srv/../etc/shadow" },
        { operation: "list", path: "/srv/" },
        { operation: "remove", path: "/" },
        { operation: "write", path: "/srv/x", content: "not base64!" },
        { operation: "chmod", path: "/srv" },
      ]) {
        expect((await admin.post(filesPath(), body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      const unknown = await answer("00000000-0000-4000-8000-000000000000", {});
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe("its settings", () => {
    const runner = (method: "GET" | "POST", url: string, payload?: object) =>
      controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
    const settingsPath = () => apiPath(API_ROUTES.containerSettings, { hostId, containerName: "paperless" });
    const settings: ContainerSettings = {
      environment: [{ name: "PAPERLESS_SECRET_KEY", value: "do-not-log-me" }],
      labels: [{ name: "com.docker.compose.project", value: "paperless" }],
      ports: [{ target: 8000, protocol: "tcp", published: 8010, address: "" }],
      mounts: [{ kind: "bind", source: "/srv/paperless/data", target: "/usr/src/paperless/data", readOnly: false }],
      restart: { policy: "unless-stopped", retries: 0 },
    };

    beforeEach(async () => {
      await report(true, "exited");
    });

    describe("adding an app", () => {
      const spec = {
        name: "App",
        slug: "app",
        image: "example/app:1",
        folder: "/home/me/docker/app",
        restartPolicy: "unless-stopped",
        owner: null,
        networks: [],
        port: null,
        mounts: [],
        environment: [{ name: "SHOWN", value: "not-for-the-log" }],
        secrets: [{ name: "API_TOKEN", characters: 32 }],
        database: null,
      };
      const allow = async (hostDeploy: boolean | undefined) => {
        const response = await controlPlane.runnerApp.inject({
          method: "POST",
          url: RUNNER_ROUTES.heartbeat,
          payload: { ...heartbeatWith({ dryRun: false, containers: [] }), containerAccess: true, hostDeploy },
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
      };
      const paths = () => ({
        draft: apiPath(API_ROUTES.hostInstallDraft, { hostId }),
        install: apiPath(API_ROUTES.hostInstall, { hostId }),
        undo: apiPath(API_ROUTES.hostInstallUndo, { hostId }),
      });

      it("is refused where the runner cannot, and asks nothing of it", async () => {
        await allow(undefined);
        const asked = await admin.post(paths().draft, { image: "example/app:1" });
        expect(asked.json()).toEqual({ error: "host_deploy_off" });
        await allow(false);
        expect((await admin.post(paths().install, { spec })).json()).toEqual({ error: "host_deploy_off" });
      });

      it("drafts through the runner, then makes one job whose details it hands over", async () => {
        await allow(true);
        const asked = admin.post(paths().draft, { image: "example/app:1" });
        const [request] = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>().installs!;
        expect(request).toMatchObject({ kind: "draft", image: "example/app:1", recipe: null });
        const said = { error: "no version for arm64", draft: null, checks: [] };
        await runner("POST", apiPath(RUNNER_ROUTES.installAnswer, { requestId: request!.id }), said);
        expect((await asked).json()).toEqual(said);

        const installed = await admin.post(paths().install, { spec });
        expect(installed.statusCode, installed.body).toBe(200);
        const job = installed.json<JobView>();
        expect(job).toMatchObject({ action: "install", containerName: "App", status: "pending" });
        const [delivered] = (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;
        expect(delivered).toMatchObject({ id: job.id, action: "install" });
        const details = apiPath(RUNNER_ROUTES.jobInstall, { jobId: job.id });
        expect((await runner("GET", details)).json()).toEqual(spec);

        const audit = controlPlane.stdout.join("");
        expect(audit).toContain("app.install_asked");
        expect(audit).toContain("API_TOKEN");
        expect(audit).not.toContain("not-for-the-log");
      });

      it("refuses what would write outside its rules before any job exists", async () => {
        await allow(true);
        const bad = await admin.post(paths().install, { spec: { ...spec, folder: "/home/me/../../etc" } });
        expect(bad.statusCode).toBe(400);
        expect((await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs).toEqual([]);
      });

      it("takes an app back through a job, with or without its data", async () => {
        await allow(true);
        const kept = await admin.post(paths().undo, { name: "App", removeData: false });
        expect(kept.json<JobView>()).toMatchObject({ action: "uninstall", containerName: "App" });
        const gone = await admin.post(paths().undo, { name: "App", removeData: true });
        expect(gone.json<JobView>()).toMatchObject({ action: "uninstall_with_data", containerName: "App" });
      });
    });

    it("work out how the host is set up through the runner, for admins only", async () => {
      const path = apiPath(API_ROUTES.hostProfile, { hostId });
      const read = admin.get(path);
      const [request] = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>().profiles!;
      const refusal = { error: "This host's .env keeps people out.", profile: null };
      const answered = await runner(
        "POST",
        apiPath(RUNNER_ROUTES.hostProfileAnswer, { requestId: request!.id }),
        refusal,
      );
      expect(answered.statusCode).toBe(204);
      expect((await read).json()).toEqual(refusal);
    });

    it("join a network through the runner, with the change on record", async () => {
      const path = apiPath(API_ROUTES.containerNetwork, { hostId, containerName: "paperless" });
      const asked = admin.post(path, { name: "npm", joined: true });
      const [request] = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>().settings;
      expect(request).toMatchObject({
        containerName: "paperless",
        details: true,
        network: { name: "npm", joined: true },
      });
      await runner("POST", apiPath(RUNNER_ROUTES.settingsAnswer, { requestId: request!.id }), {
        error: "not a network",
        settings: null,
      });
      expect((await asked).json<SettingsAnswer>().error).toBe("not a network");
      expect(controlPlane.stdout.join("")).toContain("container.network_changed");
      const bad = await admin.post(path, { name: "a b; rm", joined: true });
      expect(bad.statusCode).toBe(400);
    });

    it("give its details without its settings, even from a runner too old to know details, unrecorded", async () => {
      const read = admin.get(`${settingsPath()}?details=true`);
      const [request] = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>().settings;
      expect(request).toMatchObject({ containerName: "paperless", details: true });
      await runner("POST", apiPath(RUNNER_ROUTES.settingsAnswer, { requestId: request!.id }), {
        error: null,
        settings,
      });
      expect((await read).json<SettingsAnswer>()).toEqual({ error: null, settings: null, details: null });
      expect(controlPlane.stdout.join("")).not.toContain("container.settings_read");
    });

    it("are read through the runner, even of a stopped container, and changed by one edit job at a time", async () => {
      const read = admin.get(settingsPath());
      const [request] = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<ContainerAccessWork>().settings;
      expect(request).toMatchObject({ containerName: "paperless", requestedBy: "admin" });
      const answered = await runner("POST", apiPath(RUNNER_ROUTES.settingsAnswer, { requestId: request!.id }), {
        error: null,
        settings,
      });
      expect(answered.statusCode).toBe(204);
      expect((await read).json<SettingsAnswer>().settings).toEqual(settings);

      const applied = await admin.request({ method: "PUT", url: settingsPath(), payload: settings });
      expect(applied.statusCode, applied.body).toBe(200);
      const job = applied.json<JobView>();
      expect(job).toMatchObject({ action: "edit", containerName: "paperless", status: "pending" });
      const busy = await admin.request({ method: "PUT", url: settingsPath(), payload: settings });
      expect(busy.json()).toEqual({ error: "edit_busy" });

      // The runner gets the job, then its settings, once.
      const [delivered] = (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;
      expect(delivered).toMatchObject({ id: job.id, action: "edit" });
      const fetched = await runner("GET", apiPath(RUNNER_ROUTES.jobSettings, { jobId: job.id }));
      expect(fetched.json<ContainerSettings>()).toEqual(settings);
      expect((await runner("GET", apiPath(RUNNER_ROUTES.jobSettings, { jobId: job.id }))).statusCode).toBe(404);

      const audit = controlPlane.stdout.join("");
      expect(audit).toContain('"action":"container.settings_changed"');
      expect(audit).toContain("PAPERLESS_SECRET_KEY");
      expect(audit).not.toContain("do-not-log-me");
    });

    describe("an edit's settings, sealed in its job", () => {
      const apply = async () =>
        (await admin.request({ method: "PUT", url: settingsPath(), payload: settings })).json<JobView>();
      const sealedIn = (jobId: string) =>
        (
          controlPlane.services.databaseHandle.sqlite
            .prepare("SELECT edit_settings AS sealed FROM jobs WHERE id = ?")
            .get(jobId) as { sealed: string | null }
        ).sealed;

      it("outlast a restart of the control plane, for its runner to fetch once", async () => {
        const job = await apply();
        expect(sealedIn(job.id)).not.toContain("do-not-log-me");
        const { containerAccess, jobsService, auditLog, waitingRunners, databaseHandle } = controlPlane.services;
        // A control plane started again: the same database and passphrase, and nothing the last one held in memory.
        const restarted = new SettingsService(
          containerAccess,
          jobsService,
          auditLog,
          waitingRunners,
          databaseHandle,
          SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE),
        );
        const host = { id: hostId } as HostRow;
        expect(restarted.forJob(host, job.id)).toEqual(settings);
        expect(() => restarted.forJob(host, job.id)).toThrow(
          expect.objectContaining({ code: API_ERRORS.runnerRequestNotFound }),
        );
        expect(sealedIn(job.id)).toBeNull();
      });

      it("go once nobody can fetch them: when the job is over, or its host is revoked", async () => {
        const expiring = await apply();
        controlPlane.clock.now += JOB_EXPIRY_MILLISECONDS;
        await runner("GET", RUNNER_ROUTES.work);
        expect(sealedIn(expiring.id)).toBeNull();

        const revoked = await apply();
        expect(sealedIn(revoked.id)).not.toBeNull();
        const adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
        const actor = { userId: adminId, username: "admin", ip: "127.0.0.1", requestId: "test" };
        controlPlane.services.hostsService.revoke(actor, hostId);
        expect(sealedIn(revoked.id)).toBeNull();
      });
    });

    it("are changed only through their own route, with plain values", async () => {
      const generic = await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName: "paperless" }), {
        action: "edit",
      });
      expect(generic.statusCode).toBe(400);
      for (const wrong of [
        { ...settings, environment: [{ name: "A=B", value: "x" }] },
        { ...settings, mounts: [{ kind: "bind", source: "relative/path", target: "/data", readOnly: false }] },
        { ...settings, mounts: [{ kind: "volume", source: "/not/a/volume", target: "/data", readOnly: false }] },
        { ...settings, ports: [{ target: 0, protocol: "tcp", published: 80, address: "" }] },
        { ...settings, restart: { policy: "sometimes", retries: 0 } },
      ]) {
        const refused = await admin.request({ method: "PUT", url: settingsPath(), payload: wrong });
        expect(refused.statusCode, JSON.stringify(wrong)).toBe(400);
      }
    });
  });
});
