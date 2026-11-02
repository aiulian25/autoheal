import { API_ROUTES, apiPath, type TerminalView } from "../../src/shared/api.js";
import { TERMINAL_EVENTS, TERMINAL_INPUT_CHARACTERS } from "../../src/shared/constants.js";
import type { TerminalEnd } from "../../src/shared/protocol.js";
import { api } from "./api-client.js";

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalListener {
  output: (bytes: Uint8Array) => void;
  opened: () => void;
  gap: () => void;
  ended: (end: TerminalEnd) => void;
  // A request refused: the error says why.
  failed: (error: unknown) => void;
  // The stream of what it prints is gone and was not given back.
  lost: () => void;
}

const HIGH_SURROGATES = { from: 0xd800, through: 0xdbff } as const;

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

// As much of what was typed as one request carries, never splitting a character in two.
function firstPiece(typed: string): string {
  const end = Math.min(TERMINAL_INPUT_CHARACTERS, typed.length);
  const code = typed.charCodeAt(end - 1);
  const splitsPair = end < typed.length && code >= HIGH_SURROGATES.from && code <= HIGH_SURROGATES.through;
  return typed.slice(0, splitsPair ? end - 1 : end);
}

/**
 * One shell in a container or on a host, from the browser: opened, followed as a stream of what it prints, typed into
 * one request at a time (what is typed meanwhile goes in the next, so keys arrive in order), and closed.
 */
export class TerminalConnection {
  private id: string | null = null;
  private source: EventSource | null = null;
  private typed = "";
  private size: TerminalSize | null = null;
  private sending = false;
  private finished = false;

  constructor(private readonly listener: TerminalListener) {}

  /** Opens it at the path that asks for a shell in a container or on a host; what the dashboard was told of it. */
  async open(openPath: string, size: TerminalSize): Promise<TerminalView | null> {
    try {
      const view = await api<TerminalView>("POST", openPath, size);
      // Closed while it was being opened: it ends at once.
      if (this.finished) {
        void api("DELETE", apiPath(API_ROUTES.terminal, { terminalId: view.id })).catch(() => undefined);
        return null;
      }
      this.id = view.id;
      this.follow(view.id);
      void this.send();
      return view;
    } catch (error) {
      this.finish();
      this.listener.failed(error);
      return null;
    }
  }

  type(data: string) {
    this.typed += data;
    void this.send();
  }

  resize(size: TerminalSize) {
    this.size = size;
    void this.send();
  }

  /** Ends the shell, unless it ended already; nothing more is sent or shown after. */
  close() {
    const id = this.id;
    const open = !this.finished;
    this.finish();
    if (id !== null && open) {
      void api("DELETE", apiPath(API_ROUTES.terminal, { terminalId: id })).catch(() => undefined);
    }
  }

  private follow(terminalId: string) {
    const source = new EventSource(apiPath(API_ROUTES.terminalStream, { terminalId }));
    source.onopen = () => this.listener.opened();
    source.addEventListener(TERMINAL_EVENTS.gap, () => this.listener.gap());
    source.addEventListener(TERMINAL_EVENTS.output, (event) => this.listener.output(bytesOf(event.data)));
    source.addEventListener(TERMINAL_EVENTS.ended, (event) => {
      this.finish();
      this.listener.ended(JSON.parse(event.data) as TerminalEnd);
    });
    // A dropped connection is tried again by the browser, sending what it last had; a refusal is the end.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED && !this.finished) {
        this.finish();
        this.listener.lost();
      }
    };
    this.source = source;
  }

  private async send() {
    if (this.id === null || this.sending || this.finished) {
      return;
    }
    const terminalId = this.id;
    this.sending = true;
    try {
      while (!this.finished && (this.typed !== "" || this.size !== null)) {
        await this.sendNext(terminalId);
      }
    } catch (error) {
      this.close();
      this.listener.failed(error);
    } finally {
      this.sending = false;
    }
  }

  private async sendNext(terminalId: string) {
    if (this.size !== null) {
      const size = this.size;
      this.size = null;
      await api("POST", apiPath(API_ROUTES.terminalResize, { terminalId }), size);
      return;
    }
    const data = firstPiece(this.typed);
    this.typed = this.typed.slice(data.length);
    await api("POST", apiPath(API_ROUTES.terminalInput, { terminalId }), { data });
  }

  private finish() {
    this.finished = true;
    this.source?.close();
  }
}
