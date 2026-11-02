import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JOB_STATUS, TASK_PRIORITY } from "../../../src/shared/constants.js";
import { COPY_FEEDBACK_MILLISECONDS, TEXT } from "../constants.js";
import { Badge, CopyButton, PasswordInput } from "./common.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("shows the password only while the eye is pressed, and never spell-checks it", () => {
  render(<PasswordInput label={TEXT.login.password} name="password" autoComplete="current-password" />);
  const input = screen.getByLabelText(TEXT.login.password);
  const eye = screen.getByRole("button", { name: TEXT.showPassword });
  expect(input.getAttribute("type")).toBe("password");
  expect(input.getAttribute("spellcheck")).toBe("false");

  fireEvent.click(eye);
  expect(input.getAttribute("type")).toBe("text");
  expect(eye.getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(eye);
  expect(input.getAttribute("type")).toBe("password");
  expect(eye.getAttribute("aria-pressed")).toBe("false");
});

it("colours the pressing end of a scale, not the calm one", () => {
  const toneOf = (value: string) => {
    const { container } = render(<Badge value={value} />);
    const tone = container.firstElementChild?.className;
    cleanup();
    return tone;
  };
  expect(toneOf(TASK_PRIORITY.urgent)).toBe("badge danger");
  expect(toneOf(TASK_PRIORITY.high)).toBe("badge warning");
  expect(toneOf(TASK_PRIORITY.low)).toBe("badge neutral");
  expect(toneOf(JOB_STATUS.failed)).toBe("badge danger");
  expect(toneOf(JOB_STATUS.succeeded)).toBe("badge good");
});

it("resets Copied when its text changes", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { rerender } = render(<CopyButton text="synthetic-old-command" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await screen.findByRole("button", { name: "Copied" });
  rerender(<CopyButton text="synthetic-new-command" />);
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
});

it("handles clipboard refusal with a redacted manual-copy message and permits retry", async () => {
  const privateText = "synthetic-private-join-code";
  const writeText = vi.fn().mockRejectedValueOnce(new Error(privateText)).mockResolvedValueOnce(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<CopyButton text={privateText} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Could not copy. Select the text above and copy it manually.",
    ),
  );
  expect(document.body.textContent).not.toContain(privateText);
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(writeText.mock.calls).toEqual([[privateText], [privateText]]);
});

it("expires success feedback and gives a repeated copy its own full feedback interval", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<CopyButton text="synthetic-command" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MILLISECONDS - 1));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copied" })));
  act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MILLISECONDS - 1));
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  expect(writeText).toHaveBeenCalledTimes(2);
});

it.each(["unavailable", "throws"])("offers manual copy when the clipboard %s", async (mode) => {
  vi.stubGlobal(
    "navigator",
    mode === "unavailable"
      ? {}
      : {
          clipboard: {
            writeText: () => {
              throw new Error("private-secret");
            },
          },
        },
  );
  render(<CopyButton text="private-secret" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  const status = screen.getByRole("status");
  await waitFor(() => expect(status.textContent).toContain(TEXT.copyFailed));
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.textContent).not.toContain("private-secret");
  expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(["success", "failure"])(
  "ignores an old %s across changed text, even if the original text returns",
  async (result) => {
    let finishOld!: () => void;
    let finishCurrent!: () => void;
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finishOld = () => (result === "success" ? resolve() : reject(new Error("private-old-error")));
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishCurrent = resolve;
          }),
      );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { rerender } = render(<CopyButton text="original" />);
    const button = screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    rerender(<CopyButton text="replacement" />);
    rerender(<CopyButton text="original" />);
    fireEvent.click(button);
    await act(async () => finishOld());
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain(TEXT.copyFailed);
    await act(async () => finishCurrent());
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText.mock.calls).toEqual([["original"], ["original"]]);
  },
);

it("cleans up success timers on changed text and unmount", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  const { rerender, unmount } = render(<CopyButton text="first" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
  expect(vi.getTimerCount()).toBe(1);
  rerender(<CopyButton text="second" />);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
