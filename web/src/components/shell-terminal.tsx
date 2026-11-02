import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { HOST_KIND } from "../../../src/shared/constants.js";
import type { TerminalEnd } from "../../../src/shared/protocol.js";
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_RESIZE_MILLISECONDS,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_STYLE_TOKENS,
  TEXT,
} from "../constants.js";
import { TerminalConnection } from "../terminal-connection.js";
import { ErrorNotice } from "./common.js";
import { Icon } from "./icons.js";

type Status =
  | { kind: "opening" }
  | { kind: "open" }
  | { kind: "ended"; end: TerminalEnd }
  | { kind: "lost" }
  | { kind: "failed"; error: unknown };

const tokenOf = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function statusText(status: Status): string | null {
  if (status.kind === "opening") {
    return TEXT.terminal.opening;
  }
  if (status.kind === "open") {
    return TEXT.terminal.open;
  }
  if (status.kind === "ended") {
    return TEXT.terminal.ended(status.end.exitCode, status.end.reason);
  }
  return status.kind === "lost" ? TEXT.terminal.lost : null;
}

interface ShellPanelProps {
  // Where the shell is asked for: in a container, or on a host.
  openPath: string;
  title: string;
  // Under its title; whom the shell runs as once the dashboard is told, null before.
  noteOf: (user: string | null) => string;
  onClose: () => void;
  // Beside its title, once the dashboard is told whom the shell runs as.
  whoOf?: (user: string) => string;
  // More buttons, before its close button.
  tools?: ReactNode;
  className?: string;
}

/** A shell, in place: typed into as any terminal, closed with its button. */
function ShellPanel({ openPath, title, noteOf, onClose, whoOf, tools, className }: ShellPanelProps) {
  const screen = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "opening" });
  const [hasGap, setHasGap] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  useEffect(() => {
    const element = screen.current!;
    setHasGap(false);
    const font = tokenOf(TERMINAL_STYLE_TOKENS.font);
    const foreground = tokenOf(TERMINAL_STYLE_TOKENS.foreground);
    const terminal = new Terminal({
      fontFamily: font,
      fontSize: TERMINAL_FONT_SIZE,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: true,
      theme: { background: tokenOf(TERMINAL_STYLE_TOKENS.background), foreground, cursor: foreground },
    });
    const fit = new FitAddon();
    // Drawn on a canvas: xterm's own renderer writes inline styles, which the page's CSP refuses.
    terminal.loadAddon(new CanvasAddon());
    terminal.loadAddon(fit);
    const connection = new TerminalConnection({
      output: (bytes) => terminal.write(bytes),
      gap: () => setHasGap(true),
      opened: () => setStatus({ kind: "open" }),
      ended: (end) => setStatus({ kind: "ended", end }),
      failed: (error) => setStatus({ kind: "failed", error }),
      lost: () => setStatus({ kind: "lost" }),
    });
    let resizing: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizing);
      resizing = window.setTimeout(() => fit.fit(), TERMINAL_RESIZE_MILLISECONDS);
    });
    let disposed = false;
    // Its characters are measured once, so the page's mono font must have loaded first.
    void document.fonts
      .load(`${TERMINAL_FONT_SIZE}px ${font}`)
      .catch(() => undefined)
      .then(async () => {
        if (disposed) {
          return;
        }
        terminal.open(element);
        fit.fit();
        terminal.onData((data) => connection.type(data));
        terminal.onResize(({ cols, rows }) => connection.resize({ columns: cols, rows }));
        observer.observe(element);
        terminal.focus();
        const view = await connection.open(openPath, { columns: terminal.cols, rows: terminal.rows });
        if (!disposed) setUser(view?.user ?? null);
      });
    return () => {
      disposed = true;
      window.clearTimeout(resizing);
      observer.disconnect();
      connection.close();
      terminal.dispose();
    };
  }, [openPath]);
  const text = statusText(status);
  return (
    <section className={className ? `terminal-panel ${className}` : "terminal-panel"} aria-label={title}>
      <header className="terminal-head">
        <strong>{title}</strong>
        {user !== null && whoOf !== undefined && <span className="terminal-who">{whoOf(user)}</span>}
        {text !== null && (
          <span className="muted small" role="status">
            {text}
          </span>
        )}
        <span className="terminal-tools">
          {tools}
          <button
            type="button"
            className="icon-button"
            title={TEXT.terminal.close}
            aria-label={TEXT.terminal.close}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </span>
      </header>
      <p className="muted small">{noteOf(user)}</p>
      {hasGap && (
        <p className="notice warning small" role="status">
          {TEXT.terminal.gap}
        </p>
      )}
      {status.kind === "failed" && <ErrorNotice error={status.error} />}
      <div ref={screen} className="terminal-screen" />
    </section>
  );
}

/** A shell in a container, in place under its row. */
export function ContainerTerminal({
  hostId,
  containerName,
  onClose,
}: {
  hostId: string;
  containerName: string;
  onClose: () => void;
}) {
  return (
    <ShellPanel
      openPath={apiPath(API_ROUTES.terminals, { hostId, containerName })}
      title={TEXT.terminal.title(containerName)}
      noteOf={() => TEXT.terminal.sessionShells}
      onClose={onClose}
    />
  );
}

/** A shell on the host itself, under its page's header: the SSH user's over SSH, root's elsewhere; full window too. */
export function HostTerminal({ host, onClose }: { host: HostView; onClose: () => void }) {
  const [full, setFull] = useState(false);
  const overSsh = host.kind === HOST_KIND.ssh;
  const text = TEXT.hostTerminal;
  const fullLabel = full ? text.leaveFullWindow : text.fullWindow;
  return (
    <ShellPanel
      openPath={apiPath(API_ROUTES.hostTerminals, { hostId: host.id })}
      title={text.title(host.label)}
      noteOf={(user) => (overSsh ? text.note.ssh(host.label, user) : text.note.helper(host.label))}
      whoOf={overSsh ? text.who.ssh : text.who.helper}
      onClose={onClose}
      className={full ? "host-terminal terminal-full" : "host-terminal"}
      tools={
        <button
          type="button"
          className="icon-button"
          title={fullLabel}
          aria-label={fullLabel}
          aria-pressed={full}
          onClick={() => setFull(!full)}
        >
          <Icon name={full ? "minimize" : "maximize"} />
        </button>
      }
    />
  );
}
