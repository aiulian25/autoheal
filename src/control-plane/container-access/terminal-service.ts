import type { ResourceMember } from "../auth/resource-permissions.js";
import { randomUUID } from "node:crypto";
import { API_ERRORS, type TerminalView } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  ACCESS_FULL,
  AUDIT_ACTIONS,
  CONTAINER_STATE_RUNNING,
  TARGET_CONTAINER,
  TARGET_HOST,
  TERMINAL_BACKLOG_BYTES,
  TERMINAL_BACKLOG_EVENTS,
  TERMINAL_ENDED_KEEP_MILLISECONDS,
  TERMINAL_ENDINGS,
  TERMINAL_IDLE_MILLISECONDS,
  TERMINAL_INPUT_WAIT_MILLISECONDS,
  TERMINAL_RUNNER_SILENT_MILLISECONDS,
  TERMINAL_START_WAIT_MILLISECONDS,
  TERMINAL_STATE,
  TERMINALS_PER_HOST,
  type TerminalState,
} from "../../shared/constants.js";
import type { TerminalEnd, TerminalInput, TerminalStart } from "../../shared/protocol.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { ResolvedSession, SessionStore } from "../auth/sessions.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { ContainerAccessService } from "./container-access-service.js";
import type { WaitingRunners } from "./waiting-runners.js";

/** What a person's browser is told about a shell: something it printed, numbered, or that it ended. */
export type TerminalEvent =
  | { kind: "output"; sequence: number; data: string }
  | { kind: "ended"; end: TerminalEnd }
  | { kind: "gap"; sequence: number };

export type TerminalSize = { columns: number; rows: number };

interface Terminal {
  id: string;
  hostId: string;
  // Null for a shell on the host itself.
  containerName: string | null;
  // The sign-in that opened it: only that one follows it, types into it, resizes and closes it.
  ownerTokenHash: string;
  operatorUserId?: string;
  actor: Actor;
  state: TerminalState;
  start: TerminalSize;
  // Typed and not yet taken by the runner; a size not yet passed on; why it is being closed, once it is.
  typed: string[];
  size: TerminalSize | null;
  closing: { reason: string | null } | null;
  // The runner's question for keystrokes, while it waits.
  answer: ((input: TerminalInput) => void) | null;
  listeners: Set<(event: TerminalEvent) => void>;
  // What it printed lately, numbered, for a browser that connects again; and how it ended.
  backlog: { sequence: number; data: string }[];
  printed: number;
  end: TerminalEnd | null;
  // Traffic totals only: keystrokes may be passwords, and neither direction belongs in the audit log.
  inputBytes: number;
  outputBytes: number;
  // When it was asked for, last typed into, last asked about by its runner, ended.
  openedAt: number;
  typedAt: number;
  askedAt: number;
  endedAt: number;
}

const NOTHING: TerminalInput = { data: [], size: null, closed: false };

/**
 * Shells people open in containers, between their browser and the container's runner: what they type waits
 * for the runner's next question, which it answers at once; what the shell prints goes to the browser as it
 * comes. Only who opened/closed it and traffic totals go in the audit log. Shells live in memory: a control
 * plane that starts again ends them all, and their runners end them as soon as they hear it forgot them.
 */
export class TerminalService {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly access: Pick<ContainerAccessService, "require"> &
      Partial<Pick<ContainerAccessService, "operatorUserId" | "authorizeOperator" | "requireHostShell">>,
    private readonly auditLog: AuditLog,
    private readonly runners: Pick<WaitingRunners, "wake">,
    private readonly sessions: Pick<SessionStore, "isLive">,
    private readonly clock: () => number = Date.now,
  ) {}

  open(
    actor: Actor,
    session: ResolvedSession,
    hostId: string,
    containerName: string,
    start: TerminalSize,
  ): TerminalView {
    const operatorUserId = this.access.operatorUserId?.(actor.userId);
    if (!this.sessions.isLive(session.tokenHash, operatorUserId ? ACCESS_FULL : ACCESS_ADMIN)) {
      throw new DomainError(API_ERRORS.terminalNotFound);
    }
    const container = this.access.require(hostId, containerName, actor.userId, "terminal");
    if (container.state !== CONTAINER_STATE_RUNNING) {
      throw new DomainError(API_ERRORS.containerNotRunning);
    }
    return { id: this.create(actor, session, hostId, containerName, start, operatorUserId).id };
  }

  /** A shell on the host itself, for an admin, on a host whose .env lets one open: as whom it runs there. */
  openHost(actor: Actor, session: ResolvedSession, hostId: string, start: TerminalSize): TerminalView {
    if (!this.sessions.isLive(session.tokenHash, ACCESS_ADMIN) || this.access.requireHostShell === undefined) {
      throw new DomainError(API_ERRORS.terminalNotFound);
    }
    const { user } = this.access.requireHostShell(hostId, actor.userId);
    return { id: this.create(actor, session, hostId, null, start, undefined).id, user };
  }

  private create(
    actor: Actor,
    session: ResolvedSession,
    hostId: string,
    containerName: string | null,
    start: TerminalSize,
    operatorUserId: string | undefined,
  ): Terminal {
    const openOnHost = [...this.terminals.values()].filter(
      (terminal) => terminal.hostId === hostId && terminal.state !== TERMINAL_STATE.ended,
    );
    if (openOnHost.length >= TERMINALS_PER_HOST) {
      throw new DomainError(API_ERRORS.terminalsFull);
    }
    const now = this.clock();
    const terminal: Terminal = {
      id: randomUUID(),
      hostId,
      containerName,
      ownerTokenHash: session.tokenHash,
      ...(operatorUserId ? { operatorUserId } : {}),
      actor,
      state: TERMINAL_STATE.waiting,
      start,
      typed: [],
      size: null,
      closing: null,
      answer: null,
      listeners: new Set(),
      backlog: [],
      printed: 0,
      end: null,
      inputBytes: 0,
      outputBytes: 0,
      openedAt: now,
      typedAt: now,
      askedAt: now,
      endedAt: 0,
    };
    this.terminals.set(terminal.id, terminal);
    this.audit(terminal, "opened", {});
    this.runners.wake(hostId);
    return terminal;
  }

  /** The shells waiting for this host's runner to start them; each is handed over once. */
  starts(host: HostRow): TerminalStart[] {
    for (const terminal of this.terminals.values()) {
      if (terminal.hostId === host.id && terminal.state === TERMINAL_STATE.waiting) this.checkOwner(terminal);
    }
    const waiting = [...this.terminals.values()].filter(
      (terminal) =>
        terminal.hostId === host.id &&
        terminal.state === TERMINAL_STATE.waiting &&
        (terminal.operatorUserId === undefined || host.resourcePermissions === true),
    );
    const now = this.clock();
    return waiting.map((terminal) => {
      terminal.state = TERMINAL_STATE.open;
      terminal.askedAt = now;
      return {
        id: terminal.id,
        ...(terminal.operatorUserId ? { operatorUserId: terminal.operatorUserId } : {}),
        containerName: terminal.containerName,
        ...terminal.start,
        requestedBy: terminal.actor.username,
      };
    });
  }

  authorizeOperator(host: HostRow, requestId: string, members: readonly ResourceMember[]): boolean {
    const terminal = this.terminals.get(requestId);
    if (
      !terminal ||
      terminal.hostId !== host.id ||
      !terminal.operatorUserId ||
      terminal.containerName === null ||
      terminal.end !== null
    )
      return false;
    const containerName = terminal.containerName;
    this.checkOwner(terminal);
    return (
      terminal.end === null &&
      (this.access.authorizeOperator?.(
        host.id,
        containerName,
        terminal.operatorUserId,
        "terminal",
        members,
        terminal.ownerTokenHash,
      ) ??
        false)
    );
  }

  /** What it printed after the event the browser last had, then each new event as it comes; returns how to stop. */
  follow(
    session: ResolvedSession,
    terminalId: string,
    lastSequence: number,
    listener: (event: TerminalEvent) => void,
    isOpen: () => boolean = () => true,
  ): () => void {
    const terminal = this.owned(session, terminalId);
    const firstSequence = terminal.backlog[0]?.sequence ?? terminal.printed + 1;
    if (lastSequence < firstSequence - 1) listener({ kind: "gap", sequence: firstSequence - 1 });
    for (const output of terminal.backlog) {
      if (!isOpen()) return () => undefined;
      if (output.sequence > lastSequence) listener({ kind: "output", ...output });
    }
    if (!isOpen()) return () => undefined;
    if (terminal.end !== null) {
      listener({ kind: "ended", end: terminal.end });
      return () => undefined;
    }
    terminal.listeners.add(listener);
    return () => terminal.listeners.delete(listener);
  }

  type(session: ResolvedSession, terminalId: string, data: string) {
    const terminal = this.owned(session, terminalId);
    if (terminal.end !== null) {
      return;
    }
    terminal.typed.push(data);
    terminal.typedAt = this.clock();
    terminal.inputBytes += Buffer.byteLength(data);
    this.wake(terminal);
  }

  resize(session: ResolvedSession, terminalId: string, size: TerminalSize) {
    const terminal = this.owned(session, terminalId);
    if (terminal.end !== null) return;
    terminal.size = size;
    this.wake(terminal);
  }

  close(session: ResolvedSession, terminalId: string) {
    this.closeFor(this.owned(session, terminalId), null);
  }

  /**
   * The runner's question for keystrokes: answered at once with what waits, or as soon as some come, or with
   * none after a while. One the control plane already ended is answered closed, so its runner ends it too.
   */
  takeInput(host: HostRow, terminalId: string): Promise<TerminalInput> {
    const terminal = this.ofHost(host, terminalId);
    terminal.askedAt = this.clock();
    // A runner asks once at a time: one that asks again gave up on its last question.
    terminal.answer?.(NOTHING);
    const ready = this.inputOf(terminal);
    if (ready !== null) {
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => terminal.answer?.(NOTHING), TERMINAL_INPUT_WAIT_MILLISECONDS);
      terminal.answer = (input) => {
        clearTimeout(timer);
        terminal.answer = null;
        resolve(input);
      };
    });
  }

  printed(host: HostRow, terminalId: string, data: string) {
    const terminal = this.ofHost(host, terminalId);
    if (terminal.end !== null) {
      return;
    }
    terminal.printed += 1;
    terminal.outputBytes += Buffer.byteLength(data, "base64");
    const output = { sequence: terminal.printed, data };
    terminal.backlog.push(output);
    let kept = terminal.backlog.reduce((sum, entry) => sum + Buffer.byteLength(entry.data), 0);
    while (kept > TERMINAL_BACKLOG_BYTES || terminal.backlog.length > TERMINAL_BACKLOG_EVENTS) {
      kept -= Buffer.byteLength(terminal.backlog.shift()!.data);
    }
    terminal.listeners.forEach((listener) => listener({ kind: "output", ...output }));
  }

  ended(host: HostRow, terminalId: string, end: TerminalEnd) {
    this.finish(this.ofHost(host, terminalId), end);
  }

  /** A revoked host's shells end at once: what was typed and not yet taken never reaches its runner. */
  endForHost(hostId: string) {
    for (const terminal of [...this.terminals.values()].filter((each) => each.hostId === hostId)) {
      terminal.typed = [];
      terminal.size = null;
      this.finish(terminal, { exitCode: null, reason: TERMINAL_ENDINGS.hostRevoked });
    }
  }

  /**
   * Ends what nobody will: a shell its runner never started or stopped asking about (the runner is gone),
   * closes one nobody typed into for long, and forgets ended ones once a late browser had time to hear it.
   */
  resetForRestore() {
    for (const terminal of this.terminals.values())
      this.finish(terminal, { exitCode: null, reason: "Database restore maintenance." });
    this.terminals.clear();
  }

  sweep() {
    const now = this.clock();
    for (const terminal of [...this.terminals.values()]) {
      this.checkOwner(terminal);
      const neverStarted =
        terminal.state === TERMINAL_STATE.waiting && now - terminal.openedAt > TERMINAL_START_WAIT_MILLISECONDS;
      const runnerSilent =
        terminal.state === TERMINAL_STATE.open && now - terminal.askedAt > TERMINAL_RUNNER_SILENT_MILLISECONDS;
      const idle = terminal.state === TERMINAL_STATE.open && now - terminal.typedAt > TERMINAL_IDLE_MILLISECONDS;
      const forgotten =
        terminal.state === TERMINAL_STATE.ended && now - terminal.endedAt > TERMINAL_ENDED_KEEP_MILLISECONDS;
      if (neverStarted) {
        this.finish(terminal, { exitCode: null, reason: TERMINAL_ENDINGS.notStarted });
      }
      if (runnerSilent) {
        this.finish(terminal, { exitCode: null, reason: TERMINAL_ENDINGS.runnerSilent });
      }
      if (idle && terminal.closing === null) {
        this.closeFor(terminal, TERMINAL_ENDINGS.idle);
      }
      if (forgotten) {
        this.terminals.delete(terminal.id);
      }
    }
  }

  private checkOwner(terminal: Terminal) {
    if (terminal.end !== null) return;
    let permitted = this.sessions.isLive(terminal.ownerTokenHash, terminal.operatorUserId ? ACCESS_FULL : ACCESS_ADMIN);
    // Only container shells are ever an operator's.
    if (permitted && terminal.operatorUserId && terminal.containerName !== null) {
      try {
        this.access.require(terminal.hostId, terminal.containerName, terminal.operatorUserId, "terminal");
      } catch {
        permitted = false;
      }
    }
    if (permitted) return;
    // Nothing queued before revocation may reach the shell, nor may its output be replayed.
    terminal.typed = [];
    terminal.size = null;
    terminal.backlog = [];
    this.finish(terminal, { exitCode: null, reason: TERMINAL_ENDINGS.sessionEnded });
  }

  private closeFor(terminal: Terminal, reason: string | null) {
    terminal.closing = { reason };
    // Never taken by its runner: there is nothing to stop, only to end.
    if (terminal.state === TERMINAL_STATE.waiting) {
      this.finish(terminal, { exitCode: null, reason });
      return;
    }
    this.wake(terminal);
  }

  private finish(terminal: Terminal, end: TerminalEnd) {
    if (terminal.end !== null) {
      return;
    }
    // The runner tells how the shell ended; why it was closed is the dashboard's to add.
    terminal.end = { ...end, reason: end.reason ?? terminal.closing?.reason ?? null };
    terminal.state = TERMINAL_STATE.ended;
    terminal.endedAt = this.clock();
    terminal.closing ??= { reason: null };
    this.wake(terminal);
    terminal.listeners.forEach((listener) => listener({ kind: "ended", end: terminal.end! }));
    terminal.listeners.clear();
    this.audit(terminal, "closed", {
      ...terminal.end,
      inputBytes: terminal.inputBytes,
      outputBytes: terminal.outputBytes,
    });
  }

  private inputOf(terminal: Terminal): TerminalInput | null {
    if (terminal.typed.length === 0 && terminal.size === null && terminal.closing === null) {
      return null;
    }
    const input = { data: terminal.typed, size: terminal.size, closed: terminal.closing !== null };
    terminal.typed = [];
    terminal.size = null;
    return input;
  }

  private wake(terminal: Terminal) {
    if (terminal.answer === null) {
      return;
    }
    const ready = this.inputOf(terminal);
    if (ready !== null) {
      terminal.answer(ready);
    }
  }

  private audit(terminal: Terminal, moment: "opened" | "closed", details: object) {
    const onHost = terminal.containerName === null;
    const actions = onHost
      ? { opened: AUDIT_ACTIONS.hostTerminalOpened, closed: AUDIT_ACTIONS.hostTerminalClosed }
      : { opened: AUDIT_ACTIONS.terminalOpened, closed: AUDIT_ACTIONS.terminalClosed };
    const target = onHost
      ? { kind: TARGET_HOST, id: terminal.hostId }
      : { kind: TARGET_CONTAINER, id: `${terminal.hostId}/${terminal.containerName}` };
    this.auditLog.recordUserAction(terminal.actor, actions[moment], target, {
      hostId: terminal.hostId,
      terminalId: terminal.id,
      ...details,
    });
  }

  private owned(session: ResolvedSession, terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || terminal.ownerTokenHash !== session.tokenHash) {
      throw new DomainError(API_ERRORS.terminalNotFound);
    }
    this.checkOwner(terminal);
    return terminal;
  }

  private ofHost(host: HostRow, terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || terminal.hostId !== host.id) {
      throw new DomainError(API_ERRORS.terminalNotFound);
    }
    this.checkOwner(terminal);
    return terminal;
  }
}
