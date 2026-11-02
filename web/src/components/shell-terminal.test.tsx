import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalListener } from "../terminal-connection.js";
import { TEXT } from "../constants.js";
import { ContainerTerminal, HostTerminal } from "./shell-terminal.js";
import type { HostView } from "../../../src/shared/api.js";

const connection = vi.hoisted(() => ({ listener: null as TerminalListener | null, opened: [] as string[] }));
vi.mock("../terminal-connection.js", () => ({
  TerminalConnection: class {
    constructor(listener: TerminalListener) {
      connection.listener = listener;
    }
    async open(path: string) {
      connection.opened.push(path);
      return { id: "t1", user: "alex" };
    }
    close() {}
    type() {}
    resize() {}
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    focus() {}
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class {} }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps the lost-output warning visible while the shell reconnects and continues", async () => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(<ContainerTerminal hostId="h1" containerName="app" onClose={() => {}} />);
  await waitFor(() => expect(connection.listener).not.toBeNull());
  act(() => connection.listener!.gap());
  expect(screen.getByText(TEXT.terminal.gap).getAttribute("role")).toBe("status");
  act(() => connection.listener!.opened());
  expect(screen.getByText(TEXT.terminal.gap)).toBeTruthy();
  expect(screen.getByText(TEXT.terminal.open)).toBeTruthy();
});

it("opens a host's shell at its own path, says whom it runs as over SSH, and fills the window when asked", async () => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const cedar2 = { id: "h2", label: "cedar2", kind: "ssh" } as HostView;
  render(<HostTerminal host={cedar2} onClose={() => {}} />);
  expect(await screen.findByText(TEXT.hostTerminal.who.ssh("alex"))).toBeTruthy();
  expect(connection.opened.at(-1)).toBe("/api/inventory/hosts/h2/terminals");
  expect(screen.getByText(TEXT.hostTerminal.note.ssh("cedar2", "alex"))).toBeTruthy();
  const panel = screen.getByRole("region", { name: TEXT.hostTerminal.title("cedar2") });
  expect(panel.className).not.toContain("terminal-full");
  fireEvent.click(screen.getByRole("button", { name: TEXT.hostTerminal.fullWindow }));
  expect(panel.className).toContain("terminal-full");
  fireEvent.click(screen.getByRole("button", { name: TEXT.hostTerminal.leaveFullWindow }));
  expect(panel.className).not.toContain("terminal-full");
});
