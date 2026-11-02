import type { HomeAssistantSettings } from "../../config/shared-settings.js";
import {
  HOME_ASSISTANT_COMMAND_TIMEOUT_MILLISECONDS,
  HOME_ASSISTANT_MESSAGE,
  HOME_ASSISTANT_MESSAGES,
  HOME_ASSISTANT_READ_COMMANDS,
  HOME_ASSISTANT_STATE_CHANGED,
  HOME_ASSISTANT_WEBSOCKET_PATH,
  HTTP_SCHEME_PATTERN,
  WEBSOCKET_SCHEME,
} from "../../shared/constants.js";
import type { StateEntry } from "./home-assistant-views.js";

export type ReadCommand = (typeof HOME_ASSISTANT_READ_COMMANDS)[keyof typeof HOME_ASSISTANT_READ_COMMANDS];

const READ_COMMANDS: ReadonlySet<string> = new Set(Object.values(HOME_ASSISTANT_READ_COMMANDS));

export interface StateChange {
  entity_id: string;
  // Null when the entity was removed.
  new_state: StateEntry | null;
}

interface Message {
  id?: number;
  type: string;
  success?: boolean;
  result?: unknown;
  error?: { message?: string };
  event?: { data?: unknown };
  ha_version?: string;
}

interface Waiting {
  socket: WebSocket;
  type: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// A frame that is not JSON (a proxy's error page) is skipped: thrown inside a socket listener, the
// error would end the whole process.
function parseMessage(data: unknown): Message | null {
  try {
    return JSON.parse(String(data)) as Message;
  } catch {
    return null;
  }
}

/** Home Assistant said no to the token: retrying would only add failed logins, which HA may ban. */
export class HomeAssistantTokenRefused extends Error {}

/**
 * Home Assistant's WebSocket API, read-only: it sends only the commands in
 * HOME_ASSISTANT_READ_COMMANDS and refuses anything else before it leaves. The token goes out once,
 * in the authentication message, and is never logged.
 */
export class HomeAssistantClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly listeners = new Map<number, (data: unknown) => void>();

  constructor(private readonly settings: HomeAssistantSettings) {}

  /** Opens and authenticates; resolves with HA's version. `onClosed` reports a later disconnect. */
  connect(onClosed: (reason: string) => void): Promise<string> {
    this.close();
    const socket = new WebSocket(
      `${this.settings.url.replace(HTTP_SCHEME_PATTERN, WEBSOCKET_SCHEME)}${HOME_ASSISTANT_WEBSOCKET_PATH}`,
    );
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let authenticated = false;
      let ended = false;
      // Ends the connection once, however it ends: Node's WebSocket reports some failures (an
      // untrusted certificate) with "error" alone and never fires "close".
      const end = (reason: string) => {
        if (ended) {
          return;
        }
        ended = true;
        clearTimeout(deadline);
        this.failWaiting(socket, reason);
        // close() lets go of a socket before closing it, so this tells a drop from a deliberate close.
        const dropped = this.socket === socket;
        if (dropped) {
          this.socket = null;
        }
        socket.close();
        if (!authenticated) {
          reject(new Error(reason));
          return;
        }
        if (dropped) {
          onClosed(reason);
        }
      };
      const deadline = setTimeout(
        () => end(HOME_ASSISTANT_MESSAGES.timedOut(HOME_ASSISTANT_MESSAGE.auth)),
        HOME_ASSISTANT_COMMAND_TIMEOUT_MILLISECONDS,
      );
      socket.addEventListener("message", (event) => {
        const message = parseMessage(event.data);
        if (message === null) {
          return;
        }
        if (message.type === HOME_ASSISTANT_MESSAGE.authRequired) {
          socket.send(JSON.stringify({ type: HOME_ASSISTANT_MESSAGE.auth, access_token: this.settings.token }));
          return;
        }
        if (message.type === HOME_ASSISTANT_MESSAGE.authInvalid) {
          reject(new HomeAssistantTokenRefused(HOME_ASSISTANT_MESSAGES.tokenRefused));
          end(HOME_ASSISTANT_MESSAGES.tokenRefused);
          return;
        }
        if (message.type === HOME_ASSISTANT_MESSAGE.authOk) {
          authenticated = true;
          clearTimeout(deadline);
          resolve(message.ha_version ?? "");
          return;
        }
        this.dispatch(message);
      });
      socket.addEventListener("close", (event) => end(event.reason || HOME_ASSISTANT_MESSAGES.closed(event.code)));
      socket.addEventListener("error", () => end(HOME_ASSISTANT_MESSAGES.connectionFailed));
    });
  }

  command<Result>(type: ReadCommand): Promise<Result> {
    return this.send(type, {}).answered as Promise<Result>;
  }

  /** Every state change from now on goes to `listener`; resolves once Home Assistant confirmed it. */
  subscribeStateChanges(listener: (change: StateChange) => void): Promise<void> {
    return this.subscribe(HOME_ASSISTANT_STATE_CHANGED, (data) => listener(data as StateChange));
  }

  /** Each event of this type from now on goes to `listener`; resolves once Home Assistant confirmed it. */
  async subscribe(eventType: string, listener: (data: unknown) => void): Promise<void> {
    const { id, answered } = this.send(HOME_ASSISTANT_READ_COMMANDS.subscribe, { event_type: eventType });
    this.listeners.set(id, listener);
    await answered;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.listeners.clear();
    socket?.close();
  }

  private send(type: string, fields: Record<string, unknown>): { id: number; answered: Promise<unknown> } {
    const id = this.nextId++;
    // Checked here as well as by the type: the guarantee must hold whoever calls this.
    if (!READ_COMMANDS.has(type)) {
      return { id, answered: Promise.reject(new Error(HOME_ASSISTANT_MESSAGES.readOnly(type))) };
    }
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return { id, answered: Promise.reject(new Error(HOME_ASSISTANT_MESSAGES.notConnected)) };
    }
    const answered = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(HOME_ASSISTANT_MESSAGES.timedOut(type)));
      }, HOME_ASSISTANT_COMMAND_TIMEOUT_MILLISECONDS);
      this.waiting.set(id, { socket, type, resolve, reject, timer });
    });
    // id and type last, so no field can stand in for them.
    socket.send(JSON.stringify({ ...fields, id, type }));
    return { id, answered };
  }

  private dispatch(message: Message) {
    if (message.id === undefined) {
      return;
    }
    if (message.type === HOME_ASSISTANT_MESSAGE.event) {
      this.listeners.get(message.id)?.(message.event?.data);
      return;
    }
    const waiting = this.waiting.get(message.id);
    if (message.type !== HOME_ASSISTANT_MESSAGE.result || waiting === undefined) {
      return;
    }
    this.waiting.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.success) {
      waiting.resolve(message.result);
      return;
    }
    waiting.reject(new Error(HOME_ASSISTANT_MESSAGES.commandFailed(waiting.type, message.error?.message ?? "")));
  }

  private failWaiting(socket: WebSocket, reason: string) {
    for (const [id, waiting] of this.waiting) {
      if (waiting.socket !== socket) {
        continue;
      }
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
      this.waiting.delete(id);
    }
  }
}
